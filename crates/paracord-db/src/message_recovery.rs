//! Durable, bounded recovery of message bodies and deletions, not gateway events.
//! Channel writers hold the same channel lock before their message row locks.
//! Each page fixes its delta upper bound while reporting separately versioned,
//! current projections from one coherent snapshot. Deleted plaintext is never
//! copied into this table. Encrypted envelopes survive only the retained window.
use crate::{messages::MessageRow, DbError, DbPool};
use sqlx::Row;

pub const RETAINED_MESSAGE_MUTATIONS: i64 = 2048;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageMutation {
    pub revision: i64,
    pub message_id: i64,
    pub kind: String,
    pub encrypted_message: Option<String>,
}

#[derive(Debug)]
pub struct RecoveryPage {
    pub after: i64,
    pub through: i64,
    pub floor: i64,
    pub next: i64,
    pub projection_head: i64,
    pub changes: Vec<MessageMutation>,
    /// None is an explicit absence in this authorized channel snapshot.
    pub states: Vec<(i64, Option<MessageRow>)>,
}

#[derive(Debug)]
pub enum RecoveryResult {
    Page(RecoveryPage),
    Gap {
        floor: i64,
        head: i64,
        before_migration: bool,
    },
}

async fn append(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    channel_id: i64,
    message_id: i64,
    kind: &str,
    encrypted_message: Option<String>,
) -> Result<i64, DbError> {
    let (revision,): (i64,) = sqlx::query_as(
        "UPDATE channels SET message_revision = message_revision + 1 WHERE id = $1 RETURNING message_revision",
    ).bind(channel_id).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO message_recovery(channel_id, revision, message_id, kind, encrypted_message) VALUES($1, $2, $3, $4, $5)")
        .bind(channel_id).bind(revision).bind(message_id).bind(kind).bind(encrypted_message)
        .execute(&mut **tx).await?;
    // A contiguous revision floor includes every removed mutation. Unique
    // per-message revisions mean a page never splits a bulk-operation group.
    let cutoff: Option<(i64,)> = sqlx::query_as(
        "SELECT revision FROM message_recovery WHERE channel_id = $1 ORDER BY revision DESC LIMIT 1 OFFSET $2",
    ).bind(channel_id).bind(RETAINED_MESSAGE_MUTATIONS).fetch_optional(&mut **tx).await?;
    if let Some((cutoff,)) = cutoff {
        sqlx::query("DELETE FROM message_recovery WHERE channel_id = $1 AND revision <= $2")
            .bind(channel_id)
            .bind(cutoff)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE channels SET message_recovery_floor = CASE WHEN message_recovery_floor < $2 THEN $2 ELSE message_recovery_floor END WHERE id = $1")
            .bind(channel_id).bind(cutoff).execute(&mut **tx).await?;
    }
    Ok(revision)
}

pub(crate) async fn record_upsert(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    message: &mut MessageRow,
    kind: &str,
) -> Result<(), DbError> {
    // Bit 0 is the persisted DM-E2EE flag. The DB crate must not depend on core.
    let encrypted = if message.flags & 1 != 0 {
        let (Some(ciphertext), Some(nonce)) = (&message.content, &message.nonce) else {
            return Err(DbError::Conflict(
                "An encrypted message is missing its immutable envelope.".into(),
            ));
        };
        Some(
            serde_json::json!({
                "id": message.id.to_string(), "channel_id": message.channel_id.to_string(),
                "author": { "id": message.author_id.to_string() }, "content": "",
                "nonce": message.delivery_nonce, "timestamp": message.created_at.to_rfc3339(),
                "edited_timestamp": message.edited_at.map(|value| value.to_rfc3339()),
                "flags": message.flags,
                "e2ee": { "version": if message.e2ee_header.is_some() { 2 } else { 1 },
                    "nonce": nonce, "ciphertext": ciphertext, "header": message.e2ee_header },
            })
            .to_string(),
        )
    } else {
        None
    };
    let revision = append(tx, message.channel_id, message.id, kind, encrypted).await?;
    sqlx::query("UPDATE messages SET recovery_revision = $2 WHERE id = $1")
        .bind(message.id)
        .bind(revision)
        .execute(&mut **tx)
        .await?;
    message.recovery_revision = revision;
    Ok(())
}

