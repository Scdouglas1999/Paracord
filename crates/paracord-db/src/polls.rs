use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct PollRow {
    pub id: i64,
    pub message_id: i64,
    pub channel_id: i64,
    pub question: String,
    pub allow_multiselect: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PollOptionRow {
    pub id: i64,
    pub poll_id: i64,
    pub text: String,
    pub emoji: Option<String>,
    pub position: i32,
}

#[derive(Debug, Clone)]
pub struct PollOptionWithVotes {
    pub id: i64,
    pub text: String,
    pub emoji: Option<String>,
    pub position: i32,
    pub vote_count: i32,
    pub voted: bool,
}

#[derive(Debug, Clone)]
pub struct PollWithOptions {
    pub poll: PollRow,
    pub options: Vec<PollOptionWithVotes>,
    pub total_votes: i32,
}

pub struct CreatePollOption {
    pub text: String,
    pub emoji: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for PollRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let expires_at_raw: Option<String> = row.try_get("expires_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            message_id: row.try_get("message_id")?,
            channel_id: row.try_get("channel_id")?,
            question: row.try_get("question")?,
            allow_multiselect: bool_from_any_row(row, "allow_multiselect")?,
            expires_at: expires_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_poll(
    pool: &DbPool,
    poll_id: i64,
    message_id: i64,
    channel_id: i64,
    question: &str,
    options: &[CreatePollOption],
    allow_multiselect: bool,
    expires_at: Option<DateTime<Utc>>,
) -> Result<PollRow, DbError> {
    let row = sqlx::query_as::<_, PollRow>(
        "INSERT INTO polls (id, message_id, channel_id, question, allow_multiselect, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, message_id, channel_id, question, allow_multiselect, expires_at, created_at",
    )
    .bind(poll_id)
    .bind(message_id)
    .bind(channel_id)
    .bind(question)
    .bind(allow_multiselect)
    .bind(expires_at.map(datetime_to_db_text))
    .fetch_one(pool)
    .await?;

    for (i, opt) in options.iter().enumerate() {
        let option_id = paracord_util::snowflake::generate(1);
        sqlx::query(
            "INSERT INTO poll_options (id, poll_id, text, emoji, position)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(option_id)
        .bind(poll_id)
        .bind(&opt.text)
        .bind(opt.emoji.as_deref())
        .bind(i as i32)
        .execute(pool)
        .await?;
    }

    Ok(row)
}

pub async fn get_poll(
    pool: &DbPool,
    poll_id: i64,
    viewer_id: i64,
) -> Result<Option<PollWithOptions>, DbError> {
    let poll = sqlx::query_as::<_, PollRow>(
        "SELECT id, message_id, channel_id, question, allow_multiselect, expires_at, created_at
         FROM polls WHERE id = $1",
    )
    .bind(poll_id)
    .fetch_optional(pool)
    .await?;

    let Some(poll) = poll else {
        return Ok(None);
    };

    let options = build_options_with_votes(pool, poll_id, viewer_id).await?;
    let total_votes: i32 = options.iter().map(|o| o.vote_count).sum();

    Ok(Some(PollWithOptions {
        poll,
        options,
        total_votes,
    }))
}

pub async fn get_message_poll(
    pool: &DbPool,
    message_id: i64,
    viewer_id: i64,
) -> Result<Option<PollWithOptions>, DbError> {
    let poll = sqlx::query_as::<_, PollRow>(
        "SELECT id, message_id, channel_id, question, allow_multiselect, expires_at, created_at
         FROM polls WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;

    let Some(poll) = poll else {
        return Ok(None);
    };

    let options = build_options_with_votes(pool, poll.id, viewer_id).await?;
    let total_votes: i32 = options.iter().map(|o| o.vote_count).sum();

    Ok(Some(PollWithOptions {
        poll,
        options,
        total_votes,
    }))
}

async fn build_options_with_votes(
    pool: &DbPool,
    poll_id: i64,
    viewer_id: i64,
) -> Result<Vec<PollOptionWithVotes>, DbError> {
    let option_rows = sqlx::query_as::<_, PollOptionRow>(
        "SELECT id, poll_id, text, emoji, position
         FROM poll_options WHERE poll_id = $1 ORDER BY position",
    )
    .bind(poll_id)
    .fetch_all(pool)
    .await?;

    let mut result = Vec::with_capacity(option_rows.len());
    for opt in option_rows {
        let vote_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM poll_votes WHERE poll_id = $1 AND option_id = $2")
                .bind(poll_id)
                .bind(opt.id)
                .fetch_one(pool)
                .await?;

        let voted: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM poll_votes WHERE poll_id = $1 AND option_id = $2 AND user_id = $3)",
        )
        .bind(poll_id)
        .bind(opt.id)
        .bind(viewer_id)
        .fetch_one(pool)
        .await?;

        result.push(PollOptionWithVotes {
            id: opt.id,
            text: opt.text,
            emoji: opt.emoji,
            position: opt.position,
            vote_count: vote_count.0 as i32,
            voted,
        });
    }

    Ok(result)
}

pub async fn add_vote(
    pool: &DbPool,
    poll_id: i64,
    option_id: i64,
    user_id: i64,
) -> Result<(), DbError> {
    // Check if poll allows multiselect
    let poll = sqlx::query_as::<_, PollRow>(
        "SELECT id, message_id, channel_id, question, allow_multiselect, expires_at, created_at
         FROM polls WHERE id = $1",
    )
    .bind(poll_id)
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound)?;

    // If single-select, remove existing votes first
    if !poll.allow_multiselect {
        sqlx::query("DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2")
            .bind(poll_id)
            .bind(user_id)
            .execute(pool)
            .await?;
    }

    sqlx::query(
        "INSERT INTO poll_votes (poll_id, option_id, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (poll_id, option_id, user_id) DO NOTHING",
    )
    .bind(poll_id)
    .bind(option_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn remove_vote(
    pool: &DbPool,
    poll_id: i64,
    option_id: i64,
    user_id: i64,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM poll_votes WHERE poll_id = $1 AND option_id = $2 AND user_id = $3")
        .bind(poll_id)
        .bind(option_id)
        .bind(user_id)
        .execute(pool)
        .await?;

    Ok(())
}
