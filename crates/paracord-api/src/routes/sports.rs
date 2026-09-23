//! Sports add-on: per-server league list and the shared scoreboard.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, NaiveDate, Utc};
use paracord_core::sports::{
    format_rfc3339, is_valid_event_id, is_valid_league_path, league_catalog, scoreboard,
    FavoriteTeam, DEFAULT_LEAGUE_PATHS,
};
use paracord_core::AppState;
use paracord_db::channels::ChannelRow;
use paracord_models::permissions::Permissions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use super::audit;
use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_LEAGUES: usize = 12;
const MAX_FAVORITES: usize = 24;
const MAX_TEAM_ID: usize = 32;
const MAX_ABBR: usize = 12;
const MAX_NAME: usize = 80;
const ADDON_OFF: &str = "The sports add-on is not turned on for this server.";
const TEAMS_UNAVAILABLE: &str = "The team list for this league is unavailable.";
const DETAIL_UNAVAILABLE: &str = "This game's detail is unavailable.";
const STANDINGS_UNAVAILABLE: &str = "Standings for this league are unavailable.";
const LEAGUE_NOT_FOLLOWED: &str = "This server is not following that league.";
const EVENT_ID: &str = "An event id must be 1 to 20 digits.";
const LEAGUE_PATH: &str = "A league path must be one sport/league segment using only letters, digits, dots, and hyphens, at most 48 characters.";
const MAX_PINS: usize = 32;
const TEXT_CHANNEL: i16 = 0;
const PIN_FINAL_FOR: chrono::Duration = chrono::Duration::hours(3);
const NOT_TEXT: &str = "A pin has to be on a text channel.";
const PIN_MISSING: &str = "Nothing is pinned in that channel.";
const PIN_CAP: &str = "A server can pin at most 32 games.";
const GAME_SHAPE: &str = "A pinned game must be sport/league/event_id.";
const DATE_WINDOW: &str = "A scoreboard date is YYYYMMDD, from 14 days ago through 14 days ahead.";

fn default_announce() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub(crate) struct ChannelPin {
    pub(crate) channel_id: String,
    pub(crate) game: String,
    pub(crate) pinned_by: String,
    pub(crate) pinned_at: String,
    #[serde(default = "default_announce")]
    pub(crate) announce: bool,
    #[serde(default)]
    pub(crate) announced_through: Option<String>,
    #[serde(default)]
    pub(crate) announced_final: bool,
    #[serde(default)]
    pub(crate) announced_halftime: bool,
    #[serde(default)]
    pub(crate) announced_regulation: bool,
    #[serde(default)]
    pub(crate) announce_blocked: Option<String>,
    /// Drop the pin at the final instead of a few hours after it. The final
    /// score line still posts first when the pin announces.
    #[serde(default)]
    pub(crate) unpin_at_final: bool,
}

struct StoredSports {
    enabled: bool,
    leagues: Vec<String>,
    favorites: Vec<FavoriteTeam>,
    show_on_server_page: bool,
    default_view: String,
    layout: String,
    pins: Vec<ChannelPin>,
    score_alerts: bool,
    stored: bool,
    updated_at: DateTime<Utc>,
}

impl StoredSports {
    fn defaults() -> Self {
        Self {
            enabled: false,
            leagues: DEFAULT_LEAGUE_PATHS
                .iter()
                .map(|path| (*path).to_string())
                .collect(),
            favorites: Vec::new(),
            show_on_server_page: true,
            default_view: "all".to_string(),
            layout: "cards".to_string(),
            pins: Vec::new(),
            score_alerts: false,
            stored: false,
            updated_at: DateTime::<Utc>::UNIX_EPOCH,
        }
    }

