use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use paracord_core::{AppState, MESSAGE_FLAG_DM_E2EE};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;
use crate::routes::mod_log;

// Cohesive submodules split out of the former monolithic `channels.rs`. Each
// holds a group of route handlers and their request/query types; the shared
// helpers, channel CRUD, permission overwrites, follows and federation
// forwarding stay here in the module root. The `pub use` re-exports keep every
// handler reachable at `crate::routes::channels::<fn>` so `lib.rs` routing and
// other callers are unchanged.
mod capabilities;
mod forums;
mod messages;
mod pins;
mod polls;
mod reactions;
mod saved;
mod threads;

pub use capabilities::*;
pub use forums::*;
pub use messages::*;
pub use pins::*;
pub use polls::*;
pub use reactions::*;
pub use saved::*;
pub use threads::*;

/// Fan a channel event out to the correct audience: a guild channel broadcasts
/// to the whole owning guild, while a DM channel delivers only to that DM's
/// recipients. Collapses the guild-vs-DM dispatch branch that was duplicated
/// across every message/reaction/poll/pin/typing handler.
async fn dispatch_channel_event(
    state: &AppState,
    channel: &paracord_db::channels::ChannelRow,
    event: &str,
    payload: Value,
) -> Result<(), ApiError> {
    let message_event = matches!(
        event,
        "MESSAGE_CREATE" | "MESSAGE_UPDATE" | "MESSAGE_DELETE" | "MESSAGE_DELETE_BULK"
    );
    match channel.guild_id() {
        Some(guild_id) => {
            if message_event {
                state
                    .event_bus
                    .dispatch_message(&state.db, event, payload, Some(guild_id))
                    .await;
            } else {
                state.event_bus.dispatch(event, payload, Some(guild_id));
            }
        }
        None => {
            let recipient_ids =
                paracord_db::dms::get_dm_recipient_ids(&state.db, channel.id).await?;
            if message_event {
                state
                    .event_bus
                    .dispatch_message_to_users(&state.db, event, payload, recipient_ids)
                    .await;
            } else {
                state
                    .event_bus
                    .dispatch_to_users(event, payload, recipient_ids);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
use paracord_util::mentions::contains_mass_mention;

const MAX_CHANNEL_TOPIC_LEN: usize = 1_024;
/// Matches the `channels.name` column, and the bound the thread handlers in
/// this crate already apply. The guild channel create/update handlers had no
/// bound at all, so an over-long name stored fine on SQLite and 500ed on
/// PostgreSQL.
const MAX_CHANNEL_NAME_LEN: usize = 100;
const MAX_BULK_DELETE_REQUEST_IDS: usize = 500;
const MAX_POLL_QUESTION_LEN: usize = 300;
const MAX_POLL_OPTION_LEN: usize = 100;
const MAX_POLL_OPTIONS: usize = 10;
const MAX_POLL_DURATION_MINUTES: i64 = 60 * 24 * 14; // 14 days
const MAX_MESSAGE_NONCE_LEN: usize = 64;
const MAX_FORUM_SEARCH_POSTS: usize = 250;

use paracord_util::validation::{contains_dangerous_markup, validate_visible_label};

fn parse_optional_datetime_param(
    raw: Option<&str>,
    end_of_day_for_date_only: bool,
) -> Result<Option<DateTime<Utc>>, ApiError> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Ok(Some(dt.with_timezone(&Utc)));
    }

    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        let naive = if end_of_day_for_date_only {
            date.and_hms_opt(23, 59, 59)
        } else {
            date.and_hms_opt(0, 0, 0)
        }
        .ok_or_else(|| ApiError::BadRequest("Invalid date filter value".into()))?;
        return Ok(Some(Utc.from_utc_datetime(&naive)));
    }

    Err(ApiError::BadRequest(
        "Invalid date filter. Use RFC3339 or YYYY-MM-DD.".into(),
    ))
}

/// A category channel; `parent_id` may point at nothing else.
const CHANNEL_TYPE_CATEGORY: i16 = 4;

/// The room kinds a space owner may create through this route.
///
/// Text, voice, category, announcement, forum and stage. Direct messages (1)
/// and group DMs (3) are not a space's to create, and a thread (6) is created
/// from the message it hangs off. Any `i16` used to be accepted and stored:
/// `channel_type: 9999` returned 201 and the sidebar then drew it as an
/// ordinary text room, because every reader falls back to type 0.
const CREATABLE_CHANNEL_TYPES: [i16; 6] = [0, 2, 4, 5, 7, 13];

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub channel_type: i16,
    /// A snowflake, as a decimal string — every other id on this API, including
    /// `required_role_ids` in this same body and `parent_id` on the sibling
    /// channel-positions route, travels that way. It was typed `i64` here, which
    /// meant the client's string was a 422 (so a room could not be created
    /// inside a category at all) and a raw JSON number lost precision above
    /// 2^53 in every JavaScript caller.
    pub parent_id: Option<String>,
    pub required_role_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub required_role_ids: Option<Vec<String>>,
    pub rate_limit_per_user: Option<i32>,
    /// Voice channel audio bitrate in bits/sec (8000–384000).
    pub bitrate: Option<i32>,
    /// Max simultaneous users (0 = unlimited, 1–99).
    pub user_limit: Option<i32>,
    pub nsfw: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateReadStateRequest {
    pub last_message_id: Option<String>,
}

#[derive(Deserialize)]
pub struct UpsertChannelOverwriteRequest {
    pub target_type: i16,
    pub allow_perms: i64,
    pub deny_perms: i64,
}

fn validate_overwrite_permission_bits(
    guild_owner_id: i64,
    actor_user_id: i64,
    actor_perms: Permissions,
    allow_perms: i64,
    deny_perms: i64,
) -> Result<(), ApiError> {
    // Whoever the actor is, the bits have to be bits this server defines. The
    // owner and every ADMINISTRATOR used to take the early return below and
    // skip this entirely, so `allow_perms: -1` stored every unknown bit in the
    // set and then took part in permission math forever after.
    for bits in [allow_perms, deny_perms] {
        Permissions::from_bits(bits)
            .ok_or(ApiError::BadRequest("Invalid permissions bitset".into()))?;
    }
    if actor_user_id == guild_owner_id || actor_perms.contains(Permissions::ADMINISTRATOR) {
        return Ok(());
    }
    for bits in [allow_perms, deny_perms] {
        if bits & Permissions::ADMINISTRATOR.bits() != 0 {
            return Err(ApiError::Forbidden);
        }
        let disallowed = bits & !actor_perms.bits();
        if disallowed != 0 {
            return Err(ApiError::Forbidden);
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct AddChannelFollowRequest {
    pub target_channel_id: String,
    pub target_guild_id: String,
}

pub fn channel_to_json(c: &paracord_db::channels::ChannelRow) -> Value {
    let required_role_ids: Vec<String> =
        paracord_db::channels::parse_required_role_ids(&c.required_role_ids)
            .into_iter()
            .map(|id| id.to_string())
            .collect();

    let thread_metadata: Option<Value> = c
        .thread_metadata
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    let applied_tags: Option<Value> = c
        .applied_tags
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    json!({
        "id": c.id.to_string(),
        "guild_id": c.guild_id().map(|id| id.to_string()),
        "name": c.name,
        "topic": c.topic,
        "type": c.channel_type,
        "channel_type": c.channel_type,
        "position": c.position,
        "parent_id": c.parent_id.map(|id| id.to_string()),
        "nsfw": c.nsfw,
        "rate_limit_per_user": c.rate_limit_per_user,
        "last_message_id": c.last_message_id.map(|id| id.to_string()),
            "message_revision": c.message_revision.to_string(),
        "required_role_ids": required_role_ids,
        "thread_metadata": thread_metadata,
        "owner_id": c.owner_id.map(|id| id.to_string()),
        "message_count": c.message_count,
        "applied_tags": applied_tags,
        "default_sort_order": c.default_sort_order,
        "created_at": c.created_at.to_rfc3339(),
    })
}

fn parse_role_id_strings(raw_role_ids: &[String]) -> Result<Vec<i64>, ApiError> {
    raw_role_ids
        .iter()
        .map(|raw| {
            raw.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid role id".into()))
        })
        .collect()
}

async fn normalize_required_role_ids(
    state: &AppState,
    guild_id: i64,
    actor_id: i64,
    raw_role_ids: &[String],
) -> Result<String, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // Capped fold — see `compute_guild_permissions`.
    let actor_perms = paracord_core::permissions::compute_guild_permissions(
        &state.db,
        guild_id,
        guild.owner_id,
        actor_id,
    )
    .await?;
    if !paracord_core::permissions::is_server_admin(actor_perms) {
        return Err(ApiError::Forbidden);
    }

    let mut parsed_role_ids = parse_role_id_strings(raw_role_ids)?;
    parsed_role_ids.retain(|role_id| *role_id != guild_id);
    if parsed_role_ids.is_empty() {
        return Ok("[]".to_string());
    }

    let guild_roles = paracord_db::roles::get_guild_roles(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let guild_role_ids: std::collections::HashSet<i64> = guild_roles.iter().map(|r| r.id).collect();
    if parsed_role_ids
        .iter()
        .any(|role_id| !guild_role_ids.contains(role_id))
    {
        return Err(ApiError::BadRequest(
            "One or more required roles do not belong to this guild".into(),
        ));
    }

    Ok(paracord_db::channels::serialize_required_role_ids(
        &parsed_role_ids,
    ))
}

pub(crate) async fn ensure_channel_permissions(
    state: &AppState,
    channel: &paracord_db::channels::ChannelRow,
    user_id: i64,
    required: &[Permissions],
) -> Result<(), ApiError> {
    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions_cached(
            &state.permission_cache,
            &state.db,
            guild_id,
            channel.id,
            guild.owner_id,
            user_id,
        )
        .await?;
        for req in required {
            paracord_core::permissions::require_permission(perms, *req)?;
        }
    } else {
        if !paracord_db::dms::is_dm_recipient(&state.db, channel.id, user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        {
            return Err(ApiError::Forbidden);
        }
        // Re-enforce the block-list on every 1:1 DM send or call. Blocks are only checked
        // at DM-creation time, but DM channels are persistent: once A and V share a
        // channel and V later blocks A, A must be stopped from continuing to message
        // V. Gate sends and calls, while reads remain available so a conversation can
        // still be viewed by either party.
        if channel.channel_type == 1
            && required.iter().any(|permission| {
                permission.intersects(
                    Permissions::SEND_MESSAGES | Permissions::CONNECT | Permissions::STREAM,
                )
            })
        {
            let recipients = paracord_db::dms::get_dm_recipient_ids(&state.db, channel.id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            for other in recipients.into_iter().filter(|&r| r != user_id) {
                let blocked = paracord_db::relationships::is_blocked_either_direction(
                    &state.db, user_id, other,
                )
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
                if blocked {
                    return Err(ApiError::Forbidden);
                }
            }
        }
    }
    Ok(())
}

/// Build the author JSON payload from an already-fetched user row (or a fallback
/// "Unknown" author when the row is missing).
fn author_json_from_row(author_id: i64, author: Option<&paracord_db::users::UserRow>) -> Value {
    if let Some(author) = author {
        json!({
            "id": author.id.to_string(),
            "username": author.username,
            "display_name": author.display_name,
            "discriminator": author.discriminator,
            "avatar_hash": author.avatar_hash,
            "public_key": author.public_key,
            "flags": author.flags,
            "bot": paracord_core::is_bot(author.flags),
        })
    } else {
        json!({
            "id": author_id.to_string(),
            "username": "Unknown",
            "display_name": null,
            "discriminator": 0,
            "avatar_hash": null,
            "public_key": null,
            "flags": 0,
            "bot": false,
        })
    }
}

fn poll_to_json(poll: &paracord_db::polls::PollWithOptions) -> Value {
    let options: Vec<Value> = poll
        .options
        .iter()
        .map(|opt| {
            json!({
                "id": opt.id.to_string(),
                "text": opt.text,
                "emoji": opt.emoji,
                "position": opt.position,
                "vote_count": opt.vote_count,
                "voted": opt.voted,
            })
        })
        .collect();

    json!({
        "id": poll.poll.id.to_string(),
        "message_id": poll.poll.message_id.to_string(),
        "channel_id": poll.poll.channel_id.to_string(),
        "question": poll.poll.question,
        "allow_multiselect": poll.poll.allow_multiselect,
        "expires_at": poll.poll.expires_at.map(|t| t.to_rfc3339()),
        "created_at": poll.poll.created_at.to_rfc3339(),
        "options": options,
        "total_votes": poll.total_votes,
    })
}

/// Per-page batch-loaded collections used to assemble message JSON without
/// per-message queries. Every field is keyed by message id (or, for authors, by
/// author id) so [`build_message_json`] can look up a message's data in memory.
#[derive(Default)]
struct MessageJsonBatch {
    /// Author user rows keyed by author id (missing => "Unknown" fallback).
    authors: HashMap<i64, paracord_db::users::UserRow>,
    federation: HashMap<i64, paracord_db::federation::FederatedMessageMetadata>,
    /// Channel rows keyed by channel id, loaded once per distinct channel.
    channels: HashMap<i64, paracord_db::channels::ChannelRow>,
    /// Channel feature rows keyed by channel id, loaded once per distinct channel.
    channel_features: HashMap<i64, paracord_db::channel_features::ChannelFeatureSettingsRow>,
    /// Anonymous-message records keyed by message id (only anonymous messages).
    anonymous: HashMap<i64, paracord_db::anonymous_messages::AnonymousMessageRow>,
    /// `can_deanonymize` decision for each anonymous message, keyed by message id.
    can_deanonymize: HashMap<i64, bool>,
    /// Attachment rows keyed by message id, preserving `upload_created_at` order.
    attachments: HashMap<i64, Vec<paracord_db::attachments::AttachmentRow>>,
    /// Sticker rows keyed by message id, preserving `created_at` order.
    stickers: HashMap<i64, Vec<paracord_db::stickers::StickerRow>>,
    /// Aggregated reaction counts keyed by message id, preserving emoji order.
    reactions: HashMap<i64, Vec<paracord_db::reactions::BatchReactionCountRow>>,
    /// Set of `(message_id, emoji_name)` the viewer reacted to, for the `me` flag.
    viewer_reactions: std::collections::HashSet<(i64, String)>,
    /// Fully assembled polls keyed by message id.
    polls: HashMap<i64, paracord_db::polls::PollWithOptions>,
    /// `(webhook id, webhook name)` for messages a webhook posted, keyed by
    /// message id. Such a message is stored under its webhook's *creator*, so
    /// without this the author reads back as that person.
    webhooks: HashMap<i64, (i64, String)>,
}

/// Load every per-message collection for a page of messages using a bounded,
/// constant number of batched queries (independent of the message count).
async fn load_message_json_batch(
    state: &AppState,
    messages: &[paracord_db::messages::MessageRow],
    viewer_id: i64,
) -> MessageJsonBatch {
    let mut batch = MessageJsonBatch::default();
    if messages.is_empty() {
        return batch;
    }

    let message_ids: Vec<i64> = messages.iter().map(|m| m.id).collect();

    if let Ok(metadata) =
        paracord_db::federation::get_message_metadata_batch(&state.db, &message_ids).await
    {
        for row in metadata {
            batch.federation.insert(row.local_message_id, row);
        }
    }

    // Authors: one query for the distinct set of author ids.
    let mut author_ids: Vec<i64> = messages.iter().map(|m| m.author_id).collect();
    author_ids.sort_unstable();
    author_ids.dedup();
    if let Ok(authors) =
        paracord_db::messages::get_authors_for_message_ids(&state.db, &author_ids).await
    {
        for author in authors {
            batch.authors.insert(author.id, author);
        }
    }

    // Channels + channel features: one query each per distinct channel id.
    let mut channel_ids: Vec<i64> = messages.iter().map(|m| m.channel_id).collect();
    channel_ids.sort_unstable();
    channel_ids.dedup();
    for channel_id in &channel_ids {
        if let Ok(Some(channel)) = paracord_db::channels::get_channel(&state.db, *channel_id).await
        {
            batch.channels.insert(*channel_id, channel);
        }
        if let Ok(features) =
            paracord_db::channel_features::get_or_default(&state.db, *channel_id).await
        {
            batch.channel_features.insert(*channel_id, features);
        }
    }

    // Webhook identities: one query for the whole page.
    if let Ok(webhook_rows) =
        paracord_db::webhooks::get_webhooks_for_message_ids(&state.db, &message_ids).await
    {
        for (message_id, webhook_id, name) in webhook_rows {
            batch.webhooks.insert(message_id, (webhook_id, name));
        }
    }

    // Anonymous records: one query for the whole page.
    if let Ok(anon_rows) =
        paracord_db::messages::get_anonymous_messages_for_message_ids(&state.db, &message_ids).await
    {
        for anon in anon_rows {
            batch.anonymous.insert(anon.message_id, anon);
        }
    }
    // De-anonymization permission is per (channel, viewer); resolve it once per
    // message that is actually anonymous (typically none on a page).
    for msg in messages {
        if !batch.anonymous.contains_key(&msg.id) {
            continue;
        }
        let mut can_deanonymize = false;
        if let Some(channel_row) = batch.channels.get(&msg.channel_id) {
            if let Some(guild_id) = channel_row.guild_id() {
                if let Ok(Some(guild)) = paracord_db::guilds::get_guild(&state.db, guild_id).await {
                    if let Ok(perms) =
                        paracord_core::permissions::compute_channel_permissions_cached(
                            &state.permission_cache,
                            &state.db,
                            guild_id,
                            msg.channel_id,
                            guild.owner_id,
                            viewer_id,
                        )
                        .await
                    {
                        can_deanonymize = perms.contains(Permissions::MANAGE_MESSAGES)
                            || perms.contains(Permissions::MANAGE_GUILD);
                    }
                }
            }
        }
        batch.can_deanonymize.insert(msg.id, can_deanonymize);
    }

    // Attachments: one query for the whole page.
    if let Ok(attachments) = paracord_db::attachments::get_attachments_for_message_ids(
        &state.db,
        &message_ids,
        message_ids.len() as i64 * 100,
    )
    .await
    {
        for attachment in attachments {
            // The batch query filters on `message_id IN (...)`, so every row has
            // an owning message; skip defensively if the column is somehow NULL.
            if let Some(message_id) = attachment.message_id {
                batch
                    .attachments
                    .entry(message_id)
                    .or_default()
                    .push(attachment);
            }
        }
    }

    // Stickers: one query for the whole page.
    if let Ok(stickers) =
        paracord_db::messages::get_stickers_for_message_ids(&state.db, &message_ids).await
    {
        for row in stickers {
            batch
                .stickers
                .entry(row.message_id)
                .or_default()
                .push(row.sticker);
        }
    }

    // Reaction counts + the viewer's own reactions: two queries for the page.
    if let Ok(reactions) =
        paracord_db::reactions::get_reactions_for_message_ids(&state.db, &message_ids).await
    {
        for row in reactions {
            batch.reactions.entry(row.message_id).or_default().push(row);
        }
    }
    if let Ok(viewer_reactions) = paracord_db::reactions::get_viewer_reactions_for_message_ids(
        &state.db,
        &message_ids,
        viewer_id,
    )
    .await
    {
        for row in viewer_reactions {
            batch
                .viewer_reactions
                .insert((row.message_id, row.emoji_name));
        }
    }

    // Polls: a bounded number of queries for any polls attached to the page.
    if let Ok(polls) =
        paracord_db::messages::get_polls_for_message_ids(&state.db, &message_ids, viewer_id).await
    {
        for (message_id, poll) in polls {
            batch.polls.insert(message_id, poll);
        }
    }

    batch
}

/// Assemble a single message's JSON from the pre-loaded [`MessageJsonBatch`].
/// This is a pure, in-memory transform and issues no queries. The output is
/// byte-stable with the pre-batch implementation.
fn build_message_json(
    msg: &paracord_db::messages::MessageRow,
    viewer_id: i64,
    batch: &MessageJsonBatch,
) -> Value {
    let is_dm_e2ee = (msg.flags & MESSAGE_FLAG_DM_E2EE) != 0;
    let e2ee_payload = if is_dm_e2ee {
        msg.nonce
            .as_ref()
            .zip(msg.content.as_ref())
            .map(|(nonce, ciphertext)| {
                let version = if msg.e2ee_header.is_some() { 2 } else { 1 };
                let mut payload = json!({
                    "version": version,
                    "nonce": nonce,
                    "ciphertext": ciphertext,
                });
                if let Some(header) = &msg.e2ee_header {
                    payload["header"] = json!(header);
                }
                payload
            })
    } else {
        None
    };
    let content = if is_dm_e2ee {
        Value::Null
    } else {
        json!(msg.content)
    };

    let mut author = author_json_from_row(msg.author_id, batch.authors.get(&msg.author_id));

    // A webhook post is stored under the webhook's creator, because a webhook
    // has no user row. The live MESSAGE_CREATE event says the webhook posted
    // it; the history did not, so the same message changed author on reload —
    // from "Hook Bot" to the human who created the hook, bot flag and all.
    let webhook_id = batch.webhooks.get(&msg.id).map(|(id, name)| {
        author = json!({
            "id": id.to_string(),
            "username": name,
            "discriminator": 0,
            "avatar_hash": null,
            "avatar_url": null,
            "public_key": null,
            "flags": 0,
            "bot": true,
        });
        *id
    });

    let mut anonymous_json: Option<Value> = None;
    if let Some(anonymous) = batch.anonymous.get(&msg.id) {
        let can_deanonymize = batch.can_deanonymize.get(&msg.id).copied().unwrap_or(false);
        if !can_deanonymize {
            author = json!({
                "id": format!("anon:{}:{}", anonymous.channel_id, anonymous.alias),
                "username": anonymous.alias,
                "discriminator": 0,
                "avatar_hash": null,
                "public_key": null,
                "flags": 0,
                "bot": false,
            });
        }
        anonymous_json = Some(json!({
            "alias": anonymous.alias,
            "is_anonymous": true,
            "can_deanonymize": can_deanonymize,
        }));
    }

    let mut attachment_json: Vec<Value> = batch
        .attachments
        .get(&msg.id)
        .map(|attachments| {
            attachments
                .iter()
                .map(|a| {
                    json!({
                        "id": a.id.to_string(),
                        "filename": a.filename,
                        "size": a.size,
                        "content_type": a.content_type,
                        "url": a.url,
                        "width": a.width,
                        "height": a.height,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let federation_json = batch.federation.get(&msg.id).map(|metadata| {
        if let Ok(content) = serde_json::from_str::<Value>(&metadata.content) {
            attachment_json.extend(crate::routes::federation::message_attachment_metadata(
                &metadata.origin_server,
                msg.channel_id,
                &content,
            ));
        }
        json!({
            "event_id": metadata.event_id, "origin_server": metadata.origin_server,
            "sender": metadata.sender, "remote_message_id": metadata.remote_message_id,
        })
    });
    let sticker_json: Vec<Value> = batch
        .stickers
        .get(&msg.id)
        .map(|stickers| {
            stickers
                .iter()
                .map(|sticker| {
                    json!({
                        "id": sticker.id.to_string(),
                        "guild_id": sticker.guild_id.to_string(),
                        "name": sticker.name,
                        "description": sticker.description,
                        "format_type": sticker.format_type,
                        "image_url": sticker.asset_key.as_ref().map(|_| format!("/api/v1/guilds/{}/stickers/{}/image", sticker.guild_id, sticker.id)),
                        "asset_content_type": sticker.asset_content_type,
                        "creator_id": sticker.creator_id.map(|id| id.to_string()),
                        "created_at": sticker.created_at.to_rfc3339(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let reaction_json: Vec<Value> = batch
        .reactions
        .get(&msg.id)
        .map(|reactions| {
            reactions
                .iter()
                .map(|reaction| {
                    let me = batch
                        .viewer_reactions
                        .contains(&(msg.id, reaction.emoji_name.clone()));
                    json!({
                        "emoji": reaction.emoji_name,
                        "count": reaction.count,
                        "me": me,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let poll_json = batch.polls.get(&msg.id).map(poll_to_json);

    let embeds_value: serde_json::Value = msg
        .embeds
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::json!([]));
    let components_value: serde_json::Value = msg
        .components
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::json!([]));
    let expires_at = batch
        .channel_features
        .get(&msg.channel_id)
        .filter(|features| features.disappearing_seconds > 0)
        .map(|features| {
            (msg.created_at + chrono::Duration::seconds(i64::from(features.disappearing_seconds)))
                .to_rfc3339()
        });

    // Note on `viewer_id`: only used above for the anonymous/reaction `me`
    // decisions, which are pre-resolved into the batch; kept in the signature
    // for parity with the single-message wrapper.
    let _ = viewer_id;

    json!({
        "id": msg.id.to_string(),
        "message_revision": msg.recovery_revision.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "author": author,
        "content": content,
        "nonce": msg.delivery_nonce,
        "e2ee": e2ee_payload,
        "pinned": msg.pinned,
        "type": msg.message_type,
        "message_type": msg.message_type,
        "timestamp": msg.created_at.to_rfc3339(),
        "created_at": msg.created_at.to_rfc3339(),
        "edited_timestamp": msg.edited_at.map(|t| t.to_rfc3339()),
        "edited_at": msg.edited_at.map(|t| t.to_rfc3339()),
        "reference_id": msg.reference_id.map(|id| id.to_string()),
        "attachments": attachment_json,
        "federation": federation_json,
        "stickers": sticker_json,
        "reactions": reaction_json,
        "poll": poll_json,
        "embeds": embeds_value,
        "components": components_value,
        "anonymous": anonymous_json,
        "expires_at": expires_at,
        "webhook_id": webhook_id.map(|id| id.to_string()),
    })
}

/// Serialize a whole page of messages to JSON, batch-loading every per-message
/// collection up front so the endpoint issues a bounded, constant number of
/// queries instead of the previous O(messages x reactions) fan-out.
pub async fn messages_to_json(
    state: &AppState,
    messages: &[paracord_db::messages::MessageRow],
    viewer_id: i64,
) -> Vec<Value> {
    if messages.is_empty() {
        return Vec::new();
    }
    let batch = load_message_json_batch(state, messages, viewer_id).await;
    messages
        .iter()
        .map(|msg| build_message_json(msg, viewer_id, &batch))
        .collect()
}

/// Serialize a single message to JSON. Thin wrapper over [`messages_to_json`]
/// with a one-element page, kept for send/edit/fetch responses.
pub async fn message_to_json(
    state: &AppState,
    msg: &paracord_db::messages::MessageRow,
    viewer_id: i64,
) -> Value {
    let batch = load_message_json_batch(state, std::slice::from_ref(msg), viewer_id).await;
    build_message_json(msg, viewer_id, &batch)
}

/// Reject permission-overwrite writes aimed at a thread or forum post.
///
/// Thread permissions are resolved entirely from the parent channel (see
/// `paracord_core::permissions::compute_channel_permissions`), so an overwrite
/// stored on a thread row has no effect whatsoever. Accepting one would report
/// success while silently doing nothing — exactly the kind of quiet no-op this
/// project's fail-loudly stance forbids. Forum posts share `channel_type == 6`,
/// so this covers both.
fn ensure_overwrites_supported(
    channel: &paracord_db::channels::ChannelRow,
) -> Result<(), ApiError> {
    if channel.channel_type == paracord_core::permissions::CHANNEL_TYPE_THREAD {
        return Err(ApiError::BadRequest(
            "Threads and forum posts inherit permissions from their parent channel; \
             set the overwrite on the parent instead"
                .into(),
        ));
    }
    Ok(())
}

/// Returns the IDs of channels the requesting user can see in a guild.
pub async fn get_visible_channels(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let permission_generation = state.permission_cache.generation();
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

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

    let onboarding_settings =
        paracord_db::onboarding::get_guild_onboarding_settings(&state.db, guild_id)
            .await
            .ok()
            .flatten();
    let onboarding_state =
        paracord_db::onboarding::get_member_onboarding_state(&state.db, guild_id, auth.user_id)
            .await
            .ok()
            .flatten();

    let requires_rules = onboarding_settings
        .as_ref()
        .and_then(|row| row.rules_text.as_ref())
        .is_some_and(|text| !text.trim().is_empty());
    let accepted_rules = onboarding_state
        .as_ref()
        .map(|row| row.accepted_rules)
        .unwrap_or(false);
    let onboarding_completed = onboarding_state
        .as_ref()
        .and_then(|row| row.completed_at)
        .is_some();

    let progressive_threshold = onboarding_settings
        .as_ref()
        .map(|row| row.progressive_channel_min_messages.max(0))
        .unwrap_or(0);
    let message_count = if progressive_threshold > 0 {
        paracord_db::messages::count_guild_messages_by_author(&state.db, guild_id, auth.user_id)
            .await
            .unwrap_or(0)
    } else {
        0
    };

    let gate_for_rules = requires_rules && !accepted_rules;
    let gate_for_progressive = progressive_threshold > 0
        && !onboarding_completed
        && message_count < i64::from(progressive_threshold);

    let mut visible = channels
        .iter()
        .filter(|channel| {
            channel_permissions
                .get(&channel.id)
                .copied()
                .unwrap_or(Permissions::empty())
                .contains(Permissions::VIEW_CHANNEL)
        })
        .collect::<Vec<_>>();
    visible.sort_by_key(|channel| channel.position);

    if gate_for_rules {
        // Rules gate: expose only a small starter set until onboarding acceptance.
        visible.retain(|channel| channel.channel_type == 0 || channel.channel_type == 4);
        visible.truncate(3);
    } else if gate_for_progressive {
        // Progressive disclosure: keep initial channel surface small for new members.
        visible.truncate(8);
    }

    let channel_ids: Vec<String> = visible.into_iter().map(|c| c.id.to_string()).collect();

    Ok(Json(json!({ "channel_ids": channel_ids })))
}

/// Resolve and vet the category a new room is being created inside.
///
/// The sibling channel-positions route learned this the hard way: `parent_id` is
/// an access-control input, because `resolve_permission_gate` reads a room's
/// overwrites and required roles through its parent. This route wrote the value
/// straight into the row unchecked, so a category in *another* space, or a plain
/// text room, or an id belonging to nothing at all, all went in — the last of
/// those as a foreign-key error the caller saw as a 500.
async fn resolve_new_channel_parent(
    state: &AppState,
    guild_id: i64,
    raw: Option<&str>,
) -> Result<Option<i64>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parent_id = raw
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid parent_id".into()))?;
    let parent = paracord_db::channels::get_channel(&state.db, parent_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or_else(|| ApiError::BadRequest("Invalid parent_id".into()))?;
    if parent.guild_id() != Some(guild_id) {
        return Err(ApiError::BadRequest(
            "parent_id must be a category in this space".into(),
        ));
    }
    if parent.channel_type != CHANNEL_TYPE_CATEGORY {
        return Err(ApiError::BadRequest("parent_id must be a category".into()));
    }
    Ok(Some(parent_id))
}

pub async fn create_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateChannelRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.name.chars().count() > MAX_CHANNEL_NAME_LEN {
        return Err(ApiError::BadRequest("name is too long".into()));
    }
    // The topic beside it has always been held to this contract, and so has a
    // forum thread's name; a room name is the same kind of value and travels
    // further — every sidebar, mention, invite preview and audit-log change
    // payload carries it.
    if contains_dangerous_markup(&body.name) {
        return Err(ApiError::BadRequest("name contains unsafe markup".into()));
    }
    // There was no lower bound at all: `""` created a room whose sidebar row is
    // a blank strip nobody can name, click for, or search. A name of nothing but
    // spaces or zero-width characters reads the same way, and a newline in one
    // breaks every single-line surface that renders it.
    validate_visible_label(&body.name)
        .map_err(|_| ApiError::BadRequest("name must be readable text".into()))?;
    if !CREATABLE_CHANNEL_TYPES.contains(&body.channel_type) {
        return Err(ApiError::BadRequest(
            "channel_type must be a text, voice, category, announcement, forum or stage room"
                .into(),
        ));
    }
    let parent_id = resolve_new_channel_parent(&state, guild_id, body.parent_id.as_deref()).await?;
    let channel_id = paracord_util::snowflake::generate(1);
    let required_role_ids = match body.required_role_ids.as_deref() {
        Some(raw_role_ids) => {
            Some(normalize_required_role_ids(&state, guild_id, auth.user_id, raw_role_ids).await?)
        }
        None => None,
    };

    let channel = paracord_core::channel::create_channel(
        &state.db,
        guild_id,
        auth.user_id,
        channel_id,
        &body.name,
        body.channel_type,
        parent_id,
        required_role_ids.as_deref(),
    )
    .await?;

    let channel_json = channel_to_json(&channel);

    state
        .event_bus
        .dispatch("CHANNEL_CREATE", channel_json.clone(), Some(guild_id));
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_CHANNEL_CREATE,
        Some(channel.id),
        None,
        Some(json!({ "name": channel.name, "type": channel.channel_type })),
    )
    .await;

    Ok((StatusCode::CREATED, Json(channel_json)))
}

pub async fn get_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL])
        .await?;

    Ok(Json(channel_to_json(&channel)))
}

pub async fn update_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateChannelRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(name) = body.name.as_deref() {
        if name.chars().count() > MAX_CHANNEL_NAME_LEN {
            return Err(ApiError::BadRequest("name is too long".into()));
        }
        if contains_dangerous_markup(name) {
            return Err(ApiError::BadRequest("name contains unsafe markup".into()));
        }
        validate_visible_label(name)
            .map_err(|_| ApiError::BadRequest("name must be readable text".into()))?;
    }
    // Measured on the raw value, which is what reaches the column; checking
    // `trim()` let an arbitrarily whitespace-padded topic past.
    if let Some(topic) = body.topic.as_deref() {
        if topic.len() > MAX_CHANNEL_TOPIC_LEN {
            return Err(ApiError::BadRequest("topic is too long".into()));
        }
        if contains_dangerous_markup(topic) {
            return Err(ApiError::BadRequest("topic contains unsafe markup".into()));
        }
    }
    if let Some(rate_limit) = body.rate_limit_per_user {
        if rate_limit < 0 || rate_limit > 21600 {
            return Err(ApiError::BadRequest(
                "rate_limit_per_user must be between 0 and 21600".into(),
            ));
        }
    }
    if let Some(bitrate) = body.bitrate {
        if bitrate < 8_000 || bitrate > 384_000 {
            return Err(ApiError::BadRequest(
                "bitrate must be between 8000 and 384000".into(),
            ));
        }
    }
    if let Some(user_limit) = body.user_limit {
        if user_limit < 0 || user_limit > 99 {
            return Err(ApiError::BadRequest(
                "user_limit must be between 0 (unlimited) and 99".into(),
            ));
        }
    }

    let guild_id = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .and_then(|c| c.guild_id())
        .ok_or(ApiError::NotFound)?;
    let required_role_ids = match body.required_role_ids.as_deref() {
        Some(raw_role_ids) => {
            Some(normalize_required_role_ids(&state, guild_id, auth.user_id, raw_role_ids).await?)
        }
        None => None,
    };

    let updated = paracord_core::channel::update_channel(
        &state.db,
        channel_id,
        auth.user_id,
        body.name.as_deref(),
        body.topic.as_deref(),
        required_role_ids.as_deref(),
        body.rate_limit_per_user,
        body.bitrate,
        body.user_limit,
        body.nsfw,
    )
    .await?;

    // `required_role_ids` is a permission input, so a change to it must drop the
    // cached decisions for this channel and everything that inherits from it.
    // Nothing invalidated here previously, so tightening or relaxing a channel's
    // role gate did not take effect until the cache TTL expired.
    if required_role_ids.is_some() {
        if let Err(err) = paracord_core::permissions::invalidate_channel_tree(
            &state.db,
            &state.permission_cache,
            channel_id,
        )
        .await
        {
            tracing::warn!(channel_id, error = %err, "failed to invalidate permission cache");
        }
    }

    let channel_json = channel_to_json(&updated);

    state
        .event_bus
        .dispatch("CHANNEL_UPDATE", channel_json.clone(), updated.guild_id());
    if let Some(guild_id) = updated.guild_id() {
        audit::log_action(
            &state,
            guild_id,
            auth.user_id,
            audit::ACTION_CHANNEL_UPDATE,
            Some(updated.id),
            None,
            Some(json!({ "name": updated.name, "topic": updated.topic })),
        )
        .await;
    }

    Ok(Json(channel_json))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let channel =
        paracord_core::channel::delete_channel(&state.db, channel_id, auth.user_id).await?;

    state.event_bus.dispatch(
        "CHANNEL_DELETE",
        json!({"id": channel_id.to_string(), "guild_id": channel.guild_id().map(|id| id.to_string())}),
        channel.guild_id(),
    );
    if let Some(guild_id) = channel.guild_id() {
        audit::log_action(
            &state,
            guild_id,
            auth.user_id,
            audit::ACTION_CHANNEL_DELETE,
            Some(channel_id),
            None,
            None,
        )
        .await;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// `?stop=true` ends the indicator instead of starting it. Without it the only
/// way an indicator ever cleared was the recipient's own expiry timer, which
/// left "…is typing" on screen for seconds after the message had landed.
#[derive(Debug, Default, Deserialize)]
pub struct TypingQuery {
    #[serde(default)]
    pub stop: bool,
}

pub async fn typing(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<TypingQuery>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten()
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;
    let typing_payload = json!({
        "channel_id": channel_id.to_string(),
        "user_id": auth.user_id.to_string(),
        "timestamp": chrono::Utc::now().timestamp(),
    });
    let event = if query.stop {
        paracord_models::gateway::EVENT_TYPING_STOP
    } else {
        paracord_models::gateway::EVENT_TYPING_START
    };
    dispatch_channel_event(&state, &channel, event, typing_payload).await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_read_state(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateReadStateRequest>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;
    let last_message_id = match body.last_message_id {
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid last_message_id".into()))?,
        None => channel.last_message_id.unwrap_or(0),
    };
    let read_state = paracord_db::read_states::update_read_state(
        &state.db,
        auth.user_id,
        channel_id,
        last_message_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "channel_id": read_state.channel_id.to_string(),
        "last_message_id": read_state.last_message_id.to_string(),
        "mention_count": read_state.mention_count,
    })))
}

pub async fn list_channel_overwrites(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_CHANNELS],
    )
    .await?;
    let overwrites = paracord_db::channel_overwrites::get_channel_overwrites(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let result: Vec<Value> = overwrites
        .iter()
        .map(|o| {
            json!({
                "channel_id": o.channel_id.to_string(),
                "target_id": o.target_id.to_string(),
                "target_type": o.target_type,
                "allow_perms": o.allow_perms,
                "deny_perms": o.deny_perms,
            })
        })
        .collect();
    Ok(Json(json!(result)))
}

pub async fn upsert_channel_overwrite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, target_id)): Path<(i64, i64)>,
    Json(body): Json<UpsertChannelOverwriteRequest>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_CHANNELS],
    )
    .await?;
    ensure_overwrites_supported(&channel)?;
    if body.target_type != paracord_core::permissions::OVERWRITE_TARGET_ROLE
        && body.target_type != paracord_core::permissions::OVERWRITE_TARGET_MEMBER
    {
        return Err(ApiError::BadRequest("Invalid overwrite target type".into()));
    }
    let guild_id = channel
        .guild_id()
        .ok_or(ApiError::BadRequest("Channel has no guild".into()))?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // Capped fold — see `compute_guild_permissions`.
    let actor_perms = paracord_core::permissions::compute_guild_permissions(
        &state.db,
        guild_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    validate_overwrite_permission_bits(
        guild.owner_id,
        auth.user_id,
        actor_perms,
        body.allow_perms,
        body.deny_perms,
    )?;
    // The target has to be something this space actually has. Assigning a
    // deleted role to a member is already refused one route over; here a
    // deleted role id, or any id at all, was stored and then silently took
    // part in permission math against a role that resolves to nothing.
    if body.target_type == paracord_core::permissions::OVERWRITE_TARGET_ROLE {
        let role = paracord_db::roles::get_role(&state.db, target_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if role.map(|role| role.guild_id()) != Some(guild_id) {
            return Err(ApiError::BadRequest(
                "that role does not belong to this space".into(),
            ));
        }
    } else if !paracord_core::permissions::is_guild_member(&state.db, guild_id, target_id).await? {
        return Err(ApiError::BadRequest(
            "that member is not in this space".into(),
        ));
    }
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &state.db,
        channel_id,
        target_id,
        body.target_type,
        body.allow_perms,
        body.deny_perms,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    // Invalidate permission cache when channel overwrites change
    // Threads inherit from this channel, so their cached entries must go too.
    if let Err(err) = paracord_core::permissions::invalidate_channel_tree(
        &state.db,
        &state.permission_cache,
        channel_id,
    )
    .await
    {
        tracing::warn!(channel_id, error = %err, "failed to invalidate child permission cache");
    }
    state.event_bus.dispatch(
        "CHANNEL_UPDATE",
        json!({ "id": channel_id.to_string() }),
        channel.guild_id(),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_channel_overwrite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, target_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_CHANNELS],
    )
    .await?;
    ensure_overwrites_supported(&channel)?;
    paracord_db::channel_overwrites::delete_channel_overwrite(&state.db, channel_id, target_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    // Invalidate permission cache when channel overwrites are removed
    // Threads inherit from this channel, so their cached entries must go too.
    if let Err(err) = paracord_core::permissions::invalidate_channel_tree(
        &state.db,
        &state.permission_cache,
        channel_id,
    )
    .await
    {
        tracing::warn!(channel_id, error = %err, "failed to invalidate child permission cache");
    }
    state.event_bus.dispatch(
        "CHANNEL_UPDATE",
        json!({ "id": channel_id.to_string() }),
        channel.guild_id(),
    );
    Ok(StatusCode::NO_CONTENT)
}

// ── Federation message forwarding ────────────────────────────────────────────

/// Build a FederationService from environment variables (same pattern as the
/// federation routes use) and forward a message envelope to the peers that
/// participate in this guild's room.
///
/// The two gates below are the outbound counterpart of the inbound ingest
/// checks. Without them, enabling federation and trusting a single peer
/// transmitted every message in every local guild to that peer in plaintext —
/// including guilds the operator never federated and private channels inside
/// guilds that were federated. The gates live here rather than at the call site
/// so every future caller inherits them.
///
/// This function is designed to be called inside `tokio::spawn` so it never
/// returns errors -- all failures are logged.
async fn federation_forward_message(
    state: &AppState,
    message_id: i64,
    channel_id: i64,
    guild_id: i64,
    author_id: i64,
    content: &Value,
    timestamp_ms: i64,
) {
    // Gate 1: the same default-deny guild allowlist the ingest path enforces
    // (`PARACORD_FEDERATION_ALLOWED_GUILD_IDS`). A guild the operator never
    // opted into federation emits nothing.
    if crate::routes::federation::ensure_federation_guild_allowed(guild_id).is_err() {
        tracing::debug!(
            "federation: not forwarding message {message_id}: guild {guild_id} is not federation-allowed"
        );
        return;
    }

    // Look up the author's username for the federated identity
    let username = match paracord_db::users::get_user_by_id(&state.db, author_id).await {
        Ok(Some(user)) => user.username,
        Ok(None) => {
            tracing::warn!(
                "federation: cannot forward message {message_id}: author {author_id} not found"
            );
            return;
        }
        Err(e) => {
            tracing::error!("federation: db error looking up author {author_id}: {e}");
            return;
        }
    };

    // Build the federation service from env vars (matches pattern in routes/federation.rs)
    let service = crate::routes::federation::build_federation_service();
    if !service.is_enabled() {
        return;
    }
    let channel_meta = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();

    // Gate 2: channel privacy. Peers cannot evaluate local roles or overwrites,
    // so only channels visible to `@everyone` may be mirrored. Fail closed when
    // the channel row cannot be read at all.
    let Some(channel_row) = channel_meta.as_ref() else {
        tracing::warn!(
            "federation: not forwarding message {message_id}: channel {channel_id} not found"
        );
        return;
    };
    if !crate::routes::federation::federation_channel_is_public(state, channel_row, guild_id).await
    {
        tracing::debug!(
            "federation: not forwarding message {message_id}: channel {channel_id} is not visible to @everyone"
        );
        return;
    }

    let guild_meta = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .ok()
        .flatten();
    let outbound = crate::routes::federation::resolve_outbound_context(
        state,
        &service,
        guild_id,
        Some(channel_id),
    )
    .await;

    // Query attachment metadata for the message
    let attachments_meta = paracord_db::attachments::get_message_attachments(&state.db, message_id)
        .await
        .unwrap_or_default();

    let mention_identities = match crate::routes::federation::outbound_message_mentions(
        state, &service, channel_id, message_id,
    )
    .await
    {
        Ok(identities) => identities,
        Err(error) => {
            tracing::warn!(message_id, %error, "federation: cannot read committed message audience");
            return;
        }
    };
    let mut message_content = serde_json::json!({
        "body": content,
        "msgtype": "m.text",
        "guild_id": outbound.payload_guild_id,
        "channel_id": outbound.payload_channel_id.clone().unwrap_or_else(|| channel_id.to_string()),
        "message_id": message_id.to_string(),
        "m.mentions": { "user_ids": mention_identities },
    });
    if let Some(name) = channel_meta
        .as_ref()
        .and_then(|channel| channel.name.as_deref())
    {
        message_content["channel_name"] = Value::String(name.to_string());
    }
    if let Some(kind) = channel_meta.as_ref().map(|channel| channel.channel_type) {
        message_content["channel_type"] = Value::Number(serde_json::Number::from(kind));
    }
    if let Some(name) = guild_meta.as_ref().map(|guild| guild.name.as_str()) {
        message_content["guild_name"] = Value::String(name.to_string());
    }
    if !attachments_meta.is_empty() {
        message_content["attachments"] = serde_json::json!(attachments_meta
            .iter()
            .map(|a| {
                serde_json::json!({
                    "id": a.id.to_string(),
                    "filename": a.filename,
                    "size": a.size,
                    "content_type": a.content_type,
                    "content_hash": a.content_hash,
                    "origin_url": format!("/_paracord/federation/v1/file/{}", a.id),
                })
            })
            .collect::<Vec<_>>());
    }
    // Rich metadata and the recipient audience must be part of the signed body;
    // mutating an envelope after signing invalidates its signature.
    let envelope = match service.build_custom_envelope(
        "m.message",
        outbound.room_id,
        &username,
        &message_content,
        timestamp_ms,
        None,
        Some(&message_id.to_string()),
    ) {
        Ok(envelope) => envelope,
        Err(error) => {
            tracing::warn!(message_id, %error, "federation: cannot sign message envelope");
            return;
        }
    };

    // Also persist the event locally for federation event history
    if let Err(e) = service.persist_event(&state.db, &envelope).await {
        tracing::warn!(
            "federation: failed to persist outbound event {}: {e}",
            envelope.event_id
        );
    }

    service
        .forward_envelope_to_peers(&state.db, &envelope)
        .await;
}

/// Forward a generic federation event envelope to all trusted peers.
async fn federation_forward_generic(
    state: &AppState,
    event_type: &str,
    channel_id: i64,
    guild_id: i64,
    author_id: i64,
    content: &Value,
    timestamp_ms: i64,
    event_stable_id: Option<String>,
) {
    let username = match paracord_db::users::get_user_by_id(&state.db, author_id).await {
        Ok(Some(user)) => user.username,
        _ => return,
    };

    let service = crate::routes::federation::build_federation_service();
    if !service.is_enabled() {
        return;
    }

    let outbound = crate::routes::federation::resolve_outbound_context(
        state,
        &service,
        guild_id,
        Some(channel_id),
    )
    .await;

    let room_id = outbound.room_id.clone();
    let mut content_json = content.clone();
    // The route's IDs are local. A mirror must always translate them, including
    // the usual case where the caller already populated these fields.
    content_json["guild_id"] = Value::String(outbound.payload_guild_id.clone());
    content_json["channel_id"] = Value::String(
        outbound
            .payload_channel_id
            .clone()
            .unwrap_or_else(|| channel_id.to_string()),
    );
    if matches!(event_type, "m.reaction.add" | "m.reaction.remove") {
        if let Some(message_id) = content
            .get("message_id")
            .and_then(Value::as_str)
            .and_then(|id| id.parse::<i64>().ok())
        {
            if let Ok(metadata) =
                paracord_db::federation::get_message_metadata_batch(&state.db, &[message_id]).await
            {
                if let Some(target) = metadata.first() {
                    content_json["target_event_id"] = Value::String(target.event_id.clone());
                }
            }
        }
    }

    let envelope = match service.build_custom_envelope(
        event_type,
        room_id,
        &username,
        &content_json,
        timestamp_ms,
        None,
        event_stable_id.as_deref(),
    ) {
        Ok(env) => env,
        Err(_) => return,
    };

    let _ = service.persist_event(&state.db, &envelope).await;
    service
        .forward_envelope_to_peers(&state.db, &envelope)
        .await;
}

// ============ Announcement channel follow/subscribe ============

pub async fn add_channel_follow(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<AddChannelFollowRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 5 {
        return Err(ApiError::BadRequest(
            "Only announcement channels (type 5) can be followed".into(),
        ));
    }

    // Authorize the SOURCE against VIEW_CHANNEL only: the actor merely needs to be
    // able to see the announcement channel they are subscribing to (mirrors Discord —
    // you follow a channel you can view).
    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL])
        .await?;

    let target_channel_id: i64 = body
        .target_channel_id
        .parse()
        .map_err(|_| ApiError::BadRequest("Invalid target_channel_id".into()))?;

    // Load the TARGET channel — where crossposted content is actually delivered. It
    // must be a guild channel; content cannot be followed into a DM/group channel.
    let target = paracord_db::channels::get_channel(&state.db, target_channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::BadRequest("Target channel does not exist".into()))?;

    let target_guild_id = target
        .guild_id()
        .ok_or_else(|| ApiError::BadRequest("Target channel must be a guild channel".into()))?;

    // Authorize the follow against the TARGET (where messages land), NOT the
    // attacker-controlled source. MANAGE_WEBHOOKS is the Discord gate for adding a
    // followed channel. ensure_channel_permissions enforces guild membership plus the
    // requested bit with channel-overwrite awareness, so an actor who has never joined
    // the target guild (or lacks the bit) is rejected with 403.
    ensure_channel_permissions(
        &state,
        &target,
        auth.user_id,
        &[Permissions::MANAGE_WEBHOOKS],
    )
    .await?;

    // Derive target_guild_id from the target channel itself — never trust the body's
    // target_guild_id, which the caller could point at an arbitrary victim guild.
    let follow = paracord_db::channel_follows::create_follow(
        &state.db,
        channel_id,
        target_channel_id,
        target_guild_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": follow.id.to_string(),
            "source_channel_id": follow.source_channel_id.to_string(),
            "target_channel_id": follow.target_channel_id.to_string(),
            "target_guild_id": follow.target_guild_id.to_string(),
            "created_at": follow.created_at.to_rfc3339(),
        })),
    ))
}

pub async fn remove_channel_follow(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, target_channel_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    paracord_db::channel_follows::delete_follow(&state.db, channel_id, target_channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_channel_follows(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL])
        .await?;

    let follows = paracord_db::channel_follows::get_follows_for_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let json_follows: Vec<Value> = follows
        .iter()
        .map(|f| {
            json!({
                "id": f.id.to_string(),
                "source_channel_id": f.source_channel_id.to_string(),
                "target_channel_id": f.target_channel_id.to_string(),
                "target_guild_id": f.target_guild_id.to_string(),
                "created_at": f.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!(json_follows)))
}

#[cfg(test)]
mod mass_mention_tests {
    use super::contains_mass_mention;

    #[test]
    fn matches_bare_tokens() {
        assert!(contains_mass_mention("@everyone"));
        assert!(contains_mass_mention("@here"));
        assert!(contains_mass_mention("hey @everyone read this"));
        assert!(contains_mass_mention("please @here now"));
        // Trailing punctuation is a valid boundary; the preceding side must be the
        // start of input or whitespace.
        assert!(contains_mass_mention("@everyone!"));
        assert!(contains_mass_mention("meeting, @everyone."));
    }

    #[test]
    fn ignores_embedded_occurrences() {
        // Part of an email / domain must not trigger a mass mention.
        assert!(!contains_mass_mention("foo@everyone.com"));
        assert!(!contains_mass_mention("mailto:bob@here.example"));
        // Only start-of-input or whitespace counts as a leading boundary, so a
        // token glued to any preceding non-whitespace character is ignored.
        assert!(!contains_mass_mention("notan@everyone"));
        assert!(!contains_mass_mention("(@here)"));
        // Substrings of longer words are not tokens.
        assert!(!contains_mass_mention("@everyoneish"));
        assert!(!contains_mass_mention("@hereafter"));
        assert!(!contains_mass_mention("say hello to everyone"));
    }
}
