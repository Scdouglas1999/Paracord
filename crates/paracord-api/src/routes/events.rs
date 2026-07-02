use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::{DateTime, Utc};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_EVENT_NAME_LEN: usize = 100;
const MAX_EVENT_DESCRIPTION_LEN: usize = 1000;
const MAX_EVENT_LOCATION_LEN: usize = 200;

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

fn event_to_json(
    e: &paracord_db::scheduled_events::ScheduledEventRow,
    rsvp_count: i64,
    user_rsvp: bool,
) -> Value {
    json!({
        "id": e.id.to_string(),
        "guild_id": e.guild_id.to_string(),
        "channel_id": e.channel_id.map(|id| id.to_string()),
        "creator_id": e.creator_id.to_string(),
        "name": e.name,
        "description": e.description,
        "scheduled_start": e.scheduled_start,
        "scheduled_end": e.scheduled_end,
        "status": e.status,
        "entity_type": e.entity_type,
        "location": e.location,
        "image_url": e.image_url,
        "recurrence_rule": e.recurrence_rule,
        "reminder_minutes": e.reminder_minutes,
        "event_channel_id": e.event_channel_id.map(|id| id.to_string()),
        "event_channel_created": e.event_channel_created,
        "reminder_sent_at": e.reminder_sent_at.map(|v| v.to_rfc3339()),
        "user_count": rsvp_count,
        "user_rsvp": user_rsvp,
        "created_at": e.created_at.to_rfc3339(),
    })
}

#[derive(Deserialize)]
pub struct CreateEventRequest {
    pub name: String,
    pub description: Option<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    #[serde(default = "default_entity_type")]
    pub entity_type: i32,
    pub channel_id: Option<String>,
    pub location: Option<String>,
    pub image_url: Option<String>,
    pub recurrence_rule: Option<String>,
    pub reminder_minutes: Option<i32>,
    pub event_channel_id: Option<String>,
}

fn default_entity_type() -> i32 {
    1
}

fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
pub struct UpdateEventRequest {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub description: Option<Option<String>>,
    pub scheduled_start: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub scheduled_end: Option<Option<String>>,
    pub status: Option<i32>,
    pub entity_type: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub channel_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub location: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub image_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub recurrence_rule: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub reminder_minutes: Option<Option<i32>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub event_channel_id: Option<Option<String>>,
}

fn parse_optional_id(raw: Option<&str>, field: &str) -> Result<Option<i64>, ApiError> {
    raw.map(|value| {
        value
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest(format!("Invalid {field}")))
    })
    .transpose()
}

fn parse_optional_id_patch(
    raw: &Option<Option<String>>,
    field: &str,
) -> Result<Option<Option<i64>>, ApiError> {
    match raw {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(value)) if value.trim().is_empty() => Ok(Some(None)),
        Some(Some(value)) => value
            .parse::<i64>()
            .map(Some)
            .map(Some)
            .map_err(|_| ApiError::BadRequest(format!("Invalid {field}"))),
    }
}

fn normalize_optional_text_patch(
    raw: &Option<Option<String>>,
    max_len: usize,
    field: &str,
) -> Result<Option<Option<String>>, ApiError> {
    match raw {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(Some(None));
            }
            if trimmed.len() > max_len {
                return Err(ApiError::BadRequest(format!("{field} too long")));
            }
            if contains_dangerous_markup(trimmed) {
                return Err(ApiError::BadRequest(format!(
                    "{field} contains unsafe markup"
                )));
            }
            Ok(Some(Some(trimmed.to_string())))
        }
    }
}

