//! Score lines in a pinned channel.
//!
//! Guild text channels store the words themselves, so a pin there can carry a
//! readable line. Direct messages and group conversations are encrypted on the
//! members' devices; a pin on one of those posts nothing and records why.

use std::collections::HashSet;

use paracord_core::sports::{
    plan_score_updates, scoreboard, AnnounceCursor, ScoreKind, ScoreSnapshot, ScoreUpdate,
};
use paracord_core::{is_bot, AppState, USER_FLAG_BOT};
use paracord_db::channels::ChannelRow;

use super::sports::{split_pin_game, ChannelPin};

const SPORTS_USER_ID: i64 = -7;
const SPORTS_EMAIL: &str = "sports@paracord.internal";
const SPORTS_NAME: &str = "Sports";

/// One pass over every server that has an announcing pin. Safe to call on a timer.
pub async fn announce_due(state: &AppState) {
    let rows = match paracord_db::guild_sports::list_enabled_with_pins(&state.db).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("sports score updates could not be listed: {err}");
            return;
        }
    };
    if rows.is_empty() {
        return;
    }
    let mut author: Option<i64> = None;
    for row in rows {
        if let Err(err) = announce_guild(state, &row, &mut author).await {
            tracing::warn!(
                guild_id = row.guild_id,
                "sports score updates skipped: {err}"
            );
        }
    }
}

async fn announce_guild(
    state: &AppState,
    row: &paracord_db::guild_sports::GuildSportsRow,
    author: &mut Option<i64>,
) -> Result<(), String> {
    let followed: Vec<String> = serde_json::from_str(&row.leagues).unwrap_or_default();
    let mut pins: Vec<ChannelPin> = serde_json::from_str(&row.channel_pins).unwrap_or_default();
    let indexes: Vec<usize> = pins
        .iter()
        .enumerate()
        .filter(|(_, pin)| pin.announce && !pin.announced_final && pin.announce_blocked.is_none())
        .map(|(index, _)| index)
        .collect();
    if indexes.is_empty() {
        return Ok(());
    }

    let mut leagues = HashSet::new();
    for index in &indexes {
        let Some((league, _)) = split_pin_game(&pins[*index].game) else {
            continue;
        };
        if !followed
            .iter()
            .any(|item| item.eq_ignore_ascii_case(&league))
        {
            continue;
        }
        if scoreboard().cached_league(&league).is_some() {
            leagues.insert(league);
        }
    }
    for league in &leagues {
        if scoreboard()
            .cached_league(league)
            .is_some_and(|cached| !cached.fresh)
        {
            scoreboard().board(std::slice::from_ref(league), &[]).await;
        }
    }

    let mut updates = Vec::new();
    for index in indexes {
        if announce_pin(state, row.guild_id, &followed, &mut pins[index], author).await? {
            updates.push(pins[index].clone());
        }
    }
    if !updates.is_empty() {
        store_progress(state, row.guild_id, &updates).await?;
    }
    Ok(())
}

async fn announce_pin(
    state: &AppState,
    guild_id: i64,
    followed: &[String],
    pin: &mut ChannelPin,
    author: &mut Option<i64>,
) -> Result<bool, String> {
    let Some((league, event_id)) = split_pin_game(&pin.game) else {
        return Ok(false);
    };
    if !followed
        .iter()
        .any(|item| item.eq_ignore_ascii_case(&league))
    {
        return Ok(false);
    }
    let Some(cached) = scoreboard().cached_league(&league) else {
        return Ok(false);
    };
    let Some(game) = cached.games.iter().find(|game| game.id == event_id) else {
        return Ok(false);
    };
    let live = game.state.eq_ignore_ascii_case("in");
    let closing = game.state.eq_ignore_ascii_case("post");
    if !live && !closing {
        return Ok(false);
    }

    let Ok(channel_id) = pin.channel_id.parse::<i64>() else {
        return Ok(false);
    };
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|err| err.to_string())?;
    let Some(channel) = channel else {
        return Ok(false);
    };
    if channel.space_id != Some(guild_id) {
        return Ok(false);
    }
    if blocks_plaintext(&channel) {
        pin.announce_blocked = Some("encrypted".to_string());
        return Ok(true);
    }
    if channel.channel_type != 0 {
        return Ok(false);
    }
    match paracord_db::messages::channel_has_ciphertext(&state.db, channel.id).await {
        Ok(true) => {
            pin.announce_blocked = Some("encrypted".to_string());
            return Ok(true);
        }
        Ok(false) => {}
        Err(err) => {
            tracing::warn!(
                channel_id = channel.id,
                "sports could not tell if the channel is encrypted: {err}"
            );
            return Ok(false);
        }
    }

    let detail = match scoreboard().detail(&league, &event_id, &[]).await {
        Ok(detail) => detail,
        Err(_) => return Ok(false),
    };
    let (lines, _) = plan_score_updates(&cursor_of(pin), &ScoreSnapshot::from_detail(&detail));
    if lines.is_empty() {
        return Ok(false);
    }
    let user_id = match *author {
        Some(id) => id,
        None => {
            let id = ensure_sports_user(&state.db).await?;
            *author = Some(id);
            id
        }
    };
    let mut posted = false;
    for line in lines {
        if post_score(state, guild_id, channel.id, user_id, &line.content)
            .await
            .is_err()
        {
            break;
        }
        apply_line(pin, &line);
        posted = true;
    }
    Ok(posted)
}

