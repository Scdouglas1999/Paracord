use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use paracord_core::{AppState, USER_FLAG_BOT};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;
use crate::routes::mod_log;

const MAX_REASON_LEN: usize = 512;
const MAX_EVIDENCE_ITEMS: usize = 12;
const MAX_EVIDENCE_LEN: usize = 512;
const MAX_APPROVED_CONTENT_LEN: usize = 4_000;
const AUTO_MOD_ID: i64 = -2;

#[derive(Deserialize)]
pub struct CreateReportRequest {
    pub target_type: String,
    pub target_id: String,
    pub reason: String,
    pub message_id: Option<String>,
    pub channel_id: Option<String>,
    pub reported_user_id: Option<String>,
    pub evidence: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct ListReportsQuery {
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct ResolveReportRequest {
    pub action: String,
    pub note: Option<String>,
    pub mute_minutes: Option<i64>,
}

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

async fn ensure_reporter_member(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    Ok(())
}

async fn ensure_moderator(state: &AppState, guild_id: i64, user_id: i64) -> Result<(), ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms =
        paracord_core::permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    let can_moderate = perms.contains(Permissions::MANAGE_MESSAGES)
        || perms.contains(Permissions::BAN_MEMBERS)
        || perms.contains(Permissions::KICK_MEMBERS)
        || perms.contains(Permissions::MANAGE_GUILD)
        || perms.contains(Permissions::ADMINISTRATOR)
        || user_id == guild.owner_id;
    if !can_moderate {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn parse_optional_i64(raw: Option<&str>, field: &str) -> Result<Option<i64>, ApiError> {
    match raw {
        Some(value) => {
            Ok(Some(value.parse::<i64>().map_err(|_| {
                ApiError::BadRequest(format!("Invalid {field}"))
            })?))
        }
        None => Ok(None),
    }
}

fn parse_required_i64(raw: &str, field: &str) -> Result<i64, ApiError> {
    raw.parse::<i64>()
        .map_err(|_| ApiError::BadRequest(format!("Invalid {field}")))
}

fn normalize_status(raw: Option<&str>) -> Option<&str> {
    match raw {
        Some("open") | Some("dismissed") | Some("warned") | Some("muted") | Some("banned")
        | Some("approved") | Some("rejected") => raw,
        _ => None,
    }
}

fn parse_i64_from_value(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::String(raw)) => raw.parse::<i64>().ok(),
        Some(Value::Number(raw)) => raw.as_i64(),
        _ => None,
    }
}

fn parse_i64_from_changes(changes: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(parsed) = parse_i64_from_value(changes.get(*key)) {
            return Some(parsed);
        }
    }
    None
}

async fn author_to_json(state: &AppState, user_id: i64) -> Value {
    if let Ok(Some(user)) = paracord_db::users::get_user_by_id(&state.db, user_id).await {
        return json!({
            "id": user.id.to_string(),
            "username": user.username,
            "discriminator": user.discriminator,
            "avatar_hash": user.avatar_hash,
            "flags": user.flags,
            "bot": (user.flags & USER_FLAG_BOT) != 0,
        });
    }

    json!({
        "id": AUTO_MOD_ID.to_string(),
        "username": "Auto-Moderator",
        "discriminator": 0,
        "avatar_hash": Value::Null,
        "flags": USER_FLAG_BOT,
        "bot": true,
    })
}

