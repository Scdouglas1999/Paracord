use chrono::{Duration, Utc};
use paracord_core::{AppState, USER_FLAG_BOT};
use regex::RegexBuilder;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::Notify;

const WELCOME_BOT_ID: i64 = -1;
const AUTO_MOD_ID: i64 = -2;
const ACTION_REPORT_CREATE: i16 = 90;
const MAX_TRIGGER_LOGS: usize = 200;

#[derive(Default)]
struct BotRuntime {
    recent_messages: HashMap<(i64, i64), VecDeque<(i64, String)>>,
    recent_joins: HashMap<i64, VecDeque<i64>>,
}

struct MessageContext {
    message_id: i64,
    message_id_raw: String,
    channel_id: i64,
    channel_id_raw: String,
    author_id: i64,
    content: String,
}

pub fn spawn_bot_manager(state: AppState, shutdown: Arc<Notify>) {
    let db = state.db.clone();
    tokio::spawn(async move {
        ensure_system_bots(&db).await;
        let mut runtime = BotRuntime::default();
        let mut rx = state.event_bus.subscribe_system();
        tracing::info!("Native Bot Manager started");
        loop {
            tokio::select! {
                _ = shutdown.notified() => {
                    tracing::info!("Native Bot Manager shutting down");
                    break;
                }
                Ok(event) = rx.recv() => {
                    handle_event(&state, &mut runtime, event).await;
                }
                else => break,
            }
        }
    });
}

async fn ensure_system_bots(pool: &paracord_db::DbPool) {
    ensure_system_bot(
        pool,
        WELCOME_BOT_ID,
        "Welcome Bot",
        "welcome@paracord.internal",
    )
    .await;
    ensure_system_bot(
        pool,
        AUTO_MOD_ID,
        "Auto-Moderator",
        "automod@paracord.internal",
    )
    .await;
}

async fn ensure_system_bot(pool: &paracord_db::DbPool, id: i64, username: &str, email: &str) {
    let _ = paracord_db::users::create_user(pool, id, username, 0, email, "").await;
    if let Ok(Some(user)) = paracord_db::users::get_user_by_id(pool, id).await {
        let desired_flags = user.flags | USER_FLAG_BOT;
        if desired_flags != user.flags {
            let _ = paracord_db::users::update_user_flags(pool, id, desired_flags).await;
        }
    }
}

fn parse_i64(value: Option<&Value>, default: i64) -> i64 {
    match value {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(default),
        Some(Value::String(raw)) => raw.parse::<i64>().unwrap_or(default),
        _ => default,
    }
}

fn parse_bool(value: Option<&Value>, default: bool) -> bool {
    value.and_then(|v| v.as_bool()).unwrap_or(default)
}

fn parse_channel_id(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::String(raw)) => raw.parse::<i64>().ok(),
        Some(Value::Number(raw)) => raw.as_i64(),
        _ => None,
    }
}

fn extract_domains(content: &str) -> Vec<String> {
    let mut domains = Vec::new();
    for token in content.split_whitespace() {
        let candidate = token
            .trim_matches(|ch: char| ch == '<' || ch == '>' || ch == '(' || ch == ')' || ch == ',')
            .trim();
        let rest = candidate
            .strip_prefix("https://")
            .or_else(|| candidate.strip_prefix("http://"));
        let Some(rest) = rest else {
            continue;
        };
        let host = rest.split('/').next().unwrap_or_default();
        let host = host.split('@').next_back().unwrap_or(host);
        let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
        if !host.is_empty() && !domains.contains(&host) {
            domains.push(host);
        }
    }
    domains
}

fn mention_count(content: &str) -> usize {
    let direct_mentions = content.matches("<@").count();
    let everyone = usize::from(content.contains("@everyone"));
    let here = usize::from(content.contains("@here"));
    direct_mentions + everyone + here
}

