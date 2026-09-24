//! The game servers poller, and the "went down" / "back up" announcements.
//!
//! One pass probes every target whose minute has come, once, however many
//! servers list it, then tells each listing. An announcement is posted by the
//! internal "Game servers" user and linked the way a feed post is, so it
//! reads as the game server itself (see `channels::build_message_json`).

use chrono::{DateTime, Duration, Utc};
use futures_util::stream::{self, StreamExt};
use paracord_core::feeds::local_network_allowed;
use paracord_core::game_servers::{
    self, GameAddress, GameKind, GameStatus, ProbeError, DOWN_AFTER_FAILURES, POLL_INTERVAL,
};
use paracord_core::{is_bot, AppState, USER_FLAG_BOT};
use paracord_db::game_servers::{GameServerRow, TargetAnswer, TargetRow};

const GAME_SERVERS_USER_ID: i64 = -9;
const GAME_SERVERS_EMAIL: &str = "gameservers@paracord.internal";
const GAME_SERVERS_USERNAME: &str = "gameservers";
const GAME_SERVERS_NAME: &str = "Game servers";
/// The `feed.kind` an announcement carries.
pub const MESSAGE_KIND: &str = "game_server";
/// Targets probed in one pass. The rest wait for the next pass.
const TARGETS_PER_PASS: i64 = 200;
/// Probes in flight at once.
const CONCURRENT_PROBES: usize = 16;

const CHANNEL_TYPE_TEXT: i16 = 0;
const CHANNEL_TYPE_ANNOUNCEMENT: i16 = 5;

const STATE_UP: &str = "up";
const STATE_DOWN: &str = "down";

/// One pass over every due target. Safe to call on a timer.
pub async fn poll_due(state: &AppState) {
    poll_due_at(state, Utc::now()).await;
}

/// One pass as of `now`.
pub async fn poll_due_at(state: &AppState, now: DateTime<Utc>) {
    let due =
        match paracord_db::game_servers::list_due_targets(&state.db, now, TARGETS_PER_PASS).await {
            Ok(due) => due,
            Err(err) => {
                tracing::warn!("game servers: due targets could not be listed: {err}");
                return;
            }
        };
    if due.is_empty() {
        return;
    }
    let allow_private = local_network_allowed(&state.db).await;
    let results: Vec<(TargetRow, Result<GameStatus, ProbeError>)> = stream::iter(due)
        .map(|target| async move {
            let result = probe_target(&target, allow_private).await;
            (target, result)
        })
        .buffer_unordered(CONCURRENT_PROBES)
        .collect()
        .await;
    for (target, result) in results {
        apply_result(state, &target, result, now).await;
    }
}

async fn probe_target(target: &TargetRow, allow_private: bool) -> Result<GameStatus, ProbeError> {
    let kind = GameKind::parse(&target.kind)
        .ok_or_else(|| ProbeError::Address("This game server's type is unknown.".into()))?;
    let port = u16::try_from(target.port)
        .map_err(|_| ProbeError::Address("This game server's port is invalid.".into()))?;
    let address = GameAddress {
        host: target.host.clone(),
        port,
    };
    game_servers::probe(kind, &address, allow_private).await
}

/// The next probe: a minute on, give or take six seconds so targets added
/// together do not stay in step.
fn next_check(now: DateTime<Utc>) -> DateTime<Utc> {
    let base = POLL_INTERVAL.as_millis() as i64;
    let spread = base / 10;
    let jitter = (rand::random::<f64>() * 2.0 - 1.0) * spread as f64;
    now + Duration::milliseconds(base + jitter as i64)
}

