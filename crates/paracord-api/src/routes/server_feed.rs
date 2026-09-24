//! `GET /api/v1/guilds/{guild_id}/feed`: the server home's "Latest" feed
//! (docs/server-home-spec.md).
//!
//! What people made, across every channel the viewer can read, newest first:
//! notable messages, forum posts, and the day's new members grouped into one
//! item. Plain chat never appears; the channels are where that lives.
//!
//! Every item sorts by a key in snowflake space (a message id, a forum post's
//! thread id, or a synthetic id for the newest join of a day), so one cursor
//! pages all three kinds together.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, TimeZone, Utc};
use paracord_core::AppState;
use paracord_db::channels::ChannelRow;
use paracord_db::server_feed::{NotableMessages, ThreadMessage};
use paracord_db::users::UserRow;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::channels::messages_to_json;

const CHANNEL_TYPE_TEXT: i16 = 0;
const CHANNEL_TYPE_ANNOUNCEMENT: i16 = 5;
const CHANNEL_TYPE_THREAD: i16 = 6;
const CHANNEL_TYPE_FORUM: i16 = 7;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;

/// A message with at least this many reactions (all emoji together) is notable.
pub const NOTABLE_REACTIONS: i64 = 3;
/// A thread whose starter is notable needs at least this many messages.
const THREAD_STARTER_MIN_REPLIES: i32 = 2;
const MAX_PARTICIPANTS: usize = 5;
const MAX_JOINERS_PER_DAY: i64 = 12;
const EXCERPT_CHARS: usize = 280;

/// Paracord's snowflake epoch, 2024-01-01T00:00:00Z, in Unix milliseconds.
const PARACORD_EPOCH_MS: i64 = 1_704_067_200_000;
/// The worker and sequence bits of a synthetic key: the last id of its
/// millisecond, so it sorts after every real id minted in that millisecond.
const SYNTHETIC_LOW_BITS: i64 = 0x3F_FFFF;

/// The widgets the server home's side column knows, in their default order.
/// `hub_settings.widgets` may name only these.
pub const HOME_WIDGET_IDS: [&str; 7] = [
    "coming_up",
    "media",
    "most_active",
    "game",
    "pinned",
    "new_here",
    "daily_word",
];

/// Validate `hub_settings.widgets`: `[{ "id": <known id>, "enabled": <bool> }]`,
/// each id at most once, nothing else in an entry.
pub fn validate_home_widgets(value: &Value) -> Result<(), ApiError> {
    let invalid = |detail: &str| {
        ApiError::BadRequest(format!(
            "hub_settings.widgets {detail}. Each entry is {{ \"id\", \"enabled\" }} with id one of {}.",
            HOME_WIDGET_IDS.join(", ")
        ))
    };
    let entries = value.as_array().ok_or_else(|| invalid("must be a list"))?;
    if entries.len() > HOME_WIDGET_IDS.len() {
        return Err(invalid("has more entries than there are widgets"));
    }
    let mut seen = HashSet::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or_else(|| invalid("entries must be objects"))?;
        if object.keys().any(|key| key != "id" && key != "enabled") {
            return Err(invalid("entries may only carry id and enabled"));
        }
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("entries need a string id"))?;
        if !HOME_WIDGET_IDS.contains(&id) {
            return Err(invalid(&format!("names an unknown widget \"{id}\"")));
        }
        if !object.get("enabled").is_some_and(Value::is_boolean) {
            return Err(invalid(&format!(
                "entry \"{id}\" needs enabled true or false"
            )));
        }
        if !seen.insert(id) {
            return Err(invalid(&format!("lists \"{id}\" more than once")));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct FeedQuery {
    pub limit: Option<i64>,
    pub before: Option<String>,
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
            .map_err(|_| ApiError::BadRequest("before must be a feed cursor".into())),
    }
}

fn internal(err: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(anyhow::anyhow!(err.to_string()))
}

/// The feed key of an instant: the last snowflake of that millisecond.
fn synthetic_key(at: DateTime<Utc>) -> i64 {
    let ms = (at.timestamp_millis() - PARACORD_EPOCH_MS).max(0);
    (ms << 22) | SYNTHETIC_LOW_BITS
}

