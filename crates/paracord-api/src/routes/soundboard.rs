//! Soundboard: short sounds anyone in a voice channel can play for everyone
//! in it.
//!
//! Asset lifecycle mirrors `stickers.rs` (storage backend keyed by
//! `sounds/{guild}/{id}.{ext}`, `MANAGE_EMOJIS` to manage, guild-scoped
//! `GUILD_SOUNDS_UPDATE` on every change). Playback is the new piece:
//! `POST /channels/{id}/soundboard/play` requires the caller to be connected to
//! that voice channel, hold `USE_SOUNDBOARD`, and stay inside the cooldown
//! (one play per person per 2 s, at most 5 plays per 10 s per channel). The
//! `SOUNDBOARD_PLAY` event is targeted at the channel's current voice
//! participants only — never guild-wide — and each client plays the sound
//! locally through its own output device at `sound.volume x personal volume`.
//! Deafened listeners gate playback client-side; they still receive the event
//! so the tile ripple shows who played what.

use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use dashmap::DashMap;
use paracord_core::AppState;
use paracord_media::audio::{format_for_content_type, probe_audio};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MIN_SOUND_NAME_LEN: usize = 2;
const MAX_SOUND_NAME_LEN: usize = 32;
const MAX_SOUND_EMOJI_LEN: usize = 64;
const MAX_SOUND_BYTES: usize = 1024 * 1024; // 1 MB
const MAX_SOUND_DURATION_MS: i64 = 5000;

/// Sounds per space, same reasoning as `MAX_STICKERS_PER_GUILD`: the storage
/// accounting that bounds attachments never sees sound assets, so without a
/// cap one member with MANAGE_EMOJIS could fill the disk 1 MB at a time.
const MAX_SOUNDS_PER_GUILD: usize = 48;

/// One play per person per 2 s.
const USER_COOLDOWN: Duration = Duration::from_secs(2);
/// At most 5 plays per 10 s per channel.
const CHANNEL_WINDOW: Duration = Duration::from_secs(10);
const CHANNEL_WINDOW_MAX_PLAYS: usize = 5;

/// Sliding-window cooldown state. Keyed statically like `command_rate_limits`
/// in `realtime.rs`: the limits are a server-wide throttle, not per-deployment
/// config, so they live next to the route that enforces them.
struct SoundboardLimits {
    /// (user_id, channel_id) -> instant of the last accepted play.
    per_user: DashMap<(i64, i64), Instant>,
    /// channel_id -> timestamps of recent accepted plays (pruned to the window).
    per_channel: DashMap<i64, VecDeque<Instant>>,
}

fn soundboard_limits() -> &'static SoundboardLimits {
    static LIMITS: OnceLock<SoundboardLimits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        let limits = SoundboardLimits {
            per_user: DashMap::new(),
            per_channel: DashMap::new(),
        };
        tokio::spawn(async {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.tick().await;
            loop {
                interval.tick().await;
                let limits = soundboard_limits();
                // `checked_sub`: on a clock where now < CHANNEL_WINDOW nothing
                // can be stale yet, so skipping the sweep is correct.
                if let Some(stale_after) = Instant::now().checked_sub(CHANNEL_WINDOW) {
                    limits.per_user.retain(|_, at| *at > stale_after);
                    limits.per_channel.retain(|_, window| {
                        while window.front().is_some_and(|at| *at < stale_after) {
                            window.pop_front();
                        }
                        !window.is_empty()
                    });
                }
            }
        });
        limits
    })
}

/// Returns `Err(RateLimited(retry_after_seconds))` when the play is over the
/// user or channel budget; on success records the play.
fn check_play_cooldown(user_id: i64, channel_id: i64) -> Result<(), ApiError> {
    let limits = soundboard_limits();
    let now = Instant::now();

    if let Some(last) = limits.per_user.get(&(user_id, channel_id)) {
        let elapsed = now.saturating_duration_since(*last);
        if elapsed < USER_COOLDOWN {
            let retry = (USER_COOLDOWN - elapsed).as_secs().max(1) as i64;
            return Err(ApiError::RateLimited(retry));
        }
    }

    {
        let mut window = limits.per_channel.entry(channel_id).or_default();
        while window
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= CHANNEL_WINDOW)
        {
            window.pop_front();
        }
        if window.len() >= CHANNEL_WINDOW_MAX_PLAYS {
            let oldest = *window.front().expect("non-empty window");
            let retry = CHANNEL_WINDOW
                .checked_sub(now.saturating_duration_since(oldest))
                .unwrap_or(Duration::from_secs(1))
                .as_secs()
                .max(1) as i64;
            return Err(ApiError::RateLimited(retry));
        }
        window.push_back(now);
    }
    limits.per_user.insert((user_id, channel_id), now);
    Ok(())
}

