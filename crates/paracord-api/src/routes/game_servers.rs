//! Game servers add-on: the list every member sees (sidebar, front page), and
//! the page in Server settings → Add-ons that adds, edits and removes them.
//!
//! Reading needs membership. Changing the list needs Manage Server, and an
//! announcement channel must be one the editor can send messages in. The
//! announcements then post as the game server, not as the person who set it up.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use paracord_core::feeds::local_network_allowed;
use paracord_core::game_servers::{
    self, GameAddress, GameKind, GameStatus, ProbeError, MAX_GAME_SERVERS_PER_GUILD,
};
use paracord_core::AppState;
use paracord_db::game_servers::{GameServerRow, TargetRow};
use paracord_models::permissions::Permissions;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use super::audit;
use super::game_servers_poll;
use crate::error::ApiError;
use crate::middleware::AuthUser;

const ADDON_OFF: &str = "Game servers are not turned on for this server.";
const MISSING: &str = "That game server isn't on this server.";
const NOT_TEXT: &str = "Announcements go to a text or announcement channel.";
const CANT_SEND: &str = "You can only announce in a channel you can send messages in.";
const ENCRYPTED: &str = "That channel holds end-to-end encrypted messages, so announcements can't be posted there. Pick another channel.";
const MAX_NAME_CHARS: usize = 80;

const CHANNEL_TYPE_TEXT: i16 = 0;
const CHANNEL_TYPE_ANNOUNCEMENT: i16 = 5;

// ── Permissions ────────────────────────────────────────────────────────────

/// A member of the server: its owner, and whether they may manage it.
async fn member_access(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(i64, bool), ApiError> {
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
    Ok((guild.owner_id, perms.contains(Permissions::MANAGE_GUILD)))
}

async fn ensure_manage_guild(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<i64, ApiError> {
    let (owner_id, can_manage) = member_access(state, guild_id, user_id).await?;
    if !can_manage {
        return Err(paracord_core::error::CoreError::MissingPermission.into());
    }
    Ok(owner_id)
}

/// The announcement channel: a text or announcement channel in this server
/// that the editor can send messages in, holding no encrypted messages.
async fn require_announce_channel(
    state: &AppState,
    guild_id: i64,
    owner_id: i64,
    user_id: i64,
    channel_id: i64,
) -> Result<(), ApiError> {
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
    Ok(())
}

fn parse_id(raw: &str, what: &str) -> Result<i64, ApiError> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest(format!("{what} must be an id.")))
}

fn clean_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(ApiError::BadRequest("A game server needs a name.".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(ApiError::BadRequest(format!(
            "A game server's name is at most {MAX_NAME_CHARS} characters."
        )));
    }
    if name.contains(['<', '>']) {
        return Err(ApiError::BadRequest(
            "A game server's name can't contain < or >.".into(),
        ));
    }
    Ok(name)
}

/// The name a game server gets when none is typed: its own name when it gave
/// one, its address otherwise.
fn default_name(status: Option<&GameStatus>, address: &GameAddress) -> String {
    let own = status
        .and_then(|status| status.name.as_deref())
        .map(|name| name.replace(['<', '>'], ""))
        .map(|name| name.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|name| !name.is_empty());
    let name = own.unwrap_or_else(|| address.display());
    game_servers::clip(&name, MAX_NAME_CHARS)
}

fn parse_kind(raw: &str) -> Result<GameKind, ApiError> {
    GameKind::parse(raw).ok_or_else(|| {
        ApiError::BadRequest(
            "kind must be minecraft_java, minecraft_bedrock, source or tcp.".into(),
        )
    })
}

fn parse_address(raw: &str, kind: GameKind) -> Result<GameAddress, ApiError> {
    GameAddress::parse(raw, kind).map_err(|err| ApiError::BadRequest(err.to_string()))
}

