//! Regression tests for federation *scoping* defects: peer-controlled content
//! that escaped its intended audience (F1), local content that escaped this
//! server entirely (F2), and per-peer keys derived from an unsigned header (F3).
//!
//! Kept separate from `security_federation_regressions.rs` (which covers
//! authentication/authorization of the federation wire protocol) because these
//! assert on *delivery scope* rather than on accept/reject.

mod common;

use std::sync::OnceLock;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use common::{build_json_request, build_test_app, dispatch_json, TestApp, TestAppOptions};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tokio::sync::Mutex;

/// The destination this test server recognizes as itself. `PARACORD_SERVER_NAME`
/// is left unset, so `build_federation_service` resolves to `localhost` for both
/// `server_name` and `domain`.
const TEST_DESTINATION: &str = "localhost";

/// 32-byte ed25519 seed for the *local* server, in the hex form
/// `PARACORD_FEDERATION_SIGNING_KEY_HEX` expects. Outbound forwarding refuses to
/// build an envelope (and therefore stages nothing) without a signing key, so
/// the F2 tests must supply one for their positive control to be meaningful.
const LOCAL_SIGNING_KEY_HEX: &str =
    "a6f081626e2fa8e17e8ba9916434da6fc6467bb66b159fa19c1fb85a30b57d96";

/// Serializes tests that mutate process-global federation env vars. A tokio
/// mutex is used (not `std::sync::Mutex`) because the guard is held across the
/// `.await` points of each test body.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Clear every federation env var this file sets, so one test's configuration
/// cannot leak into the next even when an assertion fails mid-test.
struct FederationEnvGuard;

impl FederationEnvGuard {
    fn new() -> Self {
        Self
    }
}

impl Drop for FederationEnvGuard {
    fn drop(&mut self) {
        std::env::remove_var("PARACORD_FEDERATION_ENABLED");
        std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
        std::env::remove_var("PARACORD_FEDERATION_SIGNING_KEY_HEX");
    }
}

struct TestHarness {
    app: Router,
    db: paracord_db::DbPool,
    test_app: TestApp,
}

impl TestHarness {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            test_app,
        })
    }

    async fn request(&self, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(&self.app, request).await
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(
            &self.app,
            build_json_request(method, path, body, Some(token))?,
        )
        .await
    }
}

// ── Federation wire helpers (mirrors security_federation_regressions.rs) ─────

