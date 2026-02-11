//! Reverse-proxy for LiveKit signaling through the main Paracord port.
//!
//! This lets users expose only port 8080 instead of also opening 7880.
//! WebSocket connections to `/livekit/...` are forwarded to the local
//! LiveKit server, and HTTP requests (Twirp API) are also proxied.

use axum::{
    body::Body,
    extract::{ws::WebSocket, FromRequestParts, Request, State, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use paracord_core::AppState;

/// Combined handler: upgrades WebSocket requests, proxies HTTP requests.
pub async fn livekit_proxy(State(state): State<AppState>, req: Request) -> Response {
    // Try to extract WebSocketUpgrade from the request
    let (mut parts, body) = req.into_parts();
    if let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        let req = Request::from_parts(parts, body);
        handle_ws(state, ws, req)
    } else {
        let req = Request::from_parts(parts, body);
        handle_http(state, req).await
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

fn handle_ws(state: AppState, ws: WebSocketUpgrade, req: Request) -> Response {
    let target = build_target(&state.config.livekit_http_url, &req, true);
    // LiveKit signaling messages (SyncState with SDP) can be large.
    // Increase from axum's default 64 KB to 16 MB.
    ws.max_message_size(16 * 1024 * 1024)
        .max_frame_size(16 * 1024 * 1024)
        .on_upgrade(move |client_socket| proxy_ws(client_socket, target))
}

/// Bidirectional WebSocket proxy between a client and the local LiveKit server.
///
/// Uses `tokio::sync::mpsc` channels so both halves can forward messages
/// without fighting over ownership. A periodic ping is sent to the client
/// to keep NAT/proxy TCP connections alive.
async fn proxy_ws(client_socket: WebSocket, target: String) {
    use axum::extract::ws::Message as AMsg;
    use tokio_tungstenite::tungstenite::Message as TMsg;

    // Use a custom config to allow large LiveKit signaling messages.
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(16 * 1024 * 1024))
        .max_frame_size(Some(16 * 1024 * 1024));
    let backend =
        match tokio_tungstenite::connect_async_with_config(&target, Some(ws_config), false).await {
            Ok((ws_stream, _)) => ws_stream,
            Err(e) => {
                tracing::error!("Failed to connect to LiveKit backend at {}: {}", target, e);
                return;
            }
        };

    let (mut backend_write, mut backend_read) = backend.split();
    let (mut client_write, mut client_read) = client_socket.split();

    // Use CancellationTokens so each half can signal the other to stop
    // cooperatively (with a close frame) instead of aborting mid-stream.
    let cancel = tokio_util::sync::CancellationToken::new();

    tracing::debug!("LiveKit WS proxy connected to {}", target);

    let cancel_c2b = cancel.clone();
    let c2b = tokio::spawn(async move {
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
                    let tung_msg = match msg {
                        AMsg::Text(t) => TMsg::Text(t.as_str().to_string().into()),
                        AMsg::Binary(b) => TMsg::Binary(b.to_vec().into()),
                        AMsg::Ping(p) => TMsg::Ping(p.to_vec().into()),
                        AMsg::Pong(p) => TMsg::Pong(p.to_vec().into()),
                        AMsg::Close(_) => break,
                    };
                    if backend_write.send(tung_msg).await.is_err() {
                        break;
                    }
                }
            }
        }
        // Always send a proper close frame to LiveKit so it can clean up
        // the participant session immediately instead of waiting for a timeout.
        let _ = backend_write.close().await;
        cancel_c2b.cancel();
    });

    let cancel_b2c = cancel.clone();
    let b2c = tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(15));
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Skip the first immediate tick
        ping_interval.tick().await;

        loop {
            tokio::select! {
                biased;
                _ = cancel_b2c.cancelled() => break,
                maybe_msg = backend_read.next() => {
                    let msg = match maybe_msg {
                        Some(Ok(m)) => m,
                        _ => break,
                    };
                    let axum_msg = match msg {
                        TMsg::Text(t) => AMsg::Text(t.as_str().to_string().into()),
                        TMsg::Binary(b) => AMsg::Binary(b.to_vec().into()),
                        TMsg::Ping(p) => AMsg::Ping(p.to_vec().into()),
                        TMsg::Pong(p) => AMsg::Pong(p.to_vec().into()),
                        TMsg::Close(_) => break,
                        TMsg::Frame(_) => continue,
                    };
                    if client_write.send(axum_msg).await.is_err() {
                        break;
                    }
                }
                _ = ping_interval.tick() => {
                    if client_write.send(AMsg::Ping(vec![].into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = client_write.send(AMsg::Close(None)).await;
        cancel_b2c.cancel();
    });

    // Wait for both tasks to finish. The cancellation token ensures that
    // when one side exits, the other gets a cooperative shutdown signal
    // and sends a proper close frame before exiting.
    let _ = tokio::join!(c2b, b2c);
    tracing::debug!("LiveKit WS proxy disconnected from {}", target);
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
