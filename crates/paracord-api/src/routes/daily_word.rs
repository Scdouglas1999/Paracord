//! Daily word add-on: a five-letter word, six guesses, one word per UTC day for
//! the whole instance.
//!
//! The answer never leaves the server before the person asking has finished:
//! guesses are scored here and only the per-letter states go back. One result
//! per person per day, whichever server they play from; each server's board
//! lists its own members.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, SecondsFormat, Utc};
use paracord_core::daily_word::{self, DayResult, GuessError, LetterState, Stats};
use paracord_core::AppState;
use paracord_db::daily_word::{BoardRow, DailyWordResultRow, DailyWordSettingsRow};
use paracord_models::permissions::Permissions;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::num::NonZeroU32;
use std::sync::OnceLock;

use super::audit;
use crate::error::ApiError;
use crate::middleware::AuthUser;

const TEXT_CHANNEL: i16 = 0;
/// Guesses a person may send per minute, valid or not.
const GUESSES_PER_MINUTE: u32 = 20;
/// At most this many solvers are listed by name; the counts cover the rest.
const MAX_SOLVERS_LISTED: usize = 24;

const ADDON_OFF: &str = "The daily word is not turned on for this server.";
const NOT_ON_ANYWHERE: &str = "The daily word is not turned on in any of your servers.";
const NOT_A_WORD: &str = "Not in the word list";
const WORD_SHAPE: &str = "A guess is five letters, A to Z.";
const ALREADY_FINISHED: &str =
    "You have already finished today's word. A new one comes at midnight UTC.";
const GUESS_RACE: &str = "Another guess was saved first. Reload the board and try again.";
const SHARE_NOT_TEXT: &str = "Results can only be shared in a text channel on this server.";
const SETTINGS_SHAPE: &str = "Daily word settings must be a JSON object.";

#[derive(Serialize)]
pub struct SettingsResponse {
    guild_id: String,
    enabled: bool,
    share_channel_id: Option<String>,
    show_on_front_page: bool,
    updated_at: String,
}

impl SettingsResponse {
    fn from_row(guild_id: i64, row: Option<&DailyWordSettingsRow>) -> Self {
        match row {
            Some(row) => Self {
                guild_id: guild_id.to_string(),
                enabled: row.enabled,
                share_channel_id: row.share_channel_id.map(|id| id.to_string()),
                show_on_front_page: row.show_on_front_page,
                updated_at: format_rfc3339(row.updated_at),
            },
            None => Self {
                guild_id: guild_id.to_string(),
                enabled: false,
                share_channel_id: None,
                show_on_front_page: true,
                updated_at: format_rfc3339(DateTime::<Utc>::UNIX_EPOCH),
            },
        }
    }
}

#[derive(Serialize)]
pub struct GuessView {
    word: String,
    states: [LetterState; daily_word::WORD_LEN],
}

#[derive(Serialize)]
pub struct TodayResponse {
    puzzle: i64,
    /// The UTC day, YYYY-MM-DD.
    date: String,
    next_puzzle_at: String,
    word_length: usize,
    max_guesses: usize,
    guesses: Vec<GuessView>,
    finished: bool,
    solved: bool,
    /// Only once finished.
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
    /// Only once finished, and only when the word list has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    definition: Option<daily_word::Definition>,
}

#[derive(Serialize)]
pub struct StatsResponse {
    puzzle: i64,
    #[serde(flatten)]
    stats: Stats,
}

#[derive(Serialize)]
pub struct BoardUser {
    id: String,
    username: String,
    display_name: Option<String>,
    avatar_hash: Option<String>,
    nick: Option<String>,
}

#[derive(Serialize)]
pub struct BoardEntry {
    user: BoardUser,
    finished: bool,
    solved: bool,
    guess_count: i64,
    /// Letter states only, never letters. Empty while that person is still playing.
    grid: Vec<[LetterState; daily_word::WORD_LEN]>,
}

