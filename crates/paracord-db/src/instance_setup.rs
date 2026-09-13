//! Permanent first-owner claim state for this instance.
//!
//! The `instance_setup` table holds exactly one row (`id = 1`). It is the only
//! authority on whether this server has an owner: nothing here is derived from
//! the user count, from the presence of a config file, or from whether an admin
//! account happens to exist right now. Deleting the owner later therefore
//! cannot reopen the bootstrap window, which is precisely the hole the old
//! "first registrant silently becomes admin" behaviour left open.

use crate::{datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// The instance has never been claimed; `POST /api/v1/setup/claim` is the only
/// way to create the first account.
pub const STATUS_PENDING: &str = "pending";
/// The instance has an owner (or was explicitly bootstrapped); ordinary
/// registration and login behave exactly as they always have.
pub const STATUS_COMPLETE: &str = "complete";

/// The claim flow completed through the setup page / API.
pub const COMPLETED_VIA_CLAIM: &str = "claim";
/// A populated database was sealed by the `instance_setup` migration.
pub const COMPLETED_VIA_MIGRATION: &str = "migration";
/// An operator explicitly disabled the claim requirement (`[setup]
/// require_claim = false` / `PARACORD_SETUP_REQUIRE_CLAIM=false`), so the first
/// registered account owns the instance. Used by automated harnesses and
/// unattended container deployments.
pub const COMPLETED_VIA_BOOTSTRAP: &str = "bootstrap";

/// The claim token was supplied by configuration and is therefore reproducible
/// across restarts.
pub const TOKEN_SOURCE_CONFIG: &str = "config";
/// The claim token was minted by the server on a pending first run.
pub const TOKEN_SOURCE_GENERATED: &str = "generated";

/// The singleton setup row.
#[derive(Debug, Clone)]
pub struct InstanceSetupRow {
    pub status: String,
    pub instance_name: Option<String>,
    pub claimed_by_user_id: Option<i64>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub completed_via: Option<String>,
    pub claim_token_hash: Option<String>,
    pub claim_token_source: Option<String>,
    pub claim_token_issued_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl InstanceSetupRow {
    /// True while the instance still needs a first owner.
    pub fn is_pending(&self) -> bool {
        self.status == STATUS_PENDING
    }
}

fn optional_datetime(raw: Option<String>) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    raw.as_deref().map(datetime_from_db_text).transpose()
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for InstanceSetupRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            status: row.try_get("status")?,
            instance_name: row.try_get("instance_name")?,
            claimed_by_user_id: row.try_get("claimed_by_user_id")?,
            claimed_at: optional_datetime(row.try_get("claimed_at")?)?,
            completed_via: row.try_get("completed_via")?,
            claim_token_hash: row.try_get("claim_token_hash")?,
            claim_token_source: row.try_get("claim_token_source")?,
            claim_token_issued_at: optional_datetime(row.try_get("claim_token_issued_at")?)?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

const SELECT_COLUMNS: &str = "status, instance_name, claimed_by_user_id, claimed_at, \
     completed_via, claim_token_hash, claim_token_source, claim_token_issued_at, created_at";

/// Read the singleton row.
///
/// A missing row is an error rather than an implied "pending": the row is
/// created by the migration, so its absence means the schema is not what this
/// build expects, and quietly answering "pending" there would reopen the
/// bootstrap window on a live server.
pub async fn get(pool: &DbPool) -> Result<InstanceSetupRow, DbError> {
    let row = sqlx::query_as::<_, InstanceSetupRow>(&format!(
        "SELECT {SELECT_COLUMNS} FROM instance_setup WHERE id = 1"
    ))
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        DbError::from(sqlx::Error::Protocol(
            "instance_setup row is missing; the instance_setup migration did not run".into(),
        ))
    })?;
    Ok(row)
}

/// True when this instance still needs a first owner.
pub async fn is_pending(pool: &DbPool) -> Result<bool, DbError> {
    Ok(get(pool).await?.is_pending())
}

/// Store the hash of the bootstrap claim token for a pending instance.
///
/// Only ever applied while `status = 'pending'`: a completed instance must not
/// be handed a fresh bootstrap credential by a restart, however the server was
/// configured. Returns `true` when the row was updated.
pub async fn set_claim_token(
    pool: &DbPool,
    token_hash: &str,
    source: &str,
    issued_at: DateTime<Utc>,
) -> Result<bool, DbError> {
    let affected = sqlx::query(
        "UPDATE instance_setup
         SET claim_token_hash = $1, claim_token_source = $2, claim_token_issued_at = $3
         WHERE id = 1 AND status = 'pending'",
    )
    .bind(token_hash)
    .bind(source)
    .bind(datetime_to_db_text(issued_at))
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected == 1)
}

