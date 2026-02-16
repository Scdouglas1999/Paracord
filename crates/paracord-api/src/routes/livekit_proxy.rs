//! Reverse-proxy for LiveKit signaling through the main Paracord port.
//!
//! This lets users expose only port 8080 instead of also opening 7880.
//! WebSocket connections to `/livekit/...` are forwarded to the local
//! LiveKit server, and HTTP requests (Twirp API) are also proxied.

use axum::{
    body::Body,
    extract::{ws::WebSocket, FromRequestParts, Request, State, WebSocketUpgrade},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use paracord_core::AppState;
use serde::Deserialize;

const LIVEKIT_PROXY_MAX_MESSAGE_SIZE: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct LiveKitProxyClaims {
    iss: Option<String>,
    exp: Option<u64>,
}

fn query_param(uri: &axum::http::Uri, key: &str) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let k = parts.next().unwrap_or_default();
        if k != key {
            continue;
        }
        let value = parts.next().unwrap_or_default();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn is_livekit_access_token_valid(state: &AppState, uri: &axum::http::Uri) -> bool {
    let token = query_param(uri, "access_token").or_else(|| query_param(uri, "token"));
    let Some(token) = token else {
        return false;
    };

    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    validation.set_issuer(&[state.config.livekit_api_key.as_str()]);

    decode::<LiveKitProxyClaims>(
        &token,
        &DecodingKey::from_secret(state.config.livekit_api_secret.as_bytes()),
        &validation,
    )
    .map(|data| {
        let _ = data.claims.exp;
        let _ = data.claims.iss;
        true
    })
    .unwrap_or(false)
}

fn has_ws_upgrade_intent(headers: &HeaderMap) -> bool {
    if headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    {
        return true;
    }
    if headers.get("sec-websocket-key").is_some() || headers.get("sec-websocket-version").is_some()
    {
        return true;
    }
    headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
        })
        .unwrap_or(false)
}

/// Combined handler: upgrades WebSocket requests, proxies HTTP requests.
pub async fn livekit_proxy(State(state): State<AppState>, req: Request) -> Response {
    let uri_for_log = sanitize_request_uri_for_log(req.uri());
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let has_upgrade_intent = has_ws_upgrade_intent(req.headers());

    if !is_allowed_livekit_request(&path, &method, has_upgrade_intent) {
        tracing::warn!(
            "LiveKit proxy blocked disallowed request: method={}, path={}, ws_intent={}",
            method,
            path,
            has_upgrade_intent
        );
        return StatusCode::NOT_FOUND.into_response();
    }

    if method != axum::http::Method::OPTIONS && !is_livekit_access_token_valid(&state, req.uri()) {
        tracing::warn!(
            "LiveKit proxy rejected request without a valid access token: {} {}",
            method,
            uri_for_log
        );
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // Try to extract WebSocketUpgrade from the request
    let (mut parts, body) = req.into_parts();
    match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(ws) => {
            tracing::info!(
                "LiveKit proxy: WebSocket upgrade for {} {}",
                method,
                uri_for_log
            );
            let req = Request::from_parts(parts, body);
            handle_ws(state, ws, req)
        }
        Err(e) => {
            if has_upgrade_intent {
                tracing::warn!(
                    "LiveKit proxy: WebSocket upgrade extraction FAILED for {} {} (ws intent detected): {}",
                    method, uri_for_log, e
                );
                return (
                    StatusCode::UPGRADE_REQUIRED,
                    "WebSocket upgrade required for LiveKit signaling",
                )
                    .into_response();
            } else {
                tracing::debug!("LiveKit proxy: HTTP request {} {}", method, uri_for_log);
            }
            let req = Request::from_parts(parts, body);
            handle_http(state, req).await
        }
    }
}

