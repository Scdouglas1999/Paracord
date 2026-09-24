//! The feeds poller, and the cards feeds post.
//!
//! One pass checks every source whose time has come, once, however many
//! servers follow it, then hands what it found to each subscription. A card is
//! posted by the internal "Feeds" user; the message JSON carries the feed's
//! own name and icon (see `channels::build_message_json`).

use chrono::{DateTime, Utc};
use paracord_core::feeds::{
    self, Checked, FeedItem, FeedKind, SafeFetcher, SourceState, TwitchCredentials,
};
use paracord_core::{is_bot, AppState, USER_FLAG_BOT};
use paracord_db::feeds::{FeedSourceRow, GuildFeedRow, SeenItem};
use serde_json::{json, Value};

use super::feeds::{open_secret, twitch_credentials};

const FEEDS_USER_ID: i64 = -8;
const FEEDS_EMAIL: &str = "feeds@paracord.internal";
const FEEDS_NAME: &str = "Feeds";
/// Sources checked in one pass. The rest wait for the next pass.
const SOURCES_PER_PASS: i64 = 25;
const MAX_CONTENT_BYTES: usize = 2000;

const CHANNEL_TYPE_TEXT: i16 = 0;
const CHANNEL_TYPE_ANNOUNCEMENT: i16 = 5;

/// One pass over every due source. Safe to call on a timer.
pub async fn poll_due(state: &AppState) {
    poll_due_at(state, Utc::now()).await;
}

/// One pass as of `now`.
pub async fn poll_due_at(state: &AppState, now: DateTime<Utc>) {
    let due = match paracord_db::feeds::list_due_sources(&state.db, now, SOURCES_PER_PASS).await {
        Ok(due) => due,
        Err(err) => {
            tracing::warn!("feeds: due sources could not be listed: {err}");
            return;
        }
    };
    if due.is_empty() {
        return;
    }
    let fetcher = SafeFetcher::for_instance(&state.db).await;
    let twitch = twitch_credentials(state).await;
    for source in due {
        check_and_deliver(state, &fetcher, &twitch, &source, now).await;
    }
}

/// Check one source now, whether or not it is due.
pub async fn check_source_now(state: &AppState, source_id: i64) {
    let Ok(Some(source)) = paracord_db::feeds::get_source(&state.db, source_id).await else {
        return;
    };
    let fetcher = SafeFetcher::for_instance(&state.db).await;
    let twitch = twitch_credentials(state).await;
    check_and_deliver(state, &fetcher, &twitch, &source, Utc::now()).await;
}

fn jitter() -> f64 {
    rand::random::<f64>()
}

async fn check_and_deliver(
    state: &AppState,
    fetcher: &SafeFetcher,
    twitch: &Result<Option<TwitchCredentials>, String>,
    source: &FeedSourceRow,
    now: DateTime<Utc>,
) {
    let Some(kind) = FeedKind::parse(&source.kind) else {
        return;
    };
    let subscribers =
        match paracord_db::feeds::list_active_feeds_for_source(&state.db, source.id).await {
            Ok(subscribers) if !subscribers.is_empty() => subscribers,
            Ok(_) => return,
            Err(err) => {
                tracing::warn!(
                    source_id = source.id,
                    "feeds: subscribers could not be listed: {err}"
                );
                return;
            }
        };

    let api_key = if kind == FeedKind::Jellyfin {
        match subscribers.iter().find_map(|feed| feed.secret.as_deref()) {
            Some(stored) => match open_secret(state, stored) {
                Ok(key) => Some(key),
                Err(problem) => {
                    record_error(state, source, kind, &problem, now).await;
                    return;
                }
            },
            None => None,
        }
    } else {
        None
    };
    let twitch_credentials = match (kind, twitch) {
        (FeedKind::Twitch, Err(problem)) => {
            record_error(state, source, kind, problem, now).await;
            return;
        }
        (_, Ok(credentials)) => credentials.as_ref(),
        (_, Err(_)) => None,
    };

    let checked = feeds::check_source(
        fetcher,
        &SourceState {
            kind,
            url: &source.url,
            etag: source.etag.as_deref(),
            last_modified: source.last_modified.as_deref(),
            api_key: api_key.as_deref(),
        },
        twitch_credentials,
    )
    .await;

    match checked {
        Err(problem) => record_error(state, source, kind, &problem.0, now).await,
        Ok(Checked::NotModified) => {
            record_success(state, source, kind, None, None, None, now).await;
        }
        Ok(Checked::Fresh {
            feed,
            etag,
            last_modified,
        }) => {
            record_success(
                state,
                source,
                kind,
                etag.as_deref(),
                last_modified.as_deref(),
                feed.title.as_deref(),
                now,
            )
            .await;
            for subscriber in &subscribers {
                deliver(
                    state,
                    fetcher,
                    subscriber,
                    kind,
                    source,
                    &feed.items,
                    api_key.as_deref(),
                    now,
                )
                .await;
            }
        }
    }
}

