use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use dashmap::DashMap;
use hmac::{Hmac, Mac};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::LazyLock;
use std::time::Instant;

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;

// ---------------------------------------------------------------------------
// M13: Per-webhook rate limiter (sliding window: 30 requests per 60 seconds)
// ---------------------------------------------------------------------------

const WEBHOOK_RATE_LIMIT: usize = 30;
const WEBHOOK_RATE_WINDOW_SECS: u64 = 60;

#[derive(Default)]
struct WebhookRateEntry {
    timestamps: Vec<Instant>,
}

static WEBHOOK_RATE_MAP: LazyLock<DashMap<i64, WebhookRateEntry>> = LazyLock::new(DashMap::new);

fn check_webhook_rate_limit(webhook_id: i64) -> Result<(), ApiError> {
    // NOTE: This limiter is process-local / single-instance. The sliding window
    // lives in an in-memory map on one server process, so in a horizontally
    // scaled deployment each instance enforces WEBHOOK_RATE_LIMIT independently
    // and the effective global limit scales with the instance count. A shared
    // backend (e.g. Redis) would be required for a cluster-wide guarantee.
    let now = Instant::now();
    let cutoff = now - std::time::Duration::from_secs(WEBHOOK_RATE_WINDOW_SECS);

    // Fast path: an existing entry for an active webhook. Prune expired
    // timestamps, enforce the window, then record this request in place.
    if let Some(mut entry) = WEBHOOK_RATE_MAP.get_mut(&webhook_id) {
        entry.timestamps.retain(|ts| *ts > cutoff);
        if entry.timestamps.len() >= WEBHOOK_RATE_LIMIT {
            return Err(ApiError::RateLimited(WEBHOOK_RATE_WINDOW_SECS as i64));
        }
        if !entry.timestamps.is_empty() {
            entry.timestamps.push(now);
            return Ok(());
        }
        // The window fully lapsed. Drop the entry (releasing its Vec, whose
        // capacity may have grown during an earlier burst) instead of leaving a
        // zombie entry behind for every webhook id that was ever executed, then
        // fall through to record this request in a fresh entry.
        drop(entry);
        WEBHOOK_RATE_MAP.remove_if(&webhook_id, |_, e| e.timestamps.is_empty());
    }

    // No live entry (never existed, or just evicted as empty): record this
    // request in a fresh entry.
    WEBHOOK_RATE_MAP
        .entry(webhook_id)
        .or_default()
        .timestamps
        .push(now);
    Ok(())
}

// ---------------------------------------------------------------------------
// H6: GitHub webhook HMAC-SHA256 signature verification
// ---------------------------------------------------------------------------

type HmacSha256 = Hmac<Sha256>;

fn verify_github_signature(secret: &str, body: &[u8], signature_header: &str) -> bool {
    // GitHub sends: sha256=<hex>
    let hex_sig = match signature_header.strip_prefix("sha256=") {
        Some(hex) => hex,
        None => return false,
    };

    let expected_bytes = match hex::decode(hex_sig) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };

    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(body);

    // Constant-time comparison via the `verify_slice` method
    mac.verify_slice(&expected_bytes).is_ok()
}

/// Simple hex codec (avoids adding a `hex` crate dependency)
mod hex {
    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len() * 2);
        for b in input {
            out.push_str(&format!("{:02x}", b));
        }
        out
    }

    pub fn decode(input: &str) -> Result<Vec<u8>, ()> {
        if input.len() % 2 != 0 {
            return Err(());
        }
        let mut out = Vec::with_capacity(input.len() / 2);
        let bytes = input.as_bytes();
        for chunk in bytes.chunks(2) {
            let hi = hex_val(chunk[0]).ok_or(())?;
            let lo = hex_val(chunk[1]).ok_or(())?;
            out.push((hi << 4) | lo);
        }
        Ok(out)
    }

    fn hex_val(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
}

/// Encrypt a GitHub webhook HMAC secret before storing it in the database.
///
/// The DB column stays a plain string, but its contents become hex-encoded
/// AES-256-GCM ciphertext (via the shared at-rest master key). When no at-rest
/// cryptor is configured the secret is stored as-is, matching the graceful
/// degradation used for other at-rest secrets.
fn encrypt_github_secret(state: &AppState, plaintext: &str) -> Result<String, ApiError> {
    let Some(cryptor) = state.config.totp_cryptor.as_ref() else {
        return Ok(plaintext.to_string());
    };
    let ciphertext = cryptor.encrypt(plaintext.as_bytes()).map_err(|e| {
        ApiError::Internal(anyhow::anyhow!("github_secret encryption failed: {}", e))
    })?;
    Ok(hex::encode(&ciphertext))
}