    fn from_row(row: paracord_db::guild_sports::GuildSportsRow) -> Result<Self, ApiError> {
        let leagues = serde_json::from_str(&row.leagues).map_err(|err| {
            ApiError::Internal(anyhow::anyhow!("invalid stored sports leagues: {err}"))
        })?;
        let favorites = serde_json::from_str(&row.favorite_teams).map_err(|err| {
            ApiError::Internal(anyhow::anyhow!("invalid stored sports favorites: {err}"))
        })?;
        let pins = serde_json::from_str(&row.channel_pins).unwrap_or_default();
        Ok(Self {
            enabled: row.enabled,
            leagues,
            favorites,
            show_on_server_page: row.show_on_server_page,
            default_view: row.default_view,
            layout: row.layout,
            pins,
            score_alerts: row.score_alerts,
            stored: true,
            updated_at: row.updated_at,
        })
    }

    fn to_response(&self, guild_id: i64) -> SportsSettingsResponse {
        SportsSettingsResponse {
            guild_id: guild_id.to_string(),
            enabled: self.enabled,
            leagues: self.leagues.clone(),
            favorite_teams: self.favorites.clone(),
            show_on_server_page: self.show_on_server_page,
            default_view: self.default_view.clone(),
            layout: self.layout.clone(),
            channel_pins: self.pins.clone(),
            score_alerts: self.score_alerts,
            updated_at: format_rfc3339(self.updated_at),
        }
    }
}

#[derive(Serialize)]
pub struct SportsSettingsResponse {
    guild_id: String,
    enabled: bool,
    leagues: Vec<String>,
    favorite_teams: Vec<FavoriteTeam>,
    show_on_server_page: bool,
    default_view: String,
    layout: String,
    channel_pins: Vec<ChannelPin>,
    score_alerts: bool,
    updated_at: String,
}

struct SettingsPatch {
    enabled: Option<bool>,
    leagues: Option<Vec<String>>,
    favorites: Option<Vec<FavoriteTeam>>,
    show_on_server_page: Option<bool>,
    default_view: Option<String>,
    layout: Option<String>,
    score_alerts: Option<bool>,
}

pub async fn list_leagues(_auth: AuthUser) -> Json<Value> {
    Json(json!({ "leagues": league_catalog() }))
}

pub async fn list_teams(
    _auth: AuthUser,
    Path((sport, league)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let path = format!("{sport}/{league}");
    if !is_valid_league_path(&path) {
        return Err(ApiError::BadRequest(LEAGUE_PATH.to_string()));
    }
    match scoreboard().teams(&path).await {
        Ok(roster) => Ok(Json(roster).into_response()),
        Err(_) => Ok(teams_unavailable()),
    }
}

pub async fn get_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<SportsSettingsResponse>, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let settings = load_pruned(&state, guild_id).await?;
    Ok(Json(settings.to_response(guild_id)))
}

pub async fn put_pin(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, channel_id)): Path<(i64, i64)>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let mut settings = load_settings(&state, guild_id).await?;
    if !settings.enabled {
        return Ok(addon_disabled());
    }
    require_text_channel(&state, guild_id, channel_id).await?;
    require_pin_permission(&state, guild_id, auth.user_id, channel_id).await?;
    let (league, event_id) = pin_game(&body)?;
    if !settings
        .leagues
        .iter()
        .any(|followed| followed.eq_ignore_ascii_case(&league))
    {
        return Err(ApiError::BadRequest(LEAGUE_NOT_FOLLOWED.to_string()));
    }
    let game = format!("{league}/{event_id}");
    prune_pins(&mut settings);
    let channel_key = channel_id.to_string();
    let previous = settings
        .pins
        .iter()
        .find(|item| item.channel_id == channel_key)
        .cloned();
    let announce = pin_flag(
        &body,
        "announce",
        previous.as_ref().map(|pin| pin.announce),
        true,
    )?;
    let unpin_at_final = pin_flag(
        &body,
        "unpin_at_final",
        previous.as_ref().map(|pin| pin.unpin_at_final),
        false,
    )?;
    let carried = previous.as_ref().filter(|pin| pin.game == game);
    let pin = ChannelPin {
        channel_id: channel_key.clone(),
        game,
        pinned_by: auth.user_id.to_string(),
        pinned_at: format_rfc3339(Utc::now()),
        announce,
        announced_through: carried.and_then(|pin| pin.announced_through.clone()),
        announced_final: carried.is_some_and(|pin| pin.announced_final),
        announced_halftime: carried.is_some_and(|pin| pin.announced_halftime),
        announced_regulation: carried.is_some_and(|pin| pin.announced_regulation),
        announce_blocked: carried.and_then(|pin| pin.announce_blocked.clone()),
        unpin_at_final,
    };
    if let Some(existing) = settings
        .pins
        .iter_mut()
        .find(|item| item.channel_id == channel_key)
    {
        *existing = pin;
    } else if settings.pins.len() >= MAX_PINS {
        return Err(ApiError::BadRequest(PIN_CAP.to_string()));
    } else {
        settings.pins.push(pin);
    }
    save_pins(&state, guild_id, &settings).await?;
    Ok(Json(settings.to_response(guild_id)).into_response())
}