fn sound_to_json(sound: &paracord_db::soundboard::SoundboardSoundRow) -> Value {
    json!({
        "id": sound.id.to_string(),
        "guild_id": sound.guild_id.to_string(),
        "name": sound.name,
        "emoji": sound.emoji,
        "volume": sound.volume,
        "duration_ms": sound.duration_ms,
        "content_type": sound.content_type,
        "size": sound.size,
        "creator_id": sound.creator_id.map(|id| id.to_string()),
        "sound_url": format!("/api/v1/guilds/{}/sounds/{}/file", sound.guild_id, sound.id),
        "created_at": sound.created_at.to_rfc3339(),
    })
}

fn normalize_emoji(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw else { return Ok(None) };
    let emoji = raw.trim();
    if emoji.is_empty() {
        return Ok(None);
    }
    // A unicode emoji or a `<a?:name:id>` custom-emoji token — the same shape
    // message reactions carry (`CUSTOM_EMOJI_TOKEN_PATTERN` client-side).
    // Bounded length and no control characters is all the server needs;
    // rendering the token is the client's job.
    let valid_token = {
        let inner = emoji.strip_prefix('<').and_then(|s| s.strip_suffix('>'));
        match inner {
            Some(inner) => {
                let mut parts = inner.splitn(3, ':');
                let animated_ok = matches!(parts.next(), Some("a") | Some(""));
                let name_ok = parts.next().is_some_and(|name| {
                    (1..=32).contains(&name.len())
                        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                });
                let id_ok = parts
                    .next()
                    .is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()));
                animated_ok && name_ok && id_ok && !inner.contains('<')
            }
            None => !emoji
                .chars()
                .any(|c| c == '<' || c == '>' || c.is_control()),
        }
    };
    if !valid_token || emoji.chars().count() > MAX_SOUND_EMOJI_LEN {
        return Err(ApiError::BadRequest(
            "Emoji must be a single emoji or custom-emoji token".into(),
        ));
    }
    Ok(Some(emoji.to_string()))
}

fn normalize_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.chars().count() < MIN_SOUND_NAME_LEN || name.chars().count() > MAX_SOUND_NAME_LEN {
        return Err(ApiError::BadRequest(format!(
            "Sound name must be {MIN_SOUND_NAME_LEN}-{MAX_SOUND_NAME_LEN} characters"
        )));
    }
    Ok(name.to_string())
}

fn normalize_volume(raw: Option<i64>) -> Result<i32, ApiError> {
    let volume = raw.unwrap_or(100);
    if !(0..=100).contains(&volume) {
        return Err(ApiError::BadRequest(
            "Sound volume must be between 0 and 100".into(),
        ));
    }
    Ok(volume as i32)
}

async fn ensure_manage_sounds(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // Guild-scoped gate: `compute_guild_permissions` also applies the bot
    // install-permission cap, which the raw role fold cannot. Managing sounds
    // uses the same permission as stickers and emoji.
    let perms = paracord_core::permissions::compute_guild_permissions(
        &state.db,
        guild_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_EMOJIS)?;
    Ok(())
}

pub async fn list_guild_sounds(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let sounds = paracord_db::soundboard::list_sounds(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(sounds
        .iter()
        .map(sound_to_json)
        .collect::<Vec<_>>())))
}

