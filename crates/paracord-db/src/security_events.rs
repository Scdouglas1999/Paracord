use crate::{datetime_from_db_text, datetime_to_db_text, json_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct SecurityEventRow {
    pub id: i64,
    pub actor_user_id: Option<i64>,
    pub action: String,
    pub target_user_id: Option<i64>,
    pub session_id: Option<String>,
    pub device_id: Option<String>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub details: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for SecurityEventRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let details_raw: Option<String> = row.try_get("details")?;
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            actor_user_id: row.try_get("actor_user_id")?,
            action: row.try_get("action")?,
            target_user_id: row.try_get("target_user_id")?,
            session_id: row.try_get("session_id")?,
            device_id: row.try_get("device_id")?,
            user_agent: row.try_get("user_agent")?,
            ip_address: row.try_get("ip_address")?,
            details: details_raw.as_deref().map(json_from_db_text).transpose()?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn create_event(
    pool: &DbPool,
    id: i64,
    actor_user_id: Option<i64>,
    action: &str,
    target_user_id: Option<i64>,
    session_id: Option<&str>,
    device_id: Option<&str>,
    user_agent: Option<&str>,
    ip_address: Option<&str>,
    details: Option<&serde_json::Value>,
) -> Result<SecurityEventRow, DbError> {
    let details = details
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| {
            DbError::Sqlx(sqlx::Error::Protocol(format!(
                "invalid security event json: {e}"
            )))
        })?;
    let row = sqlx::query_as::<_, SecurityEventRow>(
        "INSERT INTO security_events (
            id, actor_user_id, action, target_user_id, session_id, device_id, user_agent, ip_address, details
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, actor_user_id, action, target_user_id, session_id, device_id, user_agent, ip_address, details, created_at",
    )
    .bind(id)
    .bind(actor_user_id)
    .bind(action)
    .bind(target_user_id)
    .bind(session_id)
    .bind(device_id)
    .bind(user_agent)
    .bind(ip_address)
    .bind(details)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn purge_entries_older_than(
    pool: &DbPool,
    older_than: DateTime<Utc>,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "DELETE FROM security_events
         WHERE id IN (
             SELECT id
             FROM security_events
             WHERE created_at <= $1
             ORDER BY created_at ASC
             LIMIT $2
         )",
    )
    .bind(datetime_to_db_text(older_than))
    .bind(limit)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn list_events(
    pool: &DbPool,
    action: Option<&str>,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<SecurityEventRow>, DbError> {
    let rows = match (action, before) {
        (None, None) => {
            sqlx::query_as::<_, SecurityEventRow>(
                "SELECT id, actor_user_id, action, target_user_id, session_id, device_id, user_agent, ip_address, details, created_at
                 FROM security_events
                 ORDER BY id DESC
                 LIMIT $1",
            )
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (Some(action), None) => {
            sqlx::query_as::<_, SecurityEventRow>(
                "SELECT id, actor_user_id, action, target_user_id, session_id, device_id, user_agent, ip_address, details, created_at
                 FROM security_events
                 WHERE action = $1
                 ORDER BY id DESC
                 LIMIT $2",
            )
            .bind(action)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, Some(before)) => {
            sqlx::query_as::<_, SecurityEventRow>(
                "SELECT id, actor_user_id, action, target_user_id, session_id, device_id, user_agent, ip_address, details, created_at
                 FROM security_events
                 WHERE id < $1
                 ORDER BY id DESC
                 LIMIT $2",
            )
            .bind(before)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (Some(action), Some(before)) => {
            sqlx::query_as::<_, SecurityEventRow>(
                "SELECT id, actor_user_id, action, target_user_id, session_id, device_id, user_agent, ip_address, details, created_at
                 FROM security_events
                 WHERE action = $1
                   AND id < $2
                 ORDER BY id DESC
                 LIMIT $3",
            )
            .bind(action)
            .bind(before)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows)
}
