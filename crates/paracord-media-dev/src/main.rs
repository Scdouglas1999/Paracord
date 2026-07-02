use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

use paracord_relay::bandwidth::BandwidthEstimator;
use paracord_relay::p2p::P2PCoordinator;
use paracord_relay::participant::MediaParticipant;
use paracord_relay::relay::{ConnectionHandle, RelayForwarder};
use paracord_relay::room::MediaRoomManager;
use paracord_relay::signaling::*;
use paracord_relay::speaker::SpeakerDetector;
use paracord_transport::connection::{ConnectionMode, MediaClaims, MediaConnection};
use paracord_transport::endpoint::{generate_self_signed_cert, MediaEndpoint};

#[derive(Parser, Debug)]
#[command(
    name = "paracord-media-dev",
    about = "Standalone media server for development"
)]
struct Args {
    /// HTTP signaling server port.
    #[arg(long, default_value = "8444")]
    port: u16,

    /// QUIC media transport port.
    #[arg(long, default_value = "8443")]
    quic_port: u16,

    /// JWT secret for media authentication.
    #[arg(long, default_value = "dev-media-secret")]
    jwt_secret: String,
}

/// Shared application state.
struct AppState {
    room_manager: Arc<MediaRoomManager>,
    speaker_detector: Arc<SpeakerDetector>,
    p2p_coordinator: Arc<P2PCoordinator>,
    bandwidth_estimator: Arc<BandwidthEstimator>,
    relay_forwarder: Arc<RelayForwarder>,
    jwt_secret: String,
    quic_addr: SocketAddr,
    /// Track which user is in which room (user_id -> (guild_id, channel_id)).
    user_rooms: RwLock<HashMap<i64, (i64, i64)>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let args = Args::parse();

    info!("paracord-media-dev starting...");
    info!("  Signaling port: {}", args.port);
    info!("  QUIC port:      {}", args.quic_port);

    // Generate self-signed certificate for QUIC
    let tls = generate_self_signed_cert()?;
    let quic_addr: SocketAddr = ([0, 0, 0, 0], args.quic_port).into();
    let endpoint = MediaEndpoint::bind(quic_addr, tls)?;
    let quic_local_addr = endpoint.local_addr()?;
    info!("QUIC endpoint listening on {}", quic_local_addr);

    // Create shared state
    let room_manager = Arc::new(MediaRoomManager::new());
    let speaker_detector = Arc::new(SpeakerDetector::new());
    let p2p_coordinator = Arc::new(P2PCoordinator::new());
    let bandwidth_estimator = Arc::new(BandwidthEstimator::new());
    let relay_forwarder = Arc::new(RelayForwarder::new(
        Arc::clone(&room_manager),
        Arc::clone(&speaker_detector),
    ));

    let state = Arc::new(AppState {
        room_manager,
        speaker_detector,
        p2p_coordinator,
        bandwidth_estimator,
        relay_forwarder,
        jwt_secret: args.jwt_secret.clone(),
        quic_addr: quic_local_addr,
        user_rooms: RwLock::new(HashMap::new()),
    });

    // Spawn QUIC accept loop
    let quic_state = Arc::clone(&state);
    tokio::spawn(async move {
        quic_accept_loop(endpoint, quic_state).await;
    });

    // Build axum router
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .with_state(Arc::clone(&state));

    let http_addr: SocketAddr = ([0, 0, 0, 0], args.port).into();
    info!("Signaling server listening on {}", http_addr);
    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health_handler() -> &'static str {
    "ok"
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

/// WebSocket signaling message from client.
#[derive(Debug, Deserialize)]
struct WsMessage {
    op: u8,
    d: Option<Value>,
}

/// WebSocket signaling message to client.
#[derive(Debug, Serialize)]
struct WsResponse {
    op: u8,
    d: Value,
}

/// Voice state update payload.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct VoiceStateUpdate {
    guild_id: i64,
    channel_id: Option<i64>,
    self_mute: Option<bool>,
    self_deaf: Option<bool>,
}

