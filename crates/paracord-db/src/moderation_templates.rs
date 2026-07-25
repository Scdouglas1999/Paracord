use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct ModerationTemplateRow {
    pub id: i64,
    pub guild_id: i64,
    pub name: String,
    pub action_type: i16,
    pub duration_minutes: Option<i32>,
    pub reason_template: Option<String>,
    pub dm_template: Option<String>,
    pub created_by: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ModerationTemplateRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            name: row.try_get("name")?,
            action_type: row.try_get("action_type")?,
            duration_minutes: row.try_get("duration_minutes")?,
            reason_template: row.try_get("reason_template")?,
            dm_template: row.try_get("dm_template")?,
            created_by: row.try_get("created_by")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

pub async fn create_template(
    pool: &DbPool,
    id: i64,
    guild_id: i64,
    name: &str,
    action_type: i16,
    duration_minutes: Option<i32>,
    reason_template: Option<&str>,
    dm_template: Option<&str>,
    created_by: i64,
) -> Result<ModerationTemplateRow, DbError> {
    let row = sqlx::query_as::<_, ModerationTemplateRow>(
        "INSERT INTO moderation_action_templates (
            id, guild_id, name, action_type, duration_minutes, reason_template, dm_template, created_by, updated_at
         ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, datetime('now')
         )
         RETURNING id, guild_id, name, action_type, duration_minutes, reason_template, dm_template, created_by, created_at, updated_at",
    )
    .bind(id)
    .bind(guild_id)
    .bind(name)
    .bind(action_type)
    .bind(duration_minutes)
    .bind(reason_template)
    .bind(dm_template)
    .bind(created_by)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_templates(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<ModerationTemplateRow>, DbError> {
    let rows = sqlx::query_as::<_, ModerationTemplateRow>(
        "SELECT id, guild_id, name, action_type, duration_minutes, reason_template, dm_template, created_by, created_at, updated_at
         FROM moderation_action_templates
         WHERE guild_id = $1
         ORDER BY created_at DESC",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_template(
    pool: &DbPool,
    id: i64,
) -> Result<Option<ModerationTemplateRow>, DbError> {
    let row = sqlx::query_as::<_, ModerationTemplateRow>(
        "SELECT id, guild_id, name, action_type, duration_minutes, reason_template, dm_template, created_by, created_at, updated_at
         FROM moderation_action_templates
         WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_template(pool: &DbPool, id: i64) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM moderation_action_templates WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}
