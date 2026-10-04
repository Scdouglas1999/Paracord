use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use paracord_models::voice::VoiceMode;
use sqlx::Row;

/// Every column a [`VoiceStateRow`] reads, optionally qualified by a table
/// alias. Booleans go through `CASE` (the `Any` driver cannot decode SQLite's
/// bool type info); `request_to_speak_at` is a native timestamp on PostgreSQL
/// and is read as text; `mode`, `self_stream_started_at` and `joined_at` are
/// TEXT on both engines.
fn voice_state_columns(alias: &str) -> String {
    let a = if alias.is_empty() {
        String::new()
    } else {
        format!("{alias}.")
    };
    format!(
        "{a}user_id, {a}space_id, {a}channel_id, {a}session_id,
         CASE WHEN {a}self_mute THEN 1 ELSE 0 END AS self_mute,
         CASE WHEN {a}self_deaf THEN 1 ELSE 0 END AS self_deaf,
         CASE WHEN {a}self_stream THEN 1 ELSE 0 END AS self_stream,
         CASE WHEN {a}self_video THEN 1 ELSE 0 END AS self_video,
         CASE WHEN {a}suppress THEN 1 ELSE 0 END AS suppress,
         CAST({a}request_to_speak_at AS TEXT) AS request_to_speak_at,
         {a}mode AS mode,
         {a}self_stream_started_at AS self_stream_started_at,
         {a}joined_at AS joined_at"
    )
}

fn mode_from_row(row: &sqlx::any::AnyRow) -> Result<VoiceMode, sqlx::Error> {
    let raw: String = row.try_get("mode")?;
    VoiceMode::parse(&raw)
        .ok_or_else(|| sqlx::Error::Protocol(format!("invalid voice_states.mode '{raw}'")))
}

fn stream_started_at_from_row(
    row: &sqlx::any::AnyRow,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    row.try_get::<Option<String>, _>("self_stream_started_at")?
        .map(|value| datetime_from_db_text(&value))
        .transpose()
}

/// `joined_at` as stored. Every write stamps it and the Index migration
/// backfilled older rows, so a NULL is a corrupt row and fails the read.
fn joined_at_from_row(row: &sqlx::any::AnyRow) -> Result<DateTime<Utc>, sqlx::Error> {
    let raw: Option<String> = row.try_get("joined_at")?;
    let raw = raw.ok_or_else(|| sqlx::Error::Protocol("voice_states.joined_at is NULL".into()))?;
    datetime_from_db_text(&raw)
}

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
    pub request_to_speak_at: Option<DateTime<Utc>>,
    /// Full membership or listening in.
    pub mode: VoiceMode,
    /// When the current stream started; `Some` exactly while `self_stream`.
    pub self_stream_started_at: Option<DateTime<Utc>>,
    /// When the member entered this channel; a move to another channel
    /// resets it.
    pub joined_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for VoiceStateRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let request_to_speak_at = row
            .try_get::<Option<String>, _>("request_to_speak_at")?
            .map(|value| datetime_from_db_text(&value))
            .transpose()?;
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
            request_to_speak_at,
            mode: mode_from_row(row)?,
            self_stream_started_at: stream_started_at_from_row(row)?,
            joined_at: joined_at_from_row(row)?,
        })
    }
}

impl VoiceStateRow {
    /// Backward compat: return space_id as guild_id
    pub fn guild_id(&self) -> Option<i64> {
        self.space_id
    }
}

#[derive(Debug, Clone)]
pub struct VoiceSessionRow {
    pub channel_id: i64,
    pub session_id: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for VoiceSessionRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            channel_id: row.try_get("channel_id")?,
            session_id: row.try_get("session_id")?,
        })
    }
}

