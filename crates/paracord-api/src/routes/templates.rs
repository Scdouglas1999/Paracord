use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_models::channel::ChannelType;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_TEMPLATE_ROLES: usize = 250;
const MAX_TEMPLATE_CHANNELS: usize = 500;
const MAX_TEMPLATE_NAME_LEN: usize = 100;
const ALLOWED_TEMPLATE_CHANNEL_TYPES: [i16; 5] = [
    ChannelType::Text as i16,
    ChannelType::Voice as i16,
    ChannelType::Category as i16,
    ChannelType::Announcement as i16,
    ChannelType::Forum as i16,
];

#[derive(Deserialize)]
pub struct ApplyTemplateRequest {
    pub name: String,
}

#[derive(Debug)]
struct TemplateRoleInput {
    name: String,
    permissions: i64,
}

#[derive(Debug)]
struct TemplateChannelInput {
    name: String,
    channel_type: i16,
    position: i32,
    parent_name: Option<String>,
}

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

fn validate_template_name(value: &str, field: &str) -> Result<String, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_TEMPLATE_NAME_LEN {
        return Err(ApiError::BadRequest(format!(
            "{field} must be between 1 and {MAX_TEMPLATE_NAME_LEN} characters"
        )));
    }
    if contains_dangerous_markup(trimmed) {
        return Err(ApiError::BadRequest(format!(
            "{field} contains unsafe markup"
        )));
    }
    Ok(trimmed.to_string())
}

fn parse_template_roles(data: &Value) -> Result<Vec<TemplateRoleInput>, ApiError> {
    let Some(roles) = data.get("roles").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };
    if roles.len() > MAX_TEMPLATE_ROLES {
        return Err(ApiError::BadRequest(
            "Template contains too many roles".into(),
        ));
    }

    let mut parsed = Vec::with_capacity(roles.len());
    for role_val in roles {
        let name = validate_template_name(
            role_val
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("New Role"),
            "Role name",
        )?;
        let perms_str = role_val
            .get("permissions")
            .and_then(|v| v.as_str())
            .unwrap_or("0");
        let permissions = perms_str
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid role permissions".into()))?;
        if permissions < 0
            || paracord_models::permissions::Permissions::from_bits(permissions).is_none()
        {
            return Err(ApiError::BadRequest("Invalid role permissions".into()));
        }
        parsed.push(TemplateRoleInput { name, permissions });
    }
    Ok(parsed)
}

fn parse_template_channels(data: &Value) -> Result<Vec<TemplateChannelInput>, ApiError> {
    let Some(channels) = data.get("channels").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };
    if channels.len() > MAX_TEMPLATE_CHANNELS {
        return Err(ApiError::BadRequest(
            "Template contains too many channels".into(),
        ));
    }

    let mut parsed = Vec::with_capacity(channels.len());
    for channel_val in channels {
        let name = validate_template_name(
            channel_val
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("channel"),
            "Channel name",
        )?;
        let channel_type = channel_val
            .get("type")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let channel_type = i16::try_from(channel_type)
            .map_err(|_| ApiError::BadRequest("Invalid channel type".into()))?;
        if !ALLOWED_TEMPLATE_CHANNEL_TYPES.contains(&channel_type) {
            return Err(ApiError::BadRequest("Invalid channel type".into()));
        }
        let position = channel_val
            .get("position")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let position = i32::try_from(position)
            .map_err(|_| ApiError::BadRequest("Invalid channel position".into()))?;
        let parent_name = channel_val
            .get("parent_name")
            .and_then(|v| v.as_str())
            .map(|v| validate_template_name(v, "Parent channel name"))
            .transpose()?;
        parsed.push(TemplateChannelInput {
            name,
            channel_type,
            position,
            parent_name,
        });
    }
    Ok(parsed)
}