async fn record_error(
    state: &AppState,
    source: &FeedSourceRow,
    kind: FeedKind,
    problem: &str,
    now: DateTime<Utc>,
) {
    let errors = source.error_count.saturating_add(1);
    let next = feeds::next_check(kind, now, errors, jitter());
    if let Err(err) =
        paracord_db::feeds::record_source_error(&state.db, source.id, problem, errors, now, next)
            .await
    {
        tracing::warn!(
            source_id = source.id,
            "feeds: error could not be recorded: {err}"
        );
    }
}

async fn record_success(
    state: &AppState,
    source: &FeedSourceRow,
    kind: FeedKind,
    etag: Option<&str>,
    last_modified: Option<&str>,
    title: Option<&str>,
    now: DateTime<Utc>,
) {
    let next = feeds::next_check(kind, now, 0, jitter());
    if let Err(err) = paracord_db::feeds::record_source_success(
        &state.db,
        source.id,
        &paracord_db::feeds::SourceSuccess {
            etag,
            last_modified,
            title,
            checked_at: now,
            next_check_at: next,
        },
    )
    .await
    {
        tracing::warn!(
            source_id = source.id,
            "feeds: check could not be recorded: {err}"
        );
    }
}

/// Record items as seen without posting them: a new feed's first run, and
/// items past the per-check cap.
pub(crate) async fn record_items_seen(
    state: &AppState,
    feed_id: i64,
    items: &[FeedItem],
    now: DateTime<Utc>,
) -> Result<(), String> {
    let stored: Vec<(String, String)> = items
        .iter()
        .map(|item| {
            serde_json::to_string(item)
                .map(|json| (item.key.clone(), json))
                .map_err(|err| err.to_string())
        })
        .collect::<Result<_, _>>()?;
    let seen: Vec<SeenItem<'_>> = items
        .iter()
        .zip(&stored)
        .map(|(item, (key, json))| SeenItem {
            key,
            title: &item.title,
            published_at: item.published_at,
            item: json,
        })
        .collect();
    paracord_db::feeds::record_seen(&state.db, feed_id, &seen, now)
        .await
        .map_err(|err| err.to_string())
}