/// Record a probe's result on its target, then bring every listing of the
/// target up to date, announcing where the state changed.
pub async fn apply_result(
    state: &AppState,
    target: &TargetRow,
    result: Result<GameStatus, ProbeError>,
    now: DateTime<Utc>,
) {
    let next = next_check(now);
    let (online, players) = match &result {
        Ok(status) => {
            let names = status
                .player_names
                .as_ref()
                .and_then(|names| serde_json::to_string(names).ok());
            let recorded = paracord_db::game_servers::record_answer(
                &state.db,
                target.id,
                &TargetAnswer {
                    players_online: status.players_online.map(i64::from),
                    players_max: status.players_max.map(i64::from),
                    player_names: names.as_deref(),
                    server_name: status.name.as_deref(),
                    map: status.map.as_deref(),
                    version: status.version.as_deref(),
                    motd: status.motd.as_deref(),
                    latency_ms: i64::from(status.latency_ms),
                },
                now,
                next,
            )
            .await;
            if let Err(err) = recorded {
                tracing::warn!(
                    target_id = target.id,
                    "game servers: probe could not be recorded: {err}"
                );
                return;
            }
            (true, Some((status.players_online, status.players_max)))
        }
        Err(problem) => {
            let failures = target.fail_count.saturating_add(1);
            // A server that was up stays up through two missed probes (a lost
            // UDP packet is not an outage); one never seen up is down at once.
            let online = target.online && failures < DOWN_AFTER_FAILURES;
            if let Err(err) = paracord_db::game_servers::record_failure(
                &state.db,
                target.id,
                &problem.to_string(),
                failures,
                online,
                now,
                next,
            )
            .await
            {
                tracing::warn!(
                    target_id = target.id,
                    "game servers: failure could not be recorded: {err}"
                );
                return;
            }
            (online, None)
        }
    };
    let new_state = if online { STATE_UP } else { STATE_DOWN };

    let listings =
        match paracord_db::game_servers::list_active_for_target(&state.db, target.id).await {
            Ok(listings) => listings,
            Err(err) => {
                tracing::warn!(
                    target_id = target.id,
                    "game servers: listings could not be read: {err}"
                );
                return;
            }
        };
    for listing in listings {
        if listing.last_state.as_deref() == Some(new_state) {
            continue;
        }
        // The first state a listing sees is where it starts, not a change.
        let problem = match (&listing.last_state, listing.announce_channel_id) {
            (Some(_), Some(channel_id)) => {
                let content = announcement(&listing.name, online, players);
                announce(state, &listing, channel_id, &content).await.err()
            }
            _ => None,
        };
        if let Err(err) = paracord_db::game_servers::record_state(
            &state.db,
            listing.id,
            new_state,
            problem.as_deref(),
        )
        .await
        {
            tracing::warn!(
                game_server_id = listing.id,
                "game servers: state could not be recorded: {err}"
            );
        }
    }
}

/// What an announcement says.
pub fn announcement(
    name: &str,
    online: bool,
    players: Option<(Option<u32>, Option<u32>)>,
) -> String {
    if !online {
        return format!(
            "{name} is down. It hasn't answered the last {DOWN_AFTER_FAILURES} checks."
        );
    }
    match players {
        Some((Some(on), Some(max))) => {
            let noun = if max == 1 { "player" } else { "players" };
            format!("{name} is back up, with {on} of {max} {noun} online.")
        }
        Some((Some(on), None)) => {
            let noun = if on == 1 { "player" } else { "players" };
            format!("{name} is back up, with {on} {noun} online.")
        }
        _ => format!("{name} is back up."),
    }
}

/// Why an announcement can't go into the channel right now, if it can't.
async fn channel_problem(
    state: &AppState,
    listing: &GameServerRow,
    channel_id: i64,
) -> Result<(), String> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|err| err.to_string())?
        .filter(|channel| channel.space_id == Some(listing.guild_id))
        .ok_or_else(|| {
            "The announcement channel no longer exists. Pick another channel.".to_string()
        })?;
    if !matches!(
        channel.channel_type,
        CHANNEL_TYPE_TEXT | CHANNEL_TYPE_ANNOUNCEMENT
    ) {
        return Err(
            "The announcement channel is no longer a text channel. Pick another channel."
                .to_string(),
        );
    }
    if paracord_db::messages::channel_has_ciphertext(&state.db, channel.id)
        .await
        .map_err(|err| err.to_string())?
    {
        return Err(
            "The announcement channel holds end-to-end encrypted messages, so announcements can't be posted there. Pick another channel."
                .to_string(),
        );
    }
    Ok(())
}

