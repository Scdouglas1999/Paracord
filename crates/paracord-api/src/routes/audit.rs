use paracord_core::AppState;
use serde_json::Value;

pub const ACTION_GUILD_UPDATE: i16 = 1;
pub const ACTION_CHANNEL_CREATE: i16 = 10;
pub const ACTION_CHANNEL_UPDATE: i16 = 11;
pub const ACTION_CHANNEL_DELETE: i16 = 12;
pub const ACTION_MEMBER_UPDATE: i16 = 20;
pub const ACTION_MEMBER_KICK: i16 = 21;
pub const ACTION_MEMBER_BAN_ADD: i16 = 22;
pub const ACTION_MEMBER_BAN_REMOVE: i16 = 23;
pub const ACTION_ROLE_CREATE: i16 = 30;
pub const ACTION_ROLE_UPDATE: i16 = 31;
pub const ACTION_ROLE_DELETE: i16 = 32;
pub const ACTION_INVITE_CREATE: i16 = 40;
pub const ACTION_INVITE_DELETE: i16 = 41;
pub const ACTION_WEBHOOK_CREATE: i16 = 50;
pub const ACTION_WEBHOOK_UPDATE: i16 = 51;
pub const ACTION_WEBHOOK_DELETE: i16 = 52;
pub const ACTION_EMOJI_CREATE: i16 = 60;
pub const ACTION_EMOJI_UPDATE: i16 = 61;
pub const ACTION_EMOJI_DELETE: i16 = 62;
pub const ACTION_MESSAGE_EDIT: i16 = 71;
pub const ACTION_MESSAGE_DELETE: i16 = 72;
pub const ACTION_MESSAGE_BULK_DELETE: i16 = 73;
pub const ACTION_BOT_ADD: i16 = 80;
pub const ACTION_BOT_REMOVE: i16 = 81;
pub const ACTION_REPORT_CREATE: i16 = 90;
pub const ACTION_REPORT_RESOLVE: i16 = 91;
pub const ACTION_AUTOMOD_RULE_CREATE: i16 = 100;
pub const ACTION_AUTOMOD_RULE_UPDATE: i16 = 101;
pub const ACTION_AUTOMOD_RULE_DELETE: i16 = 102;
/// Recorded when AutoMod itself acts on a message (actor is the offending user).
pub const ACTION_AUTOMOD_ACTION: i16 = 103;

pub async fn log_action(
    state: &AppState,
    guild_id: i64,
    actor_id: i64,
    action_type: i16,
    target_id: Option<i64>,
    reason: Option<&str>,
    changes: Option<Value>,
) {
    let log_id = paracord_util::snowflake::generate(1);
    let change_ref = changes.as_ref();
    if let Err(err) = paracord_db::audit_log::create_entry(
        &state.db,
        log_id,
        guild_id,
        actor_id,
        action_type,
        target_id,
        reason,
        change_ref,
    )
    .await
    {
        tracing::warn!("failed to write audit entry: {}", err);
    }
}