fn blocks_plaintext(channel: &ChannelRow) -> bool {
    channel.space_id.is_none() || matches!(channel.channel_type, 1 | 3)
}

fn cursor_of(pin: &ChannelPin) -> AnnounceCursor {
    AnnounceCursor {
        announce: pin.announce,
        through: pin.announced_through.clone(),
        halftime: pin.announced_halftime,
        regulation: pin.announced_regulation,
        final_score: pin.announced_final,
        blocked: pin.announce_blocked.clone(),
    }
}

fn apply_line(pin: &mut ChannelPin, line: &ScoreUpdate) {
    match line.kind {
        ScoreKind::Scoring => pin.announced_through = line.play_id.clone(),
        ScoreKind::Halftime => pin.announced_halftime = true,
        ScoreKind::Regulation => pin.announced_regulation = true,
        ScoreKind::Final => pin.announced_final = true,
    }
}

async fn post_score(
    state: &AppState,
    guild_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
) -> Result<(), String> {
    let content = clip_content(content.trim());
    if content.is_empty() {
        return Err("empty score line".to_string());
    }
    let msg_id = paracord_util::snowflake::generate(1);
    let msg = paracord_db::messages::create_message_with_payload_mentions(
        &state.db,
        msg_id,
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
    let payload = super::channels::message_to_json(state, &msg, author_id).await;
    state
        .event_bus
        .dispatch_message(&state.db, "MESSAGE_CREATE", payload, Some(guild_id))
        .await;
    Ok(())
}

fn clip_content(content: &str) -> &str {
    if content.len() <= 2000 {
        return content;
    }
    let mut end = 2000;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    &content[..end]
}

async fn ensure_sports_user(pool: &paracord_db::DbPool) -> Result<i64, String> {
    if let Some(user) = paracord_db::users::get_user_by_id(pool, SPORTS_USER_ID)
        .await
        .map_err(|err| err.to_string())?
    {
        finish_sports_user(pool, user.flags, user.display_name.as_deref()).await?;
        return Ok(SPORTS_USER_ID);
    }
    let username = match paracord_db::users::get_user_by_username(pool, SPORTS_NAME, 0)
        .await
        .map_err(|err| err.to_string())?
    {
        Some(_) => "sportsbot",
        None => SPORTS_NAME,
    };
    if let Err(err) =
        paracord_db::users::create_user(pool, SPORTS_USER_ID, username, 0, SPORTS_EMAIL, "").await
    {
        if paracord_db::users::get_user_by_id(pool, SPORTS_USER_ID)
            .await
            .map_err(|read| read.to_string())?
            .is_none()
        {
            return Err(err.to_string());
        }
    }
    let user = paracord_db::users::get_user_by_id(pool, SPORTS_USER_ID)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Sports user missing".to_string())?;
    finish_sports_user(pool, user.flags, user.display_name.as_deref()).await?;
    Ok(SPORTS_USER_ID)
}

async fn finish_sports_user(
    pool: &paracord_db::DbPool,
    flags: i32,
    display_name: Option<&str>,
) -> Result<(), String> {
    if !is_bot(flags) {
        paracord_db::users::update_user_flags(pool, SPORTS_USER_ID, flags | USER_FLAG_BOT)
            .await
            .map_err(|err| err.to_string())?;
    }
    if display_name != Some(SPORTS_NAME) {
        paracord_db::users::update_user(pool, SPORTS_USER_ID, Some(SPORTS_NAME), None, None)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

async fn store_progress(
    state: &AppState,
    guild_id: i64,
    updates: &[ChannelPin],
) -> Result<(), String> {
    let Some(row) = paracord_db::guild_sports::get(&state.db, guild_id)
        .await
        .map_err(|err| err.to_string())?
    else {
        return Ok(());
    };
    let mut pins: Vec<ChannelPin> = serde_json::from_str(&row.channel_pins).unwrap_or_default();
    let mut changed = false;
    for update in updates {
        let Some(pin) = pins
            .iter_mut()
            .find(|pin| pin.channel_id == update.channel_id && pin.game == update.game)
        else {
            continue;
        };
        if pin.announced_through == update.announced_through
            && pin.announced_final == update.announced_final
            && pin.announced_halftime == update.announced_halftime
            && pin.announced_regulation == update.announced_regulation
            && pin.announce_blocked == update.announce_blocked
        {
            continue;
        }
        pin.announced_through = update.announced_through.clone();
        pin.announced_final = update.announced_final;
        pin.announced_halftime = update.announced_halftime;
        pin.announced_regulation = update.announced_regulation;
        pin.announce_blocked = update.announce_blocked.clone();
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    let text = serde_json::to_string(&pins).map_err(|err| err.to_string())?;
    paracord_db::guild_sports::set_channel_pins(&state.db, guild_id, &text)
        .await
        .map_err(|err| err.to_string())?;
    Ok(())
}
