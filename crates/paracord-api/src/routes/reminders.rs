use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Duration, Utc};
use paracord_core::{AppState, MESSAGE_FLAG_DM_E2EE};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::channels::{ensure_channel_permissions, messages_to_json};

#[derive(Deserialize)]
pub struct PutReminderRequest {
    pub remind_at: String,
}

const PREVIEW_CHARS: usize = 200;

/// Most reminders one person can have waiting at once. The Inbox lists this
/// many, so a waiting reminder is never hidden behind the rest.
pub const MAX_PENDING_REMINDERS: i64 = 100;

pub async fn list_my_reminders(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = paracord_db::reminders::list_reminders_for_user(&state.db, auth.user_id, 100)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut visible = Vec::new();
    for row in rows {
        match load_visible_reminder(&state, auth.user_id, &row).await? {
            Some(pair) => visible.push((row, pair.0, pair.1)),
            None => {
                paracord_db::reminders::delete_reminder_by_id(&state.db, row.id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            }
        }
    }

    let messages: Vec<_> = visible
        .iter()
        .map(|(_, message, _)| message.clone())
        .collect();
    let message_json = messages_to_json(&state, &messages, auth.user_id).await;
    let items: Vec<Value> = visible
        .into_iter()
        .zip(message_json)
        .map(|((reminder, message, channel), message_json)| {
            reminder_item(
                &reminder,
                &message,
                &channel,
                message_json,
                reminder.fired_at,
            )
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

pub async fn put_reminder(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
    Json(body): Json<PutReminderRequest>,
) -> Result<Json<Value>, ApiError> {
    let remind_at = DateTime::parse_from_rfc3339(&body.remind_at)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| ApiError::BadRequest("remind_at must be an RFC3339 timestamp.".into()))?;
    let now = Utc::now();
    if remind_at <= now {
        return Err(ApiError::BadRequest("Choose a time in the future.".into()));
    }
    if remind_at > now + Duration::days(366) {
        return Err(ApiError::BadRequest(
            "Reminders can be set up to a year from now.".into(),
        ));
    }

    let (message, channel) =
        require_readable_message(&state, auth.user_id, channel_id, message_id).await?;
    let waiting =
        paracord_db::reminders::count_pending_reminders_except(&state.db, auth.user_id, message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if waiting >= MAX_PENDING_REMINDERS {
        return Err(ApiError::BadRequest(format!(
            "You already have {MAX_PENDING_REMINDERS} reminders waiting. Cancel one in the Inbox before setting another."
        )));
    }
    let id = paracord_util::snowflake::generate(1);
    let reminder = paracord_db::reminders::upsert_reminder(
        &state.db,
        id,
        auth.user_id,
        channel_id,
        message_id,
        remind_at,
        now,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let message_json = one_message_json(&state, &message, auth.user_id).await?;
    let item = reminder_item(
        &reminder,
        &message,
        &channel,
        message_json,
        reminder.fired_at,
    );
    Ok(Json(item))
}

pub async fn delete_reminder(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((_channel_id, message_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_db::reminders::delete_reminder(&state.db, auth.user_id, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Claim every reminder whose time has arrived and tell that person.
///
/// Callers (the 15s worker, and tests) pass the clock. A reminder whose
/// channel the person can no longer read is deleted and does not fire.
pub async fn fire_due_reminders(state: &AppState, now: DateTime<Utc>) -> Result<usize, ApiError> {
    let due = paracord_db::reminders::list_due_reminders(&state.db, now, 100)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let mut fired = 0usize;
    for reminder in due {
        let loaded = load_visible_reminder(state, reminder.user_id, &reminder).await?;
        let Some((message, channel)) = loaded else {
            paracord_db::reminders::delete_reminder_by_id(&state.db, reminder.id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            continue;
        };
        let claimed = paracord_db::reminders::mark_reminder_fired(&state.db, reminder.id, now)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !claimed {
            continue;
        }
        let message_json = one_message_json(state, &message, reminder.user_id).await?;
        let payload = reminder_item(&reminder, &message, &channel, message_json, Some(now));
        state
            .event_bus
            .dispatch_to_users("REMINDER_FIRED", payload, vec![reminder.user_id]);
        fired += 1;
    }
    Ok(fired)
}

async fn require_readable_message(
    state: &AppState,
    user_id: i64,
    channel_id: i64,
    message_id: i64,
) -> Result<
    (
        paracord_db::messages::MessageRow,
        paracord_db::channels::ChannelRow,
    ),
    ApiError,
> {
    // Access first, so a message id in a channel the person cannot read
    // answers the same way whether or not it exists.
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        state,
        &channel,
        user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;
    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if message.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }
    Ok((message, channel))
}

/// `None` when the message, the channel, or the person's access is gone.
async fn load_visible_reminder(
    state: &AppState,
    user_id: i64,
    reminder: &paracord_db::reminders::ReminderRow,
) -> Result<
    Option<(
        paracord_db::messages::MessageRow,
        paracord_db::channels::ChannelRow,
    )>,
    ApiError,
> {
    let message = paracord_db::messages::get_message(&state.db, reminder.message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let Some(message) = message else {
        return Ok(None);
    };
    if message.channel_id != reminder.channel_id {
        return Ok(None);
    }
    let channel = paracord_db::channels::get_channel(&state.db, reminder.channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let Some(channel) = channel else {
        return Ok(None);
    };
    match ensure_channel_permissions(
        state,
        &channel,
        user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await
    {
        Ok(()) => Ok(Some((message, channel))),
        Err(ApiError::Forbidden) | Err(ApiError::NotFound) => Ok(None),
        Err(other) => Err(other),
    }
}

fn reminder_item(
    reminder: &paracord_db::reminders::ReminderRow,
    message: &paracord_db::messages::MessageRow,
    channel: &paracord_db::channels::ChannelRow,
    message_json: Value,
    fired_at: Option<DateTime<Utc>>,
) -> Value {
    json!({
        "id": reminder.id.to_string(),
        "remind_at": reminder.remind_at.to_rfc3339(),
        "created_at": reminder.created_at.to_rfc3339(),
        "fired_at": fired_at.map(|value| value.to_rfc3339()),
        "channel": {
            "id": channel.id.to_string(),
            "name": channel.name,
            "guild_id": channel.guild_id().map(|id| id.to_string()),
        },
        "message": message_json,
        "preview": message_preview(message),
    })
}

async fn one_message_json(
    state: &AppState,
    message: &paracord_db::messages::MessageRow,
    viewer_id: i64,
) -> Result<Value, ApiError> {
    messages_to_json(state, std::slice::from_ref(message), viewer_id)
        .await
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("reminder message did not serialize")))
}

fn message_preview(message: &paracord_db::messages::MessageRow) -> Option<String> {
    if message.flags & MESSAGE_FLAG_DM_E2EE != 0 {
        return None;
    }
    let own = message.content.as_deref().unwrap_or("");
    // A forward with no note of its own previews as the text it quotes.
    let quoted = message
        .forwarded_from
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let content = if own.trim().is_empty() {
        quoted.as_deref().unwrap_or("")
    } else {
        own
    };
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(line.chars().take(PREVIEW_CHARS).collect())
}
