use crate::{datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct ReminderRow {
    pub id: i64,
    pub user_id: i64,
    pub channel_id: i64,
    pub message_id: i64,
    pub remind_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub fired_at: Option<DateTime<Utc>>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ReminderRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let remind_at: String = row.try_get("remind_at")?;
        let created_at: String = row.try_get("created_at")?;
        let fired_at: Option<String> = row.try_get("fired_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            user_id: row.try_get("user_id")?,
            channel_id: row.try_get("channel_id")?,
            message_id: row.try_get("message_id")?,
            remind_at: datetime_from_db_text(&remind_at)?,
            created_at: datetime_from_db_text(&created_at)?,
            fired_at: fired_at.as_deref().map(datetime_from_db_text).transpose()?,
        })
    }
}

const REMINDER_COLUMNS: &str =
    "id, user_id, channel_id, message_id, remind_at, created_at, fired_at";

/// Create a reminder, or move the one this person already has on the message.
///
/// Moving clears `fired_at` so a snoozed reminder can fire again. The original
/// id and `created_at` stay put.
pub async fn upsert_reminder(
    pool: &DbPool,
    id: i64,
    user_id: i64,
    channel_id: i64,
    message_id: i64,
    remind_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<ReminderRow, DbError> {
    let row = sqlx::query_as::<_, ReminderRow>(&format!(
        "INSERT INTO message_reminders (id, user_id, channel_id, message_id, remind_at, created_at, fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (user_id, message_id) DO UPDATE SET
            channel_id = EXCLUDED.channel_id,
            remind_at = EXCLUDED.remind_at,
            fired_at = NULL
         RETURNING {REMINDER_COLUMNS}"
    ))
    .bind(id)
    .bind(user_id)
    .bind(channel_id)
    .bind(message_id)
    .bind(datetime_to_db_text(remind_at))
    .bind(datetime_to_db_text(now))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_reminder(pool: &DbPool, user_id: i64, message_id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM message_reminders WHERE user_id = $1 AND message_id = $2")
        .bind(user_id)
        .bind(message_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_reminder_by_id(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM message_reminders WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Pending and fired reminders, newest first.
pub async fn list_reminders_for_user(
    pool: &DbPool,
    user_id: i64,
    limit: i64,
) -> Result<Vec<ReminderRow>, DbError> {
    let rows = sqlx::query_as::<_, ReminderRow>(&format!(
        "SELECT {REMINDER_COLUMNS} FROM message_reminders
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2"
    ))
    .bind(user_id)
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Reminders whose time has arrived and that have not fired yet.
pub async fn list_due_reminders(
    pool: &DbPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<ReminderRow>, DbError> {
    let rows = sqlx::query_as::<_, ReminderRow>(&format!(
        "SELECT {REMINDER_COLUMNS} FROM message_reminders
         WHERE fired_at IS NULL AND remind_at <= $1
         ORDER BY remind_at ASC, id ASC
         LIMIT $2"
    ))
    .bind(datetime_to_db_text(now))
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Mark one due reminder fired. False when another worker already claimed it.
pub async fn mark_reminder_fired(
    pool: &DbPool,
    id: i64,
    fired_at: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE message_reminders SET fired_at = $2 WHERE id = $1 AND fired_at IS NULL",
    )
    .bind(id)
    .bind(datetime_to_db_text(fired_at))
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