/// The UTC day (`YYYY-MM-DD`) a feed key falls on.
fn key_day(key: i64) -> String {
    let ms = (key.max(0) >> 22) + PARACORD_EPOCH_MS;
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%d")
        .to_string()
}

fn user_json(user: &UserRow) -> Value {
    json!({
        "id": user.id.to_string(),
        "username": user.username,
        "display_name": user.display_name,
        "avatar_hash": user.avatar_hash,
    })
}

fn unknown_user_json(id: i64) -> Value {
    json!({
        "id": id.to_string(),
        "username": "Unknown",
        "display_name": null,
        "avatar_hash": null,
    })
}

fn excerpt(message: Option<&ThreadMessage>) -> Option<String> {
    let message = message?;
    if message.flags & paracord_core::MESSAGE_FLAG_DM_E2EE != 0 {
        return None;
    }
    let text = message.content.as_deref()?.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= EXCERPT_CHARS {
        return Some(text.to_string());
    }
    let cut: String = text.chars().take(EXCERPT_CHARS).collect();
    Some(format!("{}…", cut.trim_end()))
}

fn thread_starter_id(channel: &ChannelRow) -> Option<i64> {
    let raw = channel.thread_metadata.as_deref()?;
    let metadata: Value = serde_json::from_str(raw).ok()?;
    match metadata.get("starter_message_id")? {
        Value::String(id) => id.parse().ok(),
        Value::Number(id) => id.as_i64(),
        _ => None,
    }
}

/// One candidate item before it is rendered, so only the page's winners pay
/// for their JSON.
enum Candidate {
    Message(usize),
    ForumPost(usize),
    Joined(usize),
}

struct JoinGroup {
    day: String,
    total: i64,
    latest: DateTime<Utc>,
    users: Vec<Value>,
}