/// Decrypt a stored GitHub webhook HMAC secret. Handles both encrypted values
/// (hex-encoded ciphertext) and legacy plaintext secrets written before at-rest
/// encryption was introduced, so HMAC verification always operates on the
/// original secret bytes.
fn decrypt_github_secret(state: &AppState, stored: &str) -> Result<String, ApiError> {
    let Some(cryptor) = state.config.totp_cryptor.as_ref() else {
        return Ok(stored.to_string());
    };
    // A legacy plaintext secret is not necessarily valid hex; if it fails to
    // decode, treat it as plaintext.
    let Ok(decoded) = hex::decode(stored) else {
        return Ok(stored.to_string());
    };
    // A hex-decodable legacy secret that lacks the at-rest magic prefix is still
    // plaintext (the hex decode was coincidental) — return it unchanged rather
    // than mangling it through the decryptor.
    if !paracord_util::at_rest::FileCryptor::payload_is_encrypted(&decoded) {
        return Ok(stored.to_string());
    }
    let plaintext = cryptor.decrypt(&decoded).map_err(|e| {
        ApiError::Internal(anyhow::anyhow!("github_secret decryption failed: {}", e))
    })?;
    String::from_utf8(plaintext)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("github_secret is not valid UTF-8: {}", e)))
}

fn webhook_to_json(w: &paracord_db::webhooks::WebhookRow, token: Option<&str>) -> Value {
    let mut v = json!({
        "id": w.id.to_string(),
        "guild_id": w.space_id.to_string(),
        "channel_id": w.channel_id.to_string(),
        "name": w.name,
        "creator_id": w.creator_id.map(|id| id.to_string()),
        "created_at": w.created_at.to_rfc3339(),
    });
    if let Some(token) = token {
        v["token"] = json!(token);
    }
    v
}

async fn require_manage_webhooks(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;

    let roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms =
        paracord_core::permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_WEBHOOKS)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateWebhookRequest {
    pub name: String,
    pub channel_id: Option<String>,
}

pub async fn create_webhook(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateWebhookRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_manage_webhooks(&state, guild_id, auth.user_id).await?;

    let name = body.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(ApiError::BadRequest(
            "Webhook name must be between 1 and 80 characters".into(),
        ));
    }

    // Determine target channel: either from body or first text channel in guild
    let channel_id = if let Some(ref raw) = body.channel_id {
        raw.parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid channel_id".into()))?
    } else {
        // Pick the first text channel in the guild
        let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        channels
            .into_iter()
            .find(|c| c.channel_type == 0)
            .map(|c| c.id)
            .ok_or(ApiError::BadRequest(
                "No text channel in guild to target".into(),
            ))?
    };

    // Verify channel belongs to guild
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.guild_id() != Some(guild_id) {
        return Err(ApiError::BadRequest(
            "Channel does not belong to this guild".into(),
        ));
    }

    let id = paracord_util::snowflake::generate(1);
    let token = crate::secure_tokens::generate_secure_token();

    let webhook = paracord_db::webhooks::create_webhook(
        &state.db,
        id,
        guild_id,
        channel_id,
        name,
        &token,
        auth.user_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_WEBHOOK_CREATE,
        Some(webhook.id),
        None,
        Some(json!({
            "channel_id": webhook.channel_id.to_string(),
            "name": webhook.name,
        })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(webhook_to_json(&webhook, Some(&token))),
    ))
}

