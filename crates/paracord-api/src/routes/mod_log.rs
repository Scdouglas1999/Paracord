use paracord_core::{AppState, USER_FLAG_BOT};
use serde_json::{json, Value};

pub(crate) const MOD_LOG_BOT_ID: i64 = -2;
const MOD_LOG_BOT_USERNAME: &str = "Auto-Moderator";
const MOD_LOG_BOT_EMAIL: &str = "automod@paracord.internal";

fn parse_channel_id(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::String(raw)) => raw.parse::<i64>().ok(),
        Some(Value::Number(raw)) => raw.as_i64(),
        _ => None,
    }
}

fn resolve_mod_log_channel_from_settings(settings: &Value) -> Option<i64> {
    parse_channel_id(settings.get("mod_log_channel_id"))
        .or_else(|| {
            settings
                .get("moderation")
                .and_then(|v| parse_channel_id(v.get("mod_log_channel_id")))
        })
        .or_else(|| {
            settings
                .get("auto_mod")
                .and_then(|v| parse_channel_id(v.get("mod_log_channel_id")))
        })
}

pub async fn get_mod_log_channel_id(state: &AppState, guild_id: i64) -> Option<i64> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .ok()??;
    let raw = guild.bot_settings?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let channel_id = resolve_mod_log_channel_from_settings(&parsed)?;
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()??;
    if channel.guild_id() != Some(guild_id) {
        return None;
    }
    Some(channel_id)
}

pub(crate) async fn ensure_mod_log_bot(state: &AppState) {
    let _ = paracord_db::users::create_user(
        &state.db,
        MOD_LOG_BOT_ID,
        MOD_LOG_BOT_USERNAME,
        0,
        MOD_LOG_BOT_EMAIL,
        "",
    )
    .await;
    if let Ok(Some(user)) = paracord_db::users::get_user_by_id(&state.db, MOD_LOG_BOT_ID).await {
        let desired_flags = user.flags | USER_FLAG_BOT;
        if desired_flags != user.flags {
            let _ = paracord_db::users::update_user_flags(&state.db, MOD_LOG_BOT_ID, desired_flags)
                .await;
        }
    }
}

fn build_mod_log_content(title: &str, summary: &str, details: &[(&str, String)]) -> String {
    let mut content = format!("**{}**\n{}", title, summary);
    for (label, value) in details {
        content.push('\n');
        content.push_str("- ");
        content.push_str(label);
        content.push_str(": ");
        content.push_str(value);
    }
    content
}

pub async fn emit_mod_log(
    state: &AppState,
    guild_id: i64,
    title: &str,
    summary: &str,
    details: &[(&str, String)],
) {
    let Some(channel_id) = get_mod_log_channel_id(state, guild_id).await else {
        return;
    };

    ensure_mod_log_bot(state).await;

    let content = build_mod_log_content(title, summary, details);
    let message_id = paracord_util::snowflake::generate(1);
    let Ok(message) = paracord_db::messages::create_message(
        &state.db,
        message_id,
        channel_id,
        MOD_LOG_BOT_ID,
        &content,
        0,
        None,
    )
    .await
    else {
        return;
    };

    state.event_bus.dispatch(
        "MESSAGE_CREATE",
        json!({
            "id": message.id.to_string(),
            "channel_id": message.channel_id.to_string(),
            "author_id": message.author_id.to_string(),
            "content": message.content,
            "nonce": message.nonce,
            "message_type": message.message_type,
            "flags": message.flags,
            "pinned": message.pinned,
            "e2ee_header": message.e2ee_header,
            "created_at": message.created_at.to_rfc3339(),
            "edited_at": message.edited_at.map(|d| d.to_rfc3339()),
            "author": {
                "id": MOD_LOG_BOT_ID.to_string(),
                "username": MOD_LOG_BOT_USERNAME,
                "discriminator": 0,
                "avatar_hash": serde_json::Value::Null,
                "flags": USER_FLAG_BOT,
                "bot": true,
            }
        }),
        Some(guild_id),
    );
}