async fn announce(
    state: &AppState,
    listing: &GameServerRow,
    channel_id: i64,
    content: &str,
) -> Result<i64, String> {
    channel_problem(state, listing, channel_id).await?;
    let author_id = ensure_game_servers_user(&state.db).await?;
    let message = paracord_db::messages::create_message_with_payload_mentions(
        &state.db,
        paracord_util::snowflake::generate(1),
        channel_id,
        author_id,
        content,
        0,
        None,
        0,
        None,
        None,
        &[],
    )
    .await
    .map_err(|err| err.to_string())?;
    // Linked like a feed post: the message reads as the game server, keeps
    // that name after the listing is renamed or removed, and stays off the
    // front page.
    paracord_db::feeds::link_feed_message(
        &state.db,
        &paracord_db::feeds::NewFeedMessage {
            message_id: message.id,
            feed_id: listing.id,
            guild_id: listing.guild_id,
            kind: MESSAGE_KIND,
            name: &listing.name,
            icon_url: None,
            overflow: false,
        },
    )
    .await
    .map_err(|err| err.to_string())?;
    let payload = super::channels::message_to_json(state, &message, author_id).await;
    state
        .event_bus
        .dispatch_message(&state.db, "MESSAGE_CREATE", payload, Some(listing.guild_id))
        .await;
    Ok(message.id)
}

async fn ensure_game_servers_user(pool: &paracord_db::DbPool) -> Result<i64, String> {
    if let Some(user) = paracord_db::users::get_user_by_id(pool, GAME_SERVERS_USER_ID)
        .await
        .map_err(|err| err.to_string())?
    {
        finish_user(pool, user.flags, user.display_name.as_deref()).await?;
        return Ok(GAME_SERVERS_USER_ID);
    }
    let username = match paracord_db::users::get_user_by_username(pool, GAME_SERVERS_USERNAME, 0)
        .await
        .map_err(|err| err.to_string())?
    {
        Some(_) => "gameserversbot",
        None => GAME_SERVERS_USERNAME,
    };
    if let Err(err) = paracord_db::users::create_user(
        pool,
        GAME_SERVERS_USER_ID,
        username,
        0,
        GAME_SERVERS_EMAIL,
        "",
    )
    .await
    {
        if paracord_db::users::get_user_by_id(pool, GAME_SERVERS_USER_ID)
            .await
            .map_err(|read| read.to_string())?
            .is_none()
        {
            return Err(err.to_string());
        }
    }
    let user = paracord_db::users::get_user_by_id(pool, GAME_SERVERS_USER_ID)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Game servers user missing".to_string())?;
    finish_user(pool, user.flags, user.display_name.as_deref()).await?;
    Ok(GAME_SERVERS_USER_ID)
}

async fn finish_user(
    pool: &paracord_db::DbPool,
    flags: i32,
    display_name: Option<&str>,
) -> Result<(), String> {
    if !is_bot(flags) {
        paracord_db::users::update_user_flags(pool, GAME_SERVERS_USER_ID, flags | USER_FLAG_BOT)
            .await
            .map_err(|err| err.to_string())?;
    }
    if display_name != Some(GAME_SERVERS_NAME) {
        paracord_db::users::update_user(
            pool,
            GAME_SERVERS_USER_ID,
            Some(GAME_SERVERS_NAME),
            None,
            None,
        )
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn announcements_read_as_sentences() {
        assert_eq!(
            announcement("Lantern SMP", false, None),
            "Lantern SMP is down. It hasn't answered the last 3 checks."
        );
        assert_eq!(
            announcement("Lantern SMP", true, Some((Some(3), Some(20)))),
            "Lantern SMP is back up, with 3 of 20 players online."
        );
        assert_eq!(
            announcement("Duel", true, Some((Some(1), None))),
            "Duel is back up, with 1 player online."
        );
        assert_eq!(
            announcement("Web", true, Some((None, None))),
            "Web is back up."
        );
    }

    #[test]
    fn the_next_check_is_about_a_minute_on() {
        let now = Utc::now();
        for _ in 0..200 {
            let gap = (next_check(now) - now).num_milliseconds();
            assert!((54_000..=66_000).contains(&gap), "{gap}");
        }
    }
}
