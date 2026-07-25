//! AutoMod rule management.
//!
//! All endpoints require `MANAGE_GUILD`. Rule bodies are validated through
//! `paracord_core::automod::RuleConfig::parse` before they are persisted, so
//! the send-path evaluator can assume stored rules are well-formed.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use paracord_core::automod::{RuleConfig, TriggerKind, MAX_RULES_PER_GUILD};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;

/// `event_type` is reserved for future non-message events; message send is 1.
const EVENT_MESSAGE_SEND: i16 = 1;

fn rule_to_json(row: &paracord_db::automod::AutomodRuleRow) -> Value {
    json!({
        "id": row.id.to_string(),
        "guild_id": row.guild_id.to_string(),
        "name": row.name,
        "creator_id": row.creator_id.map(|id| id.to_string()),
        "event_type": row.event_type,
        "trigger_type": row.trigger_type,
        "trigger_metadata": serde_json::from_str::<Value>(&row.trigger_metadata)
            .unwrap_or(Value::Null),
        "actions": serde_json::from_str::<Value>(&row.actions).unwrap_or(Value::Null),
        "enabled": row.enabled,
        "exempt_role_ids": serde_json::from_str::<Value>(&row.exempt_role_ids)
            .unwrap_or_else(|_| json!([])),
        "exempt_channel_ids": serde_json::from_str::<Value>(&row.exempt_channel_ids)
            .unwrap_or_else(|_| json!([])),
        "created_at": row.created_at.to_rfc3339(),
        "updated_at": row.updated_at.to_rfc3339(),
    })
}

fn hit_to_json(row: &paracord_db::automod::AutomodHitRow) -> Value {
    json!({
        "id": row.id.to_string(),
        "guild_id": row.guild_id.to_string(),
        "rule_id": row.rule_id.to_string(),
        "rule_name": row.rule_name,
        "user_id": row.user_id.to_string(),
        "channel_id": row.channel_id.to_string(),
        "trigger_type": row.trigger_type,
        "actions_taken": serde_json::from_str::<Value>(&row.actions_taken)
            .unwrap_or_else(|_| json!([])),
        "matched_excerpt": row.matched_excerpt,
        "content_excerpt": row.content_excerpt,
        "created_at": row.created_at.to_rfc3339(),
    })
}

async fn ensure_manage_guild(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms =
        paracord_core::permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;
    Ok(())
}

/// Serialize a list of snowflake-ish strings into the JSON array we persist,
/// rejecting anything that is not an id so the stored value stays trustworthy.
fn encode_id_list(values: &[String], label: &str) -> Result<String, ApiError> {
    let mut ids = Vec::with_capacity(values.len());
    for value in values {
        let parsed: i64 = value
            .parse()
            .map_err(|_| ApiError::BadRequest(format!("Invalid {label}")))?;
        ids.push(parsed.to_string());
    }
    serde_json::to_string(&ids).map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))
}

#[derive(Deserialize)]
pub struct CreateRuleBody {
    pub name: String,
    pub trigger_type: i16,
    pub trigger_metadata: Value,
    pub actions: Value,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub exempt_role_ids: Vec<String>,
    #[serde(default)]
    pub exempt_channel_ids: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn validate_name(name: &str) -> Result<String, ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        return Err(ApiError::BadRequest(
            "Rule name must be 1-100 characters".into(),
        ));
    }
    Ok(trimmed.to_string())
}

pub async fn list_rules(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user_id = auth.user_id;
    ensure_manage_guild(&state, guild_id, user_id).await?;
    let rows = paracord_db::automod::list_rules(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "rules": rows.iter().map(rule_to_json).collect::<Vec<_>>(),
    })))
}

