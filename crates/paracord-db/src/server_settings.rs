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

/// Read a boolean setting, falling back to `default` when the key is unset,
/// unreadable, or not parseable as `"true"`/`"false"`.
pub async fn get_bool_setting(pool: &DbPool, key: &str, default: bool) -> bool {
    match get_setting(pool, key).await {
        Ok(Some(value)) => match value.trim() {
            "true" => true,
            "false" => false,
            _ => default,
        },
        _ => default,
    }
}

/// Read an unsigned integer setting, falling back to `default` when the key is
/// unset, unreadable, or not parseable as a `u64`.
pub async fn get_u64_setting(pool: &DbPool, key: &str, default: u64) -> u64 {
    match get_setting(pool, key).await {
        Ok(Some(value)) => value.trim().parse().unwrap_or(default),
        _ => default,
    }
}

pub async fn get_all_settings(pool: &DbPool) -> Result<Vec<(String, String)>, DbError> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM server_settings ORDER BY key")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}