pub async fn delete_pin(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, channel_id)): Path<(i64, i64)>,
) -> Result<Response, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let mut settings = load_settings(&state, guild_id).await?;
    if !settings.enabled {
        return Ok(addon_disabled());
    }
    require_text_channel(&state, guild_id, channel_id).await?;
    require_pin_permission(&state, guild_id, auth.user_id, channel_id).await?;
    prune_pins(&mut settings);
    let channel_key = channel_id.to_string();
    let before = settings.pins.len();
    settings.pins.retain(|pin| pin.channel_id != channel_key);
    if settings.pins.len() == before {
        save_pins(&state, guild_id, &settings).await?;
        return Ok(pin_missing());
    }
    save_pins(&state, guild_id, &settings).await?;
    Ok(Json(settings.to_response(guild_id)).into_response())
}

pub async fn put_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Json<SportsSettingsResponse>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let patch = parse_patch(&body)?;
    let mut settings = load_settings(&state, guild_id).await?;
    if let Some(enabled) = patch.enabled {
        settings.enabled = enabled;
    }
    if let Some(leagues) = patch.leagues {
        settings.leagues = leagues;
    }
    if let Some(favorites) = patch.favorites {
        settings.favorites = favorites;
    }
    if let Some(show) = patch.show_on_server_page {
        settings.show_on_server_page = show;
    }
    if let Some(view) = patch.default_view {
        settings.default_view = view;
    }
    if let Some(layout) = patch.layout {
        settings.layout = layout;
    }
    if let Some(alerts) = patch.score_alerts {
        settings.score_alerts = alerts;
    }
    validate_settings(&settings)?;

    let leagues_json = serde_json::to_string(&settings.leagues)
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    let favorites_json = serde_json::to_string(&settings.favorites)
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    let row = paracord_db::guild_sports::upsert(
        &state.db,
        guild_id,
        settings.enabled,
        &leagues_json,
        &favorites_json,
        settings.show_on_server_page,
        &settings.default_view,
        &settings.layout,
        settings.score_alerts,
    )
    .await?;
    let saved = StoredSports::from_row(row)?;

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "sports": {
                "enabled": saved.enabled,
                "leagues": saved.leagues,
                "favorite_teams": saved.favorites,
                "show_on_server_page": saved.show_on_server_page,
                "default_view": saved.default_view,
                "layout": saved.layout,
                "score_alerts": saved.score_alerts,
            }
        })),
    )
    .await;

    Ok(Json(saved.to_response(guild_id)))
}

#[derive(Debug, Deserialize, Default)]
pub struct BoardQuery {
    date: Option<String>,
}

pub async fn get_board(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(query): Query<BoardQuery>,
) -> Result<Response, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let settings = load_settings(&state, guild_id).await?;
    if !settings.enabled {
        return Ok(addon_disabled());
    }
    let day = parse_board_date(query.date.as_deref())?;
    let board = scoreboard()
        .board_on(&settings.leagues, &settings.favorites, day)
        .await;
    Ok(Json(board).into_response())
}

