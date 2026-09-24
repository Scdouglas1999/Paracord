//! Feeds add-on: the Feeds page in Server settings → Add-ons, and the admin's
//! Add-ons section (Twitch credentials, local network access).
//!
//! Adding, editing and removing feeds needs Manage Server, and the editor must
//! be able to send messages in the destination channel. The feed then posts
//! as itself, not as the person who added it.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use paracord_core::feeds::{
    self, FeedKind, GithubMode, ResolvedSource, SafeFetcher, SourceInput, TwitchCredentials,
};
use paracord_core::AppState;
use paracord_db::channels::ChannelRow;
use paracord_db::feeds::{FeedSourceRow, GuildFeedRow};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use super::audit;
use super::feeds_poll;
use crate::error::ApiError;
use crate::middleware::{AdminUser, AuthUser};

const ADDON_OFF: &str = "Feeds are not turned on for this server.";
const FEED_MISSING: &str = "That feed isn't on this server.";
const NOT_TEXT: &str = "A feed posts into a text or announcement channel.";
const CANT_SEND: &str = "You can only point a feed at a channel you can send messages in.";
const ENCRYPTED: &str = "That channel holds end-to-end encrypted messages, so a feed can't post readable cards there. Pick another channel.";
const MAX_NAME_CHARS: usize = 80;

const TWITCH_CLIENT_ID_SETTING: &str = "twitch_client_id";
const TWITCH_SECRET_SETTING: &str = "twitch_client_secret";

const CHANNEL_TYPE_TEXT: i16 = 0;
const CHANNEL_TYPE_ANNOUNCEMENT: i16 = 5;

fn internal(err: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(anyhow::anyhow!(err.to_string()))
}

// ── Secrets at rest ────────────────────────────────────────────────────────

/// The cryptor for add-on secrets (a Jellyfin API key, the Twitch client
/// secret): AES-256-GCM from the shared at-rest helper, keyed by an HKDF
/// subkey of this instance's JWT secret. Every instance has one, so every
/// instance stores these encrypted, whether or not `[at_rest]` is set up.
/// Rotating the JWT secret makes stored keys unreadable, and the feed then
/// says to enter its key again.
fn secret_cryptor(state: &AppState) -> paracord_util::at_rest::FileCryptor {
    use sha2::{Digest, Sha256};
    let master: [u8; 32] = Sha256::new()
        .chain_update(b"paracord/addon-secrets/v1")
        .chain_update(state.config.jwt_secret.as_bytes())
        .finalize()
        .into();
    paracord_util::at_rest::FileCryptor::from_master_key_with_context(
        &master,
        b"addon-secrets",
        false,
    )
}

/// Seal a secret for storage.
pub(crate) fn seal_secret(state: &AppState, plaintext: &str) -> Result<String, ApiError> {
    use base64::Engine;
    let sealed = secret_cryptor(state)
        .encrypt(plaintext.as_bytes())
        .map_err(internal)?;
    Ok(format!(
        "enc:v1:{}",
        base64::engine::general_purpose::STANDARD.encode(sealed)
    ))
}

pub(crate) fn open_secret(state: &AppState, stored: &str) -> Result<String, String> {
    use base64::Engine;
    let sealed = stored
        .strip_prefix("enc:v1:")
        .ok_or_else(|| "A stored key is in an unknown format. Enter it again.".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(sealed)
        .map_err(|_| "A stored key is damaged. Enter it again.".to_string())?;
    let plain = secret_cryptor(state).decrypt(&bytes).map_err(|_| {
        "A stored key can't be decrypted with this instance's secret. Enter it again.".to_string()
    })?;
    String::from_utf8(plain).map_err(|_| "A stored key is damaged. Enter it again.".to_string())
}

/// The instance's Twitch app, when the admin has set one.
pub(crate) async fn twitch_credentials(
    state: &AppState,
) -> Result<Option<TwitchCredentials>, String> {
    let client_id = paracord_db::server_settings::get_setting(&state.db, TWITCH_CLIENT_ID_SETTING)
        .await
        .map_err(|err| err.to_string())?
        .filter(|value| !value.trim().is_empty());
    let secret = paracord_db::server_settings::get_setting(&state.db, TWITCH_SECRET_SETTING)
        .await
        .map_err(|err| err.to_string())?
        .filter(|value| !value.trim().is_empty());
    match (client_id, secret) {
        (Some(client_id), Some(secret)) => Ok(Some(TwitchCredentials {
            client_id,
            client_secret: open_secret(state, &secret)?,
        })),
        _ => Ok(None),
    }
}

async fn twitch_available(state: &AppState) -> bool {
    matches!(twitch_credentials(state).await, Ok(Some(_)))
}

// ── Permissions ────────────────────────────────────────────────────────────

async fn ensure_manage_guild(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<i64, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
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
    Ok(guild.owner_id)
}

/// The destination channel: a text or announcement channel in this server
/// that the editor can send messages in, holding no encrypted messages.
async fn require_destination(
    state: &AppState,
    guild_id: i64,
    owner_id: i64,
    user_id: i64,
    channel_id: i64,
) -> Result<ChannelRow, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await?
        .filter(|channel| channel.space_id == Some(guild_id))
        .ok_or_else(|| ApiError::BadRequest("That channel isn't in this server.".into()))?;
    if !matches!(
        channel.channel_type,
        CHANNEL_TYPE_TEXT | CHANNEL_TYPE_ANNOUNCEMENT
    ) {
        return Err(ApiError::BadRequest(NOT_TEXT.into()));
    }
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db, guild_id, channel.id, owner_id, user_id,
    )
    .await?;
    if !perms.contains(Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES) {
        return Err(ApiError::BadRequest(CANT_SEND.into()));
    }
    if paracord_db::messages::channel_has_ciphertext(&state.db, channel.id).await? {
        return Err(ApiError::BadRequest(ENCRYPTED.into()));
    }
    Ok(channel)
}