async fn approve_quarantine_report(
    state: &AppState,
    guild_id: i64,
    target_user_id: Option<i64>,
    changes: &mut Value,
) -> Result<(), ApiError> {
    let original_channel_id =
        parse_i64_from_changes(changes, &["original_channel_id", "channel_id"]).ok_or(
            ApiError::BadRequest("quarantine report is missing original channel metadata".into()),
        )?;
    let original_content = changes
        .get("original_content")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(ApiError::BadRequest(
            "quarantine report is missing original content".into(),
        ))?;
    let approved_content = original_content
        .chars()
        .take(MAX_APPROVED_CONTENT_LEN)
        .collect::<String>();

    let channel = paracord_db::channels::get_channel(&state.db, original_channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.guild_id() != Some(guild_id) {
        return Err(ApiError::BadRequest(
            "original channel does not belong to this guild".into(),
        ));
    }

    let author_id = target_user_id.unwrap_or(AUTO_MOD_ID);
    let approved_message_id = paracord_util::snowflake::generate(1);
    let approved_message = paracord_db::messages::create_message(
        &state.db,
        approved_message_id,
        original_channel_id,
        author_id,
        &approved_content,
        0,
        None,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let message_json = json!({
        "id": approved_message.id.to_string(),
        "channel_id": approved_message.channel_id.to_string(),
        "author_id": approved_message.author_id.to_string(),
        "content": approved_message.content,
        "nonce": approved_message.nonce,
        "message_type": approved_message.message_type,
        "flags": approved_message.flags,
        "pinned": approved_message.pinned,
        "e2ee_header": approved_message.e2ee_header,
        "created_at": approved_message.created_at.to_rfc3339(),
        "edited_at": approved_message.edited_at.map(|d| d.to_rfc3339()),
        "author": author_to_json(state, author_id).await,
    });
    state
        .event_bus
        .dispatch("MESSAGE_CREATE", message_json, Some(guild_id));

    changes["approved_message_id"] = Value::String(approved_message.id.to_string());
    changes["approved_channel_id"] = Value::String(original_channel_id.to_string());
    changes["approved_by_automod_review"] = Value::Bool(true);
    Ok(())
}

fn report_entry_to_json(entry: &paracord_db::audit_log::AuditLogEntryRow) -> Value {
    let changes = entry.changes.clone().unwrap_or_else(|| json!({}));
    let status = changes
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("open");
    json!({
        "id": entry.id.to_string(),
        "guild_id": entry.space_id.to_string(),
        "reporter_id": entry.user_id.to_string(),
        "action_type": entry.action_type,
        "status": status,
        "target_id": entry.target_id.map(|id| id.to_string()),
        "reason": entry.reason,
        "changes": changes,
        "created_at": entry.created_at.to_rfc3339(),
    })
}

pub async fn create_report(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateReportRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_reporter_member(&state, guild_id, auth.user_id).await?;

    let target_type = body.target_type.trim().to_ascii_lowercase();
    if !matches!(target_type.as_str(), "message" | "user" | "guild") {
        return Err(ApiError::BadRequest(
            "target_type must be one of: message, user, guild".into(),
        ));
    }
    if body.reason.trim().is_empty() || body.reason.trim().len() > MAX_REASON_LEN {
        return Err(ApiError::BadRequest(
            "reason must be between 1 and 512 characters".into(),
        ));
    }
    if contains_dangerous_markup(&body.reason) {
        return Err(ApiError::BadRequest("reason contains unsafe markup".into()));
    }
    let evidence = body.evidence.unwrap_or_default();
    if evidence.len() > MAX_EVIDENCE_ITEMS {
        return Err(ApiError::BadRequest(
            "too many evidence items (max 12)".into(),
        ));
    }
    if evidence
        .iter()
        .any(|item| item.trim().is_empty() || item.len() > MAX_EVIDENCE_LEN)
    {
        return Err(ApiError::BadRequest(
            "each evidence item must be 1-512 characters".into(),
        ));
    }

    let target_id = parse_required_i64(&body.target_id, "target_id")?;
    let message_id = parse_optional_i64(body.message_id.as_deref(), "message_id")?;
    let channel_id = parse_optional_i64(body.channel_id.as_deref(), "channel_id")?;
    let reported_user_id =
        parse_optional_i64(body.reported_user_id.as_deref(), "reported_user_id")?;

    let changes = json!({
        "target_type": target_type,
        "target_id": target_id.to_string(),
        "message_id": message_id.map(|id| id.to_string()),
        "channel_id": channel_id.map(|id| id.to_string()),
        "reported_user_id": reported_user_id.map(|id| id.to_string()),
        "evidence": evidence,
        "status": "open",
    });

    let report_id = paracord_util::snowflake::generate(1);
    let entry = paracord_db::audit_log::create_entry(
        &state.db,
        report_id,
        guild_id,
        auth.user_id,
        audit::ACTION_REPORT_CREATE,
        Some(target_id),
        Some(body.reason.trim()),
        Some(&changes),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "GUILD_REPORT_CREATE",
        report_entry_to_json(&entry),
        Some(guild_id),
    );

    let report_kind = entry
        .changes
        .as_ref()
        .and_then(|v| v.get("target_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Report Submitted",
        "A new moderation report was submitted.",
        &[
            ("Reporter", auth.user_id.to_string()),
            ("Target Type", report_kind.to_string()),
            ("Target ID", target_id.to_string()),
        ],
    )
    .await;

    Ok((StatusCode::CREATED, Json(report_entry_to_json(&entry))))
}

pub async fn list_reports(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(query): Query<ListReportsQuery>,
) -> Result<Json<Value>, ApiError> {
    ensure_moderator(&state, guild_id, auth.user_id).await?;

    let entries = paracord_db::audit_log::get_guild_entries(
        &state.db,
        guild_id,
        Some(audit::ACTION_REPORT_CREATE),
        None,
        None,
        500,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let status_filter = normalize_status(query.status.as_deref());
    let reports: Vec<Value> = entries
        .iter()
        .filter(|entry| {
            if let Some(status) = status_filter {
                let current = entry
                    .changes
                    .as_ref()
                    .and_then(|v| v.get("status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("open");
                current == status
            } else {
                true
            }
        })
        .map(report_entry_to_json)
        .collect();

    Ok(Json(json!({ "reports": reports })))
}

async fn resolve_report_target_user(
    state: &AppState,
    report: &paracord_db::audit_log::AuditLogEntryRow,
) -> Result<Option<i64>, ApiError> {
    let Some(changes) = report.changes.as_ref() else {
        return Ok(None);
    };

    if let Some(user_id) = changes
        .get("reported_user_id")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<i64>().ok())
    {
        return Ok(Some(user_id));
    }

    let target_type = changes
        .get("target_type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let target_id = changes
        .get("target_id")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<i64>().ok());

    match target_type {
        "user" => Ok(target_id),
        "message" => {
            let Some(message_id) = target_id else {
                return Ok(None);
            };
            let Some(message) = paracord_db::messages::get_message(&state.db, message_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            else {
                return Ok(None);
            };
            // The message id came straight from the reporter's request body and
            // was never bound to the guild the report lives in. Without this
            // containment check a member could report any message snowflake on
            // the instance, resolve their own report as "ban", and then read the
            // author's id + username back out of `GET /guilds/{own}/bans` --
            // de-anonymizing (and banning) an arbitrary user from a guild they
            // control. Resolve to no target instead of erroring so a moderator
            // can still dismiss a bogus report.
            let channel = paracord_db::channels::get_channel(&state.db, message.channel_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            match channel {
                Some(channel) if channel.guild_id() == Some(report.space_id) => {
                    Ok(Some(message.author_id))
                }
                _ => Ok(None),
            }
        }
        _ => Ok(None),
    }
}

pub async fn resolve_report(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, report_id)): Path<(i64, i64)>,
    Json(body): Json<ResolveReportRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_moderator(&state, guild_id, auth.user_id).await?;

    // Validated up front, not at the point it is recorded further down. The
    // `"ban"` branch passes `body.note` to `ban_member` long before the old
    // check ran, so an over-long note was written to a length-limited column
    // first and rejected afterwards — a 500 on PostgreSQL. The emptiness filter
    // on the later check also skipped whitespace-only notes entirely, which are
    // then handed untrimmed to the audit log.
    if let Some(note) = body.note.as_deref() {
        if note.len() > MAX_REASON_LEN {
            return Err(ApiError::BadRequest("invalid note".into()));
        }
    }

    let mut report = paracord_db::audit_log::get_entry_by_id(&state.db, report_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if report.space_id != guild_id || report.action_type != audit::ACTION_REPORT_CREATE {
        return Err(ApiError::NotFound);
    }

    let action = body.action.trim().to_ascii_lowercase();
    if !matches!(
        action.as_str(),
        "dismiss" | "warn" | "mute" | "ban" | "approve" | "reject"
    ) {
        return Err(ApiError::BadRequest(
            "action must be one of: dismiss, warn, mute, ban, approve, reject".into(),
        ));
    }

    let mut changes = report.changes.clone().unwrap_or_else(|| json!({}));
    let report_kind = changes
        .get("report_kind")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let is_quarantine_report = report_kind == "automod_quarantine";
    let target_user_id = resolve_report_target_user(&state, &report).await?;
    match action.as_str() {
        "dismiss" => {
            changes["status"] = Value::String("dismissed".to_string());
        }
        "warn" => {
            changes["status"] = Value::String("warned".to_string());
        }
        "mute" => {
            let user_id = target_user_id.ok_or(ApiError::BadRequest(
                "mute action requires a user target".into(),
            ))?;
            let minutes = body.mute_minutes.unwrap_or(15).clamp(1, 60 * 24 * 7);
            let timeout_until = chrono::Utc::now() + chrono::Duration::minutes(minutes);
            paracord_core::admin::timeout_member(
                &state.db,
                guild_id,
                auth.user_id,
                user_id,
                Some(timeout_until),
            )
            .await?;
            changes["status"] = Value::String("muted".to_string());
            changes["mute_minutes"] = Value::Number(serde_json::Number::from(minutes));
            state.event_bus.dispatch(
                "GUILD_MEMBER_UPDATE",
                json!({
                    "guild_id": guild_id.to_string(),
                    "user_id": user_id.to_string(),
                    "communication_disabled_until": timeout_until.to_rfc3339(),
                }),
                Some(guild_id),
            );
        }
        "ban" => {
            let user_id = target_user_id.ok_or(ApiError::BadRequest(
                "ban action requires a user target".into(),
            ))?;
            paracord_core::admin::ban_member(
                &state.db,
                guild_id,
                auth.user_id,
                user_id,
                body.note.as_deref(),
            )
            .await?;
            changes["status"] = Value::String("banned".to_string());
            state.member_index.remove_member(guild_id, user_id);
            state.event_bus.dispatch(
                "GUILD_BAN_ADD",
                json!({
                    "guild_id": guild_id.to_string(),
                    "user_id": user_id.to_string(),
                }),
                Some(guild_id),
            );
            state.event_bus.dispatch(
                "GUILD_MEMBER_REMOVE",
                json!({
                    "guild_id": guild_id.to_string(),
                    "user_id": user_id.to_string(),
                }),
                Some(guild_id),
            );
        }
        "approve" => {
            if !is_quarantine_report {
                return Err(ApiError::BadRequest(
                    "approve is only valid for AutoMod quarantine reports".into(),
                ));
            }
            approve_quarantine_report(&state, guild_id, target_user_id, &mut changes).await?;
            changes["status"] = Value::String("approved".to_string());
        }
        "reject" => {
            if !is_quarantine_report {
                return Err(ApiError::BadRequest(
                    "reject is only valid for AutoMod quarantine reports".into(),
                ));
            }
            changes["status"] = Value::String("rejected".to_string());
        }
        _ => {}
    }

    changes["resolved_action"] = Value::String(action.clone());
    changes["resolved_by"] = Value::String(auth.user_id.to_string());
    changes["resolved_at"] = Value::String(chrono::Utc::now().to_rfc3339());
    if let Some(note) = body.note.as_ref().filter(|n| !n.trim().is_empty()) {
        if note.len() > MAX_REASON_LEN || contains_dangerous_markup(note) {
            return Err(ApiError::BadRequest("invalid note".into()));
        }
        changes["resolution_note"] = Value::String(note.trim().to_string());
    }

    report = paracord_db::audit_log::update_entry_changes(
        &state.db,
        report_id,
        body.note.as_deref().map(str::trim),
        Some(&changes),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_REPORT_RESOLVE,
        Some(report_id),
        body.note.as_deref(),
        Some(json!({ "action": action })),
    )
    .await;

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Report Resolved",
        "A moderation report has been reviewed.",
        &[
            ("Report ID", report_id.to_string()),
            ("Action", action),
            ("Moderator", auth.user_id.to_string()),
        ],
    )
    .await;

    state.event_bus.dispatch(
        "GUILD_REPORT_UPDATE",
        report_entry_to_json(&report),
        Some(guild_id),
    );

    Ok(Json(report_entry_to_json(&report)))
}