fn parse_message_context(event_data: &Value) -> Option<MessageContext> {
    let message_id_raw = event_data.get("id")?.as_str()?.to_string();
    let channel_id_raw = event_data.get("channel_id")?.as_str()?.to_string();
    let author_id_raw = event_data.get("author_id")?.as_str()?;
    Some(MessageContext {
        message_id: message_id_raw.parse::<i64>().ok()?,
        message_id_raw,
        channel_id: channel_id_raw.parse::<i64>().ok()?,
        channel_id_raw,
        author_id: author_id_raw.parse::<i64>().ok()?,
        content: event_data
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

async fn emit_bot_message(
    state: &AppState,
    guild_id: i64,
    channel_id: i64,
    bot_id: i64,
    bot_name: &str,
    content: &str,
) -> Option<i64> {
    let msg_id = paracord_util::snowflake::generate(1);
    let Ok(msg) = paracord_db::messages::create_message(
        &state.db, msg_id, channel_id, bot_id, content, 0, None,
    )
    .await
    else {
        return None;
    };

    let msg_json = json!({
        "id": msg.id.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "author_id": msg.author_id.to_string(),
        "content": msg.content,
        "nonce": msg.nonce,
        "message_type": msg.message_type,
        "flags": msg.flags,
        "pinned": msg.pinned,
        "e2ee_header": msg.e2ee_header,
        "created_at": msg.created_at.to_rfc3339(),
        "edited_at": msg.edited_at.map(|d| d.to_rfc3339()),
        "author": {
            "id": bot_id.to_string(),
            "username": bot_name,
            "discriminator": 0,
            "avatar_hash": serde_json::Value::Null,
            "flags": USER_FLAG_BOT,
            "bot": true,
        }
    });
    state
        .event_bus
        .dispatch("MESSAGE_CREATE", msg_json, Some(guild_id));
    Some(msg.id)
}

fn mod_log_channel_id(bot_settings: &Value) -> Option<i64> {
    parse_channel_id(bot_settings.get("mod_log_channel_id")).or_else(|| {
        bot_settings
            .get("auto_mod")
            .and_then(|v| parse_channel_id(v.get("mod_log_channel_id")))
    })
}

async fn emit_mod_log(state: &AppState, guild_id: i64, bot_settings: &Value, content: &str) {
    let Some(channel_id) = mod_log_channel_id(bot_settings) else {
        return;
    };
    if let Ok(Some(channel)) = paracord_db::channels::get_channel(&state.db, channel_id).await {
        if channel.guild_id() == Some(guild_id) {
            emit_bot_message(
                state,
                guild_id,
                channel_id,
                AUTO_MOD_ID,
                "Auto-Moderator",
                content,
            )
            .await;
        }
    }
}

async fn update_guild_bot_settings(
    state: &AppState,
    guild_id: i64,
    mutator: impl FnOnce(&mut Value),
) {
    let Ok(Some(guild)) = paracord_db::guilds::get_guild(&state.db, guild_id).await else {
        return;
    };
    let mut settings: Value = guild
        .bot_settings
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| json!({}));
    mutator(&mut settings);
    let Ok(serialized) = serde_json::to_string(&settings) else {
        return;
    };
    let _ = paracord_db::guilds::update_guild(
        &state.db,
        guild_id,
        None,
        None,
        None,
        None,
        Some(&serialized),
    )
    .await;
}

async fn append_trigger_log(
    state: &AppState,
    guild_id: i64,
    rule_name: &str,
    user_id: i64,
    channel_id: i64,
    message_id: i64,
    excerpt: &str,
) {
    let now = Utc::now().to_rfc3339();
    let clipped = excerpt.chars().take(220).collect::<String>();
    update_guild_bot_settings(state, guild_id, |settings| {
        if !settings.is_object() {
            *settings = json!({});
        }
        let root = settings.as_object_mut().expect("object checked above");
        let auto_mod = root
            .entry("auto_mod".to_string())
            .or_insert_with(|| json!({}));
        if !auto_mod.is_object() {
            *auto_mod = json!({});
        }
        let auto_mod_obj = auto_mod.as_object_mut().expect("object checked above");
        let logs = auto_mod_obj
            .entry("trigger_logs".to_string())
            .or_insert_with(|| json!([]));
        if !logs.is_array() {
            *logs = json!([]);
        }
        let logs_arr = logs.as_array_mut().expect("array enforced above");
        logs_arr.push(json!({
            "id": paracord_util::snowflake::generate(1).to_string(),
            "rule": rule_name,
            "user_id": user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "message_id": message_id.to_string(),
            "excerpt": clipped,
            "created_at": now,
        }));
        if logs_arr.len() > MAX_TRIGGER_LOGS {
            let remove_count = logs_arr.len() - MAX_TRIGGER_LOGS;
            logs_arr.drain(0..remove_count);
        }
    })
    .await;
}

fn report_entry_to_json(entry: &paracord_db::audit_log::AuditLogEntryRow) -> Value {
    let changes = entry.changes.clone().unwrap_or_else(|| json!({}));
    let status = changes
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("open");
    json!({
        "id": entry.id.to_string(),
        "guild_id": entry.space_id.to_string(),
        "reporter_id": entry.user_id.to_string(),
        "action_type": entry.action_type,
        "status": status,
        "target_id": entry.target_id.map(|id| id.to_string()),
        "reason": entry.reason,
        "changes": changes,
        "created_at": entry.created_at.to_rfc3339(),
    })
}

async fn create_automod_quarantine_report(
    state: &AppState,
    guild_id: i64,
    ctx: &MessageContext,
    rule_name: &str,
    quarantine_channel_id: Option<i64>,
    quarantine_message_id: Option<i64>,
) {
    let report_id = paracord_util::snowflake::generate(1);
    let reason = format!("AutoMod quarantined a message via rule \"{rule_name}\".");
    let evidence_excerpt = ctx.content.chars().take(512).collect::<String>();
    let evidence = if evidence_excerpt.is_empty() {
        Vec::<String>::new()
    } else {
        vec![evidence_excerpt]
    };
    let changes = json!({
        "target_type": "message",
        "target_id": ctx.message_id.to_string(),
        "message_id": ctx.message_id.to_string(),
        "channel_id": ctx.channel_id.to_string(),
        "reported_user_id": ctx.author_id.to_string(),
        "report_kind": "automod_quarantine",
        "auto_generated": true,
        "rule_name": rule_name,
        "original_content": ctx.content.clone(),
        "original_channel_id": ctx.channel_id.to_string(),
        "quarantine_channel_id": quarantine_channel_id.map(|id| id.to_string()),
        "quarantine_message_id": quarantine_message_id.map(|id| id.to_string()),
        "evidence": evidence,
        "status": "open",
    });

    let Ok(entry) = paracord_db::audit_log::create_entry(
        &state.db,
        report_id,
        guild_id,
        AUTO_MOD_ID,
        ACTION_REPORT_CREATE,
        Some(ctx.message_id),
        Some(reason.as_str()),
        Some(&changes),
    )
    .await
    else {
        return;
    };

    state.event_bus.dispatch(
        "GUILD_REPORT_CREATE",
        report_entry_to_json(&entry),
        Some(guild_id),
    );
}

async fn resolve_welcome_channel_id(state: &AppState, guild_id: i64, wb: &Value) -> Option<i64> {
    if let Some(channel_id) = parse_channel_id(wb.get("channel_id")) {
        if let Ok(Some(channel)) = paracord_db::channels::get_channel(&state.db, channel_id).await {
            if channel.guild_id() == Some(guild_id) {
                return Some(channel_id);
            }
        }
    }

    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
        .await
        .ok()?;
    channels
        .into_iter()
        .find(|channel| channel.channel_type == 0)
        .map(|channel| channel.id)
}

async fn handle_event(
    state: &AppState,
    runtime: &mut BotRuntime,
    event: paracord_core::events::ServerEvent,
) {
    let Some(guild_id) = event.guild_id else {
        return;
    };
    let Ok(Some(guild)) = paracord_db::guilds::get_guild(&state.db, guild_id).await else {
        return;
    };
    let bot_settings: Value = guild
        .bot_settings
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| json!({}));

    match event.event_type.as_str() {
        "GUILD_MEMBER_ADD" => {
            let removed =
                handle_anti_raid(state, runtime, guild_id, &bot_settings, &event.payload).await;
            if !removed {
                handle_welcome_bot(state, guild_id, &bot_settings, &event.payload).await;
            }
        }
        "MESSAGE_CREATE" => {
            handle_auto_mod(state, runtime, guild_id, &bot_settings, &event.payload).await;
        }
        _ => {}
    }
}

async fn handle_welcome_bot(
    state: &AppState,
    guild_id: i64,
    bot_settings: &Value,
    event_data: &Value,
) {
    let Some(welcome_bot) = bot_settings.get("welcome_bot") else {
        return;
    };
    if !parse_bool(welcome_bot.get("enabled"), false) {
        return;
    }

    let Some(channel_id) = resolve_welcome_channel_id(state, guild_id, welcome_bot).await else {
        return;
    };
    let template = welcome_bot
        .get("message_template")
        .and_then(|v| v.as_str())
        .unwrap_or("Welcome to the server, {user}!");
    let username = event_data
        .get("user")
        .and_then(|u| u.get("username"))
        .and_then(|v| v.as_str())
        .unwrap_or("User");
    let content = template.replace("{user}", username);
    emit_bot_message(
        state,
        guild_id,
        channel_id,
        WELCOME_BOT_ID,
        "Welcome Bot",
        &content,
    )
    .await;
}

async fn handle_anti_raid(
    state: &AppState,
    runtime: &mut BotRuntime,
    guild_id: i64,
    bot_settings: &Value,
    event_data: &Value,
) -> bool {
    let Some(auto_mod) = bot_settings.get("auto_mod") else {
        return false;
    };
    if !parse_bool(auto_mod.get("enabled"), false) {
        return false;
    }
    let anti_raid = auto_mod.get("anti_raid").unwrap_or(&Value::Null);
    if !parse_bool(anti_raid.get("enabled"), false) {
        return false;
    }

    let user_id = event_data
        .get("user_id")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<i64>().ok())
        .or_else(|| {
            event_data
                .get("user")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .and_then(|v| v.parse::<i64>().ok())
        });
    let Some(user_id) = user_id else {
        return false;
    };

    let now_ms = Utc::now().timestamp_millis();
    let join_window_seconds = parse_i64(anti_raid.get("join_window_seconds"), 30).clamp(5, 600);
    let join_threshold = parse_i64(anti_raid.get("join_threshold"), 10).clamp(2, 500) as usize;
    let lockdown_minutes = parse_i64(anti_raid.get("lockdown_minutes"), 10).clamp(1, 240);
    let min_account_age_minutes = parse_i64(anti_raid.get("min_account_age_minutes"), 0).max(0);
    let auto_action = anti_raid
        .get("auto_action")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_ascii_lowercase();

    let join_window = runtime.recent_joins.entry(guild_id).or_default();
    let cutoff = now_ms - (join_window_seconds * 1_000);
    while join_window.front().is_some_and(|entry| *entry < cutoff) {
        join_window.pop_front();
    }
    join_window.push_back(now_ms);

    if join_window.len() >= join_threshold {
        let locked_until = now_ms + lockdown_minutes * 60 * 1_000;
        update_guild_bot_settings(state, guild_id, |settings| {
            if !settings.is_object() {
                *settings = json!({});
            }
            let root = settings.as_object_mut().expect("object checked above");
            let auto_mod = root
                .entry("auto_mod".to_string())
                .or_insert_with(|| json!({}));
            if !auto_mod.is_object() {
                *auto_mod = json!({});
            }
            let auto_mod_obj = auto_mod.as_object_mut().expect("object enforced above");
            let anti_raid = auto_mod_obj
                .entry("anti_raid".to_string())
                .or_insert_with(|| json!({}));
            if !anti_raid.is_object() {
                *anti_raid = json!({});
            }
            anti_raid
                .as_object_mut()
                .expect("object enforced above")
                .insert("lockdown_until_ms".to_string(), json!(locked_until));
        })
        .await;

        emit_mod_log(
            state,
            guild_id,
            bot_settings,
            &format!(
                "**Raid Protection Triggered**\nJoin threshold exceeded ({} joins within {}s). Lockdown active for {} minute(s).",
                join_threshold, join_window_seconds, lockdown_minutes
            ),
        )
        .await;
    }

    if min_account_age_minutes <= 0 || auto_action == "none" {
        return false;
    }
    let Ok(Some(user)) = paracord_db::users::get_user_by_id(&state.db, user_id).await else {
        return false;
    };
    let account_age_minutes = (Utc::now() - user.created_at).num_minutes().max(0);
    if account_age_minutes >= min_account_age_minutes {
        return false;
    }

    if auto_action == "ban" {
        let _ = paracord_db::members::remove_member(&state.db, user_id, guild_id).await;
        let _ = paracord_db::bans::create_ban(
            &state.db,
            user_id,
            guild_id,
            Some("auto-raid account age gate"),
            AUTO_MOD_ID,
        )
        .await;
        state.member_index.remove_member(guild_id, user_id);
        state.event_bus.dispatch(
            "GUILD_BAN_ADD",
            json!({
                "guild_id": guild_id.to_string(),
                "user_id": user_id.to_string(),
            }),
            Some(guild_id),
        );
        state.event_bus.dispatch(
            "GUILD_MEMBER_REMOVE",
            json!({
                "guild_id": guild_id.to_string(),
                "user_id": user_id.to_string(),
            }),
            Some(guild_id),
        );
        emit_mod_log(
            state,
            guild_id,
            bot_settings,
            &format!(
                "**Anti-Raid Ban**\nUser {} was banned due to account age gate ({}m < {}m).",
                user_id, account_age_minutes, min_account_age_minutes
            ),
        )
        .await;
        return true;
    }

    if auto_action == "kick" {
        let _ = paracord_db::members::remove_member(&state.db, user_id, guild_id).await;
        state.member_index.remove_member(guild_id, user_id);
        state.event_bus.dispatch(
            "GUILD_MEMBER_REMOVE",
            json!({
                "guild_id": guild_id.to_string(),
                "user_id": user_id.to_string(),
            }),
            Some(guild_id),
        );
        emit_mod_log(
            state,
            guild_id,
            bot_settings,
            &format!(
                "**Anti-Raid Kick**\nUser {} was removed due to account age gate ({}m < {}m).",
                user_id, account_age_minutes, min_account_age_minutes
            ),
        )
        .await;
        return true;
    }

    false
}