/// Register a trusted federated peer plus its signing key, returning the
/// signing key for producing envelope/transport signatures in tests.
async fn register_signed_peer(
    harness: &TestHarness,
    peer_id: i64,
    server_name: &str,
    key_id: &str,
) -> anyhow::Result<ed25519_dalek::SigningKey> {
    let (signing_key, public_key_hex) = paracord_federation::signing::generate_keypair();
    paracord_db::federation::upsert_federated_server(
        &harness.db,
        peer_id,
        server_name,
        server_name,
        &format!("https://{server_name}/_paracord/federation/v1"),
        Some(&public_key_hex),
        Some(key_id),
        true,
    )
    .await?;
    let service =
        paracord_federation::FederationService::new(paracord_federation::FederationConfig {
            enabled: true,
            server_name: TEST_DESTINATION.to_string(),
            domain: TEST_DESTINATION.to_string(),
            key_id: "ed25519:local".to_string(),
            signing_key: None,
            allow_discovery: false,
        });
    service
        .upsert_server_key(
            &harness.db,
            &paracord_federation::FederationServerKey {
                server_name: server_name.to_string(),
                key_id: key_id.to_string(),
                public_key: public_key_hex,
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;
    Ok(signing_key)
}

/// The signed wire form of an envelope, kept as separate parts so the same
/// bytes and the same signature can be replayed under a different (unsigned)
/// origin header.
struct SignedEvent {
    body_bytes: Vec<u8>,
    timestamp_ms: i64,
    transport_signature: String,
}

/// Sign `envelope` for POST `/event`: the payload signature goes into the
/// envelope, the transport signature covers the exact bytes that will be sent.
fn sign_event(
    envelope: &mut paracord_federation::FederationEventEnvelope,
    signing_key: &ed25519_dalek::SigningKey,
    key_id: &str,
) -> anyhow::Result<SignedEvent> {
    let payload_sig = paracord_federation::signing::sign(
        signing_key,
        &paracord_federation::canonical_envelope_bytes(envelope),
    );
    envelope.signatures = json!({
        envelope.origin_server.clone(): { key_id: payload_sig },
    });
    let body_bytes = serde_json::to_vec(envelope)?;
    let timestamp_ms = chrono::Utc::now().timestamp_millis();
    let canonical =
        paracord_federation::transport::canonical_transport_bytes_with_body_and_destination(
            "POST",
            "/_paracord/federation/v1/event",
            timestamp_ms,
            &body_bytes,
            TEST_DESTINATION,
        );
    Ok(SignedEvent {
        body_bytes,
        timestamp_ms,
        transport_signature: paracord_federation::signing::sign(signing_key, &canonical),
    })
}

/// Build the ingest request for a [`SignedEvent`], presenting `origin_header` as
/// `x-paracord-origin`. That header is NOT covered by the transport signature,
/// so the same `signed` may be replayed under any spelling of the peer's name.
fn event_request(signed: &SignedEvent, origin_header: &str, key_id: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-paracord-origin", origin_header)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", signed.timestamp_ms.to_string())
        .header("x-paracord-signature", signed.transport_signature.clone())
        .header("x-paracord-destination", TEST_DESTINATION)
        .body(Body::from(signed.body_bytes.clone()))
        .expect("event request builds")
}

// ── F1: inbound message content must never reach unrelated sessions ──────────

/// A validly-signed `m.message` whose content omits `channel_id` and whose room
/// namespace yields no local guild used to be dispatched as `FEDERATION_M.MESSAGE`
/// with a `None` guild target. `EventBus::publish` treats a `None` guild with no
/// user targets as a GLOBAL event, so a trusted peer could push arbitrary JSON to
/// every connected client — including accounts in no guild at all.
#[tokio::test]
async fn federated_message_with_no_resolvable_guild_is_not_broadcast_to_every_session(
) -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard::new();
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");

    let harness = TestHarness::new().await?;
    let origin_server = "attacker.example";
    let key_id = "ed25519:test";
    let peer_key = register_signed_peer(&harness, 9801, origin_server, key_id).await?;

    // A session in ZERO guilds. Only the global branch of `publish()` can reach
    // it, so anything it receives from a federated peer is a fan-out bug.
    let victim_id = paracord_util::snowflake::generate(1);
    let mut victim_rx = harness
        .test_app
        .event_bus
        .register_session("victim-session", victim_id, &[])
        .expect("victim session registers");
    let mut system_rx = harness.test_app.event_bus.subscribe_system();

    // `room_id` is unparseable, so `origin_authoritative_for_room_namespace`
    // waves it through AND no guild can be derived from it; the content carries
    // neither `guild_id` nor `channel_id`. The mapped local guild is therefore
    // `None` — the exact shape that used to become a global broadcast.
    let mut envelope = paracord_federation::FederationEventEnvelope {
        event_id: "$unscoped:attacker.example".to_string(),
        room_id: "opaque-room".to_string(),
        event_type: "m.message".to_string(),
        sender: "@mallory:attacker.example".to_string(),
        origin_server: origin_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "attacker-controlled payload",
            "msgtype": "m.text",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let signed = sign_event(&mut envelope, &peer_key, key_id)?;
    let (status, _) = harness
        .request(event_request(&signed, origin_server, key_id))
        .await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    // The reported symptom, asserted first: an account in no guilds received
    // `FEDERATION_M.MESSAGE` with attacker-chosen origin, sender and content.
    if let Ok(leaked) = victim_rx.try_recv() {
        panic!(
            "a session in zero guilds received peer-controlled federated content: {} {}",
            leaked.event_type, leaked.payload
        );
    }

    // `subscribe_system` sees every published event regardless of scope, so this
    // also catches the dispatch when no session happens to match it.
    let mut published = Vec::new();
    while let Ok(event) = system_rx.try_recv() {
        published.push(event.event_type);
    }
    assert!(
        !published.iter().any(|t| t.starts_with("FEDERATION_")),
        "a federated message that resolves to no local guild must not be dispatched at all, saw: {published:?}"
    );

    // Liveness control: the victim session really is wired to the bus, so the
    // assertion above is meaningful rather than vacuous.
    harness
        .test_app
        .event_bus
        .dispatch("TEST_GLOBAL_PING", json!({}), None);
    let control = victim_rx
        .try_recv()
        .expect("the guild-less session should still receive a genuine global event");
    assert_eq!(control.event_type, "TEST_GLOBAL_PING");

    Ok(())
}

// ── F3: replay/rate-limit keys must not follow the unsigned origin header ────

/// The transport signature covers `METHOD\npath\ntimestamp\nsha256(body)\ndestination`
/// and NOT the origin, while `canonical_peer_name` resolves the origin header
/// case-insensitively (and by domain alias). Keyed on the raw header, one valid
/// signature yielded a fresh replay-cache entry per spelling — so the same
/// request could be replayed indefinitely by re-casing a header.
#[tokio::test]
async fn transport_replay_cache_is_keyed_on_the_canonical_peer_name() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard::new();
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");

    let harness = TestHarness::new().await?;
    let origin_server = "attacker.example";
    let key_id = "ed25519:test";
    let peer_key = register_signed_peer(&harness, 9811, origin_server, key_id).await?;

    let mut envelope = paracord_federation::FederationEventEnvelope {
        event_id: "$replayed:attacker.example".to_string(),
        room_id: "!7310:attacker.example".to_string(),
        event_type: "m.message".to_string(),
        sender: "@mallory:attacker.example".to_string(),
        origin_server: origin_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "replay me",
            "msgtype": "m.text",
            "guild_id": "7310",
            "guild_name": "Attacker Guild",
            "channel_id": "7320",
            "channel_name": "general",
            "channel_type": 0,
            "message_id": "97311",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let signed = sign_event(&mut envelope, &peer_key, key_id)?;

    let (first_status, _) = harness
        .request(event_request(&signed, origin_server, key_id))
        .await?;
    assert_eq!(first_status, StatusCode::ACCEPTED);

    // Byte-identical body, timestamp and signature — only the unsigned origin
    // header is re-cased. It still resolves to the same registered peer, so it
    // must land in the same replay bucket.
    let (replay_status, replay_body) = harness
        .request(event_request(&signed, "ATTACKER.Example", key_id))
        .await?;
    assert_eq!(
        replay_status,
        StatusCode::CONFLICT,
        "re-casing the unsigned origin header must not mint a fresh replay bucket: {replay_body}"
    );

    Ok(())
}

// ── F2: outbound forwarding must not leak local guilds/channels ──────────────

/// Read everything currently staged in the outbound federation queue.
async fn staged_outbound(
    db: &paracord_db::DbPool,
) -> anyhow::Result<Vec<paracord_db::federation::OutboundFederationEventRow>> {
    Ok(paracord_db::federation::fetch_due_outbound_events(
        db,
        chrono::Utc::now().timestamp_millis() + 60_000,
        200,
    )
    .await?)
}

/// True when some staged envelope carries `needle` as its message body.
fn staged_body(rows: &[paracord_db::federation::OutboundFederationEventRow], needle: &str) -> bool {
    rows.iter()
        .any(|row| row.content.get("body").and_then(|v| v.as_str()) == Some(needle))
}

/// Wait until the allowlisted, public, room-participating message has been
/// staged. Forwarding runs in a `tokio::spawn`, so the assertions that follow
/// need a positive signal that the background work has actually run.
async fn wait_for_staged_body(
    db: &paracord_db::DbPool,
    needle: &str,
) -> anyhow::Result<Vec<paracord_db::federation::OutboundFederationEventRow>> {
    for _ in 0..200 {
        let rows = staged_outbound(db).await?;
        if staged_body(&rows, needle) {
            // Give the sibling spawns that were queued alongside this one a
            // window to stage anything they were going to stage, so the negative
            // assertions cannot pass merely by winning a race.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            return staged_outbound(db).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    anyhow::bail!("expected outbound event with body '{needle}' was never staged")
}

async fn create_guild(harness: &TestHarness, token: &str, name: &str) -> anyhow::Result<i64> {
    let (status, payload) = harness
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
            token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "guild create failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("guild id should be a string"))?
        .parse::<i64>()?)
}

async fn create_text_channel(
    harness: &TestHarness,
    token: &str,
    guild_id: i64,
    name: &str,
) -> anyhow::Result<i64> {
    let (status, payload) = harness
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": name,
                "channel_type": 0,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
            token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "channel create failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("channel id should be a string"))?
        .parse::<i64>()?)
}

async fn post_message(
    harness: &TestHarness,
    token: &str,
    channel_id: i64,
    content: &str,
) -> anyhow::Result<()> {
    let (status, payload) = harness
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": content })),
            token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "message post failed: {payload}"
    );
    Ok(())
}

