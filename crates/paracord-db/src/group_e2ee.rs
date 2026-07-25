//! Sender-key envelopes for group (multi-recipient) E2EE channels.
//!
//! `acknowledged` is a real `BOOLEAN` on both engines, so every write and
//! comparison uses the `TRUE`/`FALSE` keywords rather than `1`/`0`. SQLite
//! treats those keywords as its integer 1/0, while PostgreSQL is strictly
//! typed and rejects an integer against a boolean column outright ("column
//! \"acknowledged\" is of type boolean but expression is of type integer"),
//! which took the whole sender-key flow down on PostgreSQL. Reads still go
//! through `CASE WHEN ... THEN 1 ELSE 0 END` + [`crate::bool_from_any_row`],
//! because the `Any` driver cannot decode SQLite's `Bool` type info.

use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct GroupSenderKeyRow {
    pub id: i64,
    pub channel_id: i64,
    pub sender_id: i64,
    pub recipient_id: i64,
    pub epoch: i32,
    pub ciphertext: String,
    pub header: Option<String>,
    pub acknowledged: bool,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GroupSenderKeyRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            channel_id: row.try_get("channel_id")?,
            sender_id: row.try_get("sender_id")?,
            recipient_id: row.try_get("recipient_id")?,
            epoch: row.try_get("epoch")?,
            ciphertext: row.try_get("ciphertext")?,
            header: row.try_get("header")?,
            acknowledged: crate::bool_from_any_row(row, "acknowledged")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn upsert_sender_key(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    sender_id: i64,
    recipient_id: i64,
    epoch: i32,
    ciphertext: &str,
    header: Option<&str>,
) -> Result<GroupSenderKeyRow, DbError> {
    let row = sqlx::query_as::<_, GroupSenderKeyRow>(
        "INSERT INTO group_e2ee_sender_keys (
            id, channel_id, sender_id, recipient_id, epoch, ciphertext, header, acknowledged
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
         ON CONFLICT(channel_id, sender_id, recipient_id, epoch) DO UPDATE SET
            ciphertext = EXCLUDED.ciphertext,
            header = EXCLUDED.header,
            acknowledged = FALSE
         RETURNING id, channel_id, sender_id, recipient_id, epoch, ciphertext, header,
                   CASE WHEN acknowledged THEN 1 ELSE 0 END AS acknowledged, created_at",
    )
    .bind(id)
    .bind(channel_id)
    .bind(sender_id)
    .bind(recipient_id)
    .bind(epoch)
    .bind(ciphertext)
    .bind(header)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_pending_for_recipient(
    pool: &DbPool,
    channel_id: i64,
    recipient_id: i64,
    since_epoch: Option<i32>,
) -> Result<Vec<GroupSenderKeyRow>, DbError> {
    let rows = sqlx::query_as::<_, GroupSenderKeyRow>(
        "SELECT id, channel_id, sender_id, recipient_id, epoch, ciphertext, header,
                CASE WHEN acknowledged THEN 1 ELSE 0 END AS acknowledged, created_at
         FROM group_e2ee_sender_keys
         WHERE channel_id = $1
           AND recipient_id = $2
           AND (acknowledged = FALSE OR $3 IS NOT NULL)
           AND ($3 IS NULL OR epoch >= $3)
         ORDER BY epoch ASC, created_at ASC",
    )
    .bind(channel_id)
    .bind(recipient_id)
    .bind(since_epoch)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn acknowledge_sender_keys(
    pool: &DbPool,
    channel_id: i64,
    recipient_id: i64,
    sender_id: Option<i64>,
    up_to_epoch: Option<i32>,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "UPDATE group_e2ee_sender_keys
         SET acknowledged = TRUE
         WHERE channel_id = $1
           AND recipient_id = $2
           AND ($3 IS NULL OR sender_id = $3)
           AND ($4 IS NULL OR epoch <= $4)",
    )
    .bind(channel_id)
    .bind(recipient_id)
    .bind(sender_id)
    .bind(up_to_epoch)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