pub async fn create_rule(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateRuleBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id = auth.user_id;
    ensure_manage_guild(&state, guild_id, user_id).await?;

    let existing = paracord_db::automod::count_rules(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if existing >= MAX_RULES_PER_GUILD {
        return Err(ApiError::BadRequest(format!(
            "This space already has the maximum of {MAX_RULES_PER_GUILD} AutoMod rules"
        )));
    }

    let name = validate_name(&body.name)?;
    let trigger_metadata = serde_json::to_string(&body.trigger_metadata)
        .map_err(|e| ApiError::BadRequest(format!("Invalid trigger configuration: {e}")))?;
    let actions = serde_json::to_string(&body.actions)
        .map_err(|e| ApiError::BadRequest(format!("Invalid actions: {e}")))?;

    // Single validation gate — rejects unknown triggers, mismatched configs,
    // empty action lists, uncompilable patterns and out-of-range durations.
    RuleConfig::parse(body.trigger_type, &trigger_metadata, &actions)?;

    let exempt_roles = encode_id_list(&body.exempt_role_ids, "role")?;
    let exempt_channels = encode_id_list(&body.exempt_channel_ids, "channel")?;

    let row = paracord_db::automod::create_rule(
        &state.db,
        paracord_util::snowflake::generate(1),
        guild_id,
        &name,
        user_id,
        EVENT_MESSAGE_SEND,
        body.trigger_type,
        &trigger_metadata,
        &actions,
        body.enabled,
        &exempt_roles,
        &exempt_channels,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    audit::log_action(
        &state,
        guild_id,
        user_id,
        audit::ACTION_AUTOMOD_RULE_CREATE,
        Some(row.id),
        None,
        Some(json!({ "name": row.name, "trigger_type": row.trigger_type })),
    )
    .await;

    Ok(Json(rule_to_json(&row)))
}

#[derive(Deserialize)]
pub struct UpdateRuleBody {
    pub name: Option<String>,
    pub trigger_metadata: Option<Value>,
    pub actions: Option<Value>,
    pub enabled: Option<bool>,
    pub exempt_role_ids: Option<Vec<String>>,
    pub exempt_channel_ids: Option<Vec<String>>,
}

pub async fn update_rule(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, rule_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateRuleBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id = auth.user_id;
    ensure_manage_guild(&state, guild_id, user_id).await?;

    let existing = paracord_db::automod::get_rule(&state.db, rule_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // A rule id from another space must not be reachable through this path.
    if existing.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    let name = match body.name.as_deref() {
        Some(value) => validate_name(value)?,
        None => existing.name.clone(),
    };
    let trigger_metadata = match body.trigger_metadata.as_ref() {
        Some(value) => serde_json::to_string(value)
            .map_err(|e| ApiError::BadRequest(format!("Invalid trigger configuration: {e}")))?,
        None => existing.trigger_metadata.clone(),
    };
    let actions = match body.actions.as_ref() {
        Some(value) => serde_json::to_string(value)
            .map_err(|e| ApiError::BadRequest(format!("Invalid actions: {e}")))?,
        None => existing.actions.clone(),
    };

    RuleConfig::parse(existing.trigger_type, &trigger_metadata, &actions)?;

    let exempt_roles = match body.exempt_role_ids.as_ref() {
        Some(values) => encode_id_list(values, "role")?,
        None => existing.exempt_role_ids.clone(),
    };
    let exempt_channels = match body.exempt_channel_ids.as_ref() {
        Some(values) => encode_id_list(values, "channel")?,
        None => existing.exempt_channel_ids.clone(),
    };
    let enabled = body.enabled.unwrap_or(existing.enabled);

    let row = paracord_db::automod::update_rule(
        &state.db,
        rule_id,
        &name,
        &trigger_metadata,
        &actions,
        enabled,
        &exempt_roles,
        &exempt_channels,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    .ok_or(ApiError::NotFound)?;

    audit::log_action(
        &state,
        guild_id,
        user_id,
        audit::ACTION_AUTOMOD_RULE_UPDATE,
        Some(row.id),
        None,
        Some(json!({ "name": row.name, "enabled": row.enabled })),
    )
    .await;

    Ok(Json(rule_to_json(&row)))
}

pub async fn delete_rule(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, rule_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    let user_id = auth.user_id;
    ensure_manage_guild(&state, guild_id, user_id).await?;

    let existing = paracord_db::automod::get_rule(&state.db, rule_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if existing.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::automod::delete_rule(&state.db, rule_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    audit::log_action(
        &state,
        guild_id,
        user_id,
        audit::ACTION_AUTOMOD_RULE_DELETE,
        Some(rule_id),
        None,
        Some(json!({ "name": existing.name })),
    )
    .await;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct HitsQuery {
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn list_hits(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(query): Query<HitsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = auth.user_id;
    ensure_manage_guild(&state, guild_id, user_id).await?;
    let rows = paracord_db::automod::list_hits(&state.db, guild_id, query.limit.unwrap_or(50))
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "hits": rows.iter().map(hit_to_json).collect::<Vec<_>>(),
    })))
}

/// Dry-run a rule against sample text so operators can check a pattern before
/// enabling it. Nothing is persisted and no action is taken.
#[derive(Deserialize)]
pub struct TestRuleBody {
    pub trigger_type: i16,
    pub trigger_metadata: Value,
    pub content: String,
    /// Simulated recent-message count for spam triggers.
    #[serde(default)]
    pub recent_message_count: Option<i64>,
}

pub async fn test_rule(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<TestRuleBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id = auth.user_id;
    ensure_manage_guild(&state, guild_id, user_id).await?;

    if TriggerKind::from_i16(body.trigger_type).is_none() {
        return Err(ApiError::BadRequest("Unknown trigger type".into()));
    }
    let trigger_metadata = serde_json::to_string(&body.trigger_metadata)
        .map_err(|e| ApiError::BadRequest(format!("Invalid trigger configuration: {e}")))?;

    // Validate through the same gate, pairing with a throwaway block action so
    // the shared parser accepts the payload.
    let config = RuleConfig::parse(
        body.trigger_type,
        &trigger_metadata,
        r#"[{"kind":"block_message"}]"#,
    )?;

    let hit = paracord_core::automod::evaluate_trigger(
        &config.trigger,
        &body.content,
        body.recent_message_count,
    );

    Ok(Json(json!({
        "matched": hit.is_some(),
        "matched_excerpt": hit.map(|h| h.excerpt),
    })))
}
