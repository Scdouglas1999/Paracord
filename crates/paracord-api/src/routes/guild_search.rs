//! `GET /api/v1/guilds/{guild_id}/messages/search`
//!
//! Searches every text channel, announcement channel, thread, and forum post
//! in the server that the caller can view and whose history they can read.
//! Direct messages are never included.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, RawQuery, State},
    Json,
};
use paracord_core::AppState;
use paracord_db::channels::ChannelRow;
use paracord_db::message_search::{MessageHas, MessageSearch, MessageSearchOrder};
use paracord_models::id::{ChannelId, UserId};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::channels::{messages_to_json, parse_optional_datetime_param};

const CHANNEL_TYPE_TEXT: i16 = 0;
const CHANNEL_TYPE_ANNOUNCEMENT: i16 = 5;
const CHANNEL_TYPE_THREAD: i16 = 6;
const CHANNEL_TYPE_FORUM: i16 = 7;
const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 50;
const MAX_OFFSET: i64 = 10_000;

#[derive(Deserialize)]
pub struct GuildMessageSearchQuery {
    #[serde(default)]
    pub q: String,
    pub author_id: Option<String>,
    pub channel_id: Option<String>,
    pub mentions: Option<String>,
    pub pinned: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// `has` is repeatable (`has=link&has=image`). Serde's query decoder rejects
/// a duplicated key, so these values are read from the raw query string.
fn repeated_query_values(raw: Option<&str>, key: &str) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    url::form_urlencoded::parse(raw.as_bytes())
        .filter(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

fn parse_snowflake(raw: Option<&str>, name: &str) -> Result<Option<i64>, ApiError> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    value
        .parse::<i64>()
        .map(Some)
        .map_err(|_| ApiError::BadRequest(format!("Invalid {name}")))
}

fn parse_pinned(raw: Option<&str>) -> Result<Option<bool>, ApiError> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    match value {
        "1" | "true" | "TRUE" | "True" => Ok(Some(true)),
        "0" | "false" | "FALSE" | "False" => Ok(Some(false)),
        _ => Err(ApiError::BadRequest("pinned must be true or false".into())),
    }
}

fn parse_has(values: &[String]) -> Result<Vec<MessageHas>, ApiError> {
    let mut parsed = Vec::new();
    for raw in values {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        let kind = match value.to_ascii_lowercase().as_str() {
            "link" => MessageHas::Link,
            "image" => MessageHas::Image,
            "video" => MessageHas::Video,
            "file" => MessageHas::File,
            "poll" => MessageHas::Poll,
            "embed" => MessageHas::Embed,
            other => {
                return Err(ApiError::BadRequest(format!(
                    "Unknown has filter \"{other}\". Use link, image, video, file, poll, or embed."
                )));
            }
        };
        if !parsed.contains(&kind) {
            parsed.push(kind);
        }
    }
    Ok(parsed)
}

fn is_message_channel(channel_type: i16) -> bool {
    matches!(
        channel_type,
        CHANNEL_TYPE_TEXT | CHANNEL_TYPE_ANNOUNCEMENT | CHANNEL_TYPE_THREAD
    )
}

fn can_read_history(perms: Permissions) -> bool {
    perms.contains(Permissions::VIEW_CHANNEL | Permissions::READ_MESSAGE_HISTORY)
}

