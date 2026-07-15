use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct WebhookRow {
    pub id: i64,
    pub space_id: i64,
    pub channel_id: i64,
    pub creator_id: Option<i64>,
    pub name: String,
    pub token: String,
    pub github_secret: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for WebhookRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            space_id: row.try_get("space_id")?,
            channel_id: row.try_get("channel_id")?,
            creator_id: row.try_get("creator_id")?,
            name: row.try_get("name")?,
            token: row.try_get("token")?,
            github_secret: row.try_get("github_secret").ok().flatten(),
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

/// Storage-format tag marking a `webhooks.token` value as a SHA-256 hash rather
/// than a legacy plaintext token. Every token written by `create_webhook` (and
/// every row upgraded on use) carries this prefix; a *bare* (unprefixed) value
/// is a legacy row awaiting migrate-on-use. The prefix is what lets us keep the
/// plaintext-upgrade path (needed for pre-hash rows) without ever letting the
/// stored digest itself be replayed as a credential on already-hashed rows.
const HASH_SCHEME_PREFIX: &str = "sha256:";

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// The at-rest form of a freshly minted token: `sha256:<lowercase-hex-digest>`.
/// The raw token is never persisted.
fn hash_for_storage(token: &str) -> String {
    format!("{HASH_SCHEME_PREFIX}{}", sha256_hex(token.trim()))
}

/// Constant-time byte equality. Unequal lengths return `false` immediately
/// (length is not a secret); equal-length inputs are compared without an early
/// exit so a match cannot be distinguished from a near-match by timing.
fn constant_time_str_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub async fn create_webhook(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    channel_id: i64,
    name: &str,
    token: &str,
    creator_id: i64,
) -> Result<WebhookRow, DbError> {
    // Persist only the SHA-256 hash (scheme-tagged), never the raw token. The
    // caller still returns the raw token to the client exactly once, at create.
    let token_hash = hash_for_storage(token);
    let row = sqlx::query_as::<_, WebhookRow>(
        "INSERT INTO webhooks (id, space_id, channel_id, name, token, creator_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, space_id, channel_id, creator_id, name, token, github_secret, created_at",
    )
    .bind(id)
    .bind(space_id)
    .bind(channel_id)
    .bind(name)
    .bind(token_hash)
    .bind(creator_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_webhook(pool: &DbPool, id: i64) -> Result<Option<WebhookRow>, DbError> {
    let row = sqlx::query_as::<_, WebhookRow>(
        "SELECT id, space_id, channel_id, creator_id, name, token, github_secret, created_at
         FROM webhooks WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_webhook_by_id_and_token(
    pool: &DbPool,
    id: i64,
    token: &str,
) -> Result<Option<WebhookRow>, DbError> {
    // Fetch by the (public) webhook id, then authenticate the presented token in
    // Rust. `create_webhook` stores `sha256:<digest>` and never the raw token, so
    // the common path hashes the presented token and compares it to the stored
    // digest in constant time — the digest itself can never be replayed.
    //
    // Two legacy on-disk states are migrated on first successful use:
    //   * a *bare* SHA-256 hash (rows hashed by the v1 backfill, no scheme tag)
    //   * a *bare* plaintext token (rows written before tokens were hashed at all)
    // Both are 64 hex chars for real tokens and therefore indistinguishable by
    // shape, so we try the hash interpretation first, then the plaintext one, and
    // rewrite the row to the scheme-tagged hashed form on a match. Every row thus
    // converges to hashed-at-rest, and after conversion the plaintext fallback no
    // longer applies to it (closing pass-the-hash on that row).
    //
    // Returning `Ok(None)` covers both "no such webhook" and "wrong token"; the
    // callers collapse both to `NotFound`, preserving existing error semantics.
    let Some(row) = get_webhook(pool, id).await? else {
        return Ok(None);
    };

    let presented = token.trim();
    let stored = row.token.as_str();

    if let Some(stored_hash) = stored.strip_prefix(HASH_SCHEME_PREFIX) {
        // Current, hashed-at-rest format. Only a token whose digest equals the
        // stored hash authenticates; presenting the hash itself does not.
        if crate::bot_applications::verify_token_hash(presented, stored_hash) {
            return Ok(Some(row));
        }
        return Ok(None);
    }

    // (a) Legacy bare hash: the presented token hashes to the stored value.
    if crate::bot_applications::verify_token_hash(presented, stored) {
        upgrade_webhook_token(pool, id, &format!("{HASH_SCHEME_PREFIX}{stored}")).await?;
        return Ok(Some(row));
    }

    // (b) Legacy plaintext: the presented token equals the stored value verbatim.
    if constant_time_str_eq(presented, stored) {
        upgrade_webhook_token(pool, id, &hash_for_storage(presented)).await?;
        return Ok(Some(row));
    }

    Ok(None)
}

/// Rewrite a webhook's stored token to `new_value` (its scheme-tagged hash).
/// Used to migrate a legacy row to hashed-at-rest on first successful auth.
async fn upgrade_webhook_token(pool: &DbPool, id: i64, new_value: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE webhooks SET token = $2 WHERE id = $1")
        .bind(id)
        .bind(new_value)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_channel_webhooks(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<WebhookRow>, DbError> {
    let rows = sqlx::query_as::<_, WebhookRow>(
        "SELECT id, space_id, channel_id, creator_id, name, token, github_secret, created_at
         FROM webhooks WHERE channel_id = $1 ORDER BY created_at",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_guild_webhooks(pool: &DbPool, space_id: i64) -> Result<Vec<WebhookRow>, DbError> {
    let rows = sqlx::query_as::<_, WebhookRow>(
        "SELECT id, space_id, channel_id, creator_id, name, token, github_secret, created_at
         FROM webhooks WHERE space_id = $1 ORDER BY created_at",
    )
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_webhook(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
) -> Result<WebhookRow, DbError> {
    let row = sqlx::query_as::<_, WebhookRow>(
        "UPDATE webhooks SET name = COALESCE($2, name)
         WHERE id = $1
         RETURNING id, space_id, channel_id, creator_id, name, token, github_secret, created_at",
    )
    .bind(id)
    .bind(name)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_webhook_github_secret(
    pool: &DbPool,
    id: i64,
    github_secret: Option<&str>,
) -> Result<WebhookRow, DbError> {
    let row = sqlx::query_as::<_, WebhookRow>(
        "UPDATE webhooks SET github_secret = $2
         WHERE id = $1
         RETURNING id, space_id, channel_id, creator_id, name, token, github_secret, created_at",
    )
    .bind(id)
    .bind(github_secret)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_webhook(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM webhooks WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn link_webhook_message(
    pool: &DbPool,
    webhook_id: i64,
    message_id: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO webhook_messages (message_id, webhook_id)
         VALUES ($1, $2)
         ON CONFLICT (message_id) DO UPDATE SET webhook_id = EXCLUDED.webhook_id",
    )
    .bind(message_id)
    .bind(webhook_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn webhook_owns_message(
    pool: &DbPool,
    webhook_id: i64,
    message_id: i64,
) -> Result<bool, DbError> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1
         FROM webhook_messages
         WHERE webhook_id = $1 AND message_id = $2",
    )
    .bind(webhook_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create_pool, run_migrations, DbPool};

    // A realistic raw webhook token: 64 lowercase hex chars, exactly what
    // `generate_secure_token()` mints. Its being 64-hex is what tripped the old
    // `is_hex_sha256` short-circuit into treating it as an already-computed hash.
    const RAW_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    async fn seed(pool: &DbPool) {
        sqlx::query(
            "INSERT INTO users (id, username, discriminator, email, password_hash)
             VALUES (1, 'u', 1, 'u@example.com', 'hash')",
        )
        .execute(pool)
        .await
        .expect("insert user");
        sqlx::query("INSERT INTO spaces (id, name, owner_id) VALUES (2, 'space', 1)")
            .execute(pool)
            .await
            .expect("insert space");
        sqlx::query(
            "INSERT INTO channels (id, space_id, name, channel_type, position)
             VALUES (3, 2, 'general', 0, 0)",
        )
        .execute(pool)
        .await
        .expect("insert channel");
    }

    async fn stored_token(pool: &DbPool, id: i64) -> String {
        sqlx::query_scalar("SELECT token FROM webhooks WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("load webhook token")
    }

    async fn insert_legacy_webhook(pool: &DbPool, id: i64, token: &str) {
        sqlx::query(
            "INSERT INTO webhooks (id, space_id, channel_id, creator_id, name, token)
             VALUES ($1, 2, 3, 1, 'hook', $2)",
        )
        .bind(id)
        .bind(token)
        .execute(pool)
        .await
        .expect("insert legacy webhook");
    }

    // New token: create stores sha256(raw) (NOT the raw); the raw token
    // authenticates; the digest of the raw token does NOT.
    #[tokio::test]
    async fn new_token_is_stored_hashed_and_only_raw_authenticates() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");
        seed(&pool).await;

        create_webhook(&pool, 4, 2, 3, "hook", RAW_TOKEN, 1)
            .await
            .expect("create webhook");

        let stored = stored_token(&pool, 4).await;
        assert_ne!(stored, RAW_TOKEN, "raw token must never be stored");
        assert_eq!(
            stored,
            hash_for_storage(RAW_TOKEN),
            "stored value must be the scheme-tagged sha256 of the raw token"
        );
        assert!(
            stored.contains(&sha256_hex(RAW_TOKEN)),
            "stored value encodes sha256(raw)"
        );

        // Authenticating with the RAW token succeeds.
        let row = get_webhook_by_id_and_token(&pool, 4, RAW_TOKEN)
            .await
            .expect("lookup ok");
        assert!(row.is_some(), "raw token must authenticate");

        // Authenticating with sha256(raw) as the token FAILS (no pass-the-hash).
        let digest = sha256_hex(RAW_TOKEN);
        let row = get_webhook_by_id_and_token(&pool, 4, &digest)
            .await
            .expect("lookup ok");
        assert!(row.is_none(), "the stored digest must not be replayable");
    }

    // Legacy plaintext: a row whose token column holds a raw 64-hex value
    // (pre-fix storage) still authenticates by the raw token, and the row is
    // upgraded to the hashed form on first use.
    #[tokio::test]
    async fn legacy_plaintext_token_authenticates_and_upgrades() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");
        seed(&pool).await;

        // Simulate a pre-fix row: token column == raw 64-hex plaintext.
        insert_legacy_webhook(&pool, 4, RAW_TOKEN).await;
        assert_eq!(stored_token(&pool, 4).await, RAW_TOKEN);

        let row = get_webhook_by_id_and_token(&pool, 4, RAW_TOKEN)
            .await
            .expect("lookup ok");
        assert!(row.is_some(), "legacy plaintext token must authenticate");

        // The row must have self-healed to the hashed-at-rest form.
        let stored = stored_token(&pool, 4).await;
        assert_ne!(stored, RAW_TOKEN, "row must be upgraded off plaintext");
        assert_eq!(stored, hash_for_storage(RAW_TOKEN));

        // Post-upgrade: raw still works, and the digest is no longer replayable.
        assert!(get_webhook_by_id_and_token(&pool, 4, RAW_TOKEN)
            .await
            .expect("lookup ok")
            .is_some());
        assert!(get_webhook_by_id_and_token(&pool, 4, &sha256_hex(RAW_TOKEN))
            .await
            .expect("lookup ok")
            .is_none());
    }

    // Legacy v1 bare-hash: a row whose token column holds sha256(non-hex legacy
    // token) still authenticates by the original (non-hex) token.
    #[tokio::test]
    async fn legacy_v1_bare_hash_authenticates() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");
        seed(&pool).await;

        let legacy_token = "legacy-nonhex-token-value";
        let bare_hash = sha256_hex(legacy_token);
        insert_legacy_webhook(&pool, 4, &bare_hash).await;

        let row = get_webhook_by_id_and_token(&pool, 4, legacy_token)
            .await
            .expect("lookup ok");
        assert!(row.is_some(), "legacy v1 bare hash must authenticate");

        // It, too, converges to the scheme-tagged form.
        assert_eq!(
            stored_token(&pool, 4).await,
            format!("{HASH_SCHEME_PREFIX}{bare_hash}")
        );
    }

    // A wrong token yields None (which callers map to NotFound), never Some.
    #[tokio::test]
    async fn wrong_token_does_not_authenticate() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");
        seed(&pool).await;

        create_webhook(&pool, 4, 2, 3, "hook", RAW_TOKEN, 1)
            .await
            .expect("create webhook");

        let wrong = "f".repeat(64);
        assert!(get_webhook_by_id_and_token(&pool, 4, &wrong)
            .await
            .expect("lookup ok")
            .is_none());
        // Unknown id is also None, not an error.
        assert!(get_webhook_by_id_and_token(&pool, 999, RAW_TOKEN)
            .await
            .expect("lookup ok")
            .is_none());
    }
}