/// Handle a WebSocket signaling connection.
async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    // The connected user's ID (set after identify/auth).
    let mut user_id: Option<i64> = None;

    // Send hello
    let hello = WsResponse {
        op: 10,
        d: json!({
            "heartbeat_interval": 41250,
            "quic_endpoint": state.quic_addr.to_string(),
        }),
    };
    if send_json(&mut socket, &hello).await.is_err() {
        return;
    }

    loop {
        let msg = match socket.recv().await {
            Some(Ok(msg)) => msg,
            Some(Err(e)) => {
                debug!(error = %e, "ws: receive error");
                break;
            }
            None => break,
        };

        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(data) => {
                let _ = socket.send(Message::Pong(data)).await;
                continue;
            }
            _ => continue,
        };

        let ws_msg: WsMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, "ws: invalid message");
                continue;
            }
        };

        match ws_msg.op {
            // OP 2: Identify (simplified -- just set user_id)
            2 => {
                if let Some(d) = ws_msg.d {
                    if let Some(uid) = d.get("user_id").and_then(|v| v.as_i64()) {
                        user_id = Some(uid);
                        info!(user_id = uid, "ws: user identified");

                        let resp = WsResponse {
                            op: 0, // Dispatch
                            d: json!({
                                "t": "READY",
                                "user_id": uid,
                            }),
                        };
                        let _ = send_json(&mut socket, &resp).await;
                    }
                }
            }

            // OP 4: Voice State Update (join/leave voice)
            4 => {
                let uid = match user_id {
                    Some(id) => id,
                    None => {
                        warn!("ws: voice state update before identify");
                        continue;
                    }
                };

                if let Some(d) = ws_msg.d {
                    let update: VoiceStateUpdate = match serde_json::from_value(d) {
                        Ok(u) => u,
                        Err(e) => {
                            warn!(error = %e, "ws: invalid voice state update");
                            continue;
                        }
                    };

                    if let Some(channel_id) = update.channel_id {
                        // Join room
                        handle_voice_join(&mut socket, &state, uid, update.guild_id, channel_id)
                            .await;
                    } else {
                        // Leave room
                        handle_voice_leave(&mut socket, &state, uid).await;
                    }
                }
            }

            // OP 11: Heartbeat ACK
            11 => {
                let _ = send_json(
                    &mut socket,
                    &WsResponse {
                        op: 11,
                        d: json!({}),
                    },
                )
                .await;
            }

            // OP_MEDIA_KEY_ANNOUNCE (14): relay key to recipients
            OP_MEDIA_KEY_ANNOUNCE => {
                let uid = match user_id {
                    Some(id) => id,
                    None => continue,
                };

                if let Some(d) = ws_msg.d {
                    let announce: MediaKeyAnnounce = match serde_json::from_value(d) {
                        Ok(a) => a,
                        Err(e) => {
                            warn!(error = %e, "ws: invalid key announce");
                            continue;
                        }
                    };

                    debug!(
                        user_id = uid,
                        epoch = announce.epoch,
                        recipients = announce.encrypted_keys.len(),
                        "ws: key announce"
                    );

                    // Deliver keys to each recipient (in a real system, we'd
                    // forward to their WS connections; here we just log)
                    for ek in &announce.encrypted_keys {
                        let deliver = MediaKeyDeliver {
                            sender_user_id: uid,
                            epoch: announce.epoch,
                            ciphertext: ek.ciphertext.clone(),
                        };
                        let resp = WsResponse {
                            op: OP_MEDIA_KEY_DELIVER,
                            d: serde_json::to_value(&deliver).unwrap_or_default(),
                        };
                        // In a production system, we'd route this to the
                        // specific recipient's WS. For dev, we broadcast
                        // back on this connection for testing.
                        let _ = send_json(&mut socket, &resp).await;
                    }
                }
            }

            op => {
                debug!(op, "ws: unknown opcode");
            }
        }
    }

    // Clean up on disconnect
    if let Some(uid) = user_id {
        handle_voice_leave(&mut socket, &state, uid).await;
        info!(user_id = uid, "ws: disconnected");
    }
}

async fn handle_voice_join(
    socket: &mut WebSocket,
    state: &Arc<AppState>,
    user_id: i64,
    guild_id: i64,
    channel_id: i64,
) {
    // Leave any existing room first
    {
        let rooms = state.user_rooms.read().await;
        if rooms.contains_key(&user_id) {
            drop(rooms);
            handle_voice_leave(socket, state, user_id).await;
        }
    }

    // Create participant
    let session_id = format!("session-{}-{}", user_id, chrono::Utc::now().timestamp());
    let participant = MediaParticipant::new(user_id, session_id);

    // Join room
    match state
        .room_manager
        .join_room(guild_id, channel_id, participant)
    {
        Ok(participants) => {
            let room_id = format!("guild_{}_channel_{}", guild_id, channel_id);

            // Track user -> room mapping
            {
                let mut user_rooms = state.user_rooms.write().await;
                user_rooms.insert(user_id, (guild_id, channel_id));
            }

            // Generate JWT token for QUIC auth
            let token = generate_media_token(user_id, &state.jwt_secret);

            // Build peer info
            let peers: Vec<PeerInfo> = participants
                .iter()
                .filter(|p| p.user_id != user_id)
                .map(|p| PeerInfo {
                    user_id: p.user_id,
                    public_addr: p.public_addr.map(|a| a.to_string()),
                    supports_p2p: p.public_addr.is_some(),
                })
                .collect();

            let session_desc = MediaSessionDesc {
                relay_endpoint: state.quic_addr.to_string(),
                wt_endpoint: format!("https://{}", state.quic_addr),
                token,
                room_id: room_id.clone(),
                codecs: vec!["opus".to_string()],
                peers,
            };

            let resp = WsResponse {
                op: OP_MEDIA_SESSION_DESC,
                d: serde_json::to_value(&session_desc).unwrap_or_default(),
            };
            let _ = send_json(socket, &resp).await;

            info!(
                user_id,
                room_id = %room_id,
                participant_count = participants.len(),
                "ws: joined voice channel"
            );
        }
        Err(e) => {
            error!(error = %e, user_id, "ws: failed to join room");
        }
    }
}