pub async fn list_guild_webhooks(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    require_manage_webhooks(&state, guild_id, auth.user_id).await?;

    let webhooks = paracord_db::webhooks::get_guild_webhooks(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = webhooks.iter().map(|w| webhook_to_json(w, None)).collect();
    Ok(Json(json!(result)))
}

pub async fn list_channel_webhooks(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if let Some(guild_id) = channel.guild_id() {
        require_manage_webhooks(&state, guild_id, auth.user_id).await?;
    }

    let webhooks = paracord_db::webhooks::get_channel_webhooks(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = webhooks.iter().map(|w| webhook_to_json(w, None)).collect();
    Ok(Json(json!(result)))
}

pub async fn get_webhook(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(webhook_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let webhook = paracord_db::webhooks::get_webhook(&state.db, webhook_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    require_manage_webhooks(&state, webhook.space_id, auth.user_id).await?;

    Ok(Json(webhook_to_json(&webhook, None)))
}

#[derive(Deserialize)]
pub struct UpdateWebhookRequest {
    pub name: Option<String>,
    pub github_secret: Option<String>,
}

pub async fn update_webhook(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(webhook_id): Path<i64>,
    Json(body): Json<UpdateWebhookRequest>,
) -> Result<Json<Value>, ApiError> {
    let webhook = paracord_db::webhooks::get_webhook(&state.db, webhook_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    require_manage_webhooks(&state, webhook.space_id, auth.user_id).await?;

    if let Some(ref name) = body.name {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.len() > 80 {
            return Err(ApiError::BadRequest(
                "Webhook name must be between 1 and 80 characters".into(),
            ));
        }
    }

    let mut updated =
        paracord_db::webhooks::update_webhook(&state.db, webhook_id, body.name.as_deref())
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Update github_secret if provided (empty string clears it). The secret is
    // encrypted at rest so the stored column holds ciphertext, never the raw
    // HMAC key.
    if let Some(ref github_secret) = body.github_secret {
        let encrypted = if github_secret.is_empty() {
            None
        } else {
            Some(encrypt_github_secret(&state, github_secret)?)
        };
        updated = paracord_db::webhooks::update_webhook_github_secret(
            &state.db,
            webhook_id,
            encrypted.as_deref(),
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    audit::log_action(
        &state,
        webhook.space_id,
        auth.user_id,
        audit::ACTION_WEBHOOK_UPDATE,
        Some(updated.id),
        None,
        Some(json!({
            "name": updated.name,
            "channel_id": updated.channel_id.to_string(),
        })),
    )
    .await;

    Ok(Json(webhook_to_json(&updated, None)))
}

pub async fn delete_webhook(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(webhook_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let webhook = paracord_db::webhooks::get_webhook(&state.db, webhook_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    require_manage_webhooks(&state, webhook.space_id, auth.user_id).await?;

    paracord_db::webhooks::delete_webhook(&state.db, webhook_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    audit::log_action(
        &state,
        webhook.space_id,
        auth.user_id,
        audit::ACTION_WEBHOOK_DELETE,
        Some(webhook.id),
        None,
        Some(json!({
            "name": webhook.name,
            "channel_id": webhook.channel_id.to_string(),
        })),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ExecuteWebhookRequest {
    pub content: Option<String>,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub embeds: Option<Vec<Value>>,
}

#[derive(Deserialize, Default)]
pub struct ExecuteWebhookQuery {
    pub wait: Option<bool>,
}

#[derive(Deserialize)]
pub struct EditWebhookMessageRequest {
    pub content: Option<String>,
    pub embeds: Option<Vec<Value>>,
}

fn webhook_message_to_json(
    msg: &paracord_db::messages::MessageRow,
    webhook_id: i64,
    display_name: &str,
    avatar_url: Option<&str>,
) -> Value {
    let embeds_value: Value = msg
        .embeds
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| json!([]));
    json!({
        "id": msg.id.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "author": {
            "id": webhook_id.to_string(),
            "username": display_name,
            "discriminator": 0,
            "avatar_hash": null,
            "avatar_url": avatar_url,
            "bot": true,
        },
        "content": msg.content,
        "pinned": msg.pinned,
        "type": msg.message_type,
        "message_type": msg.message_type,
        "flags": msg.flags,
        "timestamp": msg.created_at.to_rfc3339(),
        "created_at": msg.created_at.to_rfc3339(),
        "edited_timestamp": msg.edited_at.map(|dt| dt.to_rfc3339()),
        "edited_at": msg.edited_at.map(|dt| dt.to_rfc3339()),
        "reference_id": msg.reference_id.map(|id| id.to_string()),
        "attachments": [],
        "reactions": [],
        "embeds": embeds_value,
        "webhook_id": webhook_id.to_string(),
    })
}

/// Truncate a string to at most `max_bytes`, snapping down to the nearest UTF-8
/// character boundary so we never slice through a multi-byte code point.
fn truncate_on_char_boundary(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn format_github_event(event_type: &str, payload: &Value) -> String {
    match event_type {
        "push" => {
            let pusher = payload["pusher"]["name"].as_str().unwrap_or("someone");
            let ref_name = payload["ref"].as_str().unwrap_or("unknown");
            let branch = ref_name.strip_prefix("refs/heads/").unwrap_or(ref_name);
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            let commits = payload["commits"].as_array();
            let commit_count = commits.map(|c| c.len()).unwrap_or(0);
            let mut msg = format!(
                "**{}** pushed {} commit{} to `{}` in **{}**",
                pusher,
                commit_count,
                if commit_count == 1 { "" } else { "s" },
                branch,
                repo
            );
            if let Some(commits) = commits {
                for commit in commits.iter().take(5) {
                    let sha = commit["id"].as_str().unwrap_or("").get(..7).unwrap_or("");
                    let message = commit["message"]
                        .as_str()
                        .unwrap_or("")
                        .lines()
                        .next()
                        .unwrap_or("");
                    let url = commit["url"].as_str().unwrap_or("");
                    msg.push_str(&format!("\n> [`{}`]({}) {}", sha, url, message));
                }
                if commits.len() > 5 {
                    msg.push_str(&format!("\n> ... and {} more commits", commits.len() - 5));
                }
            }
            msg
        }
        "pull_request" => {
            let action = payload["action"].as_str().unwrap_or("updated");
            let pr = &payload["pull_request"];
            let user = payload["sender"]["login"].as_str().unwrap_or("someone");
            let title = pr["title"].as_str().unwrap_or("Untitled");
            let number = pr["number"].as_u64().unwrap_or(0);
            let url = pr["html_url"].as_str().unwrap_or("");
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            let merged = pr["merged"].as_bool().unwrap_or(false);
            let effective_action = if action == "closed" && merged {
                "merged"
            } else {
                action
            };
            format!(
                "**{}** {} PR [#{}]({}) in **{}**: {}",
                user, effective_action, number, url, repo, title
            )
        }
        "issues" => {
            let action = payload["action"].as_str().unwrap_or("updated");
            let issue = &payload["issue"];
            let user = payload["sender"]["login"].as_str().unwrap_or("someone");
            let title = issue["title"].as_str().unwrap_or("Untitled");
            let number = issue["number"].as_u64().unwrap_or(0);
            let url = issue["html_url"].as_str().unwrap_or("");
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            format!(
                "**{}** {} issue [#{}]({}) in **{}**: {}",
                user, action, number, url, repo, title
            )
        }
        "issue_comment" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("someone");
            let issue = &payload["issue"];
            let number = issue["number"].as_u64().unwrap_or(0);
            let url = payload["comment"]["html_url"].as_str().unwrap_or("");
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            let body = payload["comment"]["body"].as_str().unwrap_or("");
            let preview = if body.len() > 200 {
                format!("{}...", truncate_on_char_boundary(body, 200))
            } else {
                body.to_string()
            };
            format!(
                "**{}** commented on [#{}]({}) in **{}**\n> {}",
                user, number, url, repo, preview
            )
        }
        "create" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("someone");
            let ref_type = payload["ref_type"].as_str().unwrap_or("reference");
            let ref_name = payload["ref"].as_str().unwrap_or("unknown");
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            format!(
                "**{}** created {} `{}` in **{}**",
                user, ref_type, ref_name, repo
            )
        }
        "delete" => {
            let user = payload["sender"]["login"].as_str().unwrap_or("someone");
            let ref_type = payload["ref_type"].as_str().unwrap_or("reference");
            let ref_name = payload["ref"].as_str().unwrap_or("unknown");
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            format!(
                "**{}** deleted {} `{}` in **{}**",
                user, ref_type, ref_name, repo
            )
        }
        "star" => {
            let action = payload["action"].as_str().unwrap_or("starred");
            let user = payload["sender"]["login"].as_str().unwrap_or("someone");
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            let stars = payload["repository"]["stargazers_count"]
                .as_u64()
                .unwrap_or(0);
            if action == "created" {
                format!("**{}** starred **{}** (now {} stars)", user, repo, stars)
            } else {
                format!("**{}** unstarred **{}** ({} stars)", user, repo, stars)
            }
        }
        _ => {
            let repo = payload["repository"]["full_name"]
                .as_str()
                .unwrap_or("unknown/repo");
            let user = payload["sender"]["login"].as_str().unwrap_or("someone");
            format!("**{}**: `{}` event in **{}**", user, event_type, repo)
        }
    }
}

/// Execute a webhook - no auth required, uses token in path.
pub async fn execute_webhook(
    State(state): State<AppState>,
    Query(query): Query<ExecuteWebhookQuery>,
    Path((webhook_id, token)): Path<(i64, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    // M13: Per-webhook rate limiting
    check_webhook_rate_limit(webhook_id)?;

    let webhook = paracord_db::webhooks::get_webhook_by_id_and_token(&state.db, webhook_id, &token)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Check for GitHub webhook
    let (content, display_name, avatar_url, embeds) =
        if let Some(github_event) = headers.get("X-GitHub-Event") {
            // H6: GitHub webhook signature verification is fail-closed. A webhook that
            // receives GitHub events MUST have a github_secret configured, and every
            // request must carry a valid HMAC signature. Without both we refuse the
            // request rather than accepting unauthenticated payloads.
            let Some(ref stored_secret) = webhook.github_secret else {
                tracing::warn!(
                    webhook_id = webhook_id,
                    "Rejecting GitHub webhook event: no github_secret configured"
                );
                return Err(ApiError::Unauthorized);
            };
            // The stored secret is encrypted at rest; recover the original HMAC
            // key before verifying the signature so GitHub HMAC semantics are
            // preserved.
            let secret = decrypt_github_secret(&state, stored_secret)?;
            let sig_header = headers
                .get("X-Hub-Signature-256")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !verify_github_signature(&secret, &body, sig_header) {
                return Err(ApiError::Unauthorized);
            }

            let event_type = github_event.to_str().unwrap_or("unknown");
            let payload: Value = serde_json::from_slice(&body)
                .map_err(|_| ApiError::BadRequest("Invalid JSON payload".into()))?;
            let content = format_github_event(event_type, &payload);
            // Run the constructed content (which embeds user-controlled fields such as
            // commit messages and issue titles) through the same guards as a normal
            // webhook execution.
            if content.trim().is_empty() {
                return Err(ApiError::BadRequest("Content must not be empty".into()));
            }
            if content.len() > 2000 {
                return Err(ApiError::BadRequest(
                    "Content must be 2000 characters or fewer".into(),
                ));
            }
            (content, "GitHub".to_string(), None, Vec::new())
        } else {
            // Normal webhook execution
            let req: ExecuteWebhookRequest = serde_json::from_slice(&body)
                .map_err(|_| ApiError::BadRequest("Invalid JSON payload".into()))?;
            let content = req
                .content
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_string();
            let embeds = req.embeds.unwrap_or_default();
            if content.is_empty() && embeds.is_empty() {
                return Err(ApiError::BadRequest("Content must not be empty".into()));
            }
            if content.len() > 2000 {
                return Err(ApiError::BadRequest(
                    "Content must be 2000 characters or fewer".into(),
                ));
            }
            let name = req.username.unwrap_or_else(|| webhook.name.clone());
            if name.trim().is_empty() || name.len() > 80 {
                return Err(ApiError::BadRequest(
                    "username must be between 1 and 80 characters".into(),
                ));
            }
            (content, name, req.avatar_url, embeds)
        };

    // Re-authorize the webhook creator at execution time. A webhook must never
    // be able to post as a creator who has since left the guild or lost access
    // to the target channel, so we re-check membership and SEND_MESSAGES here
    // (using the shared permission cache) rather than trusting the stored
    // creator id. Reject entirely if the webhook has no recorded creator.
    let Some(author_id) = webhook.creator_id else {
        return Err(ApiError::Forbidden);
    };
    let guild = paracord_db::guilds::get_guild(&state.db, webhook.space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    paracord_core::permissions::ensure_guild_member(&state.db, webhook.space_id, author_id).await?;
    let creator_perms = paracord_core::permissions::compute_channel_permissions_cached(
        &state.permission_cache,
        &state.db,
        webhook.space_id,
        webhook.channel_id,
        guild.owner_id,
        author_id,
    )
    .await?;
    paracord_core::permissions::require_permission(creator_perms, Permissions::SEND_MESSAGES)?;

    // Create the message using the webhook creator as the author
    let msg_id = paracord_util::snowflake::generate(1);

    let msg = paracord_db::messages::create_message(
        &state.db,
        msg_id,
        webhook.channel_id,
        author_id,
        &content,
        0, // message_type: 0 = default
        None,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !embeds.is_empty() {
        let embeds_json = serde_json::to_string(&embeds)
            .map_err(|_| ApiError::BadRequest("Invalid embeds payload".into()))?;
        paracord_db::messages::update_message_embeds(&state.db, msg.id, &embeds_json)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }
    paracord_db::webhooks::link_webhook_message(&state.db, webhook.id, msg.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let msg = paracord_db::messages::get_message_with_embeds(&state.db, msg.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let channel = paracord_db::channels::get_channel(&state.db, webhook.channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.and_then(|c| c.guild_id());

    let msg_json = webhook_message_to_json(&msg, webhook.id, &display_name, avatar_url.as_deref());

    state
        .event_bus
        .dispatch("MESSAGE_CREATE", msg_json.clone(), guild_id);

    if query.wait.unwrap_or(true) {
        Ok((StatusCode::CREATED, Json(msg_json)))
    } else {
        Ok((StatusCode::NO_CONTENT, Json(Value::Null)))
    }
}

pub async fn edit_webhook_message(
    State(state): State<AppState>,
    Path((webhook_id, token, message_id)): Path<(i64, String, i64)>,
    Json(body): Json<EditWebhookMessageRequest>,
) -> Result<Json<Value>, ApiError> {
    let webhook = paracord_db::webhooks::get_webhook_by_id_and_token(&state.db, webhook_id, &token)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let owns_message =
        paracord_db::webhooks::webhook_owns_message(&state.db, webhook.id, message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !owns_message {
        return Err(ApiError::NotFound);
    }

    let existing = paracord_db::messages::get_message_with_embeds(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if existing.channel_id != webhook.channel_id {
        return Err(ApiError::NotFound);
    }

    let has_content_update = body.content.is_some();
    let has_embed_update = body.embeds.is_some();
    if !has_content_update && !has_embed_update {
        return Err(ApiError::BadRequest(
            "content or embeds is required".to_string(),
        ));
    }

    if let Some(content) = body.content.as_deref() {
        if content.trim().len() > 2000 {
            return Err(ApiError::BadRequest(
                "Content must be 2000 characters or fewer".into(),
            ));
        }
    }

    if has_content_update {
        let updated_content = body
            .content
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        paracord_db::messages::update_message(&state.db, message_id, &updated_content)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    if let Some(embeds) = body.embeds.as_ref() {
        let embeds_json = serde_json::to_string(embeds)
            .map_err(|_| ApiError::BadRequest("Invalid embeds payload".into()))?;
        paracord_db::messages::update_message_embeds(&state.db, message_id, &embeds_json)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let msg = paracord_db::messages::get_message_with_embeds(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let guild_id = paracord_db::channels::get_channel(&state.db, webhook.channel_id)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.guild_id());
    let msg_json = webhook_message_to_json(&msg, webhook.id, &webhook.name, None);

    state
        .event_bus
        .dispatch("MESSAGE_UPDATE", msg_json.clone(), guild_id);

    Ok(Json(msg_json))
}

pub async fn delete_webhook_message(
    State(state): State<AppState>,
    Path((webhook_id, token, message_id)): Path<(i64, String, i64)>,
) -> Result<StatusCode, ApiError> {
    let webhook = paracord_db::webhooks::get_webhook_by_id_and_token(&state.db, webhook_id, &token)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let owns_message =
        paracord_db::webhooks::webhook_owns_message(&state.db, webhook.id, message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !owns_message {
        return Err(ApiError::NotFound);
    }

    let msg = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if msg.channel_id != webhook.channel_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::messages::delete_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let guild_id = paracord_db::channels::get_channel(&state.db, webhook.channel_id)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.guild_id());
    let delete_payload = json!({
        "id": message_id.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "guild_id": guild_id.map(|id| id.to_string()),
    });
    state
        .event_bus
        .dispatch("MESSAGE_DELETE", delete_payload, guild_id);

    Ok(StatusCode::NO_CONTENT)
}