#[derive(Serialize)]
pub struct BoardResponse {
    guild_id: String,
    puzzle: i64,
    /// Members who have made at least one guess today.
    played: usize,
    finished: usize,
    solved: usize,
    /// Who solved it (not how), for the front page. The first 24.
    solvers: Vec<BoardUser>,
    /// Whether `entries` is filled in: only once you have finished.
    visible: bool,
    entries: Vec<BoardEntry>,
}

pub async fn get_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<SettingsResponse>, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let row = paracord_db::daily_word::get_settings(&state.db, guild_id).await?;
    Ok(Json(SettingsResponse::from_row(guild_id, row.as_ref())))
}

pub async fn put_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let object = match body.as_object() {
        Some(object) => object,
        None => return Ok(bad_request(SETTINGS_SHAPE)),
    };
    let current = paracord_db::daily_word::get_settings(&state.db, guild_id).await?;
    let mut enabled = current.as_ref().is_some_and(|row| row.enabled);
    let mut share_channel_id = current.as_ref().and_then(|row| row.share_channel_id);
    let mut show_on_front_page = current.as_ref().is_none_or(|row| row.show_on_front_page);

    match optional_bool(object, "enabled") {
        Ok(Some(value)) => enabled = value,
        Ok(None) => {}
        Err(message) => return Ok(bad_request(&message)),
    }
    match optional_bool(object, "show_on_front_page") {
        Ok(Some(value)) => show_on_front_page = value,
        Ok(None) => {}
        Err(message) => return Ok(bad_request(&message)),
    }
    if let Some(raw) = object.get("share_channel_id") {
        share_channel_id = match raw {
            Value::Null => None,
            Value::String(text) => match text.parse::<i64>() {
                Ok(id) => Some(id),
                Err(_) => {
                    return Ok(bad_request(
                        "share_channel_id must be a channel id or null.",
                    ))
                }
            },
            _ => {
                return Ok(bad_request(
                    "share_channel_id must be a channel id or null.",
                ))
            }
        };
    }
    if let Some(channel_id) = share_channel_id {
        let channel = paracord_db::channels::get_channel(&state.db, channel_id).await?;
        let usable = channel.is_some_and(|channel| {
            channel.space_id == Some(guild_id) && channel.channel_type == TEXT_CHANNEL
        });
        if !usable {
            return Ok(bad_request(SHARE_NOT_TEXT));
        }
    }

    let saved = paracord_db::daily_word::upsert_settings(
        &state.db,
        guild_id,
        enabled,
        share_channel_id,
        show_on_front_page,
    )
    .await?;

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "daily_word": {
                "enabled": saved.enabled,
                "share_channel_id": saved.share_channel_id.map(|id| id.to_string()),
                "show_on_front_page": saved.show_on_front_page,
            }
        })),
    )
    .await;

    Ok(Json(SettingsResponse::from_row(guild_id, Some(&saved))).into_response())
}