fn parse_id(raw: &str, what: &str) -> Result<i64, ApiError> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest(format!("{what} must be an id.")))
}

fn clean_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(ApiError::BadRequest("A feed needs a name.".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(ApiError::BadRequest(format!(
            "A feed name is at most {MAX_NAME_CHARS} characters."
        )));
    }
    if name.contains(['<', '>']) {
        return Err(ApiError::BadRequest(
            "A feed name can't contain < or >.".into(),
        ));
    }
    Ok(name)
}

// ── Wire shapes ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SourceBody {
    pub kind: String,
    #[serde(default)]
    pub input: String,
    #[serde(default)]
    pub github_mode: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

impl SourceBody {
    fn to_input(&self) -> Result<SourceInput, ApiError> {
        let kind = FeedKind::parse(&self.kind).ok_or_else(|| {
            ApiError::BadRequest("kind must be rss, youtube, github, twitch or jellyfin.".into())
        })?;
        let github_mode = match self.github_mode.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(GithubMode::parse(raw).ok_or_else(|| {
                ApiError::BadRequest("github_mode must be releases, commits or tags.".into())
            })?),
        };
        Ok(SourceInput {
            kind,
            input: self.input.clone(),
            github_mode,
            branch: self.branch.clone(),
            api_key: self.api_key.clone(),
        })
    }
}

fn item_summary(item: &feeds::FeedItem) -> Value {
    json!({
        "title": item.title,
        "link": item.link,
        "published_at": item.published_at.map(|at| at.to_rfc3339()),
        "thumbnail_url": item.thumbnail_url,
    })
}

fn time(value: Option<DateTime<Utc>>) -> Value {
    json!(value.map(|at| at.to_rfc3339()))
}

fn feed_json(feed: &GuildFeedRow, source: Option<&FeedSourceRow>) -> Value {
    let options: Value = serde_json::from_str(&feed.options).unwrap_or_else(|_| json!({}));
    let display = options
        .get("display")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| source.map(|source| source.url.clone()));
    json!({
        "id": feed.id.to_string(),
        "guild_id": feed.guild_id.to_string(),
        "channel_id": feed.channel_id.to_string(),
        "kind": feed.kind,
        "name": feed.name,
        "icon_url": source.and_then(|source| source.icon_url.clone()),
        "site_url": source.and_then(|source| source.site_url.clone()),
        "source_title": source.and_then(|source| source.title.clone()),
        "source": display,
        "github_mode": options.get("github_mode"),
        "branch": options.get("branch"),
        "api_key_set": feed.secret.is_some(),
        "show_on_front_page": feed.show_on_front_page,
        "paused": feed.paused,
        "creator_id": feed.creator_id.map(|id| id.to_string()),
        "created_at": feed.created_at.to_rfc3339(),
        "status": {
            "last_checked_at": time(source.and_then(|source| source.last_checked_at)),
            "last_success_at": time(source.and_then(|source| source.last_success_at)),
            "next_check_at": time(source.and_then(|source| source.next_check_at)),
            "last_posted_at": time(feed.last_posted_at),
            "error": feed.last_error.clone().or_else(|| source.and_then(|source| source.last_error.clone())),
        },
    })
}