pub async fn get_server_feed(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(query): Query<FeedQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = parse_limit(query.limit)?;
    let before = parse_before(query.before.as_deref())?;

    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(internal)?
        .ok_or(ApiError::NotFound)?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let permission_generation = state.permission_cache.generation();
    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
        .await
        .map_err(internal)?;
    let permissions = paracord_core::permissions::compute_all_channel_permissions(
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
        &permissions,
        permission_generation,
    )
    .await;
    let readable = |channel_id: i64| {
        permissions
            .get(&channel_id)
            .copied()
            .unwrap_or_else(Permissions::empty)
            .contains(Permissions::VIEW_CHANNEL | Permissions::READ_MESSAGE_HISTORY)
    };
    let by_id: HashMap<i64, &ChannelRow> = channels.iter().map(|c| (c.id, c)).collect();
    let parent_type = |channel: &ChannelRow| {
        channel
            .parent_id
            .and_then(|id| by_id.get(&id))
            .map(|parent| parent.channel_type)
    };

    // Where notable messages can come from: readable text and announcement
    // channels, and the threads under them. A forum's threads are its posts,
    // which get their own card.
    let mut message_channels = Vec::new();
    let mut announcement_channels = Vec::new();
    let mut thread_starters = Vec::new();
    let mut forum_posts: Vec<&ChannelRow> = Vec::new();
    for channel in &channels {
        match channel.channel_type {
            CHANNEL_TYPE_TEXT | CHANNEL_TYPE_ANNOUNCEMENT if readable(channel.id) => {
                message_channels.push(channel.id);
                if channel.channel_type == CHANNEL_TYPE_ANNOUNCEMENT {
                    announcement_channels.push(channel.id);
                }
            }
            CHANNEL_TYPE_THREAD => match parent_type(channel) {
                Some(CHANNEL_TYPE_FORUM) => {
                    let parent_readable = channel.parent_id.is_some_and(&readable);
                    if parent_readable && before.is_none_or(|before| channel.id < before) {
                        forum_posts.push(channel);
                    }
                }
                Some(CHANNEL_TYPE_TEXT | CHANNEL_TYPE_ANNOUNCEMENT) => {
                    if readable(channel.id) {
                        message_channels.push(channel.id);
                    }
                    let parent_readable = channel.parent_id.is_some_and(&readable);
                    if parent_readable
                        && channel.message_count.unwrap_or(0) >= THREAD_STARTER_MIN_REPLIES
                    {
                        if let Some(starter) = thread_starter_id(channel) {
                            thread_starters.push(starter);
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    let starter_set: HashSet<i64> = thread_starters.iter().copied().collect();

    // Each source contributes its own newest `fetch_limit`. That is more than
    // a page, so a run of posts from one feed can fold into one card and the
    // page still holds `limit` cards; `assemble_cards` never reads past the
    // point where a source that was cut short could be missing something.
    let fetch_limit = limit + FEED_GROUP_MAX as i64;
    let messages = paracord_db::server_feed::list_notable_messages(
        &state.db,
        &NotableMessages {
            channel_ids: &message_channels,
            announcement_channel_ids: &announcement_channels,
            thread_starter_ids: &thread_starters,
            min_reactions: NOTABLE_REACTIONS,
            before,
            limit: fetch_limit,
        },
    )
    .await
    .map_err(internal)?;

    forum_posts.sort_unstable_by_key(|post| std::cmp::Reverse(post.id));
    let forum_cut = forum_posts.len() as i64 > fetch_limit;
    forum_posts.truncate(fetch_limit as usize);

    let join_groups = load_join_groups(&state, guild_id, before, fetch_limit).await?;

    // The lowest key every source is complete down to.
    let mut horizon: Option<i64> = None;
    let mut lower = |oldest: Option<i64>| {
        if let Some(oldest) = oldest {
            horizon = Some(horizon.map_or(oldest, |h: i64| h.max(oldest)));
        }
    };
    if messages.len() as i64 >= fetch_limit {
        lower(messages.last().map(|row| row.id));
    }
    if forum_cut {
        lower(forum_posts.last().map(|post| post.id));
    }
    if join_groups.len() as i64 >= fetch_limit {
        lower(
            join_groups
                .iter()
                .map(|group| synthetic_key(group.latest))
                .min(),
        );
    }

    let message_ids: Vec<i64> = messages.iter().map(|row| row.id).collect();
    let feed_posts = paracord_db::feeds::front_page_feed_posts(&state.db, &message_ids)
        .await
        .map_err(internal)?;

    let mut candidates: Vec<(i64, Candidate)> = Vec::new();
    candidates.extend(
        messages
            .iter()
            .enumerate()
            .map(|(i, message)| (message.id, Candidate::Message(i))),
    );
    candidates.extend(
        forum_posts
            .iter()
            .enumerate()
            .map(|(i, post)| (post.id, Candidate::ForumPost(i))),
    );
    candidates.extend(
        join_groups
            .iter()
            .enumerate()
            .map(|(i, group)| (synthetic_key(group.latest), Candidate::Joined(i))),
    );
    candidates.sort_unstable_by_key(|(key, _)| std::cmp::Reverse(*key));

    let feed_of = |candidate: &Candidate| match candidate {
        Candidate::Message(i) => feed_posts.get(&messages[*i].id).copied(),
        _ => None,
    };
    let (cards, next_cursor) = assemble_cards(&candidates, &feed_of, horizon, limit as usize);

    // Render only the winners, each kind in one batch. A group's other posts
    // are listed by title, so only its newest is rendered in full.
    let page_messages: Vec<paracord_db::messages::MessageRow> = cards
        .iter()
        .filter_map(|card| match &candidates[card.head].1 {
            Candidate::Message(i) => Some(messages[*i].clone()),
            _ => None,
        })
        .collect();
    let message_json = messages_to_json(&state, &page_messages, auth.user_id).await;
    let mut message_json: HashMap<i64, Value> = page_messages
        .iter()
        .map(|row| row.id)
        .zip(message_json)
        .collect();

    let page_posts: Vec<&ChannelRow> = cards
        .iter()
        .filter_map(|card| match &candidates[card.head].1 {
            Candidate::ForumPost(i) => Some(forum_posts[*i]),
            _ => None,
        })
        .collect();
    let mut post_json = forum_posts_json(&state, &page_posts, &by_id).await?;

    let channel_name = |channel_id: i64| {
        by_id
            .get(&channel_id)
            .and_then(|c| c.name.clone())
            .unwrap_or_else(|| "channel".to_string())
    };

    let mut items = Vec::with_capacity(cards.len());
    for card in &cards {
        let key = card.key;
        let item = match &candidates[card.head].1 {
            Candidate::Message(i) => {
                let row = &messages[*i];
                let Some(message) = message_json.remove(&row.id) else {
                    continue;
                };
                let channel = by_id.get(&row.channel_id);
                let channel_type = channel.map(|c| c.channel_type).unwrap_or(CHANNEL_TYPE_TEXT);
                let reason = message_reason(
                    &message,
                    feed_posts.contains_key(&row.id),
                    announcement_channels.contains(&row.channel_id),
                    starter_set.contains(&row.id),
                );
                let mut item = json!({
                    "type": "message",
                    "id": format!("m:{}", row.id),
                    "key": key.to_string(),
                    "at": row.created_at.to_rfc3339(),
                    "message": message,
                    "channel_id": row.channel_id.to_string(),
                    "channel_name": channel_name(row.channel_id),
                    "channel_type": channel_type,
                    "reason": reason,
                });
                if channel_type == CHANNEL_TYPE_THREAD {
                    if let Some(parent_id) = channel.and_then(|c| c.parent_id) {
                        item["thread_parent_id"] = json!(parent_id.to_string());
                    }
                }
                if !card.members.is_empty() {
                    let others: Vec<Value> = card
                        .members
                        .iter()
                        .filter_map(|member| match &candidates[*member].1 {
                            Candidate::Message(m) => Some(&messages[*m]),
                            _ => None,
                        })
                        .map(|other| {
                            json!({
                                "message_id": other.id.to_string(),
                                "channel_id": other.channel_id.to_string(),
                                "channel_name": channel_name(other.channel_id),
                                "title": feed_post_title(other),
                                "at": other.created_at.to_rfc3339(),
                            })
                        })
                        .collect();
                    item["feed_group"] = json!({
                        "feed_id": feed_posts.get(&row.id).map(|id| id.to_string()),
                        "name": item["message"]["feed"]["name"].clone(),
                        "items": others,
                    });
                }
                item
            }
            Candidate::ForumPost(i) => {
                let Some(item) = post_json.remove(&forum_posts[*i].id) else {
                    continue;
                };
                item
            }
            Candidate::Joined(i) => {
                let group = &join_groups[*i];
                json!({
                    "type": "members_joined",
                    "id": format!("j:{}", group.day),
                    "key": key.to_string(),
                    "at": group.latest.to_rfc3339(),
                    "day": group.day,
                    "users": group.users,
                    "total": group.total,
                })
            }
        };
        items.push(item);
    }

    let next_cursor = next_cursor.map(|key| key.to_string());
    Ok(Json(json!({ "items": items, "next_cursor": next_cursor })))
}

/// Most posts one card folds together: the newest in full, the rest by title.
const FEED_GROUP_MAX: usize = 25;
const FEED_GROUP_TITLE_CHARS: usize = 200;

/// One card on the page: a candidate, and for a run of posts from one feed,
/// the older posts folded under it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Card {
    /// Index of the card's own (newest) candidate.
    head: usize,
    /// Indexes of the posts folded under it, newest first.
    members: Vec<usize>,
    /// The card's cursor key: its oldest candidate's key.
    key: i64,
}

/// Fold the sorted candidates into at most `limit` cards.
///
/// Consecutive posts from the same feed (with "Show on the front page" on)
/// become one card. Nothing below `horizon` is read: a source cut short there
/// may be missing items that belong between the ones it returned, and reading
/// past it would let the cursor skip them. Every candidate read is on this
/// page, so the returned cursor (the last card's oldest key) neither skips nor
/// repeats anything. `None` means the feed has ended.
fn assemble_cards<C>(
    candidates: &[(i64, C)],
    feed_of: &dyn Fn(&C) -> Option<i64>,
    horizon: Option<i64>,
    limit: usize,
) -> (Vec<Card>, Option<i64>) {
    let readable = |key: i64| horizon.is_none_or(|h| key >= h);
    let mut cards = Vec::new();
    let mut next = 0usize;
    while next < candidates.len() && cards.len() < limit {
        let (key, candidate) = &candidates[next];
        if !readable(*key) {
            break;
        }
        let mut card = Card {
            head: next,
            members: Vec::new(),
            key: *key,
        };
        next += 1;
        if let Some(feed) = feed_of(candidate) {
            while next < candidates.len() && card.members.len() + 1 < FEED_GROUP_MAX {
                let (other_key, other) = &candidates[next];
                if !readable(*other_key) || feed_of(other) != Some(feed) {
                    break;
                }
                card.members.push(next);
                card.key = *other_key;
                next += 1;
            }
        }
        cards.push(card);
    }
    let ended = next >= candidates.len() && horizon.is_none();
    let cursor = if ended {
        None
    } else {
        cards.last().map(|card| card.key)
    };
    (cards, cursor)
}

/// A feed post's title for the folded list: its card's title, else its text.
fn feed_post_title(row: &paracord_db::messages::MessageRow) -> String {
    let from_embed = row
        .embeds
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|embeds| embeds.get(0)?.get("title")?.as_str().map(str::to_string));
    let title = from_embed
        .or_else(|| row.content.clone())
        .unwrap_or_default();
    let title = title.trim();
    if title.chars().count() <= FEED_GROUP_TITLE_CHARS {
        return title.to_string();
    }
    let cut: String = title.chars().take(FEED_GROUP_TITLE_CHARS).collect();
    format!("{}…", cut.trim_end())
}

/// Why a message is in the feed, in the order a reader would name it.
fn message_reason(
    message: &Value,
    from_feed: bool,
    in_announcements: bool,
    starts_thread: bool,
) -> &'static str {
    let has_poll = !message["poll"].is_null();
    let has_attachment = message["attachments"]
        .as_array()
        .is_some_and(|items| !items.is_empty());
    let pinned = message["pinned"].as_bool().unwrap_or(false);
    if from_feed {
        "feed"
    } else if in_announcements {
        "announcement"
    } else if has_poll {
        "poll"
    } else if has_attachment {
        "attachment"
    } else if pinned {
        "pinned"
    } else if starts_thread {
        "thread_starter"
    } else {
        "reactions"
    }
}

/// Join days whose key sorts below `before`, newest first, at most `limit`.
///
/// A day is one item, so a page can never split it: days are fetched whole,
/// and the cursor's own day is kept only when its newest join sorts below the
/// cursor (otherwise an earlier page already showed it).
async fn load_join_groups(
    state: &AppState,
    guild_id: i64,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<JoinGroup>, ApiError> {
    let through_day = before.map(key_day);
    let days = paracord_db::server_feed::list_join_days(
        &state.db,
        guild_id,
        through_day.as_deref(),
        limit + 1,
    )
    .await
    .map_err(internal)?;
    let day_names: Vec<String> = days.iter().map(|day| day.day.clone()).collect();
    let joiners = paracord_db::server_feed::latest_joiners(
        &state.db,
        guild_id,
        &day_names,
        MAX_JOINERS_PER_DAY,
    )
    .await
    .map_err(internal)?;

    let mut groups = Vec::with_capacity(days.len());
    for day in days {
        let mut people: Vec<_> = joiners.iter().filter(|j| j.day == day.day).collect();
        people.sort_by(|a, b| {
            b.joined_at
                .cmp(&a.joined_at)
                .then(b.user_id.cmp(&a.user_id))
        });
        let Some(latest) = people.first().map(|p| p.joined_at) else {
            continue;
        };
        if before.is_some_and(|before| synthetic_key(latest) >= before) {
            continue;
        }
        groups.push(JoinGroup {
            day: day.day,
            total: day.total,
            latest,
            users: people
                .iter()
                .map(|p| {
                    json!({
                        "id": p.user_id.to_string(),
                        "username": p.username,
                        "display_name": p.display_name,
                        "avatar_hash": p.avatar_hash,
                    })
                })
                .collect(),
        });
    }
    groups.truncate(limit as usize);
    Ok(groups)
}

/// Forum post cards for one page, keyed by thread id: four batched queries
/// (first messages, last messages, participants, people) whatever the count.
async fn forum_posts_json(
    state: &AppState,
    posts: &[&ChannelRow],
    by_id: &HashMap<i64, &ChannelRow>,
) -> Result<HashMap<i64, Value>, ApiError> {
    if posts.is_empty() {
        return Ok(HashMap::new());
    }
    let thread_ids: Vec<i64> = posts.iter().map(|post| post.id).collect();
    let first: HashMap<i64, ThreadMessage> =
        paracord_db::server_feed::first_thread_messages(&state.db, &thread_ids)
            .await
            .map_err(internal)?
            .into_iter()
            .map(|message| (message.channel_id, message))
            .collect();
    let last: HashMap<i64, ThreadMessage> =
        paracord_db::server_feed::last_thread_messages(&state.db, &thread_ids)
            .await
            .map_err(internal)?
            .into_iter()
            .map(|message| (message.channel_id, message))
            .collect();
    // (author id, the message that makes them a participant)
    let mut participants: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for row in paracord_db::server_feed::thread_participants(&state.db, &thread_ids)
        .await
        .map_err(internal)?
    {
        let list = participants.entry(row.thread_id).or_default();
        if list.len() < MAX_PARTICIPANTS {
            list.push((row.author_id, row.last_message_id));
        }
    }

    // A post in an anonymous channel, or a webhook post, is stored under a real
    // user id. The thread shows the alias or the webhook, so the card must too,
    // or the feed would name who wrote an anonymous post.
    let mut masked_ids: Vec<i64> = first
        .values()
        .chain(last.values())
        .map(|m| m.id)
        .chain(
            participants
                .values()
                .flatten()
                .map(|(_, message_id)| *message_id),
        )
        .collect();
    masked_ids.sort_unstable();
    masked_ids.dedup();
    let mut masks: HashMap<i64, Value> = HashMap::new();
    for row in paracord_db::messages::get_anonymous_messages_for_message_ids(&state.db, &masked_ids)
        .await
        .map_err(internal)?
    {
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
    for (message_id, webhook_id, name) in
        paracord_db::webhooks::get_webhooks_for_message_ids(&state.db, &masked_ids)
            .await
            .map_err(internal)?
    {
        masks.entry(message_id).or_insert_with(|| {
            json!({
                "id": webhook_id.to_string(),
                "username": name,
                "display_name": null,
                "avatar_hash": null,
            })
        });
    }

    let mut user_ids: Vec<i64> = posts
        .iter()
        .filter_map(|post| post.owner_id)
        .chain(first.values().map(|m| m.author_id))
        .chain(last.values().map(|m| m.author_id))
        .chain(
            participants
                .values()
                .flatten()
                .map(|(author_id, _)| *author_id),
        )
        .collect();
    user_ids.sort_unstable();
    user_ids.dedup();
    let users: HashMap<i64, UserRow> =
        paracord_db::messages::get_authors_for_message_ids(&state.db, &user_ids)
            .await
            .map_err(internal)?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();
    let person = |id: i64| {
        users
            .get(&id)
            .map(user_json)
            .unwrap_or_else(|| unknown_user_json(id))
    };

    let mut out = HashMap::with_capacity(posts.len());
    for post in posts {
        let opening = first.get(&post.id);
        let replies = i64::from(post.message_count.unwrap_or(0).max(1) - 1);
        let latest = last
            .get(&post.id)
            .filter(|message| replies > 0 && opening.is_none_or(|o| o.id != message.id));
        let author = match opening.and_then(|m| masks.get(&m.id)) {
            Some(mask) => Some(mask.clone()),
            None => post.owner_id.or(opening.map(|m| m.author_id)).map(person),
        };
        let last_reply_author = latest.map(|m| {
            masks
                .get(&m.id)
                .cloned()
                .unwrap_or_else(|| person(m.author_id))
        });
        let mut seen = std::collections::HashSet::new();
        let people: Vec<Value> = participants
            .get(&post.id)
            .map(|list| {
                list.iter()
                    .map(|(author_id, message_id)| {
                        masks
                            .get(message_id)
                            .cloned()
                            .unwrap_or_else(|| person(*author_id))
                    })
                    .filter(|p| seen.insert(p["id"].as_str().unwrap_or_default().to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let forum = post.parent_id.and_then(|id| by_id.get(&id));
        out.insert(
            post.id,
            json!({
                "type": "forum_post",
                "id": format!("f:{}", post.id),
                "key": post.id.to_string(),
                "at": post.created_at.to_rfc3339(),
                "channel_id": post.parent_id.map(|id| id.to_string()),
                "channel_name": forum
                    .and_then(|f| f.name.clone())
                    .unwrap_or_else(|| "forum".to_string()),
                "thread_id": post.id.to_string(),
                "title": post.name.clone().unwrap_or_default(),
                "author": author,
                "excerpt": excerpt(opening),
                "reply_count": replies,
                "last_reply_at": latest.map(|m| m.created_at.to_rfc3339()),
                "last_reply_author": last_reply_author,
                "participants": people,
            }),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_keys_round_trip_their_day() {
        let at = Utc.with_ymd_and_hms(2026, 9, 21, 23, 59, 59).unwrap();
        assert_eq!(key_day(synthetic_key(at)), "2026-09-21");
        let later = Utc.with_ymd_and_hms(2026, 9, 22, 0, 0, 0).unwrap();
        assert!(synthetic_key(later) > synthetic_key(at));
    }

    #[test]
    fn widget_lists_are_validated() {
        assert!(validate_home_widgets(&json!([
            { "id": "media", "enabled": true },
            { "id": "coming_up", "enabled": false },
        ]))
        .is_ok());
        assert!(validate_home_widgets(&json!([{ "id": "weather", "enabled": true }])).is_err());
        assert!(validate_home_widgets(&json!([
            { "id": "media", "enabled": true },
            { "id": "media", "enabled": false },
        ]))
        .is_err());
        assert!(validate_home_widgets(&json!([{ "id": "media", "enabled": "yes" }])).is_err());
        assert!(
            validate_home_widgets(&json!([{ "id": "media", "enabled": true, "x": 1 }])).is_err()
        );
        assert!(validate_home_widgets(&json!({ "id": "media" })).is_err());
    }

    /// Candidates as (key, feed) pairs, newest first; `None` is anything that
    /// is not a front-page feed post.
    fn run(
        keys: &[(i64, Option<i64>)],
        horizon: Option<i64>,
        limit: usize,
    ) -> (Vec<Vec<i64>>, Option<i64>) {
        let candidates: Vec<(i64, Option<i64>)> = keys.to_vec();
        let (cards, cursor) =
            assemble_cards(&candidates, &|feed: &Option<i64>| *feed, horizon, limit);
        let shape = cards
            .iter()
            .map(|card| {
                std::iter::once(card.head)
                    .chain(card.members.iter().copied())
                    .map(|index| candidates[index].0)
                    .collect()
            })
            .collect();
        (shape, cursor)
    }

    #[test]
    fn consecutive_posts_from_one_feed_fold_into_one_card() {
        let (cards, cursor) = run(
            &[
                (10, Some(1)),
                (9, Some(1)),
                (8, Some(1)),
                (7, None),
                (6, Some(1)),
                (5, Some(2)),
                (4, Some(1)),
            ],
            None,
            20,
        );
        assert_eq!(
            cards,
            vec![vec![10, 9, 8], vec![7], vec![6], vec![5], vec![4]],
            "a person's post or another feed breaks the run"
        );
        assert_eq!(cursor, None, "everything was read");
    }

    #[test]
    fn a_page_holds_limit_cards_and_its_cursor_is_the_oldest_folded_key() {
        let (cards, cursor) = run(
            &[
                (10, None),
                (9, Some(1)),
                (8, Some(1)),
                (7, Some(1)),
                (6, None),
                (5, None),
            ],
            None,
            2,
        );
        assert_eq!(cards, vec![vec![10], vec![9, 8, 7]]);
        assert_eq!(cursor, Some(7));
    }

    #[test]
    fn nothing_past_the_horizon_is_read() {
        // A source was cut short at 8: something older from it could sit
        // between 8 and 7, so the run stops at 8 and the cursor says so.
        let (cards, cursor) = run(
            &[(10, Some(1)), (9, Some(1)), (8, Some(1)), (7, Some(1))],
            Some(8),
            20,
        );
        assert_eq!(cards, vec![vec![10, 9, 8]]);
        assert_eq!(cursor, Some(8));
    }

    #[test]
    fn a_card_folds_at_most_the_group_limit() {
        let keys: Vec<(i64, Option<i64>)> = (0..30).rev().map(|key| (key, Some(1))).collect();
        let (cards, cursor) = run(&keys, None, 20);
        assert_eq!(cards[0].len(), FEED_GROUP_MAX);
        assert_eq!(cards[1].len(), 30 - FEED_GROUP_MAX);
        assert_eq!(cursor, None);
    }
}