pub async fn get_today(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Response, ApiError> {
    if !paracord_db::daily_word::enabled_for_user(&state.db, auth.user_id).await? {
        return Ok(not_found(NOT_ON_ANYWHERE));
    }
    let now = daily_word::now();
    let puzzle = daily_word::puzzle_at(now);
    let answer = answer_for(&state, puzzle).await?;
    let row = paracord_db::daily_word::get_result(&state.db, auth.user_id, puzzle).await?;
    Ok(Json(today_view(now, puzzle, &answer, row.as_ref())?).into_response())
}

pub async fn post_guess(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    check_guess_rate(auth.user_id)?;
    if !paracord_db::daily_word::enabled_for_user(&state.db, auth.user_id).await? {
        return Ok(not_found(NOT_ON_ANYWHERE));
    }
    let raw = match body.get("word").and_then(Value::as_str) {
        Some(raw) => raw,
        None => return Ok(bad_request(WORD_SHAPE)),
    };
    let word = match daily_word::normalize_guess(raw) {
        Ok(word) => word,
        Err(GuessError::Shape) => return Ok(bad_request(WORD_SHAPE)),
        Err(GuessError::NotAWord) => {
            return Ok(error_response(
                StatusCode::BAD_REQUEST,
                "NOT_IN_WORD_LIST",
                NOT_A_WORD,
            ))
        }
    };

    let now = daily_word::now();
    let puzzle = daily_word::puzzle_at(now);
    let answer = answer_for(&state, puzzle).await?;
    let row = paracord_db::daily_word::get_result(&state.db, auth.user_id, puzzle).await?;
    if row.as_ref().is_some_and(|row| row.finished) {
        return Ok(error_response(
            StatusCode::CONFLICT,
            "CONFLICT",
            ALREADY_FINISHED,
        ));
    }
    let mut guesses = match row.as_ref() {
        Some(row) => stored_guesses(row)?,
        None => Vec::new(),
    };
    let expected = row.as_ref().map_or(0, |row| row.guess_count);
    guesses.push(word.clone());
    let solved = word == answer;
    let finished = solved || guesses.len() >= daily_word::MAX_GUESSES;
    let guesses_json =
        serde_json::to_string(&guesses).map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    let saved = paracord_db::daily_word::record_guess(
        &state.db,
        auth.user_id,
        puzzle,
        expected,
        &guesses_json,
        guesses.len() as i64,
        finished,
        solved,
    )
    .await?;
    if !saved {
        return Ok(error_response(StatusCode::CONFLICT, "CONFLICT", GUESS_RACE));
    }
    let row = paracord_db::daily_word::get_result(&state.db, auth.user_id, puzzle).await?;
    Ok(Json(today_view(now, puzzle, &answer, row.as_ref())?).into_response())
}

pub async fn get_stats(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Response, ApiError> {
    if !paracord_db::daily_word::enabled_for_user(&state.db, auth.user_id).await? {
        return Ok(not_found(NOT_ON_ANYWHERE));
    }
    let puzzle = daily_word::puzzle_at(daily_word::now());
    let rows = paracord_db::daily_word::list_results_for_user(&state.db, auth.user_id).await?;
    let days: Vec<DayResult> = rows
        .iter()
        .map(|row| DayResult {
            puzzle: row.puzzle,
            guess_count: row.guess_count,
            finished: row.finished,
            solved: row.solved,
        })
        .collect();
    Ok(Json(StatsResponse {
        puzzle,
        stats: daily_word::stats(&days, puzzle),
    })
    .into_response())
}

pub async fn get_board(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Response, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let settings = paracord_db::daily_word::get_settings(&state.db, guild_id).await?;
    if !settings.as_ref().is_some_and(|row| row.enabled) {
        return Ok(not_found(ADDON_OFF));
    }
    let puzzle = daily_word::puzzle_at(daily_word::now());
    let rows = paracord_db::daily_word::board(&state.db, guild_id, puzzle).await?;
    let viewer_finished = paracord_db::daily_word::get_result(&state.db, auth.user_id, puzzle)
        .await?
        .is_some_and(|row| row.finished);

    let answer = if viewer_finished {
        Some(answer_for(&state, puzzle).await?)
    } else {
        None
    };
    let finished = rows.iter().filter(|row| row.result.finished).count();
    let solved = rows.iter().filter(|row| row.result.solved).count();
    let solvers = rows
        .iter()
        .filter(|row| row.result.solved)
        .take(MAX_SOLVERS_LISTED)
        .map(board_user)
        .collect();
    let entries = match answer.as_deref() {
        Some(answer) => rows
            .iter()
            .map(|row| board_entry(row, answer))
            .collect::<Result<Vec<_>, ApiError>>()?,
        None => Vec::new(),
    };
    Ok(Json(BoardResponse {
        guild_id: guild_id.to_string(),
        puzzle,
        played: rows.len(),
        finished,
        solved,
        solvers,
        visible: viewer_finished,
        entries,
    })
    .into_response())
}

fn board_user(row: &BoardRow) -> BoardUser {
    BoardUser {
        id: row.result.user_id.to_string(),
        username: row.username.clone(),
        display_name: row.display_name.clone(),
        avatar_hash: row.avatar_hash.clone(),
        nick: row.nick.clone(),
    }
}

fn board_entry(row: &BoardRow, answer: &str) -> Result<BoardEntry, ApiError> {
    let grid = if row.result.finished {
        stored_guesses(&row.result)?
            .iter()
            .map(|word| daily_word::score(word, answer))
            .collect()
    } else {
        Vec::new()
    };
    Ok(BoardEntry {
        user: board_user(row),
        finished: row.result.finished,
        solved: row.result.solved,
        guess_count: row.result.guess_count,
        grid,
    })
}

fn today_view(
    now: DateTime<Utc>,
    puzzle: i64,
    answer: &str,
    row: Option<&DailyWordResultRow>,
) -> Result<TodayResponse, ApiError> {
    let guesses = match row {
        Some(row) => stored_guesses(row)?,
        None => Vec::new(),
    };
    let finished = row.is_some_and(|row| row.finished);
    let solved = row.is_some_and(|row| row.solved);
    Ok(TodayResponse {
        puzzle,
        date: daily_word::date_for(puzzle).format("%Y-%m-%d").to_string(),
        next_puzzle_at: format_rfc3339(daily_word::next_puzzle_at(now)),
        word_length: daily_word::WORD_LEN,
        max_guesses: daily_word::MAX_GUESSES,
        guesses: guesses
            .into_iter()
            .map(|word| GuessView {
                states: daily_word::score(&word, answer),
                word,
            })
            .collect(),
        finished,
        solved,
        answer: finished.then(|| answer.to_string()),
        definition: if finished {
            daily_word::definition(answer)
        } else {
            None
        },
    })
}

fn stored_guesses(row: &DailyWordResultRow) -> Result<Vec<String>, ApiError> {
    let words: Vec<String> = serde_json::from_str(&row.guesses).map_err(|err| {
        ApiError::Internal(anyhow::anyhow!("invalid stored daily word guesses: {err}"))
    })?;
    if words.iter().any(|word| {
        word.len() != daily_word::WORD_LEN || !word.bytes().all(|b| b.is_ascii_lowercase())
    }) {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "invalid stored daily word guess for user {} on puzzle {}",
            row.user_id,
            row.puzzle
        )));
    }
    Ok(words)
}