async fn feed_with_source(state: &AppState, feed: &GuildFeedRow) -> Result<Value, ApiError> {
    let source = paracord_db::feeds::get_source(&state.db, feed.source_id).await?;
    Ok(feed_json(feed, source.as_ref()))
}

async fn load_feed(
    state: &AppState,
    guild_id: i64,
    feed_id: i64,
) -> Result<GuildFeedRow, ApiError> {
    paracord_db::feeds::get_feed(&state.db, feed_id)
        .await?
        .filter(|feed| feed.guild_id == guild_id)
        .ok_or_else(|| ApiError::BadRequest(FEED_MISSING.into()))
}

async fn resolve(state: &AppState, input: &SourceInput) -> Result<ResolvedSource, ApiError> {
    let fetcher = SafeFetcher::for_instance(&state.db).await;
    let twitch = if input.kind == FeedKind::Twitch {
        twitch_credentials(state)
            .await
            .map_err(ApiError::BadRequest)?
    } else {
        None
    };
    feeds::resolve_source(&fetcher, input, twitch.as_ref())
        .await
        .map_err(|problem| ApiError::BadRequest(problem.0))
}

// ── Handlers ───────────────────────────────────────────────────────────────

/// `GET /guilds/{guild_id}/feeds`
pub async fn list_feeds(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let enabled = paracord_db::feeds::is_enabled(&state.db, guild_id).await?;
    let rows = paracord_db::feeds::list_guild_feeds(&state.db, guild_id).await?;
    let mut feeds_json = Vec::with_capacity(rows.len());
    for row in &rows {
        feeds_json.push(feed_with_source(&state, row).await?);
    }
    Ok(Json(json!({
        "enabled": enabled,
        "feeds": feeds_json,
        "limit": feeds::max_feeds_per_guild(),
        "twitch_available": twitch_available(&state).await,
    })))
}

#[derive(Debug, Deserialize)]
pub struct SettingsBody {
    pub enabled: bool,
}

/// `PUT /guilds/{guild_id}/feeds/settings`
pub async fn put_feed_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<SettingsBody>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    paracord_db::feeds::set_enabled(&state.db, guild_id, body.enabled).await?;
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({ "feeds": { "enabled": body.enabled } })),
    )
    .await;
    Ok(Json(json!({ "enabled": body.enabled })))
}

/// `POST /guilds/{guild_id}/feeds/preview`: what a source holds, before saving.
pub async fn preview_feed(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<SourceBody>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let input = body.to_input()?;
    let resolved = resolve(&state, &input).await?;
    Ok(Json(json!({
        "kind": resolved.kind.as_str(),
        "name": resolved.name,
        "title": resolved.feed.title.clone().unwrap_or_else(|| resolved.name.clone()),
        "icon_url": resolved.icon_url,
        "site_url": resolved.site_url,
        "source": resolved.display,
        "item_count": resolved.feed.items.len(),
        "newest": resolved.feed.items.first().map(item_summary),
    })))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub source: SourceBody,
    pub channel_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub show_on_front_page: Option<bool>,
}

/// `POST /guilds/{guild_id}/feeds`
///
/// First run posts nothing: every item the source holds now is recorded as
/// seen, and the newest one comes back so the page can offer "Post it now".
pub async fn create_feed(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let owner_id = ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    if !paracord_db::feeds::is_enabled(&state.db, guild_id).await? {
        return Err(ApiError::BadRequest(ADDON_OFF.into()));
    }
    let limit = i64::from(feeds::max_feeds_per_guild());
    if paracord_db::feeds::count_guild_feeds(&state.db, guild_id).await? >= limit {
        return Err(ApiError::BadRequest(format!(
            "A server can have at most {limit} feeds. Remove one to add another."
        )));
    }
    let channel_id = parse_id(&body.channel_id, "channel_id")?;
    let channel = require_destination(&state, guild_id, owner_id, auth.user_id, channel_id).await?;
    let input = body.source.to_input()?;
    let resolved = resolve(&state, &input).await?;
    let name = match body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(name) => clean_name(name)?,
        None => clean_name(&resolved.name).or_else(|_| clean_name(resolved.kind.label()))?,
    };
    let secret = match resolved.kind {
        FeedKind::Jellyfin => {
            let key = input.api_key.as_deref().map(str::trim).unwrap_or_default();
            Some(seal_secret(&state, key)?)
        }
        _ => None,
    };

    let now = Utc::now();
    let source_id = paracord_db::feeds::upsert_source(
        &state.db,
        paracord_util::snowflake::generate(1),
        &paracord_db::feeds::NewSource {
            kind: resolved.kind.as_str(),
            source_key: &resolved.source_key,
            url: &resolved.url,
            title: resolved.feed.title.as_deref(),
            site_url: resolved.site_url.as_deref(),
            icon_url: resolved.icon_url.as_deref(),
            next_check_at: feeds::next_check(resolved.kind, now, 0, rand::random::<f64>()),
        },
    )
    .await?;

    let mut options = resolved.options.clone();
    if let Some(object) = options.as_object_mut() {
        object.insert("display".to_string(), json!(resolved.display));
    }
    let options_text = serde_json::to_string(&options).map_err(internal)?;
    let feed = paracord_db::feeds::create_feed(
        &state.db,
        &paracord_db::feeds::NewGuildFeed {
            id: paracord_util::snowflake::generate(1),
            guild_id,
            channel_id: channel.id,
            source_id,
            creator_id: auth.user_id,
            kind: resolved.kind.as_str(),
            name: &name,
            options: &options_text,
            secret: secret.as_deref(),
            show_on_front_page: body.show_on_front_page.unwrap_or(true),
        },
    )
    .await?;

    feeds_poll::record_items_seen(&state, feed.id, &resolved.feed.items, now)
        .await
        .map_err(internal)?;

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "feeds": {
                "added": { "id": feed.id.to_string(), "kind": feed.kind, "name": feed.name,
                           "channel_id": feed.channel_id.to_string() }
            }
        })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "feed": feed_with_source(&state, &feed).await?,
            "newest": resolved.feed.items.first().map(item_summary),
        })),
    ))
}

