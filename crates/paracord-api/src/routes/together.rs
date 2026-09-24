//! Watch together / Listen together.
//!
//! Every route here acts on the session of one server voice channel. The gate
//! is the call itself: the caller must be connected to that voice channel right
//! now (their voice state says so) and still hold `VIEW_CHANNEL` + `CONNECT` on
//! it. The engine and its events live in `paracord_core::together`.

use std::sync::OnceLock;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::together::{self, Control, ControllerPolicy, ItemSource, NewItem, TogetherKind};
use paracord_core::AppState;
use paracord_db::channels::ChannelRow;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

/// Most items one request may add (a YouTube playlist is expanded into its
/// videos by the client and sent in one go).
const MAX_ITEMS_PER_REQUEST: usize = 25;
const MAX_TITLE_CHARS: usize = 200;
const MAX_URL_LEN: usize = 2048;
const OEMBED_TIMEOUT: Duration = Duration::from_secs(6);

const VIDEO_EXTENSIONS: &[(&str, &str)] = &[("mp4", "video/mp4"), ("webm", "video/webm")];
const AUDIO_EXTENSIONS: &[(&str, &str)] = &[
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("m4a", "audio/mp4"),
    ("flac", "audio/flac"),
    ("wav", "audio/wav"),
];

const UNSUPPORTED_SOURCE: &str = "Paracord can play YouTube links and direct video or audio files";
const HTTP_LINK: &str = "Direct links must start with https:// so every device can play them";

fn map_error(error: together::TogetherError) -> ApiError {
    use together::TogetherError as E;
    match error {
        E::NoSession | E::ItemNotFound => ApiError::BadRequest(error.to_string()),
        E::AlreadyRunning | E::QueueFull => ApiError::Conflict(error.to_string()),
        E::ControlsLocked => ApiError::Forbidden,
        E::Invalid(message) => ApiError::BadRequest(message),
    }
}

fn parse_id(raw: &str, what: &str) -> Result<i64, ApiError> {
    raw.trim()
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| ApiError::BadRequest(format!("{what} must be an id")))
}

/// The channel, if `user_id` may use Together in it right now.
async fn require_in_call(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
) -> Result<ChannelRow, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // Server voice channels only: calls in direct messages use a different
    // call view that has no stage to put a player on.
    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest(
            "Watch together works in voice channels".into(),
        ));
    }
    crate::routes::channels::ensure_channel_permissions(
        state,
        &channel,
        user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::CONNECT],
    )
    .await?;
    let voice_state =
        paracord_db::voice_states::get_user_voice_state(&state.db, user_id, channel.guild_id())
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if voice_state.map(|vs| vs.channel_id) != Some(channel_id) {
        return Err(ApiError::BadRequest(
            "Join the call to watch or listen together".into(),
        ));
    }
    Ok(channel)
}

#[derive(Debug, Deserialize)]
pub struct ItemInput {
    pub source: String,
    #[serde(rename = "ref")]
    pub reference: String,
    /// A still frame of an attached video, captured by the adder's client
    /// (`data:image/jpeg;base64,…`). Attachments have no server-side preview.
    #[serde(default)]
    pub thumbnail: Option<String>,
}

/// Largest captured still accepted, as a data URL. It rides along in every
/// session update, so it is kept to a small JPEG (~256×144).
pub const MAX_THUMBNAIL_CHARS: usize = 16 * 1024;

/// Accept a client-captured still: a small base64 JPEG data URL, nothing else.
pub fn validate_captured_thumbnail(raw: &str) -> Result<String, ApiError> {
    const PREFIX: &str = "data:image/jpeg;base64,";
    let Some(body) = raw.strip_prefix(PREFIX) else {
        return Err(ApiError::BadRequest(
            "The preview image must be a JPEG".into(),
        ));
    };
    if raw.len() > MAX_THUMBNAIL_CHARS {
        return Err(ApiError::BadRequest(
            "The preview image is too large".into(),
        ));
    }
    if body.is_empty()
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
    {
        return Err(ApiError::BadRequest(
            "The preview image is not valid".into(),
        ));
    }
    Ok(raw.to_string())
}