/// POST /guilds/:guild_id/template  --  snapshot the guild into a template
pub async fn create_template_from_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    // Require MANAGE_GUILD
    let roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id).await?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;

    // Snapshot channels
    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id).await?;
    // Build a map of category id -> category name for parent_name resolution
    let category_names: std::collections::HashMap<i64, String> = channels
        .iter()
        .filter(|c| c.channel_type == 4) // category
        .filter_map(|c| Some((c.id, c.name.clone()?)))
        .collect();

    let channel_data: Vec<Value> = channels
        .iter()
        .filter(|c| c.channel_type != 6) // exclude threads
        .map(|c| {
            let parent_name = c
                .parent_id
                .and_then(|pid| category_names.get(&pid))
                .cloned();
            json!({
                "name": c.name,
                "type": c.channel_type,
                "position": c.position,
                "parent_name": parent_name,
            })
        })
        .collect();

    // Snapshot roles (excluding the default @everyone role which has id == guild_id)
    let all_roles = paracord_db::roles::get_guild_roles(&state.db, guild_id).await?;
    let role_data: Vec<Value> = all_roles
        .iter()
        .filter(|r| r.id != guild_id)
        .map(|r| {
            json!({
                "name": r.name,
                "permissions": r.permissions.to_string(),
                "color": r.color,
                "position": r.position,
            })
        })
        .collect();

    let template_data = json!({
        "channels": channel_data,
        "roles": role_data,
    });

    let template_id = paracord_util::snowflake::generate(1);
    let tmpl = paracord_db::guild_templates::create_template(
        &state.db,
        template_id,
        &guild.name,
        guild.description.as_deref().unwrap_or(""),
        auth.user_id,
        Some(guild_id),
        &template_data.to_string(),
    )
    .await?;

    let result = template_to_json(&tmpl);
    Ok((StatusCode::CREATED, Json(result)))
}

/// GET /templates  --  list the templates the caller is allowed to see.
///
/// A template embeds `template_data`: the full channel tree plus every role of
/// the source guild *including raw permission bitmasks*, alongside
/// `source_guild_id` and `creator_id`. Returning the instance-wide list handed
/// any authenticated user a complete structural and privilege map of every
/// guild that had ever been snapshotted.
///
/// The schema carries no public/private flag, so visibility is derived from
/// what the caller already legitimately knows: templates they created, and
/// templates snapshotted from a guild they are currently a member of. (A
/// follow-up migration adding an explicit visibility column would let a guild
/// publish a template deliberately; that column is owned elsewhere.)
pub async fn list_templates(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let templates = paracord_db::guild_templates::list_all(&state.db).await?;

    let member_guild_ids: std::collections::HashSet<i64> =
        paracord_db::guilds::get_user_guilds(&state.db, auth.user_id.into())
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .into_iter()
            .map(|guild| guild.id)
            .collect();

    let arr: Vec<Value> = templates
        .iter()
        .filter(|tmpl| {
            tmpl.creator_id == auth.user_id
                || tmpl
                    .source_guild_id
                    .is_some_and(|guild_id| member_guild_ids.contains(&guild_id))
        })
        .map(template_to_json)
        .collect();
    Ok(Json(json!(arr)))
}

