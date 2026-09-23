//! Channel and server media galleries.
//!
//! Posted attachments and link URLs, paged by snowflake. Direct messages are
//! refused: their attachments are encrypted and this list would only return
//! ciphertext.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use paracord_core::AppState;
use paracord_db::attachments::{GalleryKindFilter, LinkCandidate, PostedAttachment};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;
const LINK_SCAN_BATCH: i64 = 50;
const MAX_LINK_SCANS: usize = 20;

const DM_GALLERY_MESSAGE: &str = "Direct messages are end-to-end encrypted. Their media stays on this device and is not listed here.";

#[derive(Debug, Deserialize)]
pub struct AttachmentGalleryQuery {
    pub kind: Option<String>,
    pub before: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct GuildAttachmentGalleryQuery {
    pub kind: Option<String>,
    pub before: Option<String>,
    pub limit: Option<i64>,
    pub channel_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LinkGalleryQuery {
    pub before: Option<String>,
    pub limit: Option<i64>,
}

fn parse_limit(limit: Option<i64>) -> Result<i64, ApiError> {
    match limit {
        None => Ok(DEFAULT_LIMIT),
        Some(limit) if (1..=MAX_LIMIT).contains(&limit) => Ok(limit),
        Some(_) => Err(ApiError::BadRequest(format!(
            "limit must be between 1 and {MAX_LIMIT}"
        ))),
    }
}

fn parse_before(before: Option<&str>) -> Result<Option<i64>, ApiError> {
    match before.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) => value
            .parse::<i64>()
            .map(Some)
            .map_err(|_| ApiError::BadRequest("before must be an attachment or message id".into())),
    }
}

fn parse_kinds(kind: Option<&str>) -> Result<GalleryKindFilter, ApiError> {
    let Some(kind) = kind.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(GalleryKindFilter::all());
    };
    let mut filter = GalleryKindFilter {
        image: false,
        video: false,
        file: false,
    };
    for token in kind.split(',') {
        match token.trim() {
            "image" => filter.image = true,
            "video" => filter.video = true,
            "file" => filter.file = true,
            "" => {}
            other => {
                return Err(ApiError::BadRequest(format!(
                    "kind must be image, video, or file (got {other})"
                )));
            }
        }
    }
    if !filter.image && !filter.video && !filter.file {
        return Err(ApiError::BadRequest(
            "kind must include image, video, or file".into(),
        ));
    }
    Ok(filter)
}

fn attachment_kind(content_type: Option<&str>) -> &'static str {
    let content_type = content_type.unwrap_or("").to_ascii_lowercase();
    if content_type.starts_with("image/") {
        "image"
    } else if content_type.starts_with("video/") {
        "video"
    } else {
        "file"
    }
}

fn author_json(
    id: i64,
    username: &str,
    display_name: &Option<String>,
    avatar_hash: &Option<String>,
) -> Value {
    json!({
        "id": id.to_string(),
        "username": username,
        "display_name": display_name,
        "avatar_hash": avatar_hash,
    })
}

fn attachment_json(row: &PostedAttachment) -> Value {
    json!({
        "id": row.id.to_string(),
        "message_id": row.message_id.to_string(),
        "channel_id": row.channel_id.to_string(),
        "filename": row.filename,
        "content_type": row.content_type,
        "size": row.size,
        "url": row.url,
        "width": row.width,
        "height": row.height,
        "kind": attachment_kind(row.content_type.as_deref()),
        "created_at": row.created_at.to_rfc3339(),
        "author": author_json(row.author_id, &row.author_username, &row.author_display_name, &row.author_avatar_hash),
    })
}

