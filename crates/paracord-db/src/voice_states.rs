use crate::{bool_from_any_row, DbError, DbPool};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct VoiceStateRow {
    pub user_id: i64,
    pub space_id: Option<i64>,
    pub channel_id: i64,
    pub session_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub self_stream: bool,
    pub self_video: bool,
    pub suppress: bool,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for VoiceStateRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            user_id: row.try_get("user_id")?,
            space_id: row.try_get("space_id")?,
            channel_id: row.try_get("channel_id")?,
            session_id: row.try_get("session_id")?,
            self_mute: bool_from_any_row(row, "self_mute")?,
            self_deaf: bool_from_any_row(row, "self_deaf")?,
            self_stream: bool_from_any_row(row, "self_stream")?,
            self_video: bool_from_any_row(row, "self_video")?,
            suppress: bool_from_any_row(row, "suppress")?,
        })
    }
}

impl VoiceStateRow {
    /// Backward compat: return space_id as guild_id
    pub fn guild_id(&self) -> Option<i64> {
        self.space_id
    }
}

pub async fn upsert_voice_state(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
    channel_id: i64,
    session_id: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO voice_states (user_id, space_id, channel_id, session_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET space_id = $2, channel_id = $3, session_id = $4",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(channel_id)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_channel_voice_states(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<VoiceStateRow>, DbError> {
    let rows = sqlx::query_as::<_, VoiceStateRow>(
        "SELECT user_id, space_id, channel_id, session_id, self_mute, self_deaf, self_stream, self_video, suppress
         FROM voice_states WHERE channel_id = $1"
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_user_voice_state(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
) -> Result<Option<VoiceStateRow>, DbError> {
    let row = sqlx::query_as::<_, VoiceStateRow>(
        "SELECT user_id, space_id, channel_id, session_id, self_mute, self_deaf, self_stream, self_video, suppress
         FROM voice_states WHERE user_id = $1 AND COALESCE(space_id, 0) = COALESCE($2, 0)"
    )
    .bind(user_id)
    .bind(space_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_all_user_voice_states(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<VoiceStateRow>, DbError> {
    let rows = sqlx::query_as::<_, VoiceStateRow>(
        "SELECT user_id, space_id, channel_id, session_id, self_mute, self_deaf, self_stream, self_video, suppress
         FROM voice_states WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn remove_voice_state(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM voice_states WHERE user_id = $1 AND COALESCE(space_id, 0) = COALESCE($2, 0)",
    )
    .bind(user_id)
    .bind(space_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove all voice state entries. Used on server startup to clear stale
/// rows that survived from a previous process (no one is actually in a
/// LiveKit room after a fresh server start).
pub async fn clear_all_voice_states(pool: &DbPool) -> Result<u64, DbError> {
    let result = sqlx::query("DELETE FROM voice_states")
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

#[derive(Debug, Clone)]
pub struct VoiceStateWithUser {
    pub user_id: i64,
    pub space_id: Option<i64>,
    pub channel_id: i64,
    pub session_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub self_stream: bool,
    pub self_video: bool,
    pub suppress: bool,
    pub username: String,
    pub avatar_hash: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for VoiceStateWithUser {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            user_id: row.try_get("user_id")?,
            space_id: row.try_get("space_id")?,
            channel_id: row.try_get("channel_id")?,
            session_id: row.try_get("session_id")?,
            self_mute: bool_from_any_row(row, "self_mute")?,
            self_deaf: bool_from_any_row(row, "self_deaf")?,
            self_stream: bool_from_any_row(row, "self_stream")?,
            self_video: bool_from_any_row(row, "self_video")?,
            suppress: bool_from_any_row(row, "suppress")?,
            username: row.try_get("username")?,
            avatar_hash: row.try_get("avatar_hash")?,
        })
    }
}

impl VoiceStateWithUser {
    /// Backward compat
    pub fn guild_id(&self) -> Option<i64> {
        self.space_id
    }
}

/// Get voice states for a space. Kept as get_guild_voice_states for API compat.
pub async fn get_guild_voice_states(
    pool: &DbPool,
    space_id: i64,
) -> Result<Vec<VoiceStateWithUser>, DbError> {
    get_space_voice_states(pool, space_id).await
}

pub async fn get_space_voice_states(
    pool: &DbPool,
    space_id: i64,
) -> Result<Vec<VoiceStateWithUser>, DbError> {
    let rows = sqlx::query_as::<_, VoiceStateWithUser>(
        "SELECT vs.user_id, vs.space_id, vs.channel_id, vs.session_id, vs.self_mute, vs.self_deaf, vs.self_stream, vs.self_video, vs.suppress, u.username, u.avatar_hash
         FROM voice_states vs
         JOIN users u ON u.id = vs.user_id
         WHERE vs.space_id = $1"
    )
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_voice_state(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
    self_mute: bool,
    self_deaf: bool,
    self_stream: bool,
    self_video: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE voice_states SET self_mute = $3, self_deaf = $4, self_stream = $5, self_video = $6
         WHERE user_id = $1 AND COALESCE(space_id, 0) = COALESCE($2, 0)",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(self_mute)
    .bind(self_deaf)
    .bind(self_stream)
    .bind(self_video)
    .execute(pool)
    .await?;
    Ok(())
}