/// POST /templates/:template_id/apply  --  create a new guild from a template
pub async fn apply_template(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(template_id): Path<i64>,
    Json(body): Json<ApplyTemplateRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.name.len() < 2 || body.name.len() > 100 {
        return Err(ApiError::BadRequest(
            "Guild name must be between 2 and 100 characters".into(),
        ));
    }
    if contains_dangerous_markup(&body.name) {
        return Err(ApiError::BadRequest(
            "Guild name contains unsafe markup".into(),
        ));
    }

    // Applying a template creates a guild, so it is subject to the same
    // per-account guild quota as POST /guilds.
    crate::routes::guilds::ensure_guild_creation_allowed(&state, auth.user_id).await?;

    let tmpl = paracord_db::guild_templates::get_by_id(&state.db, template_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let data: Value = serde_json::from_str(&tmpl.template_data)
        .map_err(|_| ApiError::BadRequest("Invalid template data".into()))?;
    let template_roles = parse_template_roles(&data)?;
    let template_channels = parse_template_channels(&data)?;

    // Create the guild (with default channels + member role via create_guild_full)
    let guild_id = paracord_util::snowflake::generate(1);
    let guild = paracord_core::guild::create_guild_full(
        &state.db,
        guild_id,
        &body.name,
        auth.user_id,
        None,
    )
    .await?;

    // Create roles from template (skip the default @everyone which is already created)
    for role in template_roles {
        let role_id = paracord_util::snowflake::generate(1);
        let _ = paracord_db::roles::create_role(
            &state.db,
            role_id,
            guild_id,
            &role.name,
            role.permissions,
        )
        .await;
    }

    // Create channels from template
    // First pass: create categories so we can map parent_name -> new id
    let mut category_id_map: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    // Categories first (type 4)
    for ch in template_channels
        .iter()
        .filter(|channel| channel.channel_type == 4)
    {
        let ch_id = paracord_util::snowflake::generate(1);
        let _ = paracord_db::channels::create_channel(
            &state.db,
            ch_id,
            guild_id,
            &ch.name,
            4,
            ch.position,
            None,
            None,
        )
        .await;
        category_id_map.insert(ch.name.clone(), ch_id);
    }

    // Then non-category, non-default channels.
    // The default "general" (text, pos 0) and "General" (voice, pos 1) are created by
    // create_guild_full already, so we skip exact duplicates.
    for ch in template_channels
        .iter()
        .filter(|channel| channel.channel_type != 4)
    {
        let parent_id = ch
            .parent_name
            .as_deref()
            .and_then(|pn| category_id_map.get(pn).copied());

        if ch.name == "general" && ch.channel_type == 0 && ch.position == 0 && parent_id.is_none() {
            continue;
        }
        if ch.name == "General" && ch.channel_type == 2 && ch.position == 1 && parent_id.is_none() {
            continue;
        }

        let ch_id = paracord_util::snowflake::generate(1);
        let _ = paracord_db::channels::create_channel(
            &state.db,
            ch_id,
            guild_id,
            &ch.name,
            ch.channel_type,
            ch.position,
            parent_id,
            None,
        )
        .await;
    }

    // Increment template usage count
    let _ = paracord_db::guild_templates::increment_usage(&state.db, template_id).await;

    let guild_json = json!({
        "id": guild.id.to_string(),
        "name": guild.name,
        "description": guild.description,
        "icon_hash": guild.icon_hash,
        "owner_id": guild.owner_id.to_string(),
        "member_count": 1,
        "created_at": guild.created_at.to_rfc3339(),
    });

    state.member_index.add_member(guild_id, auth.user_id);
    state
        .event_bus
        .dispatch("GUILD_CREATE", guild_json.clone(), Some(guild_id));

    Ok((StatusCode::CREATED, Json(guild_json)))
}

/// DELETE /templates/:template_id  --  delete a template (creator only)
pub async fn delete_template(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(template_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let tmpl = paracord_db::guild_templates::get_by_id(&state.db, template_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    if tmpl.creator_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }

    paracord_db::guild_templates::delete_template(&state.db, template_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn template_to_json(tmpl: &paracord_db::guild_templates::GuildTemplateRow) -> Value {
    let parsed_data: Value = serde_json::from_str(&tmpl.template_data).unwrap_or(json!({}));
    json!({
        "id": tmpl.id.to_string(),
        "name": tmpl.name,
        "description": tmpl.description,
        "creator_id": tmpl.creator_id.to_string(),
        "source_guild_id": tmpl.source_guild_id.map(|id| id.to_string()),
        "template_data": parsed_data,
        "usage_count": tmpl.usage_count,
        "created_at": tmpl.created_at.to_rfc3339(),
        "updated_at": tmpl.updated_at.to_rfc3339(),
    })
}