/// Show each item's author the way the message itself shows them.
///
/// A post in an anonymous channel and a webhook post are both stored under a
/// real user id. The message list swaps in the alias or the webhook; the
/// gallery must do the same, or it would name who wrote an anonymous post.
async fn mask_authors(state: &AppState, mut page: Value) -> Result<Value, ApiError> {
    let Some(items) = page.get_mut("items").and_then(Value::as_array_mut) else {
        return Ok(page);
    };
    let mut message_ids: Vec<i64> = items
        .iter()
        .filter_map(|item| item.get("message_id")?.as_str()?.parse().ok())
        .collect();
    message_ids.sort_unstable();
    message_ids.dedup();
    if message_ids.is_empty() {
        return Ok(page);
    }
    let anonymous =
        paracord_db::messages::get_anonymous_messages_for_message_ids(&state.db, &message_ids)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let webhooks = paracord_db::webhooks::get_webhooks_for_message_ids(&state.db, &message_ids)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if anonymous.is_empty() && webhooks.is_empty() {
        return Ok(page);
    }
    let mut masks = std::collections::HashMap::new();
    for row in anonymous {
        masks.insert(
            row.message_id,
            json!({
                "id": format!("anon:{}:{}", row.channel_id, row.alias),
                "username": row.alias,
                "display_name": null,
                "avatar_hash": null,
            }),
        );
    }
    for (message_id, webhook_id, name) in webhooks {
        masks.entry(message_id).or_insert_with(|| {
            json!({
                "id": webhook_id.to_string(),
                "username": name,
                "display_name": null,
                "avatar_hash": null,
            })
        });
    }
    for item in items.iter_mut() {
        let id = item
            .get("message_id")
            .and_then(Value::as_str)
            .and_then(|id| id.parse::<i64>().ok());
        if let Some(mask) = id.and_then(|id| masks.get(&id)) {
            item["author"] = mask.clone();
        }
    }
    Ok(page)
}

fn page(items: Vec<Value>, next_before: Option<i64>) -> Value {
    json!({
        "items": items,
        "next_before": next_before.map(|id| id.to_string()),
    })
}

async fn load_channel_for_gallery(
    state: &AppState,
    user_id: i64,
    channel_id: i64,
) -> Result<i64, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type == 1 || channel.channel_type == 3 {
        return Err(ApiError::BadRequest(DM_GALLERY_MESSAGE.into()));
    }
    let guild_id = channel.guild_id().ok_or(ApiError::Forbidden)?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions_cached(
        &state.permission_cache,
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::READ_MESSAGE_HISTORY)?;
    Ok(guild_id)
}

async fn readable_guild_channels(
    state: &AppState,
    user_id: i64,
    guild_id: i64,
) -> Result<Vec<i64>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let mut readable = Vec::new();
    for channel in channels {
        // Direct messages never belong to a server; a category holds no messages.
        if matches!(channel.channel_type, 1 | 3 | 4) {
            continue;
        }
        let perms = paracord_core::permissions::compute_channel_permissions_cached(
            &state.permission_cache,
            &state.db,
            guild_id,
            channel.id,
            guild.owner_id,
            user_id,
        )
        .await?;
        if perms.contains(Permissions::VIEW_CHANNEL | Permissions::READ_MESSAGE_HISTORY) {
            readable.push(channel.id);
        }
    }
    if readable.len() > paracord_db::attachments::MAX_GALLERY_CHANNELS {
        return Err(ApiError::BadRequest(
            "This server has too many channels to gather its media at once. Open a channel's media instead.".into(),
        ));
    }
    Ok(readable)
}

