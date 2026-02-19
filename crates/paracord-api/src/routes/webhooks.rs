use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

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
    let token = generate_webhook_token();

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

    let updated =
        paracord_db::webhooks::update_webhook(&state.db, webhook_id, body.name.as_deref())
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

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

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ExecuteWebhookRequest {
    pub content: String,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
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
                    let sha = commit["id"]
                        .as_str()
                        .unwrap_or("")
                        .get(..7)
                        .unwrap_or("");
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
                    msg.push_str(&format!(
                        "\n> ... and {} more commits",
                        commits.len() - 5
                    ));
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
                format!("{}...", &body[..200])
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
    Path((webhook_id, token)): Path<(i64, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let webhook = paracord_db::webhooks::get_webhook_by_id_and_token(&state.db, webhook_id, &token)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Check for GitHub webhook
    let (content, display_name) = if let Some(github_event) = headers.get("X-GitHub-Event") {
        let event_type = github_event.to_str().unwrap_or("unknown");
        let payload: Value = serde_json::from_slice(&body)
            .map_err(|_| ApiError::BadRequest("Invalid JSON payload".into()))?;
        let content = format_github_event(event_type, &payload);
        (content, "GitHub".to_string())
    } else {
        // Normal webhook execution
        let req: ExecuteWebhookRequest = serde_json::from_slice(&body)
            .map_err(|_| ApiError::BadRequest("Invalid JSON payload".into()))?;
        let content = req.content.trim().to_string();
        if content.is_empty() {
            return Err(ApiError::BadRequest("Content must not be empty".into()));
        }
        if content.len() > 2000 {
            return Err(ApiError::BadRequest(
                "Content must be 2000 characters or fewer".into(),
            ));
        }
        let name = req.username.unwrap_or_else(|| webhook.name.clone());
        (content, name)
    };

    // Create the message using the webhook creator as the author
    let msg_id = paracord_util::snowflake::generate(1);
    let author_id = webhook.creator_id.unwrap_or(0);

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

    let channel = paracord_db::channels::get_channel(&state.db, webhook.channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.and_then(|c| c.guild_id());

    let msg_json = json!({
        "id": msg.id.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "author": {
            "id": webhook.id.to_string(),
            "username": display_name,
            "discriminator": 0,
            "avatar_hash": null,
            "bot": true,
        },
        "content": msg.content,
        "pinned": msg.pinned,
        "type": msg.message_type,
        "message_type": msg.message_type,
        "timestamp": msg.created_at.to_rfc3339(),
        "created_at": msg.created_at.to_rfc3339(),
        "edited_timestamp": null,
        "edited_at": null,
        "reference_id": null,
        "attachments": [],
        "reactions": [],
        "webhook_id": webhook.id.to_string(),
    });

    state
        .event_bus
        .dispatch("MESSAGE_CREATE", msg_json.clone(), guild_id);

    Ok((StatusCode::CREATED, Json(msg_json)))
}

fn generate_webhook_token() -> String {
    use rand::RngCore;
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}