/// Probe once. An address the policy refuses is refused outright; any other
/// failure is a server that is down right now, which may still be added.
async fn probe_once(
    state: &AppState,
    kind: GameKind,
    address: &GameAddress,
) -> Result<Result<GameStatus, ProbeError>, ApiError> {
    let allow_private = local_network_allowed(&state.db).await;
    match game_servers::probe(kind, address, allow_private).await {
        Err(err) if err.is_refusal() => Err(ApiError::BadRequest(err.to_string())),
        result => Ok(result),
    }
}

// ── Wire shapes ────────────────────────────────────────────────────────────

fn time(value: Option<DateTime<Utc>>) -> Value {
    json!(value.map(|at| at.to_rfc3339()))
}

fn status_json(target: Option<&TargetRow>) -> Value {
    let Some(target) = target else {
        return json!({ "state": "checking" });
    };
    let state = if target.last_checked_at.is_none() {
        "checking"
    } else if target.online {
        "up"
    } else {
        "down"
    };
    let names: Option<Vec<String>> = target
        .player_names
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    json!({
        "state": state,
        "players_online": target.players_online,
        "players_max": target.players_max,
        "player_names": names,
        "server_name": target.server_name,
        "map": target.map,
        "version": target.version,
        "motd": target.motd,
        "latency_ms": target.latency_ms,
        "last_checked_at": time(target.last_checked_at),
        "last_seen_online": time(target.last_seen_online),
        "error": target.last_error,
    })
}

fn server_json(server: &GameServerRow, target: Option<&TargetRow>, can_manage: bool) -> Value {
    let mut out = json!({
        "id": server.id.to_string(),
        "guild_id": server.guild_id.to_string(),
        "kind": server.kind,
        "name": server.name,
        "address": server.address,
        "created_at": server.created_at.to_rfc3339(),
        "status": status_json(target),
    });
    if can_manage {
        if let Some(object) = out.as_object_mut() {
            object.insert(
                "announce_channel_id".into(),
                json!(server.announce_channel_id.map(|id| id.to_string())),
            );
            object.insert("announce_error".into(), json!(server.announce_error));
        }
    }
    out
}

async fn server_with_target(
    state: &AppState,
    server: &GameServerRow,
    can_manage: bool,
) -> Result<Value, ApiError> {
    let target = paracord_db::game_servers::get_target(&state.db, server.target_id).await?;
    Ok(server_json(server, target.as_ref(), can_manage))
}

async fn load_server(
    state: &AppState,
    guild_id: i64,
    server_id: i64,
) -> Result<GameServerRow, ApiError> {
    paracord_db::game_servers::get_game_server(&state.db, server_id)
        .await?
        .filter(|server| server.guild_id == guild_id)
        .ok_or_else(|| ApiError::BadRequest(MISSING.into()))
}

fn probe_json(
    kind: GameKind,
    address: &GameAddress,
    result: &Result<GameStatus, ProbeError>,
) -> Value {
    match result {
        Ok(status) => json!({
            "kind": kind.as_str(),
            "address": address.display(),
            "online": true,
            "name": default_name(Some(status), address),
            "players_online": status.players_online,
            "players_max": status.players_max,
            "player_names": status.player_names,
            "map": status.map,
            "version": status.version,
            "motd": status.motd,
            "latency_ms": status.latency_ms,
            "error": Value::Null,
        }),
        Err(err) => json!({
            "kind": kind.as_str(),
            "address": address.display(),
            "online": false,
            "name": default_name(None, address),
            "error": err.to_string(),
        }),
    }
}