fn is_allowed_livekit_request(
    path: &str,
    method: &axum::http::Method,
    is_ws_upgrade: bool,
) -> bool {
    let stripped = path
        .strip_prefix("/livekit")
        .unwrap_or(path)
        .trim_start_matches('/');
    if is_ws_upgrade {
        stripped.is_empty() || stripped.starts_with("rtc")
    } else {
        (method == axum::http::Method::GET || method == axum::http::Method::OPTIONS)
            && stripped.starts_with("rtc/")
            && stripped.ends_with("/validate")
    }
}

fn build_target(livekit_http_url: &str, req: &Request, ws: bool) -> String {
    let path = req
        .uri()
        .path()
        .strip_prefix("/livekit")
        .unwrap_or(req.uri().path());
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{}", q))
        .unwrap_or_default();

    if ws {
        let backend_url = livekit_http_url
            .replace("http://", "ws://")
            .replace("https://", "wss://");
        format!("{}{}{}", backend_url, path, query)
    } else {
        format!("{}{}{}", livekit_http_url, path, query)
    }
}

fn sanitize_request_uri_for_log(uri: &axum::http::Uri) -> String {
    let path = uri.path();
    let Some(query) = uri.query() else {
        return path.to_string();
    };
    let mut redacted_parts = Vec::new();
    for pair in query.split('&') {
        let key = pair.split('=').next().unwrap_or_default().trim();
        if key.is_empty() {
            continue;
        }
        redacted_parts.push(format!("{}=REDACTED", key));
    }
    if redacted_parts.is_empty() {
        path.to_string()
    } else {
        format!("{}?{}", path, redacted_parts.join("&"))
    }
}

fn sanitize_target_for_log(target: &str) -> String {
    target.split('?').next().unwrap_or(target).to_string()
}

fn handle_ws(state: AppState, ws: WebSocketUpgrade, req: Request) -> Response {
    let target = build_target(&state.config.livekit_http_url, &req, true);
    tracing::info!(
        "LiveKit WS proxy: upgrading connection to {}",
        sanitize_target_for_log(&target)
    );
    // Keep signaling payload limits explicit and conservative.
    ws.max_message_size(LIVEKIT_PROXY_MAX_MESSAGE_SIZE)
        .max_frame_size(LIVEKIT_PROXY_MAX_MESSAGE_SIZE)
        .on_upgrade(move |client_socket| proxy_ws(client_socket, target))
}