#[derive(Debug, Deserialize, Default)]
pub struct UpdateBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub show_on_front_page: Option<bool>,
    #[serde(default)]
    pub paused: Option<bool>,
    /// Jellyfin: a new API key. Checked against the server before saving.
    #[serde(default)]
    pub api_key: Option<String>,
}

/// `PATCH /guilds/{guild_id}/feeds/{feed_id}`
pub async fn update_feed(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, feed_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>, ApiError> {
    let owner_id = ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let feed = load_feed(&state, guild_id, feed_id).await?;
    let name = match body.name.as_deref() {
        Some(name) => clean_name(name)?,
        None => feed.name.clone(),
    };
    let channel_id = match body.channel_id.as_deref() {
        Some(raw) => {
            let channel_id = parse_id(raw, "channel_id")?;
            if channel_id != feed.channel_id {
                require_destination(&state, guild_id, owner_id, auth.user_id, channel_id).await?;
            }
            channel_id
        }
        None => feed.channel_id,
    };

    let mut source_id = feed.source_id;
    let mut secret = feed.secret.clone();
    if let Some(key) = body
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        if feed.kind != FeedKind::Jellyfin.as_str() {
            return Err(ApiError::BadRequest(
                "Only a Jellyfin feed takes an API key.".into(),
            ));
        }
        let source = paracord_db::feeds::get_source(&state.db, feed.source_id)
            .await?
            .ok_or(ApiError::NotFound)?;
        let resolved = resolve(
            &state,
            &SourceInput {
                kind: FeedKind::Jellyfin,
                input: source.url.clone(),
                github_mode: None,
                branch: None,
                api_key: Some(key.to_string()),
            },
        )
        .await?;
        source_id = paracord_db::feeds::upsert_source(
            &state.db,
            paracord_util::snowflake::generate(1),
            &paracord_db::feeds::NewSource {
                kind: resolved.kind.as_str(),
                source_key: &resolved.source_key,
                url: &resolved.url,
                title: resolved.feed.title.as_deref(),
                site_url: resolved.site_url.as_deref(),
                icon_url: resolved.icon_url.as_deref(),
                next_check_at: feeds::next_check(
                    FeedKind::Jellyfin,
                    Utc::now(),
                    0,
                    rand::random::<f64>(),
                ),
            },
        )
        .await?;
        secret = Some(seal_secret(&state, key)?);
        feeds_poll::record_items_seen(&state, feed.id, &resolved.feed.items, Utc::now())
            .await
            .map_err(internal)?;
    }

    let updated = paracord_db::feeds::update_feed(
        &state.db,
        feed.id,
        &paracord_db::feeds::FeedUpdate {
            source_id,
            name: &name,
            channel_id,
            show_on_front_page: body.show_on_front_page.unwrap_or(feed.show_on_front_page),
            paused: body.paused.unwrap_or(feed.paused),
            secret: secret.as_deref(),
        },
    )
    .await?;
    if channel_id != feed.channel_id {
        // A new channel starts with a clean slate.
        paracord_db::feeds::record_delivery(&state.db, feed.id, None, None).await?;
    }
    if source_id != feed.source_id {
        paracord_db::feeds::delete_source_if_orphaned(&state.db, feed.source_id).await?;
    }
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "feeds": {
                "updated": { "id": updated.id.to_string(), "name": updated.name,
                             "channel_id": updated.channel_id.to_string(),
                             "paused": updated.paused,
                             "show_on_front_page": updated.show_on_front_page }
            }
        })),
    )
    .await;
    let refreshed = paracord_db::feeds::get_feed(&state.db, updated.id)
        .await?
        .unwrap_or(updated);
    Ok(Json(feed_with_source(&state, &refreshed).await?))
}