#[allow(clippy::too_many_arguments)]
async fn deliver(
    state: &AppState,
    fetcher: &SafeFetcher,
    feed: &GuildFeedRow,
    kind: FeedKind,
    source: &FeedSourceRow,
    items: &[FeedItem],
    api_key: Option<&str>,
    now: DateTime<Utc>,
) {
    let seen = match paracord_db::feeds::seen_keys(&state.db, feed.id).await {
        Ok(seen) => seen,
        Err(err) => {
            tracing::warn!(
                feed_id = feed.id,
                "feeds: seen items could not be read: {err}"
            );
            return;
        }
    };
    let plan = feeds::plan_posts(kind, items, &seen);
    if plan.new_items.is_empty() {
        return;
    }
    // Everything new is seen from here on, posted or not: a channel that
    // cannot take the cards must not turn into a flood once it can.
    if let Err(err) = record_items_seen(state, feed.id, &plan.new_items, now).await {
        tracing::warn!(
            feed_id = feed.id,
            "feeds: items could not be recorded: {err}"
        );
        return;
    }
    let mut failure: Option<String> = None;
    for card in &plan.cards {
        match post_card(state, fetcher, feed, kind, source, card, api_key).await {
            Ok(_) => {
                let keys = if card.keys.is_empty() {
                    vec![card.key.clone()]
                } else {
                    card.keys.clone()
                };
                let _ = paracord_db::feeds::mark_posted(&state.db, feed.id, &keys).await;
            }
            Err(problem) => {
                failure = Some(problem);
                break;
            }
        }
    }
    if failure.is_none() && plan.more > 0 {
        if let Err(problem) = post_more(state, feed, kind, source, plan.more).await {
            failure = Some(problem);
        }
    }
    let result = match failure {
        Some(problem) => {
            paracord_db::feeds::record_delivery(&state.db, feed.id, Some(&problem), None).await
        }
        None => paracord_db::feeds::record_delivery(&state.db, feed.id, None, Some(now)).await,
    };
    if let Err(err) = result {
        tracing::warn!(
            feed_id = feed.id,
            "feeds: delivery could not be recorded: {err}"
        );
    }
}

/// Post one item now ("Post it now", "Post the latest now").
pub(crate) async fn post_item_now(
    state: &AppState,
    feed: &GuildFeedRow,
    item: &FeedItem,
) -> Result<i64, String> {
    let kind =
        FeedKind::parse(&feed.kind).ok_or_else(|| "This feed's kind is unknown.".to_string())?;
    let source = paracord_db::feeds::get_source(&state.db, feed.source_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "This feed's source is missing.".to_string())?;
    let api_key = match feed.secret.as_deref() {
        Some(stored) if kind == FeedKind::Jellyfin => Some(open_secret(state, stored)?),
        _ => None,
    };
    let fetcher = SafeFetcher::for_instance(&state.db).await;
    let mut card = item.clone();
    if card.keys.is_empty() {
        card.keys = vec![card.key.clone()];
    }
    let message_id = post_card(
        state,
        &fetcher,
        feed,
        kind,
        &source,
        &card,
        api_key.as_deref(),
    )
    .await?;
    let _ = paracord_db::feeds::mark_posted(&state.db, feed.id, &card.keys).await;
    let _ = paracord_db::feeds::record_delivery(&state.db, feed.id, None, Some(Utc::now())).await;
    Ok(message_id)
}

/// Why a feed can't post into its channel right now, if it can't.
async fn channel_problem(state: &AppState, feed: &GuildFeedRow) -> Result<(), String> {
    let channel = paracord_db::channels::get_channel(&state.db, feed.channel_id)
        .await
        .map_err(|err| err.to_string())?
        .filter(|channel| channel.space_id == Some(feed.guild_id))
        .ok_or_else(|| "The feed's channel no longer exists. Pick another channel.".to_string())?;
    if !matches!(
        channel.channel_type,
        CHANNEL_TYPE_TEXT | CHANNEL_TYPE_ANNOUNCEMENT
    ) {
        return Err(
            "The feed's channel is no longer a text channel. Pick another channel.".to_string(),
        );
    }
    if paracord_db::messages::channel_has_ciphertext(&state.db, channel.id)
        .await
        .map_err(|err| err.to_string())?
    {
        return Err(
            "The feed's channel holds end-to-end encrypted messages, so a feed can't post readable cards there. Pick another channel."
                .to_string(),
        );
    }
    Ok(())
}

fn clip_content(content: &str) -> String {
    if content.len() <= MAX_CONTENT_BYTES {
        return content.to_string();
    }
    let mut end = MAX_CONTENT_BYTES;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    content[..end].to_string()
}

