//! Sports add-on: per-server league list and the shared scoreboard.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use paracord_core::sports::{
    format_rfc3339, is_valid_event_id, is_valid_league_path, league_catalog, scoreboard,
    FavoriteTeam, DEFAULT_LEAGUE_PATHS,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Serialize;
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
const LEAGUE_NOT_FOLLOWED: &str = "This server is not following that league.";
const EVENT_ID: &str = "An event id must be 1 to 20 digits.";
const LEAGUE_PATH: &str = "A league path must be one sport/league segment using only letters, digits, dots, and hyphens, at most 48 characters.";

struct StoredSports {
    enabled: bool,
    leagues: Vec<String>,
    favorites: Vec<FavoriteTeam>,
    show_on_server_page: bool,
    default_view: String,
    layout: String,
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
        Ok(Self {
            enabled: row.enabled,
            leagues,
            favorites,
            show_on_server_page: row.show_on_server_page,
            default_view: row.default_view,
            layout: row.layout,
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
    updated_at: String,
}

struct SettingsPatch {
    enabled: Option<bool>,
    leagues: Option<Vec<String>>,
    favorites: Option<Vec<FavoriteTeam>>,
    show_on_server_page: Option<bool>,
    default_view: Option<String>,
    layout: Option<String>,
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
    let settings = load_settings(&state, guild_id).await?;
    Ok(Json(settings.to_response(guild_id)))
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
            }
        })),
    )
    .await;

    Ok(Json(saved.to_response(guild_id)))
}

pub async fn get_board(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Response, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let settings = load_settings(&state, guild_id).await?;
    if !settings.enabled {
        return Ok(addon_disabled());
    }
    let board = scoreboard()
        .board(&settings.leagues, &settings.favorites)
        .await;
    Ok(Json(board).into_response())
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