pub async fn list_channel_attachments(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<AttachmentGalleryQuery>,
) -> Result<Json<Value>, ApiError> {
    load_channel_for_gallery(&state, auth.user_id, channel_id).await?;
    let limit = parse_limit(query.limit)?;
    let before = parse_before(query.before.as_deref())?;
    let kinds = parse_kinds(query.kind.as_deref())?;
    let rows = paracord_db::attachments::list_posted_attachments(
        &state.db,
        &[channel_id],
        before,
        limit,
        kinds,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let next_before = (rows.len() as i64 == limit)
        .then(|| rows.last().map(|row| row.id))
        .flatten();
    Ok(Json(
        mask_authors(
            &state,
            page(rows.iter().map(attachment_json).collect(), next_before),
        )
        .await?,
    ))
}

pub async fn list_guild_attachments(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(query): Query<GuildAttachmentGalleryQuery>,
) -> Result<Json<Value>, ApiError> {
    let mut channels = readable_guild_channels(&state, auth.user_id, guild_id).await?;
    if let Some(channel_id) = query
        .channel_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let channel_id = channel_id
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("channel_id must be a channel id".into()))?;
        if !channels.contains(&channel_id) {
            return Err(ApiError::NotFound);
        }
        channels = vec![channel_id];
    }
    let limit = parse_limit(query.limit)?;
    let before = parse_before(query.before.as_deref())?;
    let kinds = parse_kinds(query.kind.as_deref())?;
    let rows = paracord_db::attachments::list_posted_attachments(
        &state.db, &channels, before, limit, kinds,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let next_before = (rows.len() as i64 == limit)
        .then(|| rows.last().map(|row| row.id))
        .flatten();
    Ok(Json(
        mask_authors(
            &state,
            page(rows.iter().map(attachment_json).collect(), next_before),
        )
        .await?,
    ))
}

fn embed_for_url(
    embeds: Option<&str>,
    url: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(raw) = embeds else {
        return (None, None, None);
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return (None, None, None);
    };
    for item in items {
        if item.get("url").and_then(Value::as_str) != Some(url) {
            continue;
        }
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string);
        let site = item
            .pointer("/provider/name")
            .and_then(Value::as_str)
            .map(str::to_string);
        let image = item
            .pointer("/thumbnail/url")
            .and_then(Value::as_str)
            .map(str::to_string);
        return (title, site, image);
    }
    (None, None, None)
}

fn link_json(message: &LinkCandidate, url: &str) -> Value {
    let (title, site, image) = embed_for_url(message.embeds.as_deref(), url);
    json!({
        "url": url,
        "title": title,
        "site": site,
        "image": image,
        "message_id": message.id.to_string(),
        "channel_id": message.channel_id.to_string(),
        "created_at": message.created_at.to_rfc3339(),
        "author": author_json(
            message.author_id,
            &message.author_username,
            &message.author_display_name,
            &message.author_avatar_hash,
        ),
    })
}

/// One page of links, newest first.
///
/// Messages are scanned in batches because most carry no URL. The cursor is a
/// message id: `next_before` is the last message examined, so the next page
/// resumes exactly where this one stopped, and it is null once the channel has
/// no older messages. A page can hold a few more than `limit` links when the
/// last message posted several.
async fn list_links(
    state: &AppState,
    channel_ids: &[i64],
    before: Option<i64>,
    limit: i64,
) -> Result<Value, ApiError> {
    let page_limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let mut items = Vec::new();
    let mut cursor = before;

    for _ in 0..MAX_LINK_SCANS {
        let batch = paracord_db::attachments::list_link_candidates(
            &state.db,
            channel_ids,
            cursor,
            LINK_SCAN_BATCH,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let exhausted = (batch.len() as i64) < LINK_SCAN_BATCH;
        for message in &batch {
            if items.len() >= page_limit {
                return Ok(page(items, cursor));
            }
            for url in crate::opengraph::extract_urls(&message.content) {
                items.push(link_json(message, &url));
            }
            cursor = Some(message.id);
        }
        if exhausted {
            return Ok(page(items, None));
        }
        if items.len() >= page_limit {
            break;
        }
    }
    Ok(page(items, cursor))
}

pub async fn list_channel_links(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<LinkGalleryQuery>,
) -> Result<Json<Value>, ApiError> {
    load_channel_for_gallery(&state, auth.user_id, channel_id).await?;
    let limit = parse_limit(query.limit)?;
    let before = parse_before(query.before.as_deref())?;
    Ok(Json(
        mask_authors(
            &state,
            list_links(&state, &[channel_id], before, limit).await?,
        )
        .await?,
    ))
}