pub async fn create_sound(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_manage_sounds(&state, guild_id, auth.user_id).await?;

    // Checked before the body is consumed so a space already at its cap never
    // buffers the audio at all.
    let existing = paracord_db::soundboard::count_sounds(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if existing as usize >= MAX_SOUNDS_PER_GUILD {
        return Err(ApiError::Conflict(format!(
            "This server already has the maximum of {MAX_SOUNDS_PER_GUILD} sounds"
        )));
    }

    let mut name: Option<String> = None;
    let mut emoji: Option<String> = None;
    let mut volume: Option<i64> = None;
    let mut audio_data: Option<Vec<u8>> = None;
    let mut content_type: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        match field.name().unwrap_or("").trim() {
            "name" => {
                name = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?,
                );
            }
            "emoji" => {
                emoji = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?,
                );
            }
            "volume" => {
                let raw = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                volume = Some(raw.trim().parse::<i64>().map_err(|_| {
                    ApiError::BadRequest("Sound volume must be between 0 and 100".into())
                })?);
            }
            "file" | "audio" | "sound" => {
                content_type = field.content_type().map(str::to_string);
                audio_data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?
                        .to_vec(),
                );
            }
            _ => {}
        }
    }

    let name = normalize_name(
        name.as_deref()
            .ok_or_else(|| ApiError::BadRequest("Missing sound name".into()))?,
    )?;
    let emoji = normalize_emoji(emoji.as_deref())?;
    let volume = normalize_volume(volume)?;

    let audio_data = audio_data.ok_or_else(|| ApiError::BadRequest("Missing sound file".into()))?;
    if audio_data.is_empty() || audio_data.len() > MAX_SOUND_BYTES {
        return Err(ApiError::BadRequest(
            "Sound files must be between 1 byte and 1 MB".into(),
        ));
    }

    let declared = content_type.unwrap_or_else(|| "application/octet-stream".to_string());
    let Some(format) = format_for_content_type(&declared) else {
        return Err(ApiError::BadRequest(
            "Sounds must be MP3, OGG, WAV, or M4A".into(),
        ));
    };
    // The probe both validates the signature against the declared type and
    // measures the duration; a file that cannot be measured is not a sound we
    // can promise to play under the duration cap.
    let probed = probe_audio(&audio_data, &declared).map_err(|e| match e {
        paracord_media::audio::AudioProbeError::Unrecognized => {
            ApiError::BadRequest("The file does not match its declared audio type".into())
        }
        other => ApiError::BadRequest(format!("Could not read the audio file: {other}")),
    })?;
    debug_assert_eq!(probed.format, format);
    if probed.duration_ms > MAX_SOUND_DURATION_MS {
        return Err(ApiError::BadRequest(format!(
            "Sounds must be at most {} seconds long (this one is {:.1} s)",
            MAX_SOUND_DURATION_MS / 1000,
            probed.duration_ms as f64 / 1000.0,
        )));
    }

    let ext = match format {
        paracord_media::audio::AudioFormat::Wav => "wav",
        paracord_media::audio::AudioFormat::Mp3 => "mp3",
        paracord_media::audio::AudioFormat::Ogg => "ogg",
        paracord_media::audio::AudioFormat::Mp4 => "m4a",
    };
    let sound_id = paracord_util::snowflake::generate(1);
    let asset_key = format!("sounds/{guild_id}/{sound_id}.{ext}");
    state
        .storage_backend
        .store(&asset_key, &audio_data)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let sound = paracord_db::soundboard::create_sound(
        &state.db,
        sound_id,
        guild_id,
        &name,
        emoji.as_deref(),
        volume,
        probed.duration_ms,
        format.content_type(),
        audio_data.len() as i64,
        &asset_key,
        Some(auth.user_id),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let payload = sound_to_json(&sound);
    state.event_bus.dispatch(
        "GUILD_SOUNDS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "sound": payload,
        }),
        Some(guild_id),
    );

    Ok((StatusCode::CREATED, Json(payload)))
}

#[derive(Deserialize)]
pub struct UpdateSoundRequest {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub volume: Option<i64>,
}

