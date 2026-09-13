use crate::{DbConnection, DbError, DbPool};

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

/// Reserved metadata, not an operator-editable setting. Revisions are comparable
/// only within this database history. Never rotate it on an ordinary restart.
pub const DATABASE_HISTORY_EPOCH_KEY: &str = "database_history_epoch";

fn validate_database_history_epoch(value: String) -> Result<String, DbError> {
    if uuid::Uuid::parse_str(&value).is_ok_and(|id| id.to_string() == value) {
        Ok(value)
    } else {
        Err(sqlx::Error::Protocol("invalid database history epoch".into()).into())
    }
}

/// Read and validate an existing history identity without changing database state.
pub async fn get_database_history_epoch(pool: &DbPool) -> Result<Option<String>, DbError> {
    get_setting(pool, DATABASE_HISTORY_EPOCH_KEY)
        .await?
        .map(validate_database_history_epoch)
        .transpose()
}

/// Initialize missing metadata once. Concurrent instances converge on the same
/// stored UUID; an invalid existing value is an error, never an implicit reset.
pub async fn get_or_create_database_history_epoch(pool: &DbPool) -> Result<String, DbError> {
    let candidate = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO server_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING",
    )
    .bind(DATABASE_HISTORY_EPOCH_KEY)
    .bind(candidate)
    .execute(pool)
    .await?;
    get_database_history_epoch(pool).await?.ok_or_else(|| {
        sqlx::Error::Protocol("database history epoch disappeared during initialization".into())
            .into()
    })
}

/// Mint a new history identity inside the caller's offline restore/import
/// transaction, after all source settings have been copied. The caller must
/// commit this together with the replaced data and derived-state repairs.
/// Clients must reject old-history responses before accepting lower revisions;
/// persisting this metadata alone does not perform client invalidation.
pub async fn rotate_database_history_epoch(conn: &mut DbConnection) -> Result<String, DbError> {
    let epoch = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO server_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(DATABASE_HISTORY_EPOCH_KEY)
    .bind(&epoch)
    .execute(conn)
    .await?;
    Ok(epoch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn database_history_epoch_survives_migrations_and_pool_reopen() {
        let path =
            std::env::temp_dir().join(format!("paracord-history-{}.db", uuid::Uuid::new_v4()));
        let url = format!("sqlite://{}?mode=rwc", path.display());
        let pool = crate::create_pool(&url, 2).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        let original = get_or_create_database_history_epoch(&pool).await.unwrap();
        assert_eq!(
            uuid::Uuid::parse_str(&original).unwrap().get_version_num(),
            4
        );
        crate::run_migrations(&pool).await.unwrap();
        assert_eq!(
            get_database_history_epoch(&pool).await.unwrap(),
            Some(original.clone())
        );
        pool.close().await;

        let pool = crate::create_pool(&url, 2).await.unwrap();
        assert_eq!(
            get_or_create_database_history_epoch(&pool).await.unwrap(),
            original
        );
        sqlx::query("DELETE FROM server_settings WHERE key = $1")
            .bind(DATABASE_HISTORY_EPOCH_KEY)
            .execute(&pool)
            .await
            .unwrap();
        let (first, second) = tokio::join!(
            get_or_create_database_history_epoch(&pool),
            get_or_create_database_history_epoch(&pool),
        );
        let replacement = first.unwrap();
        assert_eq!(replacement, second.unwrap());
        assert_ne!(replacement, original);
        pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn database_history_epoch_rotation_rolls_back_with_its_transaction() {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        let original = get_or_create_database_history_epoch(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let aborted = rotate_database_history_epoch(&mut tx).await.unwrap();
        assert_ne!(aborted, original);
        tx.rollback().await.unwrap();
        assert_eq!(
            get_database_history_epoch(&pool).await.unwrap(),
            Some(original)
        );
        let mut tx = pool.begin().await.unwrap();
        let committed = rotate_database_history_epoch(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            get_database_history_epoch(&pool).await.unwrap(),
            Some(committed)
        );
    }

    #[tokio::test]
    async fn invalid_database_history_epoch_is_not_silently_replaced() {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        set_setting(&pool, DATABASE_HISTORY_EPOCH_KEY, "broken")
            .await
            .unwrap();
        assert!(get_or_create_database_history_epoch(&pool).await.is_err());
        assert_eq!(
            get_setting(&pool, DATABASE_HISTORY_EPOCH_KEY)
                .await
                .unwrap()
                .as_deref(),
            Some("broken")
        );
    }
}