pub async fn search_guild_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(params): Query<GuildMessageSearchQuery>,
    RawQuery(raw_query): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let author_id = parse_snowflake(params.author_id.as_deref(), "author_id")?;
    let channel_filter = parse_snowflake(params.channel_id.as_deref(), "channel_id")?;
    let mentions = parse_snowflake(params.mentions.as_deref(), "mentions")?;
    let has = parse_has(&repeated_query_values(raw_query.as_deref(), "has"))?;
    let pinned = parse_pinned(params.pinned.as_deref())?;
    let after = parse_optional_datetime_param(params.after.as_deref(), false)?;
    let before = parse_optional_datetime_param(params.before.as_deref(), true)?;
    if let (Some(after_dt), Some(before_dt)) = (after.as_ref(), before.as_ref()) {
        if after_dt > before_dt {
            return Err(ApiError::BadRequest(
                "after filter must be earlier than before filter".into(),
            ));
        }
    }
    let limit = match params.limit {
        None => DEFAULT_LIMIT,
        Some(limit) if (1..=MAX_LIMIT).contains(&limit) => limit,
        Some(_) => {
            return Err(ApiError::BadRequest(
                "limit must be between 1 and 50".into(),
            ))
        }
    };
    let offset = match params.offset {
        None => 0,
        Some(offset) if (0..=MAX_OFFSET).contains(&offset) => offset,
        Some(offset) if offset < 0 => {
            return Err(ApiError::BadRequest("offset must be zero or more".into()))
        }
        Some(_) => return Err(ApiError::BadRequest("offset is too large".into())),
    };

    let query_text = params.q.trim();
    let has_filter = author_id.is_some()
        || channel_filter.is_some()
        || !has.is_empty()
        || mentions.is_some()
        || pinned.is_some()
        || after.is_some()
        || before.is_some();
    if query_text.is_empty() && !has_filter {
        return Err(ApiError::BadRequest(
            "Add a search word or at least one filter.".into(),
        ));
    }

    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let permission_generation = state.permission_cache.generation();
    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let channel_permissions = paracord_core::permissions::compute_all_channel_permissions(
        &state.db,
        guild_id,
        &channels,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::seed_channel_permissions(
        &state.permission_cache,
        auth.user_id,
        &channel_permissions,
        permission_generation,
    )
    .await;

    let can_read = |channel: &ChannelRow| {
        can_read_history(
            channel_permissions
                .get(&channel.id)
                .copied()
                .unwrap_or_else(Permissions::empty),
        )
    };

    let search_channels: Vec<&ChannelRow> = if let Some(channel_id) = channel_filter {
        // A channel of another server and a channel the caller cannot read
        // answer the same way, so the filter cannot probe for hidden channels.
        let Some(channel) = channels
            .iter()
            .find(|channel| channel.id == channel_id)
            .filter(|channel| can_read(channel))
        else {
            return Ok(Json(json!({ "total": 0, "messages": [] })));
        };
        if channel.channel_type == CHANNEL_TYPE_FORUM {
            channels
                .iter()
                .filter(|child| {
                    child.parent_id == Some(channel.id)
                        && child.channel_type == CHANNEL_TYPE_THREAD
                        && can_read(child)
                })
                .collect()
        } else if is_message_channel(channel.channel_type) {
            vec![channel]
        } else {
            return Err(ApiError::BadRequest(
                "That channel cannot be searched.".into(),
            ));
        }
    } else {
        channels
            .iter()
            .filter(|channel| is_message_channel(channel.channel_type) && can_read(channel))
            .collect()
    };

    if search_channels.is_empty() {
        return Ok(Json(json!({ "total": 0, "messages": [] })));
    }
    if search_channels.len() > paracord_db::message_search::MAX_SEARCH_CHANNELS {
        return Err(ApiError::BadRequest(
            "This server has too many channels to search at once.".into(),
        ));
    }

    let mut by_id: HashMap<i64, &ChannelRow> = HashMap::with_capacity(search_channels.len());
    let mut channel_ids = Vec::with_capacity(search_channels.len());
    for channel in &search_channels {
        by_id.insert(channel.id, *channel);
        channel_ids.push(ChannelId::new(channel.id));
    }

    let page = paracord_db::message_search::search_messages_page(
        &state.db,
        &MessageSearch {
            channel_ids: &channel_ids,
            query: if query_text.is_empty() {
                None
            } else {
                Some(query_text)
            },
            author_id: author_id.map(UserId::new),
            after,
            before,
            pinned,
            mentions_user_id: mentions.map(UserId::new),
            has: &has,
            limit,
            offset,
            order: MessageSearchOrder::Newest,
        },
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let message_json = messages_to_json(&state, &page.messages, auth.user_id).await;
    let mut messages = Vec::with_capacity(page.messages.len());
    for (row, message) in page.messages.iter().zip(message_json) {
        let channel = by_id.get(&row.channel_id);
        let mut item = json!({
            "message": message,
            "channel_id": row.channel_id.to_string(),
            "channel_name": channel.and_then(|channel| channel.name.clone()).unwrap_or_else(|| "channel".to_string()),
        });
        if let Some(channel) = channel {
            if channel.channel_type == CHANNEL_TYPE_THREAD {
                if let Some(parent_id) = channel.parent_id {
                    item["thread_parent_id"] = json!(parent_id.to_string());
                }
            }
        }
        messages.push(item);
    }

    Ok(Json(json!({
        "total": page.total,
        "messages": messages,
    })))
}
