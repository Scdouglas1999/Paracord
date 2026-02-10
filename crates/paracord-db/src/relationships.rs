use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RelationshipRow {
    pub user_id: i64,
    pub target_id: i64,
    pub rel_type: i16,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RelationshipWithUserRow {
    pub user_id: i64,
    pub target_id: i64,
    pub rel_type: i16,
    pub created_at: DateTime<Utc>,
    pub target_username: String,
    pub target_discriminator: i16,
    pub target_avatar_hash: Option<String>,
}

pub async fn create_relationship(
    pool: &DbPool,
    user_id: i64,
    target_id: i64,
    rel_type: i16,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO relationships (user_id, target_id, rel_type) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id, target_id) DO UPDATE SET rel_type = ?3"
    )
    .bind(user_id)
    .bind(target_id)
    .bind(rel_type)
    .execute(pool)
    .await?;
    Ok(())
}

/// Get a single relationship row (directional).
pub async fn get_relationship(
    pool: &DbPool,
    user_id: i64,
    target_id: i64,
) -> Result<Option<RelationshipRow>, DbError> {
    let row = sqlx::query_as::<_, RelationshipRow>(
        "SELECT user_id, target_id, rel_type, created_at
         FROM relationships
         WHERE user_id = ?1 AND target_id = ?2",
    )
    .bind(user_id)
    .bind(target_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Returns all relationships for a user, including incoming pending requests.
///
/// Outgoing rows are returned with their stored rel_type.
/// Incoming pending requests (where someone else sent type=4 TO this user)
/// are returned with rel_type=3 (pending_incoming).
pub async fn get_relationships(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<RelationshipWithUserRow>, DbError> {
    let rows = sqlx::query_as::<_, RelationshipWithUserRow>(
        "SELECT r.user_id, r.target_id, r.rel_type, r.created_at,
                u.username AS target_username, u.discriminator AS target_discriminator, u.avatar_hash AS target_avatar_hash
         FROM relationships r
         INNER JOIN users u ON u.id = r.target_id
         WHERE r.user_id = ?1
         UNION ALL
         SELECT r.target_id AS user_id, r.user_id AS target_id, 3 AS rel_type, r.created_at,
                u.username AS target_username, u.discriminator AS target_discriminator, u.avatar_hash AS target_avatar_hash
         FROM relationships r
         INNER JOIN users u ON u.id = r.user_id
         WHERE r.target_id = ?1 AND r.rel_type = 4
         ORDER BY 4"
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_relationship(
    pool: &DbPool,
    user_id: i64,
    target_id: i64,
    rel_type: i16,
) -> Result<(), DbError> {
    sqlx::query("UPDATE relationships SET rel_type = ?3 WHERE user_id = ?1 AND target_id = ?2")
        .bind(user_id)
        .bind(target_id)
        .bind(rel_type)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_relationship(
    pool: &DbPool,
    user_id: i64,
    target_id: i64,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM relationships WHERE user_id = ?1 AND target_id = ?2")
        .bind(user_id)
        .bind(target_id)
        .execute(pool)
        .await?;
    Ok(())
}