fn card_embed(
    feed: &GuildFeedRow,
    kind: FeedKind,
    source: &FeedSourceRow,
    card: &FeedItem,
    thumbnail: Option<&str>,
) -> Value {
    json!({
        "type": "rich",
        "url": card.link,
        "title": card.title,
        "description": card.summary,
        "site_name": feed.name,
        "thumbnail": thumbnail,
        "timestamp": card.published_at.map(|at| at.to_rfc3339()),
        "feed": {
            "kind": kind.as_str(),
            "video_id": card.video_id,
            "source_url": source.site_url,
        },
    })
}

async fn post_card(
    state: &AppState,
    fetcher: &SafeFetcher,
    feed: &GuildFeedRow,
    kind: FeedKind,
    source: &FeedSourceRow,
    card: &FeedItem,
    api_key: Option<&str>,
) -> Result<i64, String> {
    channel_problem(state, feed).await?;
    let mut poster: Option<(i64, feeds::Poster)> = None;
    if let (FeedKind::Jellyfin, Some(reference), Some(key)) =
        (kind, card.poster_ref.as_deref(), api_key)
    {
        match feeds::fetch_poster(fetcher, &source.url, key, reference).await {
            Ok(image) => poster = Some((paracord_util::snowflake::generate(1), image)),
            Err(problem) => tracing::warn!(feed_id = feed.id, "feeds: poster skipped: {problem}"),
        }
    }
    let thumbnail = match &poster {
        Some((attachment_id, _)) => Some(format!("/api/v1/attachments/{attachment_id}")),
        None => card.thumbnail_url.clone(),
    };
    let embed = card_embed(feed, kind, source, card, thumbnail.as_deref());
    publish(
        state,
        feed,
        &clip_content(card.title.trim()),
        embed,
        poster,
        false,
    )
    .await
}

async fn post_more(
    state: &AppState,
    feed: &GuildFeedRow,
    kind: FeedKind,
    source: &FeedSourceRow,
    more: usize,
) -> Result<i64, String> {
    channel_problem(state, feed).await?;
    let line = format!("and {more} more from {}", feed.name);
    let embed = json!({
        "type": "rich",
        "url": source.site_url,
        "title": line,
        "site_name": feed.name,
        "feed": {
            "kind": kind.as_str(),
            "more": more,
            "source_url": source.site_url,
        },
    });
    publish(state, feed, &clip_content(&line), embed, None, true).await
}