/// Pins, embeds and components do not write encryption envelopes. In
/// particular, account erasure may have changed the visible row author to the
/// deleted-user tombstone; copying that unchanged ciphertext as a new ratchet
/// envelope would lose its original cryptographic sender identity.
pub(crate) async fn record_metadata_update(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    message: &mut MessageRow,
) -> Result<(), DbError> {
    let revision = append(tx, message.channel_id, message.id, "update", None).await?;
    sqlx::query("UPDATE messages SET recovery_revision = $2 WHERE id = $1")
        .bind(message.id)
        .bind(revision)
        .execute(&mut **tx)
        .await?;
    message.recovery_revision = revision;
    Ok(())
}

pub(crate) async fn record_delete(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    channel_id: i64,
    message_id: i64,
) -> Result<i64, DbError> {
    append(tx, channel_id, message_id, "delete", None).await
}

/// Read an exact, retained mutation identity for create/delete publications.
/// Missing history is explicit; callers must never substitute the channel head.
pub async fn mutation_revision(
    pool: &DbPool,
    channel_id: i64,
    message_id: i64,
    kind: &str,
) -> Result<Option<i64>, DbError> {
    Ok(sqlx::query_as::<_, (i64,)>("SELECT revision FROM message_recovery WHERE channel_id = $1 AND message_id = $2 AND kind = $3 ORDER BY revision ASC LIMIT 1")
        .bind(channel_id).bind(message_id).bind(kind).fetch_optional(pool).await?.map(|row| row.0))
}

pub async fn get_page(
    pool: &DbPool,
    channel_id: i64,
    after: i64,
    through: Option<i64>,
    limit: i64,
    known_ids: &[i64],
) -> Result<RecoveryResult, DbError> {
    if after < 0
        || through.is_some_and(|value| value < after)
        || !(1..=100).contains(&limit)
        || known_ids.len() > 100
    {
        return Err(DbError::Conflict("Invalid message recovery range.".into()));
    }
    let mut tx = pool.begin().await?;
    // A short channel lock is a portable coherent snapshot on SQLite and PG.
    // No network awaits or unbounded serialization happen while it is held.
    let row = sqlx::query("UPDATE channels SET last_message_id = last_message_id WHERE id = $1 RETURNING message_revision, message_recovery_floor, message_recovery_start")
        .bind(channel_id).fetch_optional(&mut *tx).await?.ok_or(DbError::NotFound)?;
    let head: i64 = row.try_get("message_revision")?;
    let floor: i64 = row.try_get("message_recovery_floor")?;
    let start: i64 = row.try_get("message_recovery_start")?;
    if after < floor {
        tx.rollback().await?;
        return Ok(RecoveryResult::Gap {
            floor,
            head,
            before_migration: after < start,
        });
    }
    let through = through.unwrap_or(head);
    if after > through || through > head {
        return Err(DbError::Conflict(
            "The message recovery fence is beyond current history.".into(),
        ));
    }
    let changes = sqlx::query_as::<_, MessageMutation>("SELECT revision, message_id, kind, encrypted_message FROM message_recovery WHERE channel_id = $1 AND revision > $2 AND revision <= $3 ORDER BY revision ASC LIMIT $4")
        .bind(channel_id).bind(after).bind(through).bind(limit).fetch_all(&mut *tx).await?;
    // Revisions after the migration floor are consecutive. Detect a damaged or
    // externally truncated archive instead of calling an empty page complete.
    let mut expected = after;
    for change in &changes {
        expected += 1;
        if change.revision != expected {
            return Err(DbError::Conflict(
                "The message recovery archive has a gap.".into(),
            ));
        }
    }
    if expected < through && changes.len() < limit as usize {
        return Err(DbError::Conflict(
            "The message recovery archive has a gap.".into(),
        ));
    }
    let mut targets: std::collections::BTreeSet<i64> = known_ids.iter().copied().collect();
    targets.extend(changes.iter().map(|change| change.message_id));
    let mut current = std::collections::BTreeMap::new();
    if !targets.is_empty() {
        let sql = format!("SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision FROM messages WHERE channel_id = $1 AND id IN ({})", crate::messages::build_placeholders(2, targets.len()));
        let mut query = sqlx::query_as::<_, MessageRow>(&sql).bind(channel_id);
        for id in &targets {
            query = query.bind(id);
        }
        for row in query.fetch_all(&mut *tx).await? {
            current.insert(row.id, row);
        }
    }
    let states = targets
        .into_iter()
        .map(|id| (id, current.remove(&id)))
        .collect();
    tx.commit().await?;
    Ok(RecoveryResult::Page(RecoveryPage {
        after,
        through,
        floor,
        next: expected,
        projection_head: head,
        changes,
        states,
    }))
}
