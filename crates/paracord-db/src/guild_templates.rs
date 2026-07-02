use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct GuildTemplateRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub creator_id: i64,
    pub source_guild_id: Option<i64>,
    pub template_data: String,
    pub usage_count: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GuildTemplateRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            creator_id: row.try_get("creator_id")?,
            source_guild_id: row.try_get("source_guild_id")?,
            template_data: row.try_get("template_data")?,
            usage_count: row.try_get("usage_count")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

pub async fn create_template(
    pool: &DbPool,
    id: i64,
    name: &str,
    description: &str,
    creator_id: i64,
    source_guild_id: Option<i64>,
    template_data: &str,
) -> Result<GuildTemplateRow, DbError> {
    let row = sqlx::query_as::<_, GuildTemplateRow>(
        "INSERT INTO guild_templates (id, name, description, creator_id, source_guild_id, template_data)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, description, creator_id, source_guild_id, template_data, usage_count,
                   CAST(created_at AS TEXT) AS created_at,
                   CAST(updated_at AS TEXT) AS updated_at",
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(creator_id)
    .bind(source_guild_id)
    .bind(template_data)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_by_id(pool: &DbPool, id: i64) -> Result<Option<GuildTemplateRow>, DbError> {
    let row = sqlx::query_as::<_, GuildTemplateRow>(
        "SELECT id, name, description, creator_id, source_guild_id, template_data, usage_count,
                CAST(created_at AS TEXT) AS created_at,
                CAST(updated_at AS TEXT) AS updated_at
         FROM guild_templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn list_all(pool: &DbPool) -> Result<Vec<GuildTemplateRow>, DbError> {
    let rows = sqlx::query_as::<_, GuildTemplateRow>(
        "SELECT id, name, description, creator_id, source_guild_id, template_data, usage_count,
                CAST(created_at AS TEXT) AS created_at,
                CAST(updated_at AS TEXT) AS updated_at
         FROM guild_templates ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_template(pool: &DbPool, id: i64) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM guild_templates WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn increment_usage(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE guild_templates SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn create_test_user(pool: &DbPool, id: i64) {
        crate::users::create_user(
            pool,
            id,
            &format!("user{}", id),
            1,
            &format!("user{}@example.com", id),
            "hash",
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn test_create_and_get_template() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        let tmpl = create_template(
            &pool,
            100,
            "Gaming Server",
            "A template for gaming communities",
            1,
            None,
            r#"{"channels":[],"roles":[]}"#,
        )
        .await
        .unwrap();
        assert_eq!(tmpl.id, 100);
        assert_eq!(tmpl.name, "Gaming Server");
        assert_eq!(tmpl.usage_count, 0);

        let fetched = get_by_id(&pool, 100).await.unwrap().unwrap();
        assert_eq!(fetched.name, "Gaming Server");
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let pool = test_pool().await;
        let tmpl = get_by_id(&pool, 9999).await.unwrap();
        assert!(tmpl.is_none());
    }

    #[tokio::test]
    async fn test_list_all() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_template(
            &pool,
            200,
            "T1",
            "",
            1,
            None,
            r#"{"channels":[],"roles":[]}"#,
        )
        .await
        .unwrap();
        create_template(
            &pool,
            201,
            "T2",
            "",
            1,
            None,
            r#"{"channels":[],"roles":[]}"#,
        )
        .await
        .unwrap();
        let all = list_all(&pool).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn test_delete_template() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_template(
            &pool,
            300,
            "Gone",
            "",
            1,
            None,
            r#"{"channels":[],"roles":[]}"#,
        )
        .await
        .unwrap();
        let deleted = delete_template(&pool, 300).await.unwrap();
        assert!(deleted);
        let fetched = get_by_id(&pool, 300).await.unwrap();
        assert!(fetched.is_none());
    }

    #[tokio::test]
    async fn test_delete_nonexistent() {
        let pool = test_pool().await;
        let deleted = delete_template(&pool, 9999).await.unwrap();
        assert!(!deleted);
    }

    #[tokio::test]
    async fn test_increment_usage() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_template(
            &pool,
            400,
            "Popular",
            "",
            1,
            None,
            r#"{"channels":[],"roles":[]}"#,
        )
        .await
        .unwrap();
        increment_usage(&pool, 400).await.unwrap();
        increment_usage(&pool, 400).await.unwrap();
        let tmpl = get_by_id(&pool, 400).await.unwrap().unwrap();
        assert_eq!(tmpl.usage_count, 2);
    }
}