/// Record a membership through the legacy gateway paths (a join without a
/// receipt, `OP_MEDIA_CONNECT`). A new row, or a move to another channel, is a
/// full membership; a repeat in the same channel keeps the member's mode, so a
/// status update without a receipt never turns a listener into a publisher on
/// the roster. `joined_at` follows the same rule: stamped on a new row or a
/// move, kept on a repeat in the same channel.
pub async fn upsert_voice_state(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
    channel_id: i64,
    session_id: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO voice_states (user_id, space_id, channel_id, session_id, mode, joined_at)
         VALUES ($1, $2, $3, $4, 'joined', $5)
         ON CONFLICT (user_id) DO UPDATE SET
             space_id = $2,
             channel_id = $3,
             session_id = $4,
             joined_at = CASE
                 WHEN voice_states.channel_id = $3
                  AND COALESCE(voice_states.space_id, 0) = COALESCE($2, 0)
                 THEN voice_states.joined_at
                 ELSE $5
             END,
             request_to_speak_at = CASE
                 WHEN voice_states.channel_id = $3
                  AND COALESCE(voice_states.space_id, 0) = COALESCE($2, 0)
                 THEN voice_states.request_to_speak_at
                 ELSE NULL
             END,
             mode = CASE
                 WHEN voice_states.channel_id = $3
                  AND COALESCE(voice_states.space_id, 0) = COALESCE($2, 0)
                 THEN voice_states.mode
                 ELSE 'joined'
             END",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(channel_id)
    .bind(session_id)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

/// A membership write staged by [`begin_voice_state_transition`]: the open
/// transaction and the member's `joined_at` as it will be stored, so the
/// caller can announce it without reading the row back.
pub struct VoiceStateTransition<'a> {
    transaction: sqlx::Transaction<'a, sqlx::Any>,
    joined_at: DateTime<Utc>,
}

impl VoiceStateTransition<'_> {
    /// Commit the membership and return its `joined_at`: now for a new
    /// membership or a move, the earlier time for a repeat in the same channel.
    pub async fn commit(self) -> Result<DateTime<Utc>, sqlx::Error> {
        self.transaction.commit().await?;
        Ok(self.joined_at)
    }
}

/// Stage both membership and stage-suppression state. The caller publishes
/// the matching media membership only after this transaction succeeds.
///
/// A full membership (`mode = 'joined'`); see
/// [`begin_voice_state_transition_with_mode`] for listening in.
pub async fn begin_voice_state_transition<'a>(
    pool: &'a DbPool,
    user_id: i64,
    space_id: Option<i64>,
    channel_id: i64,
    session_id: &str,
    suppress: bool,
) -> Result<VoiceStateTransition<'a>, DbError> {
    begin_voice_state_transition_with_mode(
        pool,
        user_id,
        space_id,
        channel_id,
        session_id,
        suppress,
        VoiceMode::Joined,
    )
    .await
}

/// [`begin_voice_state_transition`] with an explicit [`VoiceMode`]. A listener
/// never sends, so entering `listen` also clears any stream or camera flag the
/// row carried from an earlier full membership.
///
/// `joined_at` is stamped on a new row or a move to another channel and kept on
/// a repeat in the same channel (a listener who joins fully, or a rejoin).
pub async fn begin_voice_state_transition_with_mode<'a>(
    pool: &'a DbPool,
    user_id: i64,
    space_id: Option<i64>,
    channel_id: i64,
    session_id: &str,
    suppress: bool,
    mode: VoiceMode,
) -> Result<VoiceStateTransition<'a>, DbError> {
    let mut transaction = pool.begin().await?;
    let joined_at_raw: String = sqlx::query_scalar(
        "INSERT INTO voice_states (user_id, space_id, channel_id, session_id, mode, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE SET
             space_id = $2,
             channel_id = $3,
             session_id = $4,
             mode = $5,
             joined_at = CASE
                 WHEN voice_states.channel_id = $3
                  AND COALESCE(voice_states.space_id, 0) = COALESCE($2, 0)
                 THEN voice_states.joined_at
                 ELSE $6
             END,
             request_to_speak_at = CASE
                 WHEN voice_states.channel_id = $3
                  AND COALESCE(voice_states.space_id, 0) = COALESCE($2, 0)
                 THEN voice_states.request_to_speak_at
                 ELSE NULL
             END
         RETURNING joined_at",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(channel_id)
    .bind(session_id)
    .bind(mode.as_str())
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(&mut *transaction)
    .await?;
    let joined_at = datetime_from_db_text(&joined_at_raw)?;
    sqlx::query("UPDATE voice_states SET suppress = $1 WHERE user_id = $2 AND session_id = $3")
        .bind(suppress)
        .bind(user_id)
        .bind(session_id)
        .execute(&mut *transaction)
        .await?;
    if mode.is_listen() {
        sqlx::query(
            "UPDATE voice_states
             SET self_stream = FALSE, self_video = FALSE, self_stream_started_at = NULL
             WHERE user_id = $1 AND session_id = $2",
        )
        .bind(user_id)
        .bind(session_id)
        .execute(&mut *transaction)
        .await?;
    }
    Ok(VoiceStateTransition {
        transaction,
        joined_at,
    })
}