fn parse_board_date(raw: Option<&str>) -> Result<Option<NaiveDate>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    let day = NaiveDate::parse_from_str(raw, "%Y%m%d")
        .map_err(|_| ApiError::BadRequest(DATE_WINDOW.to_string()))?;
    let today = Utc::now().date_naive();
    let delta = (day - today).num_days();
    if !(-14..=14).contains(&delta) {
        return Err(ApiError::BadRequest(DATE_WINDOW.to_string()));
    }
    Ok(Some(day))
}

pub async fn get_game(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, sport, league, event_id)): Path<(i64, String, String, String)>,
) -> Result<Response, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let settings = load_settings(&state, guild_id).await?;
    if !settings.enabled {
        return Ok(addon_disabled());
    }
    let path = format!("{sport}/{league}").to_ascii_lowercase();
    if !is_valid_league_path(&path) {
        return Err(ApiError::BadRequest(LEAGUE_PATH.to_string()));
    }
    if !settings
        .leagues
        .iter()
        .any(|followed| followed.eq_ignore_ascii_case(&path))
    {
        return Err(ApiError::BadRequest(LEAGUE_NOT_FOLLOWED.to_string()));
    }
    if !is_valid_event_id(&event_id) {
        return Err(ApiError::BadRequest(EVENT_ID.to_string()));
    }
    match scoreboard()
        .detail(&path, &event_id, &settings.favorites)
        .await
    {
        Ok(detail) => Ok(Json(detail).into_response()),
        Err(_) => Ok(detail_unavailable()),
    }
}

pub async fn get_standings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, sport, league)): Path<(i64, String, String)>,
) -> Result<Response, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let settings = load_settings(&state, guild_id).await?;
    if !settings.enabled {
        return Ok(addon_disabled());
    }
    let path = format!("{sport}/{league}").to_ascii_lowercase();
    if !is_valid_league_path(&path) {
        return Err(ApiError::BadRequest(LEAGUE_PATH.to_string()));
    }
    if !settings
        .leagues
        .iter()
        .any(|followed| followed.eq_ignore_ascii_case(&path))
    {
        return Err(ApiError::BadRequest(LEAGUE_NOT_FOLLOWED.to_string()));
    }
    match scoreboard().standings(&path, &settings.favorites).await {
        Ok(table) => Ok(Json(table).into_response()),
        Err(_) => Ok(bad_gateway(STANDINGS_UNAVAILABLE)),
    }
}

fn bad_gateway(message: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "code": "BAD_GATEWAY",
            "message": message,
            "error": message,
            "details": Value::Null,
        })),
    )
        .into_response()
}

fn detail_unavailable() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "code": "BAD_GATEWAY",
            "message": DETAIL_UNAVAILABLE,
            "error": DETAIL_UNAVAILABLE,
            "details": Value::Null,
        })),
    )
        .into_response()
}

fn teams_unavailable() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "code": "BAD_GATEWAY",
            "message": TEAMS_UNAVAILABLE,
            "error": TEAMS_UNAVAILABLE,
            "details": Value::Null,
        })),
    )
        .into_response()
}

fn addon_disabled() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "code": "NOT_FOUND",
            "message": ADDON_OFF,
            "error": ADDON_OFF,
            "details": Value::Null,
        })),
    )
        .into_response()
}

async fn load_settings(state: &AppState, guild_id: i64) -> Result<StoredSports, ApiError> {
    match paracord_db::guild_sports::get(&state.db, guild_id).await? {
        Some(row) => StoredSports::from_row(row),
        None => Ok(StoredSports::defaults()),
    }
}

async fn load_pruned(state: &AppState, guild_id: i64) -> Result<StoredSports, ApiError> {
    let mut settings = load_settings(state, guild_id).await?;
    let before = settings.pins.clone();
    prune_pins(&mut settings);
    if settings.stored && settings.pins != before {
        save_pins(state, guild_id, &settings).await?;
    }
    Ok(settings)
}

fn prune_pins(settings: &mut StoredSports) {
    let now = Utc::now();
    let leagues = settings.leagues.clone();
    settings
        .pins
        .retain(|pin| pin_still_current(pin, &leagues, now));
}

