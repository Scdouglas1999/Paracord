use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Presence {
    pub user_id: i64,
    pub guild_id: Option<i64>,
    pub status: String,
    pub activities: Vec<Activity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub name: String,
    pub activity_type: i32,
    pub details: Option<String>,
    pub state: Option<String>,
}

/// The activity kinds a presence may carry, as sent on the wire in `type`.
///
/// The numbering is Discord's, which is what bots and the 3.x clients already
/// send: 0 playing (the desktop app's foreground detection), 2 listening (the
/// desktop app's now-playing reader) and 3 watching (a watch-together session).
pub mod activity_type {
    pub const PLAYING: i64 = 0;
    pub const STREAMING: i64 = 1;
    pub const LISTENING: i64 = 2;
    pub const WATCHING: i64 = 3;
    pub const CUSTOM: i64 = 4;
    pub const COMPETING: i64 = 5;

    /// Whether `value` is a kind a client can render. Anything else is dropped.
    pub fn is_known(value: i64) -> bool {
        (PLAYING..=COMPETING).contains(&value)
    }
}

/// Maximum activity entries retained from one presence update.
pub const MAX_ACTIVITY_ITEMS: usize = 8;
/// Maximum characters retained for any single presence text field.
pub const MAX_ACTIVITY_TEXT_LEN: usize = 256;
/// Timestamps are RFC 3339 strings; nothing legitimate is longer than this.
const MAX_ACTIVITY_TIMESTAMP_LEN: usize = 64;

/// Truncate `value` to at most `max` characters (not bytes).
pub fn truncate_presence_text(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// An RFC 3339 timestamp a client supplied, kept verbatim alongside its parsed
/// value, or `None` when it is not one.
fn activity_timestamp(
    raw: Option<&Value>,
) -> Option<(&str, chrono::DateTime<chrono::FixedOffset>)> {
    let text = raw?.as_str()?;
    if text.len() > MAX_ACTIVITY_TIMESTAMP_LEN {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|parsed| (text, parsed))
}

/// Normalize the `activities` of a caller-supplied presence update.
///
/// Both the WebSocket gateway and the HTTP command bus store the result in the
/// same process-global presence map, fan it out to every co-member and friend
/// and re-serve it in every READY, so the rules live here once:
///
/// * at most [`MAX_ACTIVITY_ITEMS`] entries; non-objects are skipped;
/// * `type` (or the legacy `activity_type`) must be a known kind
///   ([`activity_type::is_known`]); an entry of any other kind is dropped
///   rather than guessed at;
/// * every text field is truncated to [`MAX_ACTIVITY_TEXT_LEN`] characters;
/// * `started_at` / `ends_at` must be RFC 3339 timestamps, and `ends_at` must
///   come after `started_at`; an invalid one is dropped (the activity stays).
///
/// The output always carries the same keys, so a 3.2 client that reads
/// `name`/`type`/`details`/`state`/`started_at`/`application_id` sees exactly
/// what it did before. `ends_at` is new and optional.
pub fn normalize_activities(raw: Option<&Value>) -> Vec<Value> {
    let mut activities = Vec::new();
    let Some(Value::Array(list)) = raw else {
        return activities;
    };

    for entry in list.iter().take(MAX_ACTIVITY_ITEMS) {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let kind = obj
            .get("type")
            .or_else(|| obj.get("activity_type"))
            .and_then(|v| v.as_i64())
            .unwrap_or(activity_type::PLAYING);
        if !activity_type::is_known(kind) {
            continue;
        }
        let text_field = |key: &str| {
            obj.get(key)
                .and_then(|v| v.as_str())
                .map(|s| truncate_presence_text(s, MAX_ACTIVITY_TEXT_LEN))
        };
        let name = text_field("name").unwrap_or_else(|| "Unknown".to_string());
        let started = activity_timestamp(obj.get("started_at"));
        let ends = activity_timestamp(obj.get("ends_at"))
            .filter(|(_, ends)| started.map(|(_, started)| *ends > started).unwrap_or(true));

        activities.push(json!({
            "name": name,
            "type": kind,
            "details": text_field("details"),
            "state": text_field("state"),
            "started_at": started.map(|(text, _)| text),
            "ends_at": ends.map(|(text, _)| text),
            "application_id": text_field("application_id"),
        }));
    }

    activities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listening_activity_round_trips_with_its_timeline() {
        let raw = json!([{
            "name": "Spotify",
            "type": 2,
            "details": "Windowlicker",
            "state": "Aphex Twin",
            "started_at": "2026-09-24T10:00:00.000Z",
            "ends_at": "2026-09-24T10:06:07.000Z",
        }]);
        let out = normalize_activities(Some(&raw));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], 2);
        assert_eq!(out[0]["name"], "Spotify");
        assert_eq!(out[0]["details"], "Windowlicker");
        assert_eq!(out[0]["state"], "Aphex Twin");
        assert_eq!(out[0]["started_at"], "2026-09-24T10:00:00.000Z");
        assert_eq!(out[0]["ends_at"], "2026-09-24T10:06:07.000Z");
    }

    #[test]
    fn legacy_activity_type_key_is_accepted() {
        let raw = json!([{ "name": "Paracord", "activity_type": 3, "details": "Watching a film" }]);
        let out = normalize_activities(Some(&raw));
        assert_eq!(out[0]["type"], 3);
    }

    #[test]
    fn unknown_kinds_are_dropped_not_clamped() {
        let raw = json!([
            { "name": "a", "type": 9 },
            { "name": "b", "type": -1 },
            { "name": "c", "type": 2 },
        ]);
        let out = normalize_activities(Some(&raw));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["name"], "c");
    }

    #[test]
    fn text_is_capped_and_list_is_bounded() {
        let long = "x".repeat(1000);
        let raw = Value::Array(
            (0..20)
                .map(|_| json!({ "name": long, "type": 2, "details": long, "state": long }))
                .collect(),
        );
        let out = normalize_activities(Some(&raw));
        assert_eq!(out.len(), MAX_ACTIVITY_ITEMS);
        for key in ["name", "details", "state"] {
            assert_eq!(
                out[0][key].as_str().unwrap().chars().count(),
                MAX_ACTIVITY_TEXT_LEN
            );
        }
    }

    #[test]
    fn invalid_timestamps_are_dropped_but_the_activity_stays() {
        let raw = json!([
            { "name": "a", "type": 2, "started_at": "yesterday", "ends_at": "2026-09-24T10:00:00Z" },
            { "name": "b", "type": 2, "started_at": "2026-09-24T10:00:00Z", "ends_at": "2026-09-24T09:00:00Z" },
        ]);
        let out = normalize_activities(Some(&raw));
        assert_eq!(out.len(), 2);
        assert!(out[0]["started_at"].is_null());
        assert_eq!(out[0]["ends_at"], "2026-09-24T10:00:00Z");
        assert_eq!(out[1]["started_at"], "2026-09-24T10:00:00Z");
        assert!(
            out[1]["ends_at"].is_null(),
            "an end before the start is not a timeline"
        );
    }

    #[test]
    fn missing_or_malformed_list_is_empty() {
        assert!(normalize_activities(None).is_empty());
        assert!(normalize_activities(Some(&json!({ "name": "x" }))).is_empty());
        assert!(normalize_activities(Some(&json!(["x", 3]))).is_empty());
    }
}
