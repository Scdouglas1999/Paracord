use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct GuildOnboardingSettingsRow {
    pub guild_id: i64,
    pub welcome_title: Option<String>,
    pub welcome_body: Option<String>,
    pub rules_text: Option<String>,
    pub role_prompt: Option<String>,
    pub progressive_channel_min_messages: i32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct GuildOnboardingRoleOptionRow {
    pub id: i64,
    pub guild_id: i64,
    pub role_id: i64,
    pub label: Option<String>,
    pub description: Option<String>,
    pub position: i32,
}

#[derive(Debug, Clone)]
pub struct MemberOnboardingStateRow {
    pub guild_id: i64,
    pub user_id: i64,
    pub accepted_rules: bool,
    pub selected_role_ids: String,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GuildOnboardingSettingsRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            guild_id: row.try_get("guild_id")?,
            welcome_title: row.try_get("welcome_title")?,
            welcome_body: row.try_get("welcome_body")?,
            rules_text: row.try_get("rules_text")?,
            role_prompt: row.try_get("role_prompt")?,
            progressive_channel_min_messages: row.try_get("progressive_channel_min_messages")?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GuildOnboardingRoleOptionRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            role_id: row.try_get("role_id")?,
            label: row.try_get("label")?,
            description: row.try_get("description")?,
            position: row.try_get("position")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for MemberOnboardingStateRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        let completed_at_raw: Option<String> = row.try_get("completed_at")?;
        Ok(Self {
            guild_id: row.try_get("guild_id")?,
            user_id: row.try_get("user_id")?,
            accepted_rules: crate::bool_from_any_row(row, "accepted_rules")?,
            selected_role_ids: row.try_get("selected_role_ids")?,
            completed_at: completed_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

pub async fn get_guild_onboarding_settings(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Option<GuildOnboardingSettingsRow>, DbError> {
    let row = sqlx::query_as::<_, GuildOnboardingSettingsRow>(
        "SELECT guild_id, welcome_title, welcome_body, rules_text, role_prompt, progressive_channel_min_messages, updated_at
         FROM guild_onboarding_settings
         WHERE guild_id = $1",
    )
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_guild_onboarding_settings(
    pool: &DbPool,
    guild_id: i64,
    welcome_title: Option<&str>,
    welcome_body: Option<&str>,
    rules_text: Option<&str>,
    role_prompt: Option<&str>,
    progressive_channel_min_messages: i32,
) -> Result<GuildOnboardingSettingsRow, DbError> {
    let row = sqlx::query_as::<_, GuildOnboardingSettingsRow>(
        "INSERT INTO guild_onboarding_settings (
            guild_id, welcome_title, welcome_body, rules_text, role_prompt, progressive_channel_min_messages, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         ON CONFLICT(guild_id) DO UPDATE SET
            welcome_title = EXCLUDED.welcome_title,
            welcome_body = EXCLUDED.welcome_body,
            rules_text = EXCLUDED.rules_text,
            role_prompt = EXCLUDED.role_prompt,
            progressive_channel_min_messages = EXCLUDED.progressive_channel_min_messages,
            updated_at = CURRENT_TIMESTAMP
         RETURNING guild_id, welcome_title, welcome_body, rules_text, role_prompt, progressive_channel_min_messages, updated_at",
    )
    .bind(guild_id)
    .bind(welcome_title)
    .bind(welcome_body)
    .bind(rules_text)
    .bind(role_prompt)
    .bind(progressive_channel_min_messages)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_guild_onboarding_role_options(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<GuildOnboardingRoleOptionRow>, DbError> {
    let rows = sqlx::query_as::<_, GuildOnboardingRoleOptionRow>(
        "SELECT id, guild_id, role_id, label, description, position
         FROM guild_onboarding_role_options
         WHERE guild_id = $1
         ORDER BY position ASC, id ASC",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn replace_guild_onboarding_role_options(
    pool: &DbPool,
    guild_id: i64,
    options: &[(i64, i64, Option<String>, Option<String>, i32)],
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM guild_onboarding_role_options WHERE guild_id = $1")
        .bind(guild_id)
        .execute(pool)
        .await?;
    for (id, role_id, label, description, position) in options {
        sqlx::query(
            "INSERT INTO guild_onboarding_role_options (id, guild_id, role_id, label, description, position)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(*id)
        .bind(guild_id)
        .bind(*role_id)
        .bind(label)
        .bind(description)
        .bind(*position)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn get_member_onboarding_state(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
) -> Result<Option<MemberOnboardingStateRow>, DbError> {
    let row = sqlx::query_as::<_, MemberOnboardingStateRow>(
        "SELECT guild_id, user_id, CASE WHEN accepted_rules THEN 1 ELSE 0 END AS accepted_rules, selected_role_ids, completed_at, created_at, updated_at
         FROM member_onboarding_state
         WHERE guild_id = $1 AND user_id = $2",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_member_onboarding_state(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
    accepted_rules: bool,
    selected_role_ids: &str,
    completed: bool,
) -> Result<MemberOnboardingStateRow, DbError> {
    let completed_at = if completed {
        Some(Utc::now().format("%Y-%m-%d %H:%M:%S").to_string())
    } else {
        None
    };
    let row = sqlx::query_as::<_, MemberOnboardingStateRow>(
        "INSERT INTO member_onboarding_state (
            guild_id, user_id, accepted_rules, selected_role_ids, completed_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
            accepted_rules = EXCLUDED.accepted_rules,
            selected_role_ids = EXCLUDED.selected_role_ids,
            completed_at = COALESCE(EXCLUDED.completed_at, member_onboarding_state.completed_at),
            updated_at = CURRENT_TIMESTAMP
         RETURNING guild_id, user_id, CASE WHEN accepted_rules THEN 1 ELSE 0 END AS accepted_rules, selected_role_ids, completed_at, created_at, updated_at",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(accepted_rules)
    .bind(selected_role_ids)
    .bind(completed_at)
    .fetch_one(pool)
    .await?;
    Ok(row)
}
