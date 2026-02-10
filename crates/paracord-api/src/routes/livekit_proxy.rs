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
pub async fn livekit_proxy(
    State(state): State<AppState>,
    req: Request,
) -> Response {
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
    ws.on_upgrade(move |client_socket| proxy_ws(client_socket, target))
}

async fn proxy_ws(client_socket: WebSocket, target: String) {
    use tokio_tungstenite::tungstenite::Message as TMsg;

    let backend = match tokio_tungstenite::connect_async(&target).await {
        Ok((ws_stream, _)) => ws_stream,
        Err(e) => {
            tracing::error!("Failed to connect to LiveKit backend at {}: {}", target, e);
            return;
        }
    };

    let (mut backend_write, mut backend_read) = backend.split();
    let (mut client_write, mut client_read) = client_socket.split();

    let client_to_backend = async {
        use axum::extract::ws::Message as AMsg;
        while let Some(Ok(msg)) = client_read.next().await {
            let tung_msg = match msg {
                AMsg::Text(t) => TMsg::Text(t.as_str().to_string().into()),
                AMsg::Binary(b) => TMsg::Binary(b.to_vec().into()),
                AMsg::Ping(p) => TMsg::Ping(p.to_vec().into()),
                AMsg::Pong(p) => TMsg::Pong(p.to_vec().into()),
                AMsg::Close(_) => return,
            };
            if backend_write.send(tung_msg).await.is_err() {
                return;
            }
        }
    };

    let backend_to_client = async {
        use axum::extract::ws::Message as AMsg;
        while let Some(Ok(msg)) = backend_read.next().await {
            let axum_msg = match msg {
                TMsg::Text(t) => AMsg::Text(t.as_str().to_string().into()),
                TMsg::Binary(b) => AMsg::Binary(b.to_vec().into()),
                TMsg::Ping(p) => AMsg::Ping(p.to_vec().into()),
                TMsg::Pong(p) => AMsg::Pong(p.to_vec().into()),
                TMsg::Close(_) | TMsg::Frame(_) => return,
            };
            if client_write.send(axum_msg).await.is_err() {
                return;
            }
        }
    };

    tokio::select! {
        _ = client_to_backend => {}
        _ = backend_to_client => {}
    }
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