/// Record `peer` as a participant of the guild's canonical room, which is what
/// `list_room_member_servers` (and therefore outbound peer scoping) keys on.
async fn join_peer_to_guild_room(
    db: &paracord_db::DbPool,
    guild_id: i64,
    peer: &str,
    local_user_id: i64,
) -> anyhow::Result<()> {
    paracord_db::federation::upsert_room_membership(
        db,
        &format!("!{guild_id}:{TEST_DESTINATION}"),
        &format!("@remote:{peer}"),
        local_user_id,
        guild_id,
    )
    .await?;
    Ok(())
}

/// Outbound message forwarding used to enforce none of the constraints the
/// inbound path does: any guild, any channel, every trusted peer. Each negative
/// case below is paired with the same-shaped positive control in one test, so a
/// fix that simply disables forwarding altogether cannot pass.
#[tokio::test]
async fn outbound_forwarding_honors_allowlist_room_membership_and_channel_privacy(
) -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard::new();

    let harness = TestHarness::new().await?;
    let peer = "peer.example";
    register_signed_peer(&harness, 9821, peer, "ed25519:test").await?;

    let token = common::create_authenticated_user_token(
        &harness.db,
        &harness.test_app.jwt_secret,
        "fedowner",
        "OwnerPassw0rd!",
    )
    .await?;
    let (status, me) = harness
        .request_json(Method::GET, "/api/v1/users/@me", None, &token)
        .await?;
    assert_eq!(status, StatusCode::OK, "fetch @me failed: {me}");
    let owner_id = me["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("user id should be a string"))?
        .parse::<i64>()?;

    // Four guilds, differing in exactly one property each.
    let shared_guild = create_guild(&harness, &token, "Shared Space").await?;
    let shared_channel = create_text_channel(&harness, &token, shared_guild, "shared").await?;
    let private_guild = create_guild(&harness, &token, "Private Channel Space").await?;
    let private_channel = create_text_channel(&harness, &token, private_guild, "secret").await?;
    let denied_guild = create_guild(&harness, &token, "Never Federated").await?;
    let denied_channel = create_text_channel(&harness, &token, denied_guild, "denied").await?;
    let unshared_guild = create_guild(&harness, &token, "Local Only").await?;
    let unshared_channel = create_text_channel(&harness, &token, unshared_guild, "local").await?;

    // The peer participates in every room except `unshared_guild`'s.
    for guild_id in [shared_guild, private_guild, denied_guild] {
        join_peer_to_guild_room(&harness.db, guild_id, peer, owner_id).await?;
    }

    // Deny VIEW_CHANNEL to @everyone (role id == guild id) in the private
    // channel. The guild owner still posts fine — owners bypass overwrites — so
    // this isolates the *forwarding* gate from the local send gate.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &harness.db,
        private_channel,
        private_guild,
        paracord_core::permissions::OVERWRITE_TARGET_ROLE,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;

    // Everything above is setup; federation only goes live now so guild/channel
    // creation does not itself stage events.
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_SIGNING_KEY_HEX", LOCAL_SIGNING_KEY_HEX);
    std::env::set_var(
        "PARACORD_FEDERATION_ALLOWED_GUILD_IDS",
        format!("{shared_guild},{private_guild},{unshared_guild}"),
    );

    post_message(&harness, &token, denied_channel, "denied guild body").await?;
    post_message(&harness, &token, private_channel, "private channel body").await?;
    post_message(&harness, &token, unshared_channel, "unshared guild body").await?;
    // Posted last so that seeing it staged implies the earlier spawns have had
    // at least as long to run.
    post_message(&harness, &token, shared_channel, "shared guild body").await?;

    let staged = wait_for_staged_body(&harness.db, "shared guild body").await?;
    assert!(
        staged.iter().all(|row| row.destination_server == peer),
        "only the registered peer should ever be a destination: {:?}",
        staged
            .iter()
            .map(|row| row.destination_server.as_str())
            .collect::<Vec<_>>()
    );

    assert!(
        !staged_body(&staged, "denied guild body"),
        "a guild absent from PARACORD_FEDERATION_ALLOWED_GUILD_IDS must not be forwarded"
    );
    assert!(
        !staged_body(&staged, "private channel body"),
        "a channel @everyone cannot view must not be forwarded to peers"
    );
    assert!(
        !staged_body(&staged, "unshared guild body"),
        "a guild with no recorded remote participants must be forwarded to no peers"
    );

    Ok(())
}