fn normalize_optional_datetime_patch(raw: &Option<Option<String>>) -> Option<Option<String>> {
    raw.as_ref().map(|value| {
        value.as_ref().and_then(|inner| {
            let trimmed = inner.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
    })
}

fn normalize_recurrence_rule(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let normalized = trimmed.to_ascii_lowercase();
    if !matches!(normalized.as_str(), "daily" | "weekly" | "monthly") {
        return Err(ApiError::BadRequest(
            "recurrence_rule must be one of: daily, weekly, monthly".into(),
        ));
    }
    Ok(Some(normalized))
}

fn validate_reminder_minutes(reminder_minutes: Option<i32>) -> Result<Option<i32>, ApiError> {
    if let Some(minutes) = reminder_minutes {
        if !(1..=43_200).contains(&minutes) {
            return Err(ApiError::BadRequest(
                "reminder_minutes must be between 1 and 43200".into(),
            ));
        }
    }
    Ok(reminder_minutes)
}

fn normalize_recurrence_rule_patch(
    raw: &Option<Option<String>>,
) -> Result<Option<Option<String>>, ApiError> {
    match raw {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(value)) => Ok(Some(normalize_recurrence_rule(Some(value.as_str()))?)),
    }
}

fn validate_reminder_minutes_patch(
    reminder_minutes: Option<Option<i32>>,
) -> Result<Option<Option<i32>>, ApiError> {
    match reminder_minutes {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(minutes)) => Ok(Some(validate_reminder_minutes(Some(minutes))?)),
    }
}

