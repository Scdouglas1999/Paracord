use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

const ANIMALS: &[&str] = &[
    "Penguin", "Falcon", "Otter", "Fox", "Raven", "Lynx", "Wolf", "Koala", "Panda", "Turtle",
];

#[derive(Debug, Clone)]
pub struct AnonymousAliasRow {
    pub channel_id: i64,
    pub user_id: i64,
    pub alias: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AnonymousMessageRow {
    pub message_id: i64,
    pub channel_id: i64,
    pub user_id: i64,
    pub alias: String,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for AnonymousAliasRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            channel_id: row.try_get("channel_id")?,
            user_id: row.try_get("user_id")?,
            alias: row.try_get("alias")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for AnonymousMessageRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            message_id: row.try_get("message_id")?,
            channel_id: row.try_get("channel_id")?,
            user_id: row.try_get("user_id")?,
            alias: row.try_get("alias")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn get_alias_for_user(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
) -> Result<Option<AnonymousAliasRow>, DbError> {
    let row = sqlx::query_as::<_, AnonymousAliasRow>(
        "SELECT channel_id, user_id, alias, created_at
         FROM anonymous_channel_aliases
         WHERE channel_id = $1 AND user_id = $2",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_or_create_alias(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
) -> Result<AnonymousAliasRow, DbError> {
    if let Some(existing) = get_alias_for_user(pool, channel_id, user_id).await? {
        return Ok(existing);
    }

    for _ in 0..16 {
        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM anonymous_channel_aliases WHERE channel_id = $1")
                .bind(channel_id)
                .fetch_one(pool)
                .await?;
        let sequence = count + 1;
        let animal = ANIMALS[(sequence as usize - 1) % ANIMALS.len()];
        let alias = format!("Anonymous {animal} #{sequence}");

        let inserted = sqlx::query_as::<_, AnonymousAliasRow>(
            "INSERT INTO anonymous_channel_aliases (channel_id, user_id, alias)
             VALUES ($1, $2, $3)
             ON CONFLICT(channel_id, user_id) DO UPDATE SET alias = anonymous_channel_aliases.alias
             RETURNING channel_id, user_id, alias, created_at",
        )
        .bind(channel_id)
        .bind(user_id)
        .bind(&alias)
        .fetch_one(pool)
        .await;

        match inserted {
            Ok(row) => return Ok(row),
            Err(sqlx::Error::Database(db))
                if db
                    .message()
                    .to_ascii_lowercase()
                    .contains("idx_anonymous_channel_alias_unique") => {}
            Err(err) => return Err(DbError::Sqlx(err)),
        }
    }

    Err(DbError::Sqlx(sqlx::Error::Protocol(
        "failed to allocate anonymous alias".to_string(),
    )))
}

pub async fn attach_anonymous_message(
    pool: &DbPool,
    message_id: i64,
    channel_id: i64,
    user_id: i64,
    alias: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO anonymous_messages (message_id, channel_id, user_id, alias)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(message_id)
    .bind(channel_id)
    .bind(user_id)
    .bind(alias)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_anonymous_message(
    pool: &DbPool,
    message_id: i64,
) -> Result<Option<AnonymousMessageRow>, DbError> {
    let row = sqlx::query_as::<_, AnonymousMessageRow>(
        "SELECT message_id, channel_id, user_id, alias, created_at
         FROM anonymous_messages
         WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}