async fn match_rule(
    state: &AppState,
    runtime: &mut BotRuntime,
    guild_id: i64,
    ctx: &MessageContext,
    rule: &Value,
) -> bool {
    let rule_type = rule
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("keyword")
        .to_ascii_lowercase();
    let content_lower = ctx.content.to_ascii_lowercase();

    match rule_type.as_str() {
        "keyword" => {
            let keywords = if let Some(values) = rule.get("keywords").and_then(|v| v.as_array()) {
                values
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(|v| v.trim().to_ascii_lowercase())
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
            } else {
                rule.get("keywords")
                    .or_else(|| rule.get("banned_words"))
                    .or_else(|| rule.get("value"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .split(',')
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            };
            keywords.iter().any(|kw| content_lower.contains(kw))
        }
        "regex" => {
            let pattern = rule
                .get("pattern")
                .or_else(|| rule.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if pattern.is_empty() {
                return false;
            }
            RegexBuilder::new(pattern)
                .size_limit(10 * 1024)
                .build()
                .map(|regex| regex.is_match(&ctx.content))
                .unwrap_or(false)
        }
        "link_allowlist" => {
            let domains = extract_domains(&ctx.content);
            if domains.is_empty() {
                return false;
            }
            let allowlist: Vec<String> =
                if let Some(arr) = rule.get("allowed_domains").and_then(|v| v.as_array()) {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .map(|v| v.trim().to_ascii_lowercase())
                        .filter(|v| !v.is_empty())
                        .collect()
                } else {
                    rule.get("allowed_domains")
                        .or_else(|| rule.get("value"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .split(',')
                        .map(|v| v.trim().to_ascii_lowercase())
                        .filter(|v| !v.is_empty())
                        .collect()
                };
            if allowlist.is_empty() {
                return false;
            }
            domains.iter().any(|domain| {
                !allowlist
                    .iter()
                    .any(|allowed| domain == allowed || domain.ends_with(&format!(".{allowed}")))
            })
        }
        "link_blocklist" => {
            let domains = extract_domains(&ctx.content);
            if domains.is_empty() {
                return false;
            }
            let blocklist: Vec<String> =
                if let Some(arr) = rule.get("blocked_domains").and_then(|v| v.as_array()) {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .map(|v| v.trim().to_ascii_lowercase())
                        .filter(|v| !v.is_empty())
                        .collect()
                } else {
                    rule.get("blocked_domains")
                        .or_else(|| rule.get("value"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .split(',')
                        .map(|v| v.trim().to_ascii_lowercase())
                        .filter(|v| !v.is_empty())
                        .collect()
                };
            if blocklist.is_empty() {
                return false;
            }
            domains.iter().any(|domain| {
                blocklist
                    .iter()
                    .any(|blocked| domain == blocked || domain.ends_with(&format!(".{blocked}")))
            })
        }
        "spam_duplicate" | "spam" => {
            let mut duplicate_window_seconds =
                parse_i64(rule.get("duplicate_window_seconds"), 20).clamp(2, 600);
            let mut duplicate_count =
                parse_i64(rule.get("duplicate_count"), 4).clamp(2, 20) as usize;
            if let Some(raw) = rule.get("value").and_then(|v| v.as_str()) {
                let parts: Vec<&str> = raw.split(['/', ',', ':']).collect();
                if parts.len() >= 2 {
                    if let Ok(parsed_count) = parts[0].trim().parse::<i64>() {
                        duplicate_count = parsed_count.clamp(2, 20) as usize;
                    }
                    if let Ok(parsed_window) = parts[1].trim().parse::<i64>() {
                        duplicate_window_seconds = parsed_window.clamp(2, 600);
                    }
                }
            }

            let now_ms = Utc::now().timestamp_millis();
            let window = runtime
                .recent_messages
                .entry((guild_id, ctx.author_id))
                .or_default();
            let cutoff = now_ms - (duplicate_window_seconds * 1_000);
            while window.front().is_some_and(|(ts, _)| *ts < cutoff) {
                window.pop_front();
            }
            window.push_back((now_ms, content_lower.clone()));

            window
                .iter()
                .filter(|(_, previous)| previous == &content_lower)
                .count()
                >= duplicate_count
        }
        "mention_spam" => {
            let max_mentions = parse_i64(rule.get("max_mentions").or_else(|| rule.get("value")), 8)
                .clamp(1, 100) as usize;
            mention_count(&ctx.content) >= max_mentions
        }
        "account_age_gate" => {
            let min_age_minutes = parse_i64(
                rule.get("min_account_age_minutes")
                    .or_else(|| rule.get("value")),
                0,
            )
            .max(0);
            if min_age_minutes <= 0 {
                return false;
            }
            let Ok(Some(user)) = paracord_db::users::get_user_by_id(&state.db, ctx.author_id).await
            else {
                return false;
            };
            let age_minutes = (Utc::now() - user.created_at).num_minutes().max(0);
            age_minutes < min_age_minutes
        }
        _ => false,
    }
}

async fn apply_rule_actions(
    state: &AppState,
    guild_id: i64,
    bot_settings: &Value,
    ctx: &MessageContext,
    rule_name: &str,
    rule: &Value,
) {
    let actions = rule.get("actions").unwrap_or(&Value::Null);
    let delete_message = parse_bool(actions.get("delete"), true);
    let warn_channel = parse_bool(actions.get("warn"), true);
    let quarantine = parse_bool(actions.get("quarantine"), false);
    let ban_user = parse_bool(actions.get("ban"), false);
    let mute_minutes = parse_i64(actions.get("mute_minutes"), 0).clamp(0, 60 * 24 * 7);
    let quarantine_channel = parse_channel_id(actions.get("quarantine_channel_id").or_else(|| {
        bot_settings
            .get("auto_mod")
            .and_then(|v| v.get("quarantine_channel_id"))
    }));

    let mut quarantine_message_id = None;
    if quarantine {
        if let Some(quarantine_channel_id) = quarantine_channel {
            let quarantine_content = format!(
                "**AutoMod Quarantine**\nRule: {}\nUser: {}\nSource Channel: {}\nMessage: {}",
                rule_name, ctx.author_id, ctx.channel_id, ctx.content
            );
            quarantine_message_id = emit_bot_message(
                state,
                guild_id,
                quarantine_channel_id,
                AUTO_MOD_ID,
                "Auto-Moderator",
                &quarantine_content,
            )
            .await;
        }
        create_automod_quarantine_report(
            state,
            guild_id,
            ctx,
            rule_name,
            quarantine_channel,
            quarantine_message_id,
        )
        .await;
    }

    if delete_message {
        if paracord_db::messages::delete_message(&state.db, ctx.message_id)
            .await
            .is_ok()
        {
            state.event_bus.dispatch(
                "MESSAGE_DELETE",
                json!({
                    "id": ctx.message_id_raw,
                    "channel_id": ctx.channel_id_raw,
                }),
                Some(guild_id),
            );
        }
    }

    if warn_channel {
        let warning = format!(
            "A message from <@{}> was removed by AutoMod rule **{}**.",
            ctx.author_id, rule_name
        );
        emit_bot_message(
            state,
            guild_id,
            ctx.channel_id,
            AUTO_MOD_ID,
            "Auto-Moderator",
            &warning,
        )
        .await;
    }

    if mute_minutes > 0 {
        let timeout_until = Utc::now() + Duration::minutes(mute_minutes);
        let _ = paracord_db::members::set_member_timeout(
            &state.db,
            ctx.author_id,
            guild_id,
            Some(timeout_until),
        )
        .await;
        state.event_bus.dispatch(
            "GUILD_MEMBER_UPDATE",
            json!({
                "guild_id": guild_id.to_string(),
                "user_id": ctx.author_id.to_string(),
                "communication_disabled_until": timeout_until.to_rfc3339(),
            }),
            Some(guild_id),
        );
    }

    if ban_user {
        let _ = paracord_db::members::remove_member(&state.db, ctx.author_id, guild_id).await;
        let _ = paracord_db::bans::create_ban(
            &state.db,
            ctx.author_id,
            guild_id,
            Some("automod rule violation"),
            AUTO_MOD_ID,
        )
        .await;
        state.member_index.remove_member(guild_id, ctx.author_id);
        state.event_bus.dispatch(
            "GUILD_BAN_ADD",
            json!({
                "guild_id": guild_id.to_string(),
                "user_id": ctx.author_id.to_string(),
            }),
            Some(guild_id),
        );
        state.event_bus.dispatch(
            "GUILD_MEMBER_REMOVE",
            json!({
                "guild_id": guild_id.to_string(),
                "user_id": ctx.author_id.to_string(),
            }),
            Some(guild_id),
        );
    }

    append_trigger_log(
        state,
        guild_id,
        rule_name,
        ctx.author_id,
        ctx.channel_id,
        ctx.message_id,
        &ctx.content,
    )
    .await;

    emit_mod_log(
        state,
        guild_id,
        bot_settings,
        &format!(
            "**AutoMod Triggered**\nRule: {}\nUser: {}\nChannel: {}\nMessage ID: {}",
            rule_name, ctx.author_id, ctx.channel_id, ctx.message_id
        ),
    )
    .await;
}

fn normalized_rules(auto_mod: &Value) -> Vec<Value> {
    let mut rules = auto_mod
        .get("rules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if !rules.is_empty() {
        return rules;
    }

    let banned_words = auto_mod
        .get("banned_words")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if !banned_words.is_empty() {
        rules.push(json!({
            "id": "legacy-keyword-filter",
            "name": "Restricted Words",
            "type": "keyword",
            "enabled": true,
            "keywords": banned_words,
            "actions": {
                "delete": true,
                "warn": true
            }
        }));
    }

    rules
}

async fn handle_auto_mod(
    state: &AppState,
    runtime: &mut BotRuntime,
    guild_id: i64,
    bot_settings: &Value,
    event_data: &Value,
) {
    let Some(auto_mod) = bot_settings.get("auto_mod") else {
        return;
    };
    if !parse_bool(auto_mod.get("enabled"), false) {
        return;
    }

    let Some(ctx) = parse_message_context(event_data) else {
        return;
    };
    if ctx.author_id == WELCOME_BOT_ID || ctx.author_id == AUTO_MOD_ID {
        return;
    }
    if ctx.content.trim().is_empty() {
        return;
    }

    let rules = normalized_rules(auto_mod);
    for rule in &rules {
        if !parse_bool(rule.get("enabled"), true) {
            continue;
        }
        let matched = match_rule(state, runtime, guild_id, &ctx, rule).await;
        if !matched {
            continue;
        }
        let rule_name = rule
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unnamed Rule");
        apply_rule_actions(state, guild_id, bot_settings, &ctx, rule_name, rule).await;
        break;
    }
}