/// Complete the claim for `owner_id`, atomically and exactly once.
///
/// The `WHERE status = 'pending'` predicate is the concurrency boundary: two
/// simultaneous claims both reach this statement, but only one updates a row.
/// The loser sees `Ok(false)` and must roll back whatever it created. The claim
/// token hash is cleared in the same statement, which is what makes the token
/// single-use.
pub async fn complete_claim(
    pool: &DbPool,
    owner_id: i64,
    instance_name: &str,
    claimed_at: DateTime<Utc>,
) -> Result<bool, DbError> {
    let affected = sqlx::query(
        "UPDATE instance_setup
         SET status = 'complete', completed_via = 'claim', claimed_by_user_id = $1,
             instance_name = $2, claimed_at = $3,
             claim_token_hash = NULL, claim_token_source = NULL, claim_token_issued_at = NULL
         WHERE id = 1 AND status = 'pending'",
    )
    .bind(owner_id)
    .bind(instance_name)
    .bind(datetime_to_db_text(claimed_at))
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected == 1)
}

/// Leave `pending` without a claim, because the operator explicitly asked for
/// the legacy "first registered account owns the instance" bootstrap.
///
/// Returns `true` when this call performed the transition.
pub async fn complete_bootstrap(pool: &DbPool, at: DateTime<Utc>) -> Result<bool, DbError> {
    let affected = sqlx::query(
        "UPDATE instance_setup
         SET status = 'complete', completed_via = 'bootstrap', claimed_at = $1,
             claim_token_hash = NULL, claim_token_source = NULL, claim_token_issued_at = NULL
         WHERE id = 1 AND status = 'pending'",
    )
    .bind(datetime_to_db_text(at))
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn fresh_database_starts_pending() {
        let pool = test_pool().await;
        let row = get(&pool).await.unwrap();
        assert_eq!(row.status, STATUS_PENDING);
        assert!(row.is_pending());
        assert!(row.claimed_by_user_id.is_none());
        assert!(row.completed_via.is_none());
    }

    #[tokio::test]
    async fn claim_token_only_lands_while_pending() {
        let pool = test_pool().await;
        assert!(
            set_claim_token(&pool, "abc", TOKEN_SOURCE_GENERATED, Utc::now())
                .await
                .unwrap()
        );
        let row = get(&pool).await.unwrap();
        assert_eq!(row.claim_token_hash.as_deref(), Some("abc"));
        assert_eq!(
            row.claim_token_source.as_deref(),
            Some(TOKEN_SOURCE_GENERATED)
        );

        assert!(complete_claim(&pool, 42, "Example", Utc::now())
            .await
            .unwrap());
        // A restart must not re-arm a bootstrap credential on a claimed server.
        assert!(
            !set_claim_token(&pool, "def", TOKEN_SOURCE_CONFIG, Utc::now())
                .await
                .unwrap()
        );
        let row = get(&pool).await.unwrap();
        assert!(row.claim_token_hash.is_none());
    }

    #[tokio::test]
    async fn only_one_claim_wins() {
        let pool = test_pool().await;
        assert!(complete_claim(&pool, 7, "First", Utc::now()).await.unwrap());
        assert!(!complete_claim(&pool, 8, "Second", Utc::now())
            .await
            .unwrap());
        let row = get(&pool).await.unwrap();
        assert_eq!(row.claimed_by_user_id, Some(7));
        assert_eq!(row.instance_name.as_deref(), Some("First"));
        assert_eq!(row.completed_via.as_deref(), Some(COMPLETED_VIA_CLAIM));
        assert!(!row.is_pending());
    }

    #[tokio::test]
    async fn bootstrap_completion_is_recorded_distinctly() {
        let pool = test_pool().await;
        assert!(complete_bootstrap(&pool, Utc::now()).await.unwrap());
        let row = get(&pool).await.unwrap();
        assert_eq!(row.completed_via.as_deref(), Some(COMPLETED_VIA_BOOTSTRAP));
        assert!(!row.is_pending());
        // Already complete: a second call is a no-op, not a reopen.
        assert!(!complete_bootstrap(&pool, Utc::now()).await.unwrap());
    }

    #[tokio::test]
    async fn deleting_the_owner_does_not_reopen_setup() {
        let pool = test_pool().await;
        let password_hash = "argon2-placeholder";
        let user =
            crate::users::create_user(&pool, 1234, "owner", 0, "owner@example.com", password_hash)
                .await
                .unwrap();
        assert!(complete_claim(&pool, user.id, "Example", Utc::now())
            .await
            .unwrap());
        crate::users::delete_user(&pool, user.id).await.unwrap();
        let row = get(&pool).await.unwrap();
        assert!(!row.is_pending());
        assert_eq!(row.claimed_by_user_id, Some(user.id));
    }
}
