use crate::{datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct AttachmentRow {
    pub id: i64,
    pub message_id: Option<i64>,
    pub filename: String,
    pub content_type: Option<String>,
    pub size: i32,
    pub url: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub uploader_id: Option<i64>,
    pub upload_channel_id: Option<i64>,
    pub upload_created_at: DateTime<Utc>,
    pub upload_expires_at: Option<DateTime<Utc>>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for AttachmentRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_raw: String = row.try_get("upload_created_at")?;
        let expires_raw: Option<String> = row.try_get("upload_expires_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            message_id: row.try_get("message_id")?,
            filename: row.try_get("filename")?,
            content_type: row.try_get("content_type")?,
            size: row.try_get("size")?,
            url: row.try_get("url")?,
            width: row.try_get("width")?,
            height: row.try_get("height")?,
            uploader_id: row.try_get("uploader_id")?,
            upload_channel_id: row.try_get("upload_channel_id")?,
            upload_created_at: datetime_from_db_text(&created_raw)?,
            upload_expires_at: expires_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn create_attachment(
    pool: &DbPool,
    id: i64,
    message_id: Option<i64>,
    filename: &str,
    content_type: Option<&str>,
    size: i32,
    url: &str,
    width: Option<i32>,
    height: Option<i32>,
    uploader_id: Option<i64>,
    upload_channel_id: Option<i64>,
    upload_expires_at: Option<DateTime<Utc>>,
) -> Result<AttachmentRow, DbError> {
    let row = sqlx::query_as::<_, AttachmentRow>(
        "INSERT INTO attachments (
            id, message_id, filename, content_type, size, url, width, height,
            uploader_id, upload_channel_id, upload_expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING
            id, message_id, filename, content_type, size, url, width, height,
            uploader_id, upload_channel_id, upload_created_at, upload_expires_at",
    )
    .bind(id)
    .bind(message_id)
    .bind(filename)
    .bind(content_type)
    .bind(size)
    .bind(url)
    .bind(width)
    .bind(height)
    .bind(uploader_id)
    .bind(upload_channel_id)
    .bind(upload_expires_at.map(datetime_to_db_text))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_attachment(pool: &DbPool, id: i64) -> Result<Option<AttachmentRow>, DbError> {
    let row = sqlx::query_as::<_, AttachmentRow>(
        "SELECT
            id, message_id, filename, content_type, size, url, width, height,
            uploader_id, upload_channel_id, upload_created_at, upload_expires_at
         FROM attachments WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_attachment(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM attachments WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_message_attachments(
    pool: &DbPool,
    message_id: i64,
) -> Result<Vec<AttachmentRow>, DbError> {
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "SELECT
            id, message_id, filename, content_type, size, url, width, height,
            uploader_id, upload_channel_id, upload_created_at, upload_expires_at
         FROM attachments WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn attach_to_message(
    pool: &DbPool,
    id: i64,
    message_id: i64,
    uploader_id: i64,
    channel_id: i64,
    now: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE attachments
         SET message_id = $2, upload_expires_at = NULL
         WHERE id = $1
           AND message_id IS NULL
           AND uploader_id = $3
           AND upload_channel_id = $4
           AND (upload_expires_at IS NULL OR upload_expires_at > $5)",
    )
    .bind(id)
    .bind(message_id)
    .bind(uploader_id)
    .bind(channel_id)
    .bind(datetime_to_db_text(now))
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn get_expired_pending_attachments(
    pool: &DbPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<AttachmentRow>, DbError> {
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "SELECT
            id, message_id, filename, content_type, size, url, width, height,
            uploader_id, upload_channel_id, upload_created_at, upload_expires_at
         FROM attachments
         WHERE message_id IS NULL
           AND upload_expires_at IS NOT NULL
           AND upload_expires_at <= $1
         ORDER BY upload_expires_at ASC
         LIMIT $2",
    )
    .bind(datetime_to_db_text(now))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_attachments_for_message_ids(
    pool: &DbPool,
    message_ids: &[i64],
    limit: i64,
) -> Result<Vec<AttachmentRow>, DbError> {
    const MAX_MESSAGE_IDS: usize = 500;
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    if message_ids.len() > MAX_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in attachment lookup".to_string(),
        )));
    }

    let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("${}", i)).collect();
    let sql = format!(
        "SELECT
            id, message_id, filename, content_type, size, url, width, height,
            uploader_id, upload_channel_id, upload_created_at, upload_expires_at
         FROM attachments
         WHERE message_id IN ({})
         ORDER BY upload_created_at ASC
         LIMIT ${}",
        placeholders.join(", "),
        message_ids.len() + 1
    );

    let mut query = sqlx::query_as::<_, AttachmentRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    query = query.bind(limit);
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}

pub async fn get_unlinked_attachments_older_than(
    pool: &DbPool,
    older_than: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<AttachmentRow>, DbError> {
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "SELECT
            id, message_id, filename, content_type, size, url, width, height,
            uploader_id, upload_channel_id, upload_created_at, upload_expires_at
         FROM attachments
         WHERE message_id IS NULL
           AND upload_created_at <= $1
         ORDER BY upload_created_at ASC
         LIMIT $2",
    )
    .bind(datetime_to_db_text(older_than))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_db() -> DbPool {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let db_path = std::env::temp_dir().join(format!("paracord-db-attachments-{unique}.db"));
        let db_url = format!(
            "sqlite://{}?mode=rwc",
            db_path.to_string_lossy().replace('\\', "/")
        );

        let pool = crate::create_pool(&db_url, 1).await.expect("pool");
        crate::run_migrations(&pool).await.expect("migrations");
        pool
    }

    #[tokio::test]
    async fn attach_to_message_enforces_uploader_and_channel_binding() {
        let db = setup_db().await;

        let user_a = crate::users::create_user(&db, 1001, "alice", 1, "alice@example.com", "hash")
            .await
            .expect("create user a");
        let user_b = crate::users::create_user(&db, 1002, "bob", 1, "bob@example.com", "hash")
            .await
            .expect("create user b");

        let guild = crate::guilds::create_space(&db, 2001, "space", user_a.id, None)
            .await
            .expect("create space");
        let channel_a =
            crate::channels::create_channel(&db, 3001, guild.id, "general", 0, 0, None, None)
                .await
                .expect("create channel a");
        let channel_b =
            crate::channels::create_channel(&db, 3002, guild.id, "other", 0, 1, None, None)
                .await
                .expect("create channel b");

        let message =
            crate::messages::create_message(&db, 4001, channel_a.id, user_a.id, "hello", 0, None)
                .await
                .expect("create message");

        create_attachment(
            &db,
            5001,
            None,
            "payload.txt",
            Some("text/plain"),
            42,
            "/api/v1/attachments/5001",
            None,
            None,
            Some(user_a.id),
            Some(channel_a.id),
            Some(Utc::now() + chrono::Duration::minutes(10)),
        )
        .await
        .expect("create attachment");

        let wrong_user =
            attach_to_message(&db, 5001, message.id, user_b.id, channel_a.id, Utc::now())
                .await
                .expect("attach wrong user");
        assert!(!wrong_user);

        let wrong_channel =
            attach_to_message(&db, 5001, message.id, user_a.id, channel_b.id, Utc::now())
                .await
                .expect("attach wrong channel");
        assert!(!wrong_channel);

        let ok = attach_to_message(&db, 5001, message.id, user_a.id, channel_a.id, Utc::now())
            .await
            .expect("attach correct");
        assert!(ok);
    }
}