fn pin_still_current(pin: &ChannelPin, leagues: &[String], now: DateTime<Utc>) -> bool {
    let Some((league, event_id)) = split_pin_game(&pin.game) else {
        return false;
    };
    if !leagues
        .iter()
        .any(|followed| followed.eq_ignore_ascii_case(&league))
    {
        return false;
    }
    let Some(cached) = scoreboard().cached_league(&league) else {
        return true;
    };
    if !cached.reliable {
        return true;
    }
    match cached.games.iter().find(|game| game.id == event_id) {
        None => false,
        Some(game) if !game.state.eq_ignore_ascii_case("post") => true,
        Some(_) if pin.unpin_at_final && final_is_out(pin) => false,
        Some(game) => now - game.start <= PIN_FINAL_FOR,
    }
}

/// Nothing is left to post for this pin: the final went out, or it never will.
fn final_is_out(pin: &ChannelPin) -> bool {
    !pin.announce || pin.announce_blocked.is_some() || pin.announced_final
}

pub(crate) fn split_pin_game(game: &str) -> Option<(String, String)> {
    let game = game.trim();
    let mut parts: Vec<&str> = game.split('/').collect();
    if parts.len() < 3 {
        return None;
    }
    let event_id = parts.pop()?;
    let league = parts.join("/");
    if !is_valid_league_path(&league) || !is_valid_event_id(event_id) {
        return None;
    }
    Some((league.to_ascii_lowercase(), event_id.to_string()))
}

/// A pin's switch from the request, or what the channel's pin already had, or `default`.
fn pin_flag(
    body: &Value,
    key: &str,
    previous: Option<bool>,
    default: bool,
) -> Result<bool, ApiError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(previous.unwrap_or(default)),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(ApiError::BadRequest(format!(
            "{key} must be true or false."
        ))),
    }
}

fn pin_game(body: &Value) -> Result<(String, String), ApiError> {
    let game = body
        .get("game")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|game| !game.is_empty())
        .ok_or_else(|| ApiError::BadRequest(GAME_SHAPE.to_string()))?;
    let mut parts: Vec<&str> = game.split('/').collect();
    if parts.len() < 3 {
        return Err(ApiError::BadRequest(GAME_SHAPE.to_string()));
    }
    let event_id = parts.pop().unwrap_or("");
    let league = parts.join("/");
    if !is_valid_league_path(&league) {
        return Err(ApiError::BadRequest(LEAGUE_PATH.to_string()));
    }
    if !is_valid_event_id(event_id) {
        return Err(ApiError::BadRequest(EVENT_ID.to_string()));
    }
    Ok((league.to_ascii_lowercase(), event_id.to_string()))
}

async fn save_pins(
    state: &AppState,
    guild_id: i64,
    settings: &StoredSports,
) -> Result<(), ApiError> {
    let pins = serde_json::to_string(&settings.pins)
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    paracord_db::guild_sports::set_channel_pins(&state.db, guild_id, &pins).await?;
    Ok(())
}

async fn require_text_channel(
    state: &AppState,
    guild_id: i64,
    channel_id: i64,
) -> Result<ChannelRow, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await?
        .filter(|channel| channel.space_id == Some(guild_id))
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != TEXT_CHANNEL {
        return Err(ApiError::BadRequest(NOT_TEXT.to_string()));
    }
    Ok(channel)
}

async fn require_pin_permission(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
    channel_id: i64,
) -> Result<(), ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let channel_perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    if channel_perms.contains(Permissions::MANAGE_CHANNELS)
        || channel_perms.contains(Permissions::MANAGE_GUILD)
    {
        return Ok(());
    }
    let guild_perms = paracord_core::permissions::compute_guild_permissions(
        &state.db,
        guild_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(guild_perms, Permissions::MANAGE_GUILD)?;
    Ok(())
}

fn pin_missing() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "code": "NOT_FOUND",
            "message": PIN_MISSING,
            "error": PIN_MISSING,
            "details": Value::Null,
        })),
    )
        .into_response()
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