/// Record a probe against a target (and announce for the target's other
/// listings), the way the poller does.
async fn apply_probe(
    state: &AppState,
    target_id: i64,
    result: Result<GameStatus, ProbeError>,
) -> Result<(), ApiError> {
    let target = paracord_db::game_servers::get_target(&state.db, target_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    game_servers_poll::apply_result(state, &target, result, Utc::now()).await;
    Ok(())
}

// ── Handlers ───────────────────────────────────────────────────────────────

/// `GET /guilds/{guild_id}/game-servers`: every member sees the list and how
/// each server is doing; managers also see announcement settings.
pub async fn list_game_servers(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let (_, can_manage) = member_access(&state, guild_id, auth.user_id).await?;
    let enabled = paracord_db::game_servers::is_enabled(&state.db, guild_id).await?;
    let mut servers = Vec::new();
    if enabled || can_manage {
        for row in paracord_db::game_servers::list_guild_game_servers(&state.db, guild_id).await? {
            servers.push(server_with_target(&state, &row, can_manage).await?);
        }
    }
    Ok(Json(json!({
        "enabled": enabled,
        "can_manage": can_manage,
        "limit": MAX_GAME_SERVERS_PER_GUILD,
        "servers": servers,
    })))
}

#[derive(Debug, Deserialize)]
pub struct SettingsBody {
    pub enabled: bool,
}

/// `PUT /guilds/{guild_id}/game-servers/settings`
pub async fn put_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<SettingsBody>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    paracord_db::game_servers::set_enabled(&state.db, guild_id, body.enabled).await?;
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({ "game_servers": { "enabled": body.enabled } })),
    )
    .await;
    Ok(Json(json!({ "enabled": body.enabled })))
}

#[derive(Debug, Deserialize)]
pub struct ProbeBody {
    pub kind: String,
    pub address: String,
}

/// `POST /guilds/{guild_id}/game-servers/preview`: probe an address before
/// saving it. 200 whether or not it answers; 400 when it may not be probed.
pub async fn preview(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<ProbeBody>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let kind = parse_kind(&body.kind)?;
    let address = parse_address(&body.address, kind)?;
    let result = probe_once(&state, kind, &address).await?;
    Ok(Json(probe_json(kind, &address, &result)))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub kind: String,
    pub address: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub announce_channel_id: Option<String>,
}

/// `POST /guilds/{guild_id}/game-servers`
pub async fn create_game_server(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let owner_id = ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    if !paracord_db::game_servers::is_enabled(&state.db, guild_id).await? {
        return Err(ApiError::BadRequest(ADDON_OFF.into()));
    }
    if paracord_db::game_servers::count_guild_game_servers(&state.db, guild_id).await?
        >= MAX_GAME_SERVERS_PER_GUILD
    {
        return Err(ApiError::BadRequest(format!(
            "A server can list at most {MAX_GAME_SERVERS_PER_GUILD} game servers. Remove one to add another."
        )));
    }
    let kind = parse_kind(&body.kind)?;
    let address = parse_address(&body.address, kind)?;
    let announce_channel_id = match body
        .announce_channel_id
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    {
        Some(raw) => {
            let channel_id = parse_id(raw, "announce_channel_id")?;
            require_announce_channel(&state, guild_id, owner_id, auth.user_id, channel_id).await?;
            Some(channel_id)
        }
        None => None,
    };
    let typed_name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(clean_name)
        .transpose()?;
    let result = probe_once(&state, kind, &address).await?;
    let name = typed_name.unwrap_or_else(|| default_name(result.as_ref().ok(), &address));

    let target_id = paracord_db::game_servers::upsert_target(
        &state.db,
        paracord_util::snowflake::generate(1),
        kind.as_str(),
        &address.key(kind),
        &address.host,
        address.port,
    )
    .await?;
    let display = address.display();
    let server = paracord_db::game_servers::create_game_server(
        &state.db,
        &paracord_db::game_servers::NewGameServer {
            id: paracord_util::snowflake::generate(1),
            guild_id,
            target_id,
            kind: kind.as_str(),
            name: &name,
            address: &display,
            announce_channel_id,
            last_state: None,
            creator_id: auth.user_id,
        },
    )
    .await?;
    apply_probe(&state, target_id, result).await?;

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "game_servers": {
                "added": { "id": server.id.to_string(), "kind": server.kind,
                           "name": server.name, "address": server.address }
            }
        })),
    )
    .await;

    let server = load_server(&state, guild_id, server.id).await?;
    Ok((
        StatusCode::CREATED,
        Json(server_with_target(&state, &server, true).await?),
    ))
}

