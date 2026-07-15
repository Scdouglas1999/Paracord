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

/// Resolve a client address using the same trusted-proxy boundary as the
/// request rate limiter and authentication guard.
fn resolve_client_ip(headers: Option<&HeaderMap>, peer_ip: Option<&str>) -> Option<String> {
    let forwarded_for = headers
        .and_then(|values| values.get("x-forwarded-for"))
        .and_then(|value| value.to_str().ok());
    paracord_util::client_ip::resolve_client_ip_from_env(peer_ip, forwarded_for)
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
