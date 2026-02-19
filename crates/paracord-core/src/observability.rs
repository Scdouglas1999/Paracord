use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const EVENT_TYPE_FALLBACK: &str = "OTHER";
const MAX_EVENT_TYPE_LEN: usize = 64;
const MAX_EVENT_TYPE_KEYS: usize = 128;

static WS_CONNECTIONS_ACTIVE: AtomicU64 = AtomicU64::new(0);
static WS_EVENTS_TOTAL: AtomicU64 = AtomicU64::new(0);
static WS_EVENTS_BY_TYPE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static WIRE_TRACE_ENABLED: OnceLock<bool> = OnceLock::new();
static WIRE_TRACE_PAYLOADS_ENABLED: OnceLock<bool> = OnceLock::new();
static WIRE_TRACE_PAYLOAD_MAX_BYTES: OnceLock<usize> = OnceLock::new();

fn ws_events_by_type() -> &'static Mutex<HashMap<String, u64>> {
    WS_EVENTS_BY_TYPE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_ws_events_by_type() -> std::sync::MutexGuard<'static, HashMap<String, u64>> {
    match ws_events_by_type().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn normalize_event_type(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_EVENT_TYPE_LEN {
        return EVENT_TYPE_FALLBACK.to_string();
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
    {
        return EVENT_TYPE_FALLBACK.to_string();
    }
    trimmed.to_string()
}

fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|raw| match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

pub fn wire_trace_enabled() -> bool {
    *WIRE_TRACE_ENABLED.get_or_init(|| env_bool("PARACORD_WIRE_TRACE", false))
}

pub fn wire_trace_payloads_enabled() -> bool {
    *WIRE_TRACE_PAYLOADS_ENABLED
        .get_or_init(|| env_bool("PARACORD_WIRE_TRACE_PAYLOADS", false))
}

fn wire_trace_payload_max_bytes() -> usize {
    *WIRE_TRACE_PAYLOAD_MAX_BYTES.get_or_init(|| {
        env_usize("PARACORD_WIRE_TRACE_PAYLOAD_MAX_BYTES", 1024).min(16 * 1024)
    })
}

pub fn wire_trace_payload_preview(raw: &str) -> Option<String> {
    if !wire_trace_payloads_enabled() {
        return None;
    }
    let max = wire_trace_payload_max_bytes();
    let bytes = raw.as_bytes();
    let (slice, truncated) = if bytes.len() > max {
        (&bytes[..max], true)
    } else {
        (bytes, false)
    };
    let mut preview = String::from_utf8_lossy(slice).into_owned();
    if truncated {
        preview.push_str("...");
    }
    let escaped: String = preview.chars().flat_map(char::escape_default).collect();
    Some(escaped)
}

pub fn ws_connection_open() {
    WS_CONNECTIONS_ACTIVE.fetch_add(1, Ordering::Relaxed);
}

pub fn ws_connection_close() {
    let _ = WS_CONNECTIONS_ACTIVE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(1))
    });
}

pub fn ws_event_dispatched(event_type: &str) {
    WS_EVENTS_TOTAL.fetch_add(1, Ordering::Relaxed);

    let mut normalized = normalize_event_type(event_type);
    let mut by_type = lock_ws_events_by_type();
    if !by_type.contains_key(&normalized) && by_type.len() >= MAX_EVENT_TYPE_KEYS {
        normalized = EVENT_TYPE_FALLBACK.to_string();
    }
    let entry = by_type.entry(normalized).or_insert(0);
    *entry = entry.saturating_add(1);
}

#[derive(Clone, Debug, Default)]
pub struct WsMetricsSnapshot {
    pub active_connections: u64,
    pub total_events: u64,
    pub events_by_type: Vec<(String, u64)>,
}

pub fn ws_metrics_snapshot() -> WsMetricsSnapshot {
    let active_connections = WS_CONNECTIONS_ACTIVE.load(Ordering::Relaxed);
    let total_events = WS_EVENTS_TOTAL.load(Ordering::Relaxed);
    let mut events_by_type: Vec<(String, u64)> = lock_ws_events_by_type()
        .iter()
        .map(|(event_type, count)| (event_type.clone(), *count))
        .collect();
    events_by_type.sort_by(|a, b| a.0.cmp(&b.0));

    WsMetricsSnapshot {
        active_connections,
        total_events,
        events_by_type,
    }
}

#[cfg(test)]
fn reset_for_tests() {
    WS_CONNECTIONS_ACTIVE.store(0, Ordering::Relaxed);
    WS_EVENTS_TOTAL.store(0, Ordering::Relaxed);
    lock_ws_events_by_type().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_connection_close_is_saturating() {
        reset_for_tests();
        ws_connection_close();
        assert_eq!(ws_metrics_snapshot().active_connections, 0);
    }

    #[test]
    fn ws_event_type_is_normalized_and_cardinality_is_bounded() {
        reset_for_tests();

        ws_event_dispatched("MESSAGE_CREATE");
        ws_event_dispatched("message_create");
        ws_event_dispatched("INVALID-EVENT-TYPE");

        let snapshot = ws_metrics_snapshot();
        assert_eq!(snapshot.total_events, 3);

        let message = snapshot
            .events_by_type
            .iter()
            .find(|(event_type, _)| event_type == "MESSAGE_CREATE")
            .map(|(_, count)| *count);
        let other = snapshot
            .events_by_type
            .iter()
            .find(|(event_type, _)| event_type == EVENT_TYPE_FALLBACK)
            .map(|(_, count)| *count);

        assert_eq!(message, Some(1));
        assert_eq!(other, Some(2));
    }
}