/// Bidirectional WebSocket proxy between a client and the local LiveKit server.
///
/// We forward data frames (text/binary) and close cooperatively.
/// Ping/pong is handled explicitly on each side so idle signaling sockets
/// still satisfy keepalive probes without relying on implicit flush behavior.
async fn proxy_ws(client_socket: WebSocket, target: String) {
    use axum::extract::ws::Message as AMsg;
    use std::sync::Arc;
    use tokio_tungstenite::tungstenite::Message as TMsg;

    // On Windows, "localhost" can resolve to IPv6 [::1] which hangs if
    // LiveKit only listens on IPv4.  Force 127.0.0.1 for reliability.
    let target = target.replace("://localhost:", "://127.0.0.1:");
    let redacted_target = sanitize_target_for_log(&target);

    // Use a custom config to allow large LiveKit signaling messages.
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(LIVEKIT_PROXY_MAX_MESSAGE_SIZE))
        .max_frame_size(Some(LIVEKIT_PROXY_MAX_MESSAGE_SIZE));

    // Retry connecting to the LiveKit backend with backoff.  LiveKit can be
    // slow to accept connections right after room creation, so retrying at
    // the proxy level avoids burning through the client SDK's limited
    // connect retries on transient backend delays.
    const MAX_BACKEND_RETRIES: u32 = 6;
    const BACKEND_CONNECT_TIMEOUT_SECS: u64 = 8;

    let mut backend_opt = None;
    for attempt in 0..MAX_BACKEND_RETRIES {
        let connect_fut =
            tokio_tungstenite::connect_async_with_config(&target, Some(ws_config.clone()), false);
        match tokio::time::timeout(
            std::time::Duration::from_secs(BACKEND_CONNECT_TIMEOUT_SECS),
            connect_fut,
        )
        .await
        {
            Ok(Ok((ws_stream, _))) => {
                backend_opt = Some(ws_stream);
                break;
            }
            Ok(Err(e)) => {
                tracing::warn!(
                    "LiveKit backend connect attempt {}/{} failed for {}: {}",
                    attempt + 1,
                    MAX_BACKEND_RETRIES,
                    redacted_target,
                    e
                );
            }
            Err(_) => {
                tracing::warn!(
                    "LiveKit backend connect attempt {}/{} timed out for {} ({}s)",
                    attempt + 1,
                    MAX_BACKEND_RETRIES,
                    redacted_target,
                    BACKEND_CONNECT_TIMEOUT_SECS
                );
            }
        }
        if attempt + 1 < MAX_BACKEND_RETRIES {
            tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
        }
    }

    let backend = match backend_opt {
        Some(b) => b,
        None => {
            tracing::error!(
                "All {} attempts to connect to LiveKit backend at {} failed. \
                 Check that LiveKit is running and accessible.",
                MAX_BACKEND_RETRIES,
                redacted_target
            );
            // Send a proper close frame so the client SDK gets a clear error
            // instead of an ambiguous connection drop.
            let (mut client_write, _) = client_socket.split();
            let _ = client_write
                .send(AMsg::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1013, // Try Again Later
                    reason: "LiveKit backend unavailable".into(),
                })))
                .await;
            return;
        }
    };

    let (backend_write, mut backend_read) = backend.split();
    let (client_write, mut client_read) = client_socket.split();
    // Share write halves so either read-loop can send immediate pong/close
    // frames on that same side.
    let backend_write = Arc::new(tokio::sync::Mutex::new(backend_write));
    let client_write = Arc::new(tokio::sync::Mutex::new(client_write));

    // Use CancellationTokens so each half can signal the other to stop
    // cooperatively (with a close frame) instead of aborting mid-stream.
    let cancel = tokio_util::sync::CancellationToken::new();

    let c2b_backend_write = backend_write.clone();
    let c2b_client_write = client_write.clone();
    tracing::debug!("LiveKit WS proxy connected to {}", redacted_target);

    let cancel_c2b = cancel.clone();
    let c2b = tokio::spawn(async move {
        // Active keepalive: send a ping to the client every 20 seconds so we
        // detect dead browser connections faster than waiting for a TCP timeout.
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(20));
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Skip the first immediate tick.
        keepalive.tick().await;

        loop {
            tokio::select! {
                biased;
                _ = cancel_c2b.cancelled() => break,
                maybe_msg = client_read.next() => {
                    let msg = match maybe_msg {
                        Some(Ok(m)) => m,
                        Some(Err(e)) => {
                            tracing::debug!("LiveKit WS proxy: client read error: {}", e);
                            break;
                        }
                        None => break,
                    };
                    match msg {
                        AMsg::Text(t) => {
                            if c2b_backend_write
                                .lock()
                                .await
                                .send(TMsg::Text(t.as_str().to_string().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        AMsg::Binary(b) => {
                            if c2b_backend_write
                                .lock()
                                .await
                                .send(TMsg::Binary(b.to_vec().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        AMsg::Ping(p) => {
                            // Keep client-side keepalive healthy immediately.
                            let _ = c2b_client_write
                                .lock()
                                .await
                                .send(AMsg::Pong(p))
                                .await;
                        }
                        AMsg::Pong(_) => {
                            // Browser-level pong; no proxy action needed.
                        }
                        AMsg::Close(_) => break,
                    }
                }
                _ = keepalive.tick() => {
                    // Send a ping to the client to keep the connection alive.
                    if c2b_client_write
                        .lock()
                        .await
                        .send(AMsg::Ping(vec![].into()))
                        .await
                        .is_err()
                    {
                        tracing::debug!("LiveKit WS proxy: client keepalive ping failed");
                        break;
                    }
                }
            }
        }
        // Always send a proper close frame to LiveKit so it can clean up
        // the participant session immediately instead of waiting for a timeout.
        let _ = c2b_backend_write.lock().await.close().await;
        cancel_c2b.cancel();
    });

    let b2c_backend_write = backend_write.clone();
    let b2c_client_write = client_write.clone();
    let cancel_b2c = cancel.clone();
    let b2c = tokio::spawn(async move {
        // Active keepalive: ping the LiveKit backend every 20 seconds to keep
        // the connection alive through NAT/firewalls and detect stale sockets.
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(20));
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        keepalive.tick().await;

        loop {
            tokio::select! {
                biased;
                _ = cancel_b2c.cancelled() => break,
                maybe_msg = backend_read.next() => {
                    let msg = match maybe_msg {
                        Some(Ok(m)) => m,
                        _ => break,
                    };
                    match msg {
                        TMsg::Text(t) => {
                            if b2c_client_write
                                .lock()
                                .await
                                .send(AMsg::Text(t.as_str().to_string().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        TMsg::Binary(b) => {
                            if b2c_client_write
                                .lock()
                                .await
                                .send(AMsg::Binary(b.to_vec().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        TMsg::Ping(p) => {
                            // Respond to backend ping immediately so LiveKit
                            // does not mark the signaling socket stale while idle.
                            if b2c_backend_write
                                .lock()
                                .await
                                .send(TMsg::Pong(p))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        TMsg::Pong(_) => {
                            // Backend pong observed; nothing to forward.
                        }
                        TMsg::Close(_) => break,
                        TMsg::Frame(_) => continue,
                    }
                }
                _ = keepalive.tick() => {
                    // Ping the LiveKit backend to keep the connection alive.
                    if b2c_backend_write
                        .lock()
                        .await
                        .send(TMsg::Ping(vec![].into()))
                        .await
                        .is_err()
                    {
                        tracing::debug!("LiveKit WS proxy: backend keepalive ping failed");
                        break;
                    }
                }
            }
        }
        let _ = b2c_client_write.lock().await.send(AMsg::Close(None)).await;
        cancel_b2c.cancel();
    });

    // Wait for both tasks to finish. The cancellation token ensures that
    // when one side exits, the other gets a cooperative shutdown signal
    // and sends a proper close frame before exiting.
    let _ = tokio::join!(c2b, b2c);
    tracing::debug!("LiveKit WS proxy disconnected from {}", redacted_target);
}

async fn handle_http(state: AppState, req: Request) -> Response {
    let target_uri = build_target(&state.config.livekit_http_url, &req, false);
    let (parts, body) = req.into_parts();

    let client = reqwest::Client::new();
    let mut builder = client.request(parts.method, &target_uri);

    for (name, value) in &parts.headers {
        let n = name.as_str();
        if n == "host" || n == "connection" || n == "upgrade" {
            continue;
        }
        builder = builder.header(name.clone(), value.clone());
    }

    let body_bytes = match axum::body::to_bytes(Body::new(body), 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };

    let resp = match builder.body(body_bytes).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("LiveKit proxy error: {}", e);
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = resp.headers().clone();
    let resp_body = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };

    let mut response = (status, resp_body.to_vec()).into_response();
    for (name, value) in headers.iter() {
        let n = name.as_str();
        if n == "transfer-encoding" || n == "connection" {
            continue;
        }
        response.headers_mut().insert(name.clone(), value.clone());
    }

    response
}

#[cfg(test)]
mod tests {
    use super::is_allowed_livekit_request;
    use axum::http::Method;

    #[test]
    fn allows_livekit_signal_ws_paths() {
        assert!(is_allowed_livekit_request(
            "/livekit/rtc/v1",
            &Method::GET,
            true
        ));
        assert!(is_allowed_livekit_request("/livekit", &Method::GET, true));
    }

    #[test]
    fn allows_only_validate_http_paths() {
        assert!(is_allowed_livekit_request(
            "/livekit/rtc/v1/validate",
            &Method::GET,
            false
        ));
        assert!(!is_allowed_livekit_request(
            "/livekit/twirp/livekit.RoomService/DeleteRoom",
            &Method::POST,
            false
        ));
    }
}
