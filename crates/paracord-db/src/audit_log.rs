use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
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
    let row = sqlx::query_as::<_, AuditLogEntryRow>(
        "INSERT INTO audit_log_entries (id, space_id, user_id, action_type, target_id, reason, changes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
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
                 FROM audit_log_entries WHERE space_id = ?1
                 ORDER BY id DESC LIMIT ?2"
            )
            .bind(space_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (Some(at), None, None) => {
            sqlx::query_as::<_, AuditLogEntryRow>(
                "SELECT id, space_id, user_id, action_type, target_id, reason, changes, created_at
                 FROM audit_log_entries WHERE space_id = ?1 AND action_type = ?2
                 ORDER BY id DESC LIMIT ?3"
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
                 FROM audit_log_entries WHERE space_id = ?1 AND user_id = ?2
                 ORDER BY id DESC LIMIT ?3"
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
                 FROM audit_log_entries WHERE space_id = ?1 AND id < ?2
                 ORDER BY id DESC LIMIT ?3"
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
                 FROM audit_log_entries WHERE space_id = ?1 AND action_type = ?2 AND user_id = ?3
                 ORDER BY id DESC LIMIT ?4"
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
                 FROM audit_log_entries WHERE space_id = ?1 AND action_type = ?2 AND id < ?3
                 ORDER BY id DESC LIMIT ?4"
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
                 FROM audit_log_entries WHERE space_id = ?1 AND user_id = ?2 AND id < ?3
                 ORDER BY id DESC LIMIT ?4"
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
                 FROM audit_log_entries WHERE space_id = ?1 AND action_type = ?2 AND user_id = ?3 AND id < ?4
                 ORDER BY id DESC LIMIT ?5"
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