pub async fn update_sound(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, sound_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateSoundRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_sounds(&state, guild_id, auth.user_id).await?;
    let sound = paracord_db::soundboard::get_sound(&state.db, sound_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if sound.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }
    let name = match body.name.as_deref() {
        Some(raw) => normalize_name(raw)?,
        None => sound.name.clone(),
    };
    // `emoji` present-but-empty clears it; absent keeps the stored value.
    let emoji = match body.emoji.as_deref() {
        Some(raw) => normalize_emoji(Some(raw))?,
        None => sound.emoji.clone(),
    };
    let volume = match body.volume {
        Some(raw) => normalize_volume(Some(raw))?,
        None => sound.volume,
    };
    let updated =
        paracord_db::soundboard::update_sound(&state.db, sound_id, &name, emoji.as_deref(), volume)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let payload = sound_to_json(&updated);
    state.event_bus.dispatch(
        "GUILD_SOUNDS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "sound": payload,
        }),
        Some(guild_id),
    );
    Ok(Json(payload))
}

pub async fn delete_sound(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, sound_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_manage_sounds(&state, guild_id, auth.user_id).await?;
    let sound = paracord_db::soundboard::get_sound(&state.db, sound_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if sound.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }
    let _ = state.storage_backend.delete(&sound.asset_key).await;
    paracord_db::soundboard::delete_sound(&state.db, sound_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    state.event_bus.dispatch(
        "GUILD_SOUNDS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "deleted_sound_id": sound_id.to_string(),
        }),
        Some(guild_id),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_sound_file(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, sound_id)): Path<(i64, i64)>,
) -> Result<axum::response::Response, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let sound = paracord_db::soundboard::get_sound(&state.db, sound_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if sound.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }
    let data = state
        .storage_backend
        .retrieve(&sound.asset_key)
        .await
        .map_err(|_| ApiError::NotFound)?;
    use axum::http::header;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                axum::http::HeaderValue::from_str(&sound.content_type).unwrap_or_else(|_| {
                    axum::http::HeaderValue::from_static("application/octet-stream")
                }),
            ),
            (
                header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                axum::http::HeaderValue::from_static("nosniff"),
            ),
        ],
        data,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct PlaySoundRequest {
    /// String snowflake — matches how every other id arrives in request bodies.
    pub sound_id: String,
}

/// `POST /api/v1/channels/{channel_id}/soundboard/play`
///
/// The caller must be connected to that voice channel and hold
/// `USE_SOUNDBOARD`. The event goes only to the channel's current voice
/// participants: guild-wide dispatch would leak plays to people outside the
/// call and force every client to filter by channel anyway.
pub async fn play_sound(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<PlaySoundRequest>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Soundboard is only supported in server voice channels".into(),
    ))?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::USE_SOUNDBOARD)?;

    // "Connected to that voice channel" is the durable voice_states row: the
    // same receipt VOICE_STATE_UPDATE presence is built from, so the check
    // stays true across the media layer's own reconnect churn.
    let membership =
        paracord_db::voice_states::get_user_voice_state(&state.db, auth.user_id, Some(guild_id))
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if membership.map(|row| row.channel_id) != Some(channel_id) {
        return Err(ApiError::Forbidden);
    }

    let sound_id: i64 = body
        .sound_id
        .trim()
        .parse()
        .map_err(|_| ApiError::BadRequest("Invalid sound_id".into()))?;
    let sound = paracord_db::soundboard::get_sound(&state.db, sound_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if sound.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    check_play_cooldown(auth.user_id, channel_id)?;

    let participants = paracord_db::voice_states::get_channel_voice_states(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let mut target_user_ids: Vec<i64> = participants.iter().map(|row| row.user_id).collect();
    target_user_ids.sort_unstable();
    target_user_ids.dedup();
    // The caller is in the channel by the membership check above, but a
    // defensive `contains` keeps the event deliverable even if the rows were
    // read across a concurrent leave.
    if !target_user_ids.contains(&auth.user_id) {
        target_user_ids.push(auth.user_id);
    }

    let at = chrono::Utc::now().timestamp_millis();
    state.event_bus.dispatch_to_users(
        "SOUNDBOARD_PLAY",
        json!({
            "guild_id": guild_id.to_string(),
            "channel_id": channel_id.to_string(),
            "sound_id": sound.id.to_string(),
            "user_id": auth.user_id.to_string(),
            "sound": sound_to_json(&sound),
            "at": at,
        }),
        target_user_ids,
    );

    Ok(StatusCode::NO_CONTENT)
}