/// The day's answer: the stored one, or the keyed order's pick, stored now.
async fn answer_for(state: &AppState, puzzle: i64) -> Result<String, ApiError> {
    if let Some(answer) = paracord_db::daily_word::get_answer(&state.db, puzzle).await? {
        return Ok(answer);
    }
    let key = daily_word::order_key(&state.config.jwt_secret);
    let pick = daily_word::answer_for(&key, puzzle);
    Ok(paracord_db::daily_word::store_answer(&state.db, puzzle, pick).await?)
}

fn check_guess_rate(user_id: i64) -> Result<(), ApiError> {
    static LIMITER: OnceLock<governor::DefaultKeyedRateLimiter<i64>> = OnceLock::new();
    let limiter = LIMITER.get_or_init(|| {
        governor::RateLimiter::keyed(governor::Quota::per_minute(
            NonZeroU32::new(GUESSES_PER_MINUTE).expect("non-zero guess quota"),
        ))
    });
    if limiter.len() > 10_000 {
        limiter.retain_recent();
    }
    limiter.check_key(&user_id).map_err(|not_until| {
        use governor::clock::{Clock, DefaultClock};
        let wait = not_until.wait_time_from(DefaultClock::default().now());
        ApiError::RateLimited(wait.as_secs().max(1) as i64)
    })
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("{key} must be true or false.")),
    }
}

async fn ensure_member(state: &AppState, guild_id: i64, user_id: i64) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    Ok(())
}

async fn ensure_manage_guild(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    ensure_member(state, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_guild_permissions(
        &state.db,
        guild_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;
    Ok(())
}

fn format_rfc3339(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "code": code,
            "message": message,
            "error": message,
            "details": Value::Null,
        })),
    )
        .into_response()
}

fn bad_request(message: &str) -> Response {
    error_response(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
}

fn not_found(message: &str) -> Response {
    error_response(StatusCode::NOT_FOUND, "NOT_FOUND", message)
}