async fn handle_voice_leave(_socket: &mut WebSocket, state: &Arc<AppState>, user_id: i64) {
    let room_info = {
        let mut user_rooms = state.user_rooms.write().await;
        user_rooms.remove(&user_id)
    };

    if let Some((guild_id, channel_id)) = room_info {
        let room_id = format!("guild_{}_channel_{}", guild_id, channel_id);
        let remaining = state.room_manager.leave_room(guild_id, channel_id, user_id);

        // Clean up P2P and speaker state
        state.p2p_coordinator.remove_address(user_id);
        state.speaker_detector.remove_user(user_id);
        state.bandwidth_estimator.remove_user(user_id);

        info!(
            user_id,
            room_id = %room_id,
            remaining = remaining.as_ref().map(|r| r.len()).unwrap_or(0),
            "ws: left voice channel"
        );
    }
}

/// Generate a JWT token for QUIC media authentication.
fn generate_media_token(user_id: i64, secret: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize;

    let claims = MediaClaims {
        sub: user_id,
        iat: now,
        exp: now + 3600, // 1 hour
        sid: Some(format!("media-{}", user_id)),
        room: None,
    };

    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap_or_else(|e| {
        error!(error = %e, "failed to generate JWT");
        String::new()
    })
}

/// QUIC accept loop: accept incoming QUIC connections, authenticate, and
/// start relay forwarding.
async fn quic_accept_loop(endpoint: MediaEndpoint, state: Arc<AppState>) {
    info!("QUIC accept loop started");

    loop {
        let incoming = match endpoint.accept().await {
            Some(i) => i,
            None => {
                info!("QUIC endpoint closed");
                break;
            }
        };

        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let conn = match incoming.accept() {
                Ok(connecting) => match connecting.await {
                    Ok(conn) => conn,
                    Err(e) => {
                        debug!(error = %e, "QUIC connection failed");
                        return;
                    }
                },
                Err(e) => {
                    debug!(error = %e, "QUIC incoming accept failed");
                    return;
                }
            };

            let remote_addr = conn.remote_address();
            info!(addr = %remote_addr, "QUIC: new connection");

            // Authenticate the connection
            let media_conn = match MediaConnection::accept_and_auth(
                conn.clone(),
                &state.jwt_secret,
                ConnectionMode::Relay,
            )
            .await
            {
                Ok(mc) => mc,
                Err(e) => {
                    warn!(addr = %remote_addr, error = %e, "QUIC: auth failed");
                    return;
                }
            };

            let user_id = media_conn.meta().user_id;
            info!(user_id, addr = %remote_addr, "QUIC: authenticated");

            // Register peer address for P2P
            state.p2p_coordinator.register_address(user_id, remote_addr);

            // Look up user's room
            let room_id = {
                let user_rooms = state.user_rooms.read().await;
                user_rooms
                    .get(&user_id)
                    .map(|(g, c)| format!("guild_{}_channel_{}", g, c))
            };

            let room_id = match room_id {
                Some(r) => r,
                None => {
                    warn!(user_id, "QUIC: user not in any room");
                    return;
                }
            };

            // Create connection handle and start forwarding
            let handle = ConnectionHandle::new(user_id, room_id.clone(), conn);
            state.relay_forwarder.add_connection(handle.clone());
            state.relay_forwarder.spawn_forwarding_task(handle);

            // Update bandwidth estimate
            state
                .bandwidth_estimator
                .update_from_connection(user_id, media_conn.inner());

            info!(user_id, room_id = %room_id, "QUIC: relay forwarding started");
        });
    }
}

async fn send_json(socket: &mut WebSocket, msg: &WsResponse) -> Result<(), axum::Error> {
    let json = serde_json::to_string(msg).unwrap_or_default();
    socket.send(Message::Text(json.into())).await.map_err(|e| {
        debug!(error = %e, "ws: send error");
        e
    })
}
