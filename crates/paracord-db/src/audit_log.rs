use crate::{datetime_from_db_text, datetime_to_db_text, json_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct AuditLogEntryRow {
    pub id: i64,
    pub space_id: i64,
    pub user_id: i64,
    pub action_type: i16,
    pub target_id: Option<i64>,
    pub reason: Option<String>,
    pub changes: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for AuditLogEntryRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let changes_raw: Option<String> = row.try_get("changes")?;
        Ok(Self {
            id: row.try_get("id")?,
            space_id: row.try_get("space_id")?,
            user_id: row.try_get("user_id")?,
            action_type: row.try_get("action_type")?,
            target_id: row.try_get("target_id")?,
            reason: row.try_get("reason")?,
            changes: changes_raw.as_deref().map(json_from_db_text).transpose()?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

impl AuditLogEntryRow {
    /// Backward compat: return space_id as guild_id
    pub fn guild_id(&self) -> i64 {
        self.space_id
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn create_entry(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    user_id: i64,
    action_type: i16,
    target_id: Option<i64>,
    reason: Option<&str>,
    changes: Option<&serde_json::Value>,
) -> Result<AuditLogEntryRow, DbError> {
    let changes = changes
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(format!("invalid audit json: {e}"))))?;
    let row = sqlx::query_as::<_, AuditLogEntryRow>(
        "INSERT INTO audit_log_entries (id, space_id, user_id, action_type, target_id, reason, changes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, space_id, user_id, action_type, target_id, reason, changes, created_at"
    )
    .bind(id)
    .bind(space_id)
    .bind(user_id)
    .bind(action_type)
    .bind(target_id)
    .bind(reason)
    .bind(changes)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Get entries for a space. Kept as get_guild_entries for API compat.
pub async fn get_guild_entries(
    pool: &DbPool,
    space_id: i64,
    action_type: Option<i16>,
    user_id: Option<i64>,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<AuditLogEntryRow>, DbError> {
    get_space_entries(pool, space_id, action_type, user_id, before, limit).await
}

pub async fn get_space_entries(
    pool: &DbPool,
    space_id: i64,
    action_type: Option<i16>,
    user_id: Option<i64>,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<AuditLogEntryRow>, DbError> {
    let rows = match (action_type, user_id, before) {
        (None, None, None) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1
                 ORDER BY id DESC LIMIT $2"
            )
            .bind(space_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (Some(at), None, None) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1 AND action_type = $2
                 ORDER BY id DESC LIMIT $3"
            )
            .bind(space_id)
            .bind(at)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, Some(uid), None) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1 AND user_id = $2
                 ORDER BY id DESC LIMIT $3"
            )
            .bind(space_id)
            .bind(uid)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, None, Some(b)) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1 AND id < $2
                 ORDER BY id DESC LIMIT $3"
            )
            .bind(space_id)
            .bind(b)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (Some(at), Some(uid), None) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1 AND action_type = $2 AND user_id = $3
                 ORDER BY id DESC LIMIT $4"
            )
            .bind(space_id)
            .bind(at)
            .bind(uid)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (Some(at), None, Some(b)) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1 AND action_type = $2 AND id < $3
                 ORDER BY id DESC LIMIT $4"
            )
            .bind(space_id)
            .bind(at)
            .bind(b)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, Some(uid), Some(b)) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1 AND user_id = $2 AND id < $3
                 ORDER BY id DESC LIMIT $4"
            )
            .bind(space_id)
            .bind(uid)
            .bind(b)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (Some(at), Some(uid), Some(b)) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = $1 AND action_type = $2 AND user_id = $3 AND id < $4
                 ORDER BY id DESC LIMIT $5"
            )
            .bind(space_id)
            .bind(at)
            .bind(uid)
            .bind(b)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };

    Ok(rows)
}

pub async fn purge_entries_older_than(
    pool: &DbPool,
    older_than: DateTime<Utc>,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "DELETE FROM audit_log_entries
         WHERE id IN (
             SELECT id
             FROM audit_log_entries
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
