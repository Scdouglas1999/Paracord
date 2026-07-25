use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Duration, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct BotReviewRow {
    pub id: i64,
    pub bot_app_id: i64,
    pub user_id: i64,
    pub rating: i16,
    pub title: Option<String>,
    pub body: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct BotMetricBucket {
    pub event_type: String,
    pub count: i64,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for BotReviewRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            bot_app_id: row.try_get("bot_app_id")?,
            user_id: row.try_get("user_id")?,
            rating: row.try_get("rating")?,
            title: row.try_get("title")?,
            body: row.try_get("body")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

pub async fn upsert_review(
    pool: &DbPool,
    id: i64,
    bot_app_id: i64,
    user_id: i64,
    rating: i16,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<BotReviewRow, DbError> {
    let row = sqlx::query_as::<_, BotReviewRow>(
        "INSERT INTO bot_reviews (id, bot_app_id, user_id, rating, title, body, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, datetime('now'))
         ON CONFLICT(bot_app_id, user_id) DO UPDATE SET
             rating = EXCLUDED.rating,
             title = EXCLUDED.title,
             body = EXCLUDED.body,
             updated_at = datetime('now')
         RETURNING id, bot_app_id, user_id, rating, title, body, created_at, updated_at",
    )
    .bind(id)
    .bind(bot_app_id)
    .bind(user_id)
    .bind(rating)
    .bind(title)
    .bind(body)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_reviews(
    pool: &DbPool,
    bot_app_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<BotReviewRow>, DbError> {
    let rows = sqlx::query_as::<_, BotReviewRow>(
        "SELECT id, bot_app_id, user_id, rating, title, body, created_at, updated_at
         FROM bot_reviews
         WHERE bot_app_id = $1
         ORDER BY updated_at DESC, id DESC
         LIMIT $2 OFFSET $3",
    )
    .bind(bot_app_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_review_summary(pool: &DbPool, bot_app_id: i64) -> Result<(i64, f64), DbError> {
    let row: (i64, Option<f64>) =
        sqlx::query_as("SELECT COUNT(*), AVG(rating * 1.0) FROM bot_reviews WHERE bot_app_id = $1")
            .bind(bot_app_id)
            .fetch_one(pool)
            .await?;
    Ok((row.0, row.1.unwrap_or(0.0)))
}

/// Batch review summaries (rating count and average) keyed by bot app id.
/// Lets store listings enrich a whole page in one query instead of per row.
/// Apps with no reviews are absent from the map; callers default to `(0, 0.0)`.
pub async fn get_review_summaries(
    pool: &DbPool,
    app_ids: &[i64],
) -> Result<std::collections::HashMap<i64, (i64, f64)>, DbError> {
    if app_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = crate::messages::build_placeholders(1, app_ids.len());
    let sql = format!(
        "SELECT bot_app_id, COUNT(*) AS review_count, AVG(rating * 1.0) AS avg_rating \
         FROM bot_reviews WHERE bot_app_id IN ({placeholders}) GROUP BY bot_app_id"
    );
    let mut query = sqlx::query(&sql);
    for id in app_ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(pool).await?;
    let mut map = std::collections::HashMap::with_capacity(rows.len());
    for row in rows {
        let app_id: i64 = row.try_get("bot_app_id")?;
        let count: i64 = row.try_get("review_count").unwrap_or(0);
        let avg: Option<f64> = row.try_get("avg_rating").ok().flatten();
        map.insert(app_id, (count, avg.unwrap_or(0.0)));
    }
    Ok(map)
}

pub async fn record_metric_event(
    pool: &DbPool,
    id: i64,
    bot_app_id: i64,
    guild_id: Option<i64>,
    event_type: &str,
    metadata: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO bot_metric_events (id, bot_app_id, guild_id, event_type, metadata)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(bot_app_id)
    .bind(guild_id)
    .bind(event_type)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_metric_buckets_30d(
    pool: &DbPool,
    bot_app_id: i64,
) -> Result<Vec<BotMetricBucket>, DbError> {
    let since = (Utc::now() - Duration::days(30))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT event_type, COUNT(*)
         FROM bot_metric_events
         WHERE bot_app_id = $1
           AND created_at >= $2
         GROUP BY event_type
         ORDER BY event_type ASC",
    )
    .bind(bot_app_id)
    .bind(since)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(event_type, count)| BotMetricBucket { event_type, count })
        .collect())
}