async fn publish(
    state: &AppState,
    feed: &GuildFeedRow,
    content: &str,
    embed: Value,
    poster: Option<(i64, feeds::Poster)>,
    overflow: bool,
) -> Result<i64, String> {
    let author_id = ensure_feeds_user(&state.db).await?;
    let source = paracord_db::feeds::get_source(&state.db, feed.source_id)
        .await
        .map_err(|err| err.to_string())?;
    let icon_url = source.as_ref().and_then(|source| source.icon_url.clone());
    let embeds = serde_json::to_string(&vec![embed]).map_err(|err| err.to_string())?;

    // The poster is stored before the message exists, the way an upload is,
    // so the card never points at a picture that isn't there.
    let stored_poster = match &poster {
        Some((attachment_id, image)) => Some(store_poster(state, *attachment_id, image).await?),
        None => None,
    };

    let message_id = paracord_util::snowflake::generate(1);
    let created = paracord_db::messages::create_message_with_payload_mentions(
        &state.db,
        message_id,
        feed.channel_id,
        author_id,
        content,
        0,
        None,
        0,
        None,
        Some(&embeds),
        &[],
    )
    .await;
    let message = match created {
        Ok(message) => message,
        Err(err) => {
            if let Some(key) = &stored_poster {
                let _ = state.storage_backend.delete(key).await;
            }
            return Err(err.to_string());
        }
    };
    if let Some((attachment_id, image)) = &poster {
        let url = format!("/api/v1/attachments/{attachment_id}");
        if let Err(err) = paracord_db::attachments::create_attachment(
            &state.db,
            *attachment_id,
            Some(message.id),
            &format!("poster.{}", image.extension),
            Some(image.content_type),
            image.bytes.len() as i32,
            &url,
            None,
            None,
            None,
            Some(feed.channel_id),
            None,
            None,
        )
        .await
        {
            tracing::warn!(
                feed_id = feed.id,
                "feeds: poster could not be attached: {err}"
            );
        }
    }
    paracord_db::feeds::link_feed_message(
        &state.db,
        &paracord_db::feeds::NewFeedMessage {
            message_id: message.id,
            feed_id: feed.id,
            guild_id: feed.guild_id,
            kind: &feed.kind,
            name: &feed.name,
            icon_url: icon_url.as_deref(),
            overflow,
        },
    )
    .await
    .map_err(|err| err.to_string())?;

    let message = paracord_db::messages::get_message_with_embeds(&state.db, message.id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "The posted card went missing.".to_string())?;
    let payload = super::channels::message_to_json(state, &message, author_id).await;
    state
        .event_bus
        .dispatch_message(&state.db, "MESSAGE_CREATE", payload, Some(feed.guild_id))
        .await;
    Ok(message.id)
}

async fn store_poster(
    state: &AppState,
    attachment_id: i64,
    image: &feeds::Poster,
) -> Result<String, String> {
    let key = format!("attachments/{attachment_id}.{}", image.extension);
    let payload = match state.config.file_cryptor.as_ref() {
        Some(cryptor) => {
            let aad = super::files::attachment_aad(attachment_id);
            cryptor
                .encrypt_with_aad(&image.bytes, aad.as_bytes())
                .map_err(|err| err.to_string())?
        }
        None => image.bytes.clone(),
    };
    state
        .storage_backend
        .store(&key, &payload)
        .await
        .map_err(|err| format!("The poster could not be stored: {err}"))?;
    Ok(key)
}

async fn ensure_feeds_user(pool: &paracord_db::DbPool) -> Result<i64, String> {
    if let Some(user) = paracord_db::users::get_user_by_id(pool, FEEDS_USER_ID)
        .await
        .map_err(|err| err.to_string())?
    {
        finish_feeds_user(pool, user.flags, user.display_name.as_deref()).await?;
        return Ok(FEEDS_USER_ID);
    }
    let username = match paracord_db::users::get_user_by_username(pool, FEEDS_NAME, 0)
        .await
        .map_err(|err| err.to_string())?
    {
        Some(_) => "feedsbot",
        None => FEEDS_NAME,
    };
    if let Err(err) =
        paracord_db::users::create_user(pool, FEEDS_USER_ID, username, 0, FEEDS_EMAIL, "").await
    {
        if paracord_db::users::get_user_by_id(pool, FEEDS_USER_ID)
            .await
            .map_err(|read| read.to_string())?
            .is_none()
        {
            return Err(err.to_string());
        }
    }
    let user = paracord_db::users::get_user_by_id(pool, FEEDS_USER_ID)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Feeds user missing".to_string())?;
    finish_feeds_user(pool, user.flags, user.display_name.as_deref()).await?;
    Ok(FEEDS_USER_ID)
}

async fn finish_feeds_user(
    pool: &paracord_db::DbPool,
    flags: i32,
    display_name: Option<&str>,
) -> Result<(), String> {
    if !is_bot(flags) {
        paracord_db::users::update_user_flags(pool, FEEDS_USER_ID, flags | USER_FLAG_BOT)
            .await
            .map_err(|err| err.to_string())?;
    }
    if display_name != Some(FEEDS_NAME) {
        paracord_db::users::update_user(pool, FEEDS_USER_ID, Some(FEEDS_NAME), None, None)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}