fn parse_patch(body: &Value) -> Result<SettingsPatch, ApiError> {
    let object = body.as_object().ok_or_else(|| {
        ApiError::BadRequest("Sports settings must be a JSON object.".to_string())
    })?;
    Ok(SettingsPatch {
        enabled: optional_bool(object, "enabled")?,
        leagues: optional_leagues(object)?,
        favorites: optional_favorites(object)?,
        show_on_server_page: optional_bool(object, "show_on_server_page")?,
        default_view: optional_view(object)?,
        layout: optional_layout(object)?,
        score_alerts: optional_bool(object, "score_alerts")?,
    })
}

fn optional_layout(object: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match object.get("layout") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let layout = value.trim().to_ascii_lowercase();
            if matches!(layout.as_str(), "cards" | "list") {
                Ok(Some(layout))
            } else {
                Err(ApiError::BadRequest(
                    "layout must be cards or list.".to_string(),
                ))
            }
        }
        Some(_) => Err(ApiError::BadRequest(
            "layout must be cards or list.".to_string(),
        )),
    }
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, ApiError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ApiError::BadRequest(format!(
            "{key} must be true or false."
        ))),
    }
}

fn optional_view(object: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match object.get("default_view") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let view = value.trim().to_ascii_lowercase();
            if matches!(view.as_str(), "all" | "live" | "favorites") {
                Ok(Some(view))
            } else {
                Err(ApiError::BadRequest(
                    "default_view must be all, live, or favorites.".to_string(),
                ))
            }
        }
        Some(_) => Err(ApiError::BadRequest(
            "default_view must be all, live, or favorites.".to_string(),
        )),
    }
}

fn optional_leagues(object: &Map<String, Value>) -> Result<Option<Vec<String>>, ApiError> {
    match object.get("leagues") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut leagues = Vec::with_capacity(items.len());
            let mut seen = HashSet::new();
            for item in items {
                let Some(raw) = item.as_str() else {
                    return Err(ApiError::BadRequest(
                        "leagues must be a list of league paths.".to_string(),
                    ));
                };
                let path = raw.trim().to_ascii_lowercase();
                if !is_valid_league_path(&path) {
                    return Err(ApiError::BadRequest(LEAGUE_PATH.to_string()));
                }
                if !seen.insert(path.clone()) {
                    return Err(ApiError::BadRequest(
                        "Each league can only be listed once.".to_string(),
                    ));
                }
                leagues.push(path);
            }
            if !(1..=MAX_LEAGUES).contains(&leagues.len()) {
                return Err(ApiError::BadRequest(
                    "Choose between 1 and 12 leagues.".to_string(),
                ));
            }
            Ok(Some(leagues))
        }
        Some(_) => Err(ApiError::BadRequest(
            "leagues must be a list of league paths.".to_string(),
        )),
    }
}

fn optional_favorites(object: &Map<String, Value>) -> Result<Option<Vec<FavoriteTeam>>, ApiError> {
    match object.get("favorite_teams") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            if items.len() > MAX_FAVORITES {
                return Err(ApiError::BadRequest(
                    "Choose at most 24 favorite teams.".to_string(),
                ));
            }
            let mut favorites = Vec::with_capacity(items.len());
            let mut seen = HashSet::new();
            for item in items {
                let Some(team) = item.as_object() else {
                    return Err(ApiError::BadRequest(
                        "Each favorite team must be an object with league, team_id, abbr, and name.".to_string(),
                    ));
                };
                let league = required_string(team, "league")?.trim().to_ascii_lowercase();
                let team_id = required_string(team, "team_id")?.trim().to_string();
                let abbr = required_string(team, "abbr")?.trim().to_string();
                let name = required_string(team, "name")?.trim().to_string();
                if !is_valid_league_path(&league) {
                    return Err(ApiError::BadRequest(
                        "A favorite team's league must be a sport/league path.".to_string(),
                    ));
                }
                if !valid_token(&team_id, MAX_TEAM_ID) {
                    return Err(ApiError::BadRequest(
                        "A favorite team id must be 1 to 32 letters or digits.".to_string(),
                    ));
                }
                if !valid_token(&abbr, MAX_ABBR) {
                    return Err(ApiError::BadRequest(
                        "A favorite abbreviation must be 1 to 12 letters or digits.".to_string(),
                    ));
                }
                if name.is_empty()
                    || name.chars().count() > MAX_NAME
                    || name.chars().any(char::is_control)
                {
                    return Err(ApiError::BadRequest(
                        "A favorite team name must be 1 to 80 characters.".to_string(),
                    ));
                }
                let key = format!("{league}:{team_id}");
                if !seen.insert(key) {
                    return Err(ApiError::BadRequest(
                        "Each favorite team can only be listed once.".to_string(),
                    ));
                }
                favorites.push(FavoriteTeam {
                    league,
                    team_id,
                    abbr,
                    name,
                });
            }
            Ok(Some(favorites))
        }
        Some(_) => Err(ApiError::BadRequest(
            "favorite_teams must be a list of teams.".to_string(),
        )),
    }
}

fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, ApiError> {
    object.get(key).and_then(Value::as_str).ok_or_else(|| {
        ApiError::BadRequest(
            "Each favorite team must be an object with league, team_id, abbr, and name."
                .to_string(),
        )
    })
}

fn valid_token(value: &str, max: usize) -> bool {
    let len = value.chars().count();
    (1..=max).contains(&len) && value.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn validate_settings(settings: &StoredSports) -> Result<(), ApiError> {
    if !(1..=MAX_LEAGUES).contains(&settings.leagues.len()) {
        return Err(ApiError::BadRequest(
            "Choose between 1 and 12 leagues.".to_string(),
        ));
    }
    if settings.favorites.len() > MAX_FAVORITES {
        return Err(ApiError::BadRequest(
            "Choose at most 24 favorite teams.".to_string(),
        ));
    }
    if !matches!(settings.default_view.as_str(), "all" | "live" | "favorites") {
        return Err(ApiError::BadRequest(
            "default_view must be all, live, or favorites.".to_string(),
        ));
    }
    if !matches!(settings.layout.as_str(), "cards" | "list") {
        return Err(ApiError::BadRequest(
            "layout must be cards or list.".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_without_announce_fields_stays_on() {
        let pin: ChannelPin = serde_json::from_str(
            r#"{"channel_id":"1","game":"football/nfl/100","pinned_by":"2","pinned_at":"2026-09-22T00:00:00Z"}"#,
        )
        .expect("pin");
        assert!(pin.announce);
        assert!(!pin.announced_final);
        assert!(pin.announced_through.is_none());
        assert!(pin.announce_blocked.is_none());
        assert!(!pin.unpin_at_final);
    }

    #[test]
    fn unpin_at_final_waits_for_the_final_line() {
        let mut pin: ChannelPin = serde_json::from_str(
            r#"{"channel_id":"1","game":"football/nfl/100","pinned_by":"2","pinned_at":"2026-09-22T00:00:00Z","unpin_at_final":true}"#,
        )
        .expect("pin");
        assert!(pin.unpin_at_final);
        assert!(!final_is_out(&pin));
        pin.announced_final = true;
        assert!(final_is_out(&pin));
        pin.announced_final = false;
        pin.announce = false;
        assert!(final_is_out(&pin));
        pin.announce = true;
        pin.announce_blocked = Some("encrypted".to_string());
        assert!(final_is_out(&pin));
    }

    #[test]
    fn a_pin_flag_keeps_the_previous_value_when_absent() {
        let body = json!({ "game": "football/nfl/1" });
        assert!(pin_flag(&body, "unpin_at_final", Some(true), false).unwrap());
        assert!(!pin_flag(&body, "unpin_at_final", None, false).unwrap());
        let body = json!({ "game": "football/nfl/1", "unpin_at_final": true });
        assert!(pin_flag(&body, "unpin_at_final", Some(false), false).unwrap());
        let body = json!({ "unpin_at_final": "yes" });
        assert!(pin_flag(&body, "unpin_at_final", None, false).is_err());
    }
}