#[derive(Debug, Deserialize)]
pub struct StartRequest {
    pub kind: TogetherKind,
    #[serde(default)]
    pub controller_policy: Option<ControllerPolicy>,
    pub items: Vec<ItemInput>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRequest {
    pub controller_policy: ControllerPolicy,
}

#[derive(Debug, Deserialize)]
pub struct PlaybackRequest {
    pub action: String,
    #[serde(default)]
    pub position_ms: Option<u64>,
    #[serde(default)]
    pub item_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddItemsRequest {
    pub items: Vec<ItemInput>,
}

#[derive(Debug, Deserialize)]
pub struct MoveItemRequest {
    pub index: usize,
}

fn truncate_title(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    cleaned.chars().take(MAX_TITLE_CHARS).collect()
}

/// A YouTube video id: 11 characters of the URL-safe base64 alphabet.
pub fn is_youtube_video_id(raw: &str) -> bool {
    raw.len() == 11
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(OEMBED_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(2))
            .user_agent("Mozilla/5.0 (compatible; ParacordBot/1.0)")
            .build()
            .expect("reqwest client builds")
    })
}

/// Title a YouTube video through its public oEmbed endpoint, which also tells
/// us whether the video may be embedded at all.
async fn resolve_youtube(video_id: String) -> Result<NewItem, ApiError> {
    if !is_youtube_video_id(&video_id) {
        return Err(ApiError::BadRequest(
            "That is not a YouTube video link".into(),
        ));
    }
    let watch_url = format!("https://www.youtube.com/watch?v={video_id}");
    let response = http_client()
        .get("https://www.youtube.com/oembed")
        .query(&[("format", "json"), ("url", watch_url.as_str())])
        .send()
        .await
        .map_err(|_| {
            ApiError::ServiceUnavailable(
                "Paracord could not reach YouTube to look up that video".into(),
            )
        })?;
    match response.status() {
        status if status.is_success() => {}
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(ApiError::BadRequest(
                "The owner of that video does not allow it to play outside YouTube".into(),
            ))
        }
        StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST => {
            return Err(ApiError::BadRequest(
                "That YouTube video does not exist or is private".into(),
            ))
        }
        _ => {
            return Err(ApiError::ServiceUnavailable(
                "YouTube did not answer when Paracord looked up that video".into(),
            ))
        }
    }
    let body: Value = response.json().await.map_err(|_| {
        ApiError::ServiceUnavailable("YouTube sent an answer Paracord could not read".into())
    })?;
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .map(truncate_title)
        .filter(|title| !title.is_empty())
        .ok_or_else(|| {
            ApiError::ServiceUnavailable("YouTube sent an answer Paracord could not read".into())
        })?;
    Ok(NewItem {
        source: ItemSource::Youtube,
        thumbnail: Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
        reference: video_id,
        title,
        duration_ms: None,
        content_type: None,
    })
}