/// `Some(None)` for an explicit `null`, `None` when the field is absent.
fn explicit_null<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize, Default)]
pub struct UpdateBody {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// A channel id, or `null` to stop announcing.
    #[serde(default, deserialize_with = "explicit_null")]
    pub announce_channel_id: Option<Option<String>>,
}

/// `PATCH /guilds/{guild_id}/game-servers/{server_id}`
pub async fn update_game_server(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, server_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>, ApiError> {
    let owner_id = ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let server = load_server(&state, guild_id, server_id).await?;
    let kind = match body.kind.as_deref() {
        Some(raw) => parse_kind(raw)?,
        None => parse_kind(&server.kind)?,
    };
    let address = parse_address(body.address.as_deref().unwrap_or(&server.address), kind)?;
    let name = match body.name.as_deref() {
        Some(name) => clean_name(name)?,
        None => server.name.clone(),
    };
    let announce_channel_id = match &body.announce_channel_id {
        None => server.announce_channel_id,
        Some(None) => None,
        Some(Some(raw)) if raw.trim().is_empty() => None,
        Some(Some(raw)) => {
            let channel_id = parse_id(raw, "announce_channel_id")?;
            if Some(channel_id) != server.announce_channel_id {
                require_announce_channel(&state, guild_id, owner_id, auth.user_id, channel_id)
                    .await?;
            }
            Some(channel_id)
        }
    };

    let display = address.display();
    let moved = kind.as_str() != server.kind || display != server.address;
    let (target_id, last_state, result) = if moved {
        let result = probe_once(&state, kind, &address).await?;
        let target_id = paracord_db::game_servers::upsert_target(
            &state.db,
            paracord_util::snowflake::generate(1),
            kind.as_str(),
            &address.key(kind),
            &address.host,
            address.port,
        )
        .await?;
        (target_id, None, Some(result))
    } else {
        (server.target_id, server.last_state.as_deref(), None)
    };

    let updated = paracord_db::game_servers::update_game_server(
        &state.db,
        server.id,
        &paracord_db::game_servers::GameServerUpdate {
            target_id,
            kind: kind.as_str(),
            name: &name,
            address: &display,
            announce_channel_id,
            last_state,
        },
    )
    .await?;
    if let Some(result) = result {
        apply_probe(&state, target_id, result).await?;
        paracord_db::game_servers::delete_target_if_orphaned(&state.db, server.target_id).await?;
    }
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "game_servers": {
                "updated": { "id": updated.id.to_string(), "name": updated.name,
                             "address": updated.address, "kind": updated.kind }
            }
        })),
    )
    .await;
    let updated = load_server(&state, guild_id, updated.id).await?;
    Ok(Json(server_with_target(&state, &updated, true).await?))
}

/// `DELETE /guilds/{guild_id}/game-servers/{server_id}`. Its announcements stay.
pub async fn delete_game_server(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, server_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let server = load_server(&state, guild_id, server_id).await?;
    paracord_db::game_servers::delete_game_server(&state.db, server.id).await?;
    paracord_db::game_servers::delete_target_if_orphaned(&state.db, server.target_id).await?;
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "game_servers": { "removed": { "id": server.id.to_string(), "name": server.name } }
        })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_names_come_from_the_server_or_the_address() {
        let address = GameAddress::parse("mc.example.com", GameKind::MinecraftJava).unwrap();
        assert_eq!(default_name(None, &address), "mc.example.com:25565");
        let status = GameStatus {
            name: Some("  <Lantern>   SMP ".into()),
            ..GameStatus::default()
        };
        assert_eq!(default_name(Some(&status), &address), "Lantern SMP");
        let long = GameStatus {
            name: Some("x".repeat(200)),
            ..GameStatus::default()
        };
        assert_eq!(
            default_name(Some(&long), &address).chars().count(),
            MAX_NAME_CHARS
        );
    }
}
