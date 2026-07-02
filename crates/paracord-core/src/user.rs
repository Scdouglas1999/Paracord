use crate::error::CoreError;
use paracord_db::DbPool;

/// Update user profile fields.
pub async fn update_profile(
    pool: &DbPool,
    user_id: i64,
    display_name: Option<&str>,
    bio: Option<&str>,
    avatar_hash: Option<&str>,
) -> Result<paracord_db::users::UserRow, CoreError> {
    let updated =
        paracord_db::users::update_user(pool, user_id, display_name, bio, avatar_hash).await?;
    Ok(updated)
}