/// A direct link to a media file the browser plays itself.
pub fn resolve_direct_url(raw: &str) -> Result<NewItem, ApiError> {
    let raw = raw.trim();
    if raw.len() > MAX_URL_LEN {
        return Err(ApiError::BadRequest("That link is too long".into()));
    }
    let url = url::Url::parse(raw).map_err(|_| ApiError::BadRequest(UNSUPPORTED_SOURCE.into()))?;
    if url.scheme() == "http" {
        // Every participant's device fetches the file itself, and the desktop
        // app only plays media over https; the web app must behave the same.
        return Err(ApiError::BadRequest(HTTP_LINK.into()));
    }
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(ApiError::BadRequest(UNSUPPORTED_SOURCE.into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::BadRequest(
            "Links with a user name or password in them cannot be shared".into(),
        ));
    }
    let file_name = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or("")
        .to_string();
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let content_type = VIDEO_EXTENSIONS
        .iter()
        .chain(AUDIO_EXTENSIONS.iter())
        .find(|(ext, _)| *ext == extension)
        .map(|(_, content_type)| (*content_type).to_string())
        .ok_or_else(|| ApiError::BadRequest(UNSUPPORTED_SOURCE.into()))?;
    let decoded = percent_decode(&file_name);
    let title = truncate_title(&decoded);
    Ok(NewItem {
        source: ItemSource::Url,
        reference: url.to_string(),
        title: if title.is_empty() { file_name } else { title },
        duration_ms: None,
        thumbnail: None,
        content_type: Some(content_type),
    })
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A video or audio file posted in this server, which the adder can see.
async fn resolve_attachment(
    state: &AppState,
    call: &ChannelRow,
    user_id: i64,
    raw_id: &str,
) -> Result<NewItem, ApiError> {
    let Some(guild_id) = call.guild_id() else {
        return Err(ApiError::BadRequest("That file is not available".into()));
    };
    let attachment_id = parse_id(raw_id, "The file")?;
    let not_found = || ApiError::BadRequest("That file is not available".into());
    let attachment = paracord_db::attachments::get_attachment(&state.db, attachment_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or_else(not_found)?;
    let message_id = attachment.message_id.ok_or_else(not_found)?;
    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or_else(not_found)?;
    let channel = paracord_db::channels::get_channel(&state.db, message.channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or_else(not_found)?;
    if channel.guild_id() != Some(guild_id) {
        return Err(not_found());
    }
    crate::routes::channels::ensure_channel_permissions(
        state,
        &channel,
        user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await
    .map_err(|_| not_found())?;
    let content_type = attachment
        .content_type
        .clone()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !(content_type.starts_with("video/") || content_type.starts_with("audio/")) {
        return Err(ApiError::BadRequest(
            "Only video and audio files can be played together".into(),
        ));
    }
    Ok(NewItem {
        source: ItemSource::Attachment,
        reference: attachment.id.to_string(),
        title: truncate_title(&attachment.filename),
        duration_ms: None,
        thumbnail: None,
        content_type: Some(content_type),
    })
}

async fn resolve_items(
    state: &AppState,
    call: &ChannelRow,
    user_id: i64,
    inputs: Vec<ItemInput>,
) -> Result<Vec<NewItem>, ApiError> {
    if inputs.is_empty() {
        return Err(ApiError::BadRequest("Add something to play first".into()));
    }
    if inputs.len() > MAX_ITEMS_PER_REQUEST {
        return Err(ApiError::BadRequest(format!(
            "Add at most {MAX_ITEMS_PER_REQUEST} items at a time"
        )));
    }
    // YouTube lookups run side by side; the rest are local checks.
    let mut youtube = tokio::task::JoinSet::new();
    let mut resolved: Vec<Option<NewItem>> = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.into_iter().enumerate() {
        if input.thumbnail.is_some() && input.source != "attachment" {
            return Err(ApiError::BadRequest(
                "Only files carry their own preview image".into(),
            ));
        }
        match input.source.as_str() {
            "youtube" => {
                let video_id = input.reference.trim().to_string();
                if !is_youtube_video_id(&video_id) {
                    return Err(ApiError::BadRequest(
                        "That is not a YouTube video link".into(),
                    ));
                }
                youtube.spawn(async move { (index, resolve_youtube(video_id).await) });
                resolved.push(None);
            }
            "url" => resolved.push(Some(resolve_direct_url(&input.reference)?)),
            "attachment" => {
                let mut item = resolve_attachment(state, call, user_id, &input.reference).await?;
                if let Some(still) = input.thumbnail.as_deref() {
                    if !item
                        .content_type
                        .as_deref()
                        .is_some_and(|ct| ct.starts_with("video/"))
                    {
                        return Err(ApiError::BadRequest(
                            "Only videos carry a preview image".into(),
                        ));
                    }
                    item.thumbnail = Some(validate_captured_thumbnail(still)?);
                }
                resolved.push(Some(item));
            }
            _ => return Err(ApiError::BadRequest(UNSUPPORTED_SOURCE.into())),
        }
    }
    // One video of a playlist that its owner keeps on YouTube (or made
    // private) does not sink the rest: it is left out, and the client tells
    // the person how many were. A lone video still fails with its reason, and
    // so does YouTube being unreachable.
    let requested = resolved.len();
    let mut refused: Option<ApiError> = None;
    while let Some(joined) = youtube.join_next().await {
        let (index, item) =
            joined.map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        match item {
            Ok(item) => resolved[index] = Some(item),
            Err(error @ ApiError::BadRequest(_)) if requested > 1 => {
                refused.get_or_insert(error);
            }
            Err(error) => return Err(error),
        }
    }
    let items: Vec<NewItem> = resolved.into_iter().flatten().collect();
    match (items.is_empty(), refused) {
        (true, Some(error)) => Err(error),
        _ => Ok(items),
    }
}

/// `GET /channels/{id}/together`: the call's session, or `null`.
pub async fn get_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    require_in_call(&state, channel_id, auth.user_id).await?;
    // Read the revision before the snapshot: an answer of "nothing" must not
    // outrank a session started a moment later.
    let revision = state.together.current_revision();
    let now = together::now_ms();
    let session = state.together.snapshot(channel_id);
    Ok(Json(json!({
        "channel_id": channel_id.to_string(),
        "revision": session.as_ref().map(|s| s.revision).unwrap_or(revision),
        "server_time_ms": now,
        "session": session.map(|s| s.to_json(now)),
    })))
}

/// `POST /channels/{id}/together`: start watching or listening together.
pub async fn start_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<StartRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let call = require_in_call(&state, channel_id, auth.user_id).await?;
    if state.together.snapshot(channel_id).is_some() {
        return Err(map_error(together::TogetherError::AlreadyRunning));
    }
    let items = resolve_items(&state, &call, auth.user_id, body.items).await?;
    let session = together::start(
        &state,
        channel_id,
        call.guild_id(),
        auth.user_id,
        body.kind,
        body.controller_policy.unwrap_or(ControllerPolicy::Everyone),
        items,
    )
    .await
    .map_err(map_error)?;
    Ok((StatusCode::CREATED, Json(session)))
}

/// `PATCH /channels/{id}/together`: who may control it.
pub async fn update_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateRequest>,
) -> Result<Json<Value>, ApiError> {
    require_in_call(&state, channel_id, auth.user_id).await?;
    together::set_policy(&state, channel_id, auth.user_id, body.controller_policy)
        .await
        .map(Json)
        .map_err(map_error)
}

/// `DELETE /channels/{id}/together`: stop for everyone.
pub async fn stop_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_in_call(&state, channel_id, auth.user_id).await?;
    together::stop(&state, channel_id, auth.user_id)
        .await
        .map_err(map_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /channels/{id}/together/playback`: play, pause, seek, skip, ended.
pub async fn playback(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<PlaybackRequest>,
) -> Result<Json<Value>, ApiError> {
    require_in_call(&state, channel_id, auth.user_id).await?;
    let item_id = body
        .item_id
        .as_deref()
        .map(|raw| parse_id(raw, "item_id"))
        .transpose()?;
    let control = match body.action.as_str() {
        "play" => Control::Play,
        "pause" => Control::Pause,
        "seek" => Control::Seek {
            position_ms: body
                .position_ms
                .ok_or_else(|| ApiError::BadRequest("seek needs position_ms".into()))?,
        },
        "skip" => Control::Skip {
            to_item_id: item_id,
        },
        "ended" => Control::Ended {
            item_id: item_id.ok_or_else(|| ApiError::BadRequest("ended needs item_id".into()))?,
        },
        _ => {
            return Err(ApiError::BadRequest(
                "action must be play, pause, seek, skip or ended".into(),
            ))
        }
    };
    together::control(&state, channel_id, auth.user_id, control)
        .await
        .map(Json)
        .map_err(map_error)
}

/// `POST /channels/{id}/together/items`: add to the queue.
pub async fn add_items(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<AddItemsRequest>,
) -> Result<Json<Value>, ApiError> {
    let call = require_in_call(&state, channel_id, auth.user_id).await?;
    let session = state
        .together
        .snapshot(channel_id)
        .ok_or_else(|| map_error(together::TogetherError::NoSession))?;
    // Refuse before any YouTube lookup when the adder may not change the queue.
    if !session.can_control(auth.user_id) {
        return Err(ApiError::Forbidden);
    }
    let items = resolve_items(&state, &call, auth.user_id, body.items).await?;
    together::add_items(&state, channel_id, auth.user_id, items)
        .await
        .map(Json)
        .map_err(map_error)
}

/// `DELETE /channels/{id}/together/items/{item_id}`.
pub async fn remove_item(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, item_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    require_in_call(&state, channel_id, auth.user_id).await?;
    together::remove_item(&state, channel_id, auth.user_id, item_id)
        .await
        .map(Json)
        .map_err(map_error)
}

/// `PATCH /channels/{id}/together/items/{item_id}`: move it to `index`.
pub async fn move_item(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, item_id)): Path<(i64, i64)>,
    Json(body): Json<MoveItemRequest>,
) -> Result<Json<Value>, ApiError> {
    require_in_call(&state, channel_id, auth.user_id).await?;
    together::move_item(&state, channel_id, auth.user_id, item_id, body.index)
        .await
        .map(Json)
        .map_err(map_error)
}

/// `GET /guilds/{id}/together`: what is playing in the voice channels the
/// caller can see (sidebar rows and "Live now").
pub async fn list_guild_activities(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let revision = state.together.current_revision();
    let mut activities = Vec::new();
    for (channel_id, channel_revision, activity) in state.together.guild_activities(guild_id) {
        let perms = paracord_core::permissions::compute_channel_permissions_cached(
            &state.permission_cache,
            &state.db,
            guild_id,
            channel_id,
            guild.owner_id,
            auth.user_id,
        )
        .await?;
        if !perms.contains(Permissions::VIEW_CHANNEL) {
            continue;
        }
        activities.push(json!({
            "channel_id": channel_id.to_string(),
            "revision": channel_revision,
            "activity": activity,
        }));
    }
    Ok(Json(json!({
        "guild_id": guild_id.to_string(),
        "revision": revision,
        "activities": activities,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_ids_are_eleven_url_safe_characters() {
        assert!(is_youtube_video_id("dQw4w9WgXcQ"));
        assert!(is_youtube_video_id("aqz-KE-bpKQ"));
        assert!(!is_youtube_video_id("dQw4w9WgXc"));
        assert!(!is_youtube_video_id("dQw4w9WgXc!"));
        assert!(!is_youtube_video_id("https://yo"));
    }

    #[test]
    fn direct_urls_need_a_known_media_extension() {
        let item = resolve_direct_url("https://example.com/films/My%20Clip.MP4?x=1").unwrap();
        assert_eq!(item.title, "My Clip.MP4");
        assert_eq!(item.content_type.as_deref(), Some("video/mp4"));
        let item = resolve_direct_url("https://cdn.example.com:8443/song.flac").unwrap();
        assert_eq!(item.content_type.as_deref(), Some("audio/flac"));
        // https only: every device fetches it, and the desktop app plays https media only.
        let Err(ApiError::BadRequest(message)) =
            resolve_direct_url("http://127.0.0.1:8000/song.flac")
        else {
            panic!("http must be refused");
        };
        assert!(message.contains("https://"));
        assert!(resolve_direct_url("https://example.com/page.html").is_err());
        assert!(resolve_direct_url("ftp://example.com/a.mp4").is_err());
        assert!(resolve_direct_url("javascript:alert(1)//a.mp4").is_err());
        assert!(resolve_direct_url("https://user:pw@example.com/a.mp4").is_err());
        assert!(resolve_direct_url("not a url").is_err());
    }

    #[test]
    fn captured_stills_are_small_jpeg_data_urls() {
        assert!(validate_captured_thumbnail("data:image/jpeg;base64,/9j/4AAQSkZJRg==").is_ok());
        assert!(validate_captured_thumbnail("data:image/png;base64,iVBORw0KGgo=").is_err());
        assert!(validate_captured_thumbnail("https://example.com/a.jpg").is_err());
        assert!(validate_captured_thumbnail("data:image/jpeg;base64,<script>").is_err());
        let huge = format!("data:image/jpeg;base64,{}", "A".repeat(MAX_THUMBNAIL_CHARS));
        assert!(validate_captured_thumbnail(&huge).is_err());
    }

    #[test]
    fn percent_decoding_leaves_broken_escapes_alone() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