/// `DELETE /guilds/{guild_id}/feeds/{feed_id}`. Its posts stay in the channel.
pub async fn delete_feed(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, feed_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let feed = load_feed(&state, guild_id, feed_id).await?;
    paracord_db::feeds::delete_feed(&state.db, feed.id).await?;
    paracord_db::feeds::delete_source_if_orphaned(&state.db, feed.source_id).await?;
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({ "feeds": { "removed": { "id": feed.id.to_string(), "name": feed.name } } })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /guilds/{guild_id}/feeds/{feed_id}/post-latest`: post the newest
/// item the feed has seen, now, whether or not it was posted before.
pub async fn post_latest(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, feed_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    let owner_id = ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let feed = load_feed(&state, guild_id, feed_id).await?;
    require_destination(&state, guild_id, owner_id, auth.user_id, feed.channel_id).await?;
    let raw = paracord_db::feeds::newest_item(&state.db, feed.id)
        .await?
        .ok_or_else(|| {
            ApiError::BadRequest("This feed hasn't seen anything to post yet.".into())
        })?;
    let item: feeds::FeedItem = serde_json::from_str(&raw).map_err(internal)?;
    let message_id = feeds_poll::post_item_now(&state, &feed, &item)
        .await
        .map_err(ApiError::BadRequest)?;
    Ok(Json(json!({ "message_id": message_id.to_string() })))
}

// ── Admin → Add-ons ────────────────────────────────────────────────────────

async fn admin_addons_payload(state: &AppState) -> Result<Value, ApiError> {
    let client_id = paracord_db::server_settings::get_setting(&state.db, TWITCH_CLIENT_ID_SETTING)
        .await?
        .filter(|value| !value.trim().is_empty());
    let secret_set = paracord_db::server_settings::get_setting(&state.db, TWITCH_SECRET_SETTING)
        .await?
        .is_some_and(|value| !value.trim().is_empty());
    Ok(json!({
        "local_network_allowed": feeds::local_network_allowed(&state.db).await,
        "twitch_client_id": client_id,
        "twitch_secret_set": secret_set,
        "feeds_per_server": feeds::max_feeds_per_guild(),
    }))
}

/// `GET /admin/addons`
pub async fn get_admin_addons(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(admin_addons_payload(&state).await?))
}

#[derive(Debug, Deserialize)]
pub struct AdminAddonsBody {
    #[serde(default)]
    pub local_network_allowed: Option<bool>,
    /// Empty clears it.
    #[serde(default)]
    pub twitch_client_id: Option<String>,
    /// Empty clears it. Never sent back.
    #[serde(default)]
    pub twitch_client_secret: Option<String>,
}

/// `PATCH /admin/addons`
pub async fn update_admin_addons(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<AdminAddonsBody>,
) -> Result<Json<Value>, ApiError> {
    if let Some(allowed) = body.local_network_allowed {
        paracord_db::server_settings::set_setting(
            &state.db,
            feeds::LOCAL_NETWORK_SETTING,
            if allowed { "true" } else { "false" },
        )
        .await?;
    }
    if let Some(client_id) = body.twitch_client_id.as_deref() {
        let client_id = client_id.trim();
        if client_id.len() > 128 || !client_id.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Err(ApiError::BadRequest(
                "A Twitch client id is letters and digits only.".into(),
            ));
        }
        paracord_db::server_settings::set_setting(&state.db, TWITCH_CLIENT_ID_SETTING, client_id)
            .await?;
        feeds::forget_twitch_token();
    }
    if let Some(secret) = body.twitch_client_secret.as_deref() {
        let secret = secret.trim();
        if secret.len() > 256 {
            return Err(ApiError::BadRequest(
                "That client secret is too long.".into(),
            ));
        }
        let stored = if secret.is_empty() {
            String::new()
        } else {
            seal_secret(&state, secret)?
        };
        paracord_db::server_settings::set_setting(&state.db, TWITCH_SECRET_SETTING, &stored)
            .await?;
        feeds::forget_twitch_token();
    }
    Ok(Json(admin_addons_payload(&state).await?))
}
