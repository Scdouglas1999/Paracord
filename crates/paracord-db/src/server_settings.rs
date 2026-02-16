use crate::{DbError, DbPool};

pub async fn get_setting(pool: &DbPool, key: &str) -> Result<Option<String>, DbError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM server_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.0))
}

pub async fn set_setting(pool: &DbPool, key: &str, value: &str) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO server_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_all_settings(pool: &DbPool) -> Result<Vec<(String, String)>, DbError> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM server_settings ORDER BY key")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}