pub async fn get_channel_voice_states(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<VoiceStateRow>, DbError> {
    let sql = format!(
        "SELECT {} FROM voice_states WHERE channel_id = $1",
        voice_state_columns("")
    );
    let rows = sqlx::query_as::<_, VoiceStateRow>(&sql)
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
    let sql = format!(
        "SELECT {} FROM voice_states
         WHERE user_id = $1 AND COALESCE(space_id, 0) = COALESCE($2, 0)",
        voice_state_columns("")
    );
    let row = sqlx::query_as::<_, VoiceStateRow>(&sql)
        .bind(user_id)
        .bind(space_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn get_user_voice_session(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
) -> Result<Option<VoiceSessionRow>, DbError> {
    let row = sqlx::query_as::<_, VoiceSessionRow>(
        "SELECT channel_id, session_id
         FROM voice_states WHERE user_id = $1 AND COALESCE(space_id, 0) = COALESCE($2, 0)",
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
    let sql = format!(
        "SELECT {} FROM voice_states WHERE user_id = $1",
        voice_state_columns("")
    );
    let rows = sqlx::query_as::<_, VoiceStateRow>(&sql)
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

/// Remove a voice state only if it still matches the expected session.
/// Returns true when a row was removed.
pub async fn remove_voice_state_if_session(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
    session_id: &str,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "DELETE FROM voice_states
         WHERE user_id = $1
           AND COALESCE(space_id, 0) = COALESCE($2, 0)
           AND session_id = $3",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
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
    pub request_to_speak_at: Option<DateTime<Utc>>,
    pub mode: VoiceMode,
    pub self_stream_started_at: Option<DateTime<Utc>>,
    pub joined_at: DateTime<Utc>,
    pub username: String,
    pub avatar_hash: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for VoiceStateWithUser {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let request_to_speak_at = row
            .try_get::<Option<String>, _>("request_to_speak_at")?
            .map(|value| datetime_from_db_text(&value))
            .transpose()?;
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
            request_to_speak_at,
            mode: mode_from_row(row)?,
            self_stream_started_at: stream_started_at_from_row(row)?,
            joined_at: joined_at_from_row(row)?,
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
    let sql = format!(
        "SELECT {}, u.username, u.avatar_hash
         FROM voice_states vs
         JOIN users u ON u.id = vs.user_id
         WHERE vs.space_id = $1",
        voice_state_columns("vs")
    );
    let rows = sqlx::query_as::<_, VoiceStateWithUser>(&sql)
        .bind(space_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// The voice states of every DM or group DM call `user_id` is a recipient of
/// (the people in those calls, the caller included), for READY. A DM call has
/// no space (`space_id` NULL; `0` on some older rows).
pub async fn get_dm_call_voice_states_for_recipient(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<VoiceStateWithUser>, DbError> {
    let sql = format!(
        "SELECT {}, u.username, u.avatar_hash
         FROM voice_states vs
         JOIN users u ON u.id = vs.user_id
         JOIN dm_recipients r ON r.channel_id = vs.channel_id AND r.user_id = $1
         WHERE COALESCE(vs.space_id, 0) = 0",
        voice_state_columns("vs")
    );
    let rows = sqlx::query_as::<_, VoiceStateWithUser>(&sql)
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Record a member's flags and return the row as stored.
///
/// `self_stream_started_at` follows `self_stream`: it is stamped with the
/// current time when a stream starts (the stored flag was false), kept while
/// the stream continues (a mute or camera change while sharing), and cleared
/// when the stream stops. `None` when the member has no voice state here.
pub async fn update_voice_state(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
    self_mute: bool,
    self_deaf: bool,
    self_stream: bool,
    self_video: bool,
) -> Result<Option<VoiceStateRow>, DbError> {
    let sql = format!(
        "UPDATE voice_states
         SET self_mute = $3, self_deaf = $4, self_stream = $5, self_video = $6,
             self_stream_started_at = CASE
                 WHEN $5 THEN CASE
                     WHEN self_stream THEN COALESCE(self_stream_started_at, $7)
                     ELSE $7
                 END
                 ELSE NULL
             END
         WHERE user_id = $1 AND COALESCE(space_id, 0) = COALESCE($2, 0)
         RETURNING {}",
        voice_state_columns("")
    );
    let row = sqlx::query_as::<_, VoiceStateRow>(&sql)
        .bind(user_id)
        .bind(space_id)
        .bind(self_mute)
        .bind(self_deaf)
        .bind(self_stream)
        .bind(self_video)
        .bind(datetime_to_db_text(Utc::now()))
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Switch a member between listening in and a full membership, in place.
///
/// Scoped to the call receipt: a request naming another channel or an older
/// session changes nothing and returns `None`. Entering `listen` clears the
/// stream and camera flags (a listener never sends).
pub async fn set_voice_mode(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
    channel_id: i64,
    session_id: &str,
    mode: VoiceMode,
) -> Result<Option<VoiceStateRow>, DbError> {
    let sql = format!(
        "UPDATE voice_states
         SET mode = $1,
             self_stream = CASE WHEN $6 THEN FALSE ELSE self_stream END,
             self_video = CASE WHEN $6 THEN FALSE ELSE self_video END,
             self_stream_started_at = CASE WHEN $6 THEN NULL ELSE self_stream_started_at END
         WHERE user_id = $2
           AND COALESCE(space_id, 0) = COALESCE($3, 0)
           AND channel_id = $4
           AND session_id = $5
         RETURNING {}",
        voice_state_columns("")
    );
    let row = sqlx::query_as::<_, VoiceStateRow>(&sql)
        .bind(mode.as_str())
        .bind(user_id)
        .bind(space_id)
        .bind(channel_id)
        .bind(session_id)
        .bind(mode.is_listen())
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn update_suppress(
    pool: &DbPool,
    user_id: i64,
    space_id: Option<i64>,
    suppress: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE voice_states SET suppress = $3, request_to_speak_at = NULL
         WHERE user_id = $1 AND COALESCE(space_id, 0) = COALESCE($2, 0)",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(suppress)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark an audience member as requesting the stage. Returns false when the
/// user is not currently a suppressed participant in the requested channel.
pub async fn request_to_speak(
    pool: &DbPool,
    user_id: i64,
    space_id: i64,
    channel_id: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE voice_states
         SET request_to_speak_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND space_id = $2
           AND channel_id = $3
           AND suppress = TRUE",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(channel_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn clear_request_to_speak(
    pool: &DbPool,
    user_id: i64,
    space_id: i64,
    channel_id: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE voice_states
         SET request_to_speak_at = NULL
         WHERE user_id = $1 AND space_id = $2 AND channel_id = $3",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(channel_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
