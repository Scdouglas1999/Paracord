use axum::http::{header, HeaderMap};
use paracord_core::AppState;
use serde_json::Value;

fn header_opt(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// Whether X-Forwarded-For may be trusted for this request. Only honored when
/// proxy trust is explicitly enabled AND the connecting peer's IP is in the
/// configured allowlist — otherwise a client could spoof its source IP by
/// setting the header directly.
fn proxy_peer_is_trusted(peer_ip: Option<&str>) -> bool {
    let trust_proxy = std::env::var("PARACORD_TRUST_PROXY")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false);
    if !trust_proxy {
        return false;
    }
    let Some(peer_ip) = peer_ip else {
        return false;
    };
    std::env::var("PARACORD_TRUSTED_PROXY_IPS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .any(|trusted| trusted == peer_ip)
        })
        .unwrap_or(false)
}

/// Resolve the client IP for logging: the first X-Forwarded-For hop when the
/// peer is a trusted proxy, otherwise the raw peer address.
fn resolve_client_ip(headers: Option<&HeaderMap>, peer_ip: Option<&str>) -> Option<String> {
    if proxy_peer_is_trusted(peer_ip) {
        if let Some(forwarded) = headers.and_then(|h| header_opt(h, "x-forwarded-for")) {
            return Some(forwarded);
        }
    }
    peer_ip
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn request_metadata(
    headers: Option<&HeaderMap>,
    peer_ip: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    let ip_address = resolve_client_ip(headers, peer_ip);
    let Some(headers) = headers else {
        return (None, None, ip_address);
    };
    let device_id = header_opt(headers, "x-device-id");
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    (device_id, user_agent, ip_address)
}

pub async fn log_security_event(
    state: &AppState,
    action: &str,
    actor_user_id: Option<i64>,
    target_user_id: Option<i64>,
    session_id: Option<&str>,
    headers: Option<&HeaderMap>,
    peer_ip: Option<&str>,
    details: Option<Value>,
) {
    let (device_id, user_agent, ip_address) = request_metadata(headers, peer_ip);
    let id = paracord_util::snowflake::generate(1);
    let details_ref = details.as_ref();

    if let Err(err) = paracord_db::security_events::create_event(
        &state.db,
        id,
        actor_user_id,
        action,
        target_user_id,
        session_id,
        device_id.as_deref(),
        user_agent.as_deref(),
        ip_address.as_deref(),
        details_ref,
    )
    .await
    {
        tracing::warn!("failed to write security event '{}': {}", action, err);
    }
}