fn parse_event_datetime(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn to_ical_datetime(raw: &str) -> Option<String> {
    parse_event_datetime(raw).map(|dt| dt.format("%Y%m%dT%H%M%SZ").to_string())
}

fn escape_ical_text(raw: &str) -> String {
    raw.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

fn recurrence_to_ical_rrule(rule: Option<&str>) -> Option<&'static str> {
    match rule.map(|v| v.trim().to_ascii_lowercase()) {
        Some(ref value) if value == "daily" => Some("FREQ=DAILY"),
        Some(ref value) if value == "weekly" => Some("FREQ=WEEKLY"),
        Some(ref value) if value == "monthly" => Some("FREQ=MONTHLY"),
        _ => None,
    }
}

fn event_to_ical(e: &paracord_db::scheduled_events::ScheduledEventRow) -> Option<String> {
    let dt_start = to_ical_datetime(&e.scheduled_start)?;
    let dt_end = e.scheduled_end.as_deref().and_then(to_ical_datetime);
    let dt_stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();

    let mut lines = vec![
        "BEGIN:VEVENT".to_string(),
        format!("UID:{}@paracord", e.id),
        format!("DTSTAMP:{dt_stamp}"),
        format!("DTSTART:{dt_start}"),
        format!("SUMMARY:{}", escape_ical_text(&e.name)),
    ];

    if let Some(dt_end) = dt_end {
        lines.push(format!("DTEND:{dt_end}"));
    }
    if let Some(desc) = e.description.as_deref().filter(|v| !v.trim().is_empty()) {
        lines.push(format!("DESCRIPTION:{}", escape_ical_text(desc)));
    }
    if let Some(location) = e.location.as_deref().filter(|v| !v.trim().is_empty()) {
        lines.push(format!("LOCATION:{}", escape_ical_text(location)));
    }
    if let Some(rrule) = recurrence_to_ical_rrule(e.recurrence_rule.as_deref()) {
        lines.push(format!("RRULE:{rrule}"));
    }
    if let Some(reminder_minutes) = e.reminder_minutes.filter(|v| *v > 0) {
        lines.push("BEGIN:VALARM".to_string());
        lines.push(format!("TRIGGER:-PT{}M", reminder_minutes));
        lines.push("ACTION:DISPLAY".to_string());
        lines.push(format!(
            "DESCRIPTION:{}",
            escape_ical_text(&format!("Reminder: {}", e.name))
        ));
        lines.push("END:VALARM".to_string());
    }
    lines.push("END:VEVENT".to_string());
    Some(lines.join("\r\n"))
}

async fn ensure_manage_events(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms =
        paracord_core::permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    // MANAGE_EVENTS maps to MANAGE_GUILD for now
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;
    Ok(())
}

pub async fn create_event(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateEventRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_manage_events(&state, guild_id, auth.user_id).await?;

    if body.name.trim().is_empty() || body.name.len() > MAX_EVENT_NAME_LEN {
        return Err(ApiError::BadRequest(
            "Event name must be 1-100 characters".into(),
        ));
    }
    if contains_dangerous_markup(&body.name) {
        return Err(ApiError::BadRequest(
            "Event name contains unsafe markup".into(),
        ));
    }
    if let Some(ref desc) = body.description {
        if desc.len() > MAX_EVENT_DESCRIPTION_LEN {
            return Err(ApiError::BadRequest("Description too long".into()));
        }
        if contains_dangerous_markup(desc) {
            return Err(ApiError::BadRequest(
                "Description contains unsafe markup".into(),
            ));
        }
    }
    if let Some(ref loc) = body.location {
        if loc.len() > MAX_EVENT_LOCATION_LEN {
            return Err(ApiError::BadRequest("Location too long".into()));
        }
        if contains_dangerous_markup(loc) {
            return Err(ApiError::BadRequest(
                "Location contains unsafe markup".into(),
            ));
        }
    }
    if body.entity_type != 1 && body.entity_type != 2 {
        return Err(ApiError::BadRequest("Invalid entity type".into()));
    }

    let channel_id = parse_optional_id(body.channel_id.as_deref(), "channel_id")?;
    let event_channel_id = parse_optional_id(body.event_channel_id.as_deref(), "event_channel_id")?;
    let recurrence_rule = normalize_recurrence_rule(body.recurrence_rule.as_deref())?;
    let reminder_minutes = validate_reminder_minutes(body.reminder_minutes)?;

    let event_id = paracord_util::snowflake::generate(1);
    let event = paracord_db::scheduled_events::create_event(
        &state.db,
        event_id,
        guild_id,
        auth.user_id,
        body.name.trim(),
        body.description.as_deref(),
        &body.scheduled_start,
        body.scheduled_end.as_deref(),
        body.entity_type,
        channel_id,
        body.location.as_deref(),
        body.image_url.as_deref(),
        recurrence_rule.as_deref(),
        reminder_minutes,
        event_channel_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let event_json = event_to_json(&event, 0, false);
    state.event_bus.dispatch(
        "GUILD_SCHEDULED_EVENT_CREATE",
        event_json.clone(),
        Some(guild_id),
    );

    Ok((StatusCode::CREATED, Json(event_json)))
}

pub async fn list_events(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let events = paracord_db::scheduled_events::get_guild_events(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut result = Vec::with_capacity(events.len());
    for event in &events {
        let count = paracord_db::scheduled_events::get_rsvp_count(&state.db, event.id)
            .await
            .unwrap_or(0);
        let user_rsvp = paracord_db::scheduled_events::has_rsvp(&state.db, event.id, auth.user_id)
            .await
            .unwrap_or(false);
        result.push(event_to_json(event, count, user_rsvp));
    }

    Ok(Json(json!(result)))
}

pub async fn get_event(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, event_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let event = paracord_db::scheduled_events::get_event(&state.db, event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if event.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    let count = paracord_db::scheduled_events::get_rsvp_count(&state.db, event_id)
        .await
        .unwrap_or(0);
    let user_rsvp = paracord_db::scheduled_events::has_rsvp(&state.db, event_id, auth.user_id)
        .await
        .unwrap_or(false);

    Ok(Json(event_to_json(&event, count, user_rsvp)))
}

pub async fn update_event(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, event_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateEventRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_events(&state, guild_id, auth.user_id).await?;

    let existing = paracord_db::scheduled_events::get_event(&state.db, event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if existing.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    let name = body.name.as_ref().map(|value| value.trim().to_string());
    if let Some(ref name) = name {
        if name.trim().is_empty() || name.len() > MAX_EVENT_NAME_LEN {
            return Err(ApiError::BadRequest(
                "Event name must be 1-100 characters".into(),
            ));
        }
        if contains_dangerous_markup(name) {
            return Err(ApiError::BadRequest(
                "Event name contains unsafe markup".into(),
            ));
        }
    }
    if let Some(status) = body.status {
        if !(1..=4).contains(&status) {
            return Err(ApiError::BadRequest("Invalid status".into()));
        }
    }
    if let Some(entity_type) = body.entity_type {
        if entity_type != 1 && entity_type != 2 {
            return Err(ApiError::BadRequest("Invalid entity type".into()));
        }
    }

    let description =
        normalize_optional_text_patch(&body.description, MAX_EVENT_DESCRIPTION_LEN, "Description")?;
    let location =
        normalize_optional_text_patch(&body.location, MAX_EVENT_LOCATION_LEN, "Location")?;
    let scheduled_end = normalize_optional_datetime_patch(&body.scheduled_end);
    let channel_id = parse_optional_id_patch(&body.channel_id, "channel_id")?;
    let event_channel_id = parse_optional_id_patch(&body.event_channel_id, "event_channel_id")?;
    let recurrence_rule = normalize_recurrence_rule_patch(&body.recurrence_rule)?;
    let reminder_minutes = validate_reminder_minutes_patch(body.reminder_minutes)?;

    let updated = paracord_db::scheduled_events::update_event(
        &state.db,
        event_id,
        name.as_deref(),
        description.as_ref().map(|value| value.as_deref()),
        body.scheduled_start.as_deref(),
        scheduled_end.as_ref().map(|value| value.as_deref()),
        body.status,
        body.entity_type,
        channel_id,
        location.as_ref().map(|value| value.as_deref()),
        body.image_url.as_ref().map(|value| value.as_deref()),
        recurrence_rule.as_ref().map(|value| value.as_deref()),
        reminder_minutes,
        event_channel_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let count = paracord_db::scheduled_events::get_rsvp_count(&state.db, event_id)
        .await
        .unwrap_or(0);
    let user_rsvp = paracord_db::scheduled_events::has_rsvp(&state.db, event_id, auth.user_id)
        .await
        .unwrap_or(false);
    let event_json = event_to_json(&updated, count, user_rsvp);

    state.event_bus.dispatch(
        "GUILD_SCHEDULED_EVENT_UPDATE",
        event_json.clone(),
        Some(guild_id),
    );

    Ok(Json(event_json))
}

pub async fn delete_event(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, event_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_manage_events(&state, guild_id, auth.user_id).await?;

    let existing = paracord_db::scheduled_events::get_event(&state.db, event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if existing.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::scheduled_events::delete_event(&state.db, event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "GUILD_SCHEDULED_EVENT_DELETE",
        json!({"id": event_id.to_string(), "guild_id": guild_id.to_string()}),
        Some(guild_id),
    );

    Ok(StatusCode::NO_CONTENT)
}

pub async fn export_event_ical(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, event_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let event = paracord_db::scheduled_events::get_event(&state.db, event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if event.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }
    let Some(vevent) = event_to_ical(&event) else {
        return Err(ApiError::BadRequest(
            "event has an invalid scheduled_start value".into(),
        ));
    };
    let body = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Paracord//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n{}\r\nEND:VCALENDAR\r\n",
        vevent
    );
    Ok((
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/calendar; charset=utf-8".to_string(),
        )],
        body,
    ))
}

pub async fn export_guild_ical(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let events = paracord_db::scheduled_events::get_guild_events(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let items = events
        .iter()
        .filter_map(event_to_ical)
        .collect::<Vec<_>>()
        .join("\r\n");
    let body = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Paracord//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n{}\r\nEND:VCALENDAR\r\n",
        items
    );
    Ok((
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/calendar; charset=utf-8".to_string(),
        )],
        body,
    ))
}

pub async fn add_rsvp(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, event_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let event = paracord_db::scheduled_events::get_event(&state.db, event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if event.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::scheduled_events::add_rsvp(&state.db, event_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "GUILD_SCHEDULED_EVENT_USER_ADD",
        json!({
            "guild_scheduled_event_id": event_id.to_string(),
            "user_id": auth.user_id.to_string(),
            "guild_id": guild_id.to_string(),
        }),
        Some(guild_id),
    );

    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_rsvp(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, event_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let event = paracord_db::scheduled_events::get_event(&state.db, event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if event.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::scheduled_events::remove_rsvp(&state.db, event_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "GUILD_SCHEDULED_EVENT_USER_REMOVE",
        json!({
            "guild_scheduled_event_id": event_id.to_string(),
            "user_id": auth.user_id.to_string(),
            "guild_id": guild_id.to_string(),
        }),
        Some(guild_id),
    );

    Ok(StatusCode::NO_CONTENT)
}
