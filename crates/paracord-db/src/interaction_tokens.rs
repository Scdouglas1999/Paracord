use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct InteractionTokenRow {
    pub id: i64,
    pub interaction_id: i64,
    pub application_id: i64,
    pub token_hash: String,
    pub channel_id: i64,
    pub guild_id: Option<i64>,
    pub user_id: i64,
    pub interaction_type: i16,
    pub response_message_id: Option<i64>,
    pub modal_data: Option<String>,
    pub modal_issued_at: Option<DateTime<Utc>>,
    pub modal_consumed_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

const SELECT_COLS: &str = "id, interaction_id, application_id, token_hash, channel_id, guild_id, user_id, type, response_message_id, modal_data, modal_issued_at, modal_consumed_at, expires_at, created_at";

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for InteractionTokenRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let expires_at_raw: String = row.try_get("expires_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        let modal_issued_at_raw: Option<String> = row.try_get("modal_issued_at")?;
        let modal_consumed_at_raw: Option<String> = row.try_get("modal_consumed_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            interaction_id: row.try_get("interaction_id")?,
            application_id: row.try_get("application_id")?,
            token_hash: row.try_get("token_hash")?,
            channel_id: row.try_get("channel_id")?,
            guild_id: row.try_get("guild_id")?,
            user_id: row.try_get("user_id")?,
            interaction_type: row.try_get("type")?,
            response_message_id: row.try_get("response_message_id")?,
            modal_data: row.try_get("modal_data")?,
            modal_issued_at: modal_issued_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            modal_consumed_at: modal_consumed_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            expires_at: datetime_from_db_text(&expires_at_raw)?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_interaction_token(
    pool: &DbPool,
    id: i64,
    interaction_id: i64,
    application_id: i64,
    token_hash: &str,
    channel_id: i64,
    guild_id: Option<i64>,
    user_id: i64,
    interaction_type: i16,
    expires_at: DateTime<Utc>,
) -> Result<InteractionTokenRow, DbError> {
    let expires_at_text = crate::datetime_to_db_text(expires_at);
    let sql = format!(
        "INSERT INTO interaction_tokens (id, interaction_id, application_id, token_hash, channel_id, guild_id, user_id, type, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING {SELECT_COLS}"
    );
    let row = sqlx::query_as::<_, InteractionTokenRow>(&sql)
        .bind(id)
        .bind(interaction_id)
        .bind(application_id)
        .bind(token_hash)
        .bind(channel_id)
        .bind(guild_id)
        .bind(user_id)
        .bind(interaction_type)
        .bind(expires_at_text)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn get_interaction_token(
    pool: &DbPool,
    interaction_id: i64,
) -> Result<Option<InteractionTokenRow>, DbError> {
    let sql = format!("SELECT {SELECT_COLS} FROM interaction_tokens WHERE interaction_id = $1");
    let row = sqlx::query_as::<_, InteractionTokenRow>(&sql)
        .bind(interaction_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn get_interaction_token_by_app_and_hash(
    pool: &DbPool,
    application_id: i64,
    token_hash: &str,
) -> Result<Option<InteractionTokenRow>, DbError> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM interaction_tokens WHERE application_id = $1 AND token_hash = $2"
    );
    let row = sqlx::query_as::<_, InteractionTokenRow>(&sql)
        .bind(application_id)
        .bind(token_hash)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn update_response_message_id(
    pool: &DbPool,
    interaction_id: i64,
    message_id: i64,
) -> Result<(), DbError> {
    sqlx::query("UPDATE interaction_tokens SET response_message_id = $1 WHERE interaction_id = $2")
        .bind(message_id)
        .bind(interaction_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Record the exact modal definition a bot issued for an interaction. A modal
/// may be issued only once for a source interaction.
pub async fn mark_modal_issued(
    pool: &DbPool,
    interaction_id: i64,
    modal_data: &str,
    issued_at: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE interaction_tokens
         SET modal_data = $1, modal_issued_at = $2
         WHERE interaction_id = $3 AND modal_issued_at IS NULL AND modal_consumed_at IS NULL",
    )
    .bind(modal_data)
    .bind(crate::datetime_to_db_text(issued_at))
    .bind(interaction_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Atomically consume a previously issued modal, preventing replayed submits.
pub async fn consume_modal(
    pool: &DbPool,
    interaction_id: i64,
    consumed_at: DateTime<Utc>,
) -> Result<bool, DbError> {
    let now = crate::datetime_to_db_text(consumed_at);
    let result = sqlx::query(
        "UPDATE interaction_tokens
         SET modal_consumed_at = $1
         WHERE interaction_id = $2
           AND modal_issued_at IS NOT NULL
           AND modal_consumed_at IS NULL
           AND expires_at > $1",
    )
    .bind(now)
    .bind(interaction_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn delete_expired_tokens(pool: &DbPool) -> Result<u64, DbError> {
    // `interaction_tokens.expires_at` is TEXT on both engines, holding the
    // fixed-width UTC form `datetime_to_db_text` writes, so one bound string
    // compares correctly everywhere. The old PostgreSQL branch compared that
    // TEXT column against `NOW()` (a timestamptz) and failed with
    // `operator does not exist: text <= timestamp with time zone`, so expired
    // interaction tokens were never reaped there.
    let now_text = crate::datetime_to_db_text(chrono::Utc::now());
    let result = sqlx::query("DELETE FROM interaction_tokens WHERE expires_at <= $1")
        .bind(now_text)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}
