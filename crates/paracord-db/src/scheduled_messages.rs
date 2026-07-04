//! Scheduled-message storage.
//!
//! Datetime convention: `send_at` is stored as epoch milliseconds in an
//! INTEGER (SQLite) / BIGINT (PostgreSQL) column, mirroring the i64 timestamp
//! style used across the schema, so it needs no per-engine casts on read or
//! write and compares numerically on both engines. The bookkeeping columns
//! `created_at`/`updated_at` remain DB-native timestamp values (TEXT on SQLite,
//! TIMESTAMPTZ on PostgreSQL) and are rendered to text on PostgreSQL via the
//! projection below so they read back as strings on either engine.
use crate::{active_database_engine, datetime_from_db_text, DatabaseEngine, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

pub const STATUS_SCHEDULED: i16 = 0;
pub const STATUS_SENT: i16 = 1;
pub const STATUS_CANCELLED: i16 = 2;
pub const STATUS_FAILED: i16 = 3;

#[derive(Debug, Clone)]
pub struct ScheduledMessageRow {
    pub id: i64,
    pub channel_id: i64,
    pub author_id: i64,
    pub content: Option<String>,
    pub e2ee_payload: Option<String>,
    pub nonce: Option<String>,
    pub reference_id: Option<i64>,
    pub send_at: DateTime<Utc>,
    pub delivered_message_id: Option<i64>,
    pub status: i16,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ScheduledMessageRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let send_at_ms: i64 = row.try_get("send_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            channel_id: row.try_get("channel_id")?,
            author_id: row.try_get("author_id")?,
            content: row.try_get("content")?,
            e2ee_payload: row.try_get("e2ee_payload")?,
            nonce: row.try_get("nonce")?,
            reference_id: row.try_get("reference_id")?,
            send_at: DateTime::from_timestamp_millis(send_at_ms).ok_or_else(|| {
                sqlx::Error::Protocol(format!("invalid send_at epoch millis {send_at_ms}"))
            })?,
            delivered_message_id: row.try_get("delivered_message_id")?,
            status: row.try_get("status")?,
            error: row.try_get("error")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

const SCHEDULED_MESSAGES_SELECT_SQLITE: &str =
    "id, channel_id, author_id, content, e2ee_payload, nonce, reference_id, send_at,
     delivered_message_id, status, error, created_at, updated_at";

const SCHEDULED_MESSAGES_SELECT_POSTGRES: &str =
    "id, channel_id, author_id, content, e2ee_payload, nonce, reference_id, send_at,
     delivered_message_id, status, error,
     to_char(timezone('UTC', created_at), 'YYYY-MM-DD HH24:MI:SS.US') AS created_at,
     to_char(timezone('UTC', updated_at), 'YYYY-MM-DD HH24:MI:SS.US') AS updated_at";

pub async fn create_scheduled_message(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    author_id: i64,
    content: Option<&str>,
    e2ee_payload: Option<&str>,
    nonce: Option<&str>,
    reference_id: Option<i64>,
    send_at: DateTime<Utc>,
) -> Result<ScheduledMessageRow, DbError> {
    let select_cols = match active_database_engine() {
        DatabaseEngine::Postgres => SCHEDULED_MESSAGES_SELECT_POSTGRES,
        DatabaseEngine::Sqlite => SCHEDULED_MESSAGES_SELECT_SQLITE,
    };
    let row = sqlx::query_as::<_, ScheduledMessageRow>(&format!(
        "INSERT INTO scheduled_messages
            (id, channel_id, author_id, content, e2ee_payload, nonce, reference_id, send_at, status, updated_at)
         VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
         RETURNING {}",
        select_cols
    ))
    .bind(id)
    .bind(channel_id)
    .bind(author_id)
    .bind(content)
    .bind(e2ee_payload)
    .bind(nonce)
    .bind(reference_id)
    .bind(send_at.timestamp_millis())
    .bind(STATUS_SCHEDULED)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_for_author_in_channel(
    pool: &DbPool,
    channel_id: i64,
    author_id: i64,
) -> Result<Vec<ScheduledMessageRow>, DbError> {
    let select_cols = match active_database_engine() {
        DatabaseEngine::Postgres => SCHEDULED_MESSAGES_SELECT_POSTGRES,
        DatabaseEngine::Sqlite => SCHEDULED_MESSAGES_SELECT_SQLITE,
    };
    let rows = sqlx::query_as::<_, ScheduledMessageRow>(&format!(
        "SELECT {}
         FROM scheduled_messages
         WHERE channel_id = $1 AND author_id = $2
         ORDER BY send_at ASC, id ASC",
        select_cols
    ))
    .bind(channel_id)
    .bind(author_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_scheduled_message(
    pool: &DbPool,
    id: i64,
) -> Result<Option<ScheduledMessageRow>, DbError> {
    let select_cols = match active_database_engine() {
        DatabaseEngine::Postgres => SCHEDULED_MESSAGES_SELECT_POSTGRES,
        DatabaseEngine::Sqlite => SCHEDULED_MESSAGES_SELECT_SQLITE,
    };
    let row = sqlx::query_as::<_, ScheduledMessageRow>(&format!(
        "SELECT {}
         FROM scheduled_messages
         WHERE id = $1",
        select_cols
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn cancel_scheduled_message(
    pool: &DbPool,
    id: i64,
) -> Result<Option<ScheduledMessageRow>, DbError> {
    let select_cols = match active_database_engine() {
        DatabaseEngine::Postgres => SCHEDULED_MESSAGES_SELECT_POSTGRES,
        DatabaseEngine::Sqlite => SCHEDULED_MESSAGES_SELECT_SQLITE,
    };
    let row = sqlx::query_as::<_, ScheduledMessageRow>(&format!(
        "UPDATE scheduled_messages
         SET status = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status = $3
         RETURNING {}",
        select_cols
    ))
    .bind(id)
    .bind(STATUS_CANCELLED)
    .bind(STATUS_SCHEDULED)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn update_scheduled_message(
    pool: &DbPool,
    id: i64,
    content: Option<&str>,
    e2ee_payload: Option<&str>,
    nonce: Option<&str>,
    send_at: DateTime<Utc>,
) -> Result<Option<ScheduledMessageRow>, DbError> {
    let select_cols = match active_database_engine() {
        DatabaseEngine::Postgres => SCHEDULED_MESSAGES_SELECT_POSTGRES,
        DatabaseEngine::Sqlite => SCHEDULED_MESSAGES_SELECT_SQLITE,
    };
    let row = sqlx::query_as::<_, ScheduledMessageRow>(&format!(
        "UPDATE scheduled_messages
         SET content = $2,
             e2ee_payload = $3,
             nonce = $4,
             send_at = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status = $6
         RETURNING {}",
        select_cols
    ))
    .bind(id)
    .bind(content)
    .bind(e2ee_payload)
    .bind(nonce)
    .bind(send_at.timestamp_millis())
    .bind(STATUS_SCHEDULED)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn list_due_scheduled_messages(
    pool: &DbPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<ScheduledMessageRow>, DbError> {
    let select_cols = match active_database_engine() {
        DatabaseEngine::Postgres => SCHEDULED_MESSAGES_SELECT_POSTGRES,
        DatabaseEngine::Sqlite => SCHEDULED_MESSAGES_SELECT_SQLITE,
    };
    let rows = sqlx::query_as::<_, ScheduledMessageRow>(&format!(
        "SELECT {}
         FROM scheduled_messages
         WHERE status = $1
           AND send_at <= $2
         ORDER BY send_at ASC, id ASC
         LIMIT $3",
        select_cols
    ))
    .bind(STATUS_SCHEDULED)
    .bind(now.timestamp_millis())
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn mark_scheduled_message_sent(
    pool: &DbPool,
    id: i64,
    delivered_message_id: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE scheduled_messages
         SET status = $2,
             delivered_message_id = $3,
             error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1",
    )
    .bind(id)
    .bind(STATUS_SENT)
    .bind(delivered_message_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_scheduled_message_failed(
    pool: &DbPool,
    id: i64,
    error: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE scheduled_messages
         SET status = $2,
             error = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1",
    )
    .bind(id)
    .bind(STATUS_FAILED)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}
