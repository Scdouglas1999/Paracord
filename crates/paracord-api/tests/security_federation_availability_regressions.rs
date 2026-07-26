//! Regression tests for federation *availability* defects: resource exhaustion
//! reachable by a hostile-or-compromised trusted peer, or by an unauthenticated
//! caller who can simply reach the federation endpoints.
//!
//! Kept separate from `security_federation_regressions.rs` (authn/authz of the
//! wire protocol) and `security_federation_scope_regressions.rs` (delivery
//! scope) because these assert on *bounds* — that some quantity a remote
//! controls cannot grow without limit.
//!
//! Every test in this file takes `env_lock()`: they mutate process-global
//! federation env vars, and the fan-out test additionally drains the
//! process-global relay-slot semaphore, which would otherwise starve a
//! concurrently running sibling.

mod common;

use std::sync::OnceLock;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use common::{build_test_app, dispatch_json, TestApp, TestAppOptions};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// The destination this test server recognizes as itself. `PARACORD_SERVER_NAME`
/// is left unset, so the federation service resolves to `localhost` for both
/// `server_name` and `domain`.
const TEST_DESTINATION: &str = "localhost";

/// 32-byte ed25519 seed for the *local* server, in the hex form
/// `PARACORD_FEDERATION_SIGNING_KEY_HEX` expects. Outbound relay refuses to
/// build a client (and therefore stages nothing) without one.
const LOCAL_SIGNING_KEY_HEX: &str =
    "5c2f1c1de0f1b4b0b64f4c0cf1a0a1a8bb1a0a15f4d3c2b1a0f9e8d7c6b5a493";

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Clears every federation env var this file sets, so one test's configuration
/// cannot leak into the next even when an assertion fails mid-test.
struct FederationEnvGuard;

impl Drop for FederationEnvGuard {
    fn drop(&mut self) {
        std::env::remove_var("PARACORD_FEDERATION_ENABLED");
        std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
        std::env::remove_var("PARACORD_FEDERATION_SIGNING_KEY_HEX");
        std::env::remove_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS");
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
}

// ── Federation wire helpers (mirrors the sibling regression files) ───────────

/// Register a trusted federated peer plus its signing key, returning the
/// signing key so tests can produce envelope/transport signatures for it.
async fn register_signed_peer(
    db: &paracord_db::DbPool,
    peer_id: i64,
    server_name: &str,
    key_id: &str,
    federation_endpoint: &str,
) -> anyhow::Result<ed25519_dalek::SigningKey> {
    let (signing_key, public_key_hex) = paracord_federation::signing::generate_keypair();
    paracord_db::federation::upsert_federated_server(
        db,
        peer_id,
        server_name,
        server_name,
        federation_endpoint,
        Some(&public_key_hex),
        Some(key_id),
        true,
    )
    .await?;
    local_service()
        .upsert_server_key(
            db,
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

/// An enabled service standing in for this server, used for the DB-only helpers
/// (`upsert_server_key`, `process_outbound_queue_once`) that need one.
fn local_service() -> paracord_federation::FederationService {
    paracord_federation::FederationService::new(paracord_federation::FederationConfig {
        enabled: true,
        server_name: TEST_DESTINATION.to_string(),
        domain: TEST_DESTINATION.to_string(),
        key_id: "ed25519:local".to_string(),
        signing_key: None,
        allow_discovery: false,
    })
}

/// Sign `envelope` in place with `signing_key` and return the wire bytes plus a
/// matching transport signature for POST `/event`.
fn sign_event(
    envelope: &mut paracord_federation::FederationEventEnvelope,
    signing_key: &ed25519_dalek::SigningKey,
    key_id: &str,
) -> anyhow::Result<(Vec<u8>, i64, String)> {
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
    Ok((
        body_bytes,
        timestamp_ms,
        paracord_federation::signing::sign(signing_key, &canonical),
    ))
}

/// Sign `envelope` in place for delivery over the *catch-up* path, which reads
/// envelopes out of a `/events` response and never sees a transport signature
/// per envelope.
fn sign_envelope_payload(
    envelope: &mut paracord_federation::FederationEventEnvelope,
    signing_key: &ed25519_dalek::SigningKey,
    key_id: &str,
) {
    let payload_sig = paracord_federation::signing::sign(
        signing_key,
        &paracord_federation::canonical_envelope_bytes(envelope),
    );
    envelope.signatures = json!({
        envelope.origin_server.clone(): { key_id: payload_sig },
    });
}

/// Build a signed POST request against a federation endpoint.
fn signed_post(
    path: &str,
    body_bytes: Vec<u8>,
    origin_header: &str,
    key_id: &str,
    signing_key: &ed25519_dalek::SigningKey,
) -> anyhow::Result<Request<Body>> {
    let timestamp_ms = chrono::Utc::now().timestamp_millis();
    let canonical =
        paracord_federation::transport::canonical_transport_bytes_with_body_and_destination(
            "POST",
            path,
            timestamp_ms,
            &body_bytes,
            TEST_DESTINATION,
        );
    let signature = paracord_federation::signing::sign(signing_key, &canonical);
    Ok(Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-paracord-origin", origin_header)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", timestamp_ms.to_string())
        .header("x-paracord-signature", signature)
        .header("x-paracord-destination", TEST_DESTINATION)
        .body(Body::from(body_bytes))?)
}

/// A minimal HTTP/1.1 peer that answers every request with one fixed body.
///
/// Deliberately hand-rolled: the point of these tests is what the *client* does
/// with a response it did not choose the size of, so the server has to be able
/// to emit bodies a well-behaved implementation never would.
struct FakePeer {
    port: u16,
    handle: tokio::task::JoinHandle<()>,
}

impl FakePeer {
    async fn serving(body: String) -> anyhow::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let _ = stream.read(&mut buf).await;
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(body.as_bytes()).await;
                    let _ = stream.flush().await;
                });
            }
        });
        Ok(Self { port, handle })
    }

    fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}/_paracord/federation/v1", self.port)
    }
}

impl Drop for FakePeer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

// ── H8.2: outbound reads must be size-bounded ────────────────────────────────

/// Twelve of the thirteen outbound reads in `FederationClient` were bare
/// `resp.json()` calls, which buffer to end of stream with no ceiling. The peer
/// chooses the response size, so a hostile-or-compromised trusted peer could
/// stream unbounded data into this server's RAM on any federation read.
///
/// The `/events` batch is the worst of them — it is the only one whose
/// legitimate size scales with anything — so it is the one asserted here, with
/// an under-cap control proving the bound does not break normal catch-up.
#[tokio::test]
async fn outbound_events_read_is_bounded_by_a_response_size_cap() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard;
    // Loopback is SSRF-blocked by default; the fake peer has to be reachable.
    std::env::set_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS", "true");

    // Structurally valid JSON that deserializes cleanly into the events
    // response — an empty event list plus 12 MiB of padding in an ignored
    // field. An unbounded reader accepts this happily; a bounded one must not
    // read it at all. The oversize is therefore attributable to the SIZE of the
    // response and nothing else.
    let oversized = format!(
        "{{\"events\":[],\"pad\":\"{}\"}}",
        "a".repeat(12 * 1024 * 1024)
    );
    let peer = FakePeer::serving(oversized).await?;
    let client = paracord_federation::client::FederationClient::new()?;

    let err = client
        .fetch_messages(&peer.endpoint(), "!1:peer.example", 0, 50)
        .await
        .expect_err("a 12 MiB /events body must be refused, not buffered");
    let message = err.to_string();
    assert!(
        message.contains("maximum accepted size"),
        "the read must fail on the size cap rather than on parsing: {message}"
    );
    drop(peer);

    // Control: the same shape under the cap still parses, so the bound rejects
    // on size and nothing else.
    let small = FakePeer::serving(
        json!({
            "events": [],
            "pad": "a".repeat(1024),
        })
        .to_string(),
    )
    .await?;
    let events = client
        .fetch_messages(&small.endpoint(), "!1:peer.example", 0, 50)
        .await
        .expect("a normally-sized /events body must still be accepted");
    assert!(events.is_empty());

    Ok(())
}

// ── H8.1: content caps must apply on every ingest path ───────────────────────

/// `validate_federation_content` (1 MiB / depth 32 / 10k elements) was applied
/// only inside the signed `POST /event` handler. The catch-up puller pulls
/// envelopes from a peer over `/events` and hands them straight to the shared
/// ingest routine, so none of those caps existed on that path: a trusted peer
/// could answer a catch-up fetch with oversized `content` and have it persisted
/// and re-fanned-out.
///
/// The oversized event here is only a few hundred KiB — well under the response
/// cap asserted above — so this fails for exactly one reason: the missing
/// content validation.
#[tokio::test]
async fn catch_up_ingest_enforces_the_content_caps() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");
    std::env::set_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS", "true");
    // Catch-up refuses to run without a signed client of our own.
    std::env::set_var("PARACORD_FEDERATION_SIGNING_KEY_HEX", LOCAL_SIGNING_KEY_HEX);

    let harness = TestHarness::new().await?;
    let peer_name = "catchup.example";
    let key_id = "ed25519:catchup";
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Two envelopes in one catch-up batch, identical except for `content`:
    // one carries an array of 10_001 elements (one past MAX_COLLECTION_LENGTH),
    // the other is a normal message. The good one is the positive control that
    // proves the catch-up path actually ran end to end.
    let build = |event_id: &str, content: Value| paracord_federation::FederationEventEnvelope {
        event_id: event_id.to_string(),
        room_id: format!("!4242:{peer_name}"),
        event_type: "m.message".to_string(),
        sender: format!("@mallory:{peer_name}"),
        origin_server: peer_name.to_string(),
        origin_ts: now_ms,
        content,
        depth: now_ms,
        state_key: None,
        signatures: json!({}),
    };
    let mut oversized = build(
        "$oversized:catchup.example",
        json!({
            "body": "hi",
            "msgtype": "m.text",
            "channel_id": "5555",
            "guild_id": "4242",
            "blob": (0..(10_000 + 1)).map(|_| 0u8).collect::<Vec<_>>(),
        }),
    );
    let mut wellformed = build(
        "$wellformed:catchup.example",
        json!({
            "body": "hi",
            "msgtype": "m.text",
            "channel_id": "5555",
            "guild_id": "4242",
        }),
    );

    // The peer's `federation_endpoint` must be known before its signing key is
    // generated, so the fake peer is stood up with a placeholder body first and
    // the real batch is served by a second instance bound to the same shape.
    let scratch = register_signed_peer(
        &harness.db,
        9901,
        peer_name,
        key_id,
        "http://127.0.0.1:1/_paracord/federation/v1",
    )
    .await?;
    sign_envelope_payload(&mut oversized, &scratch, key_id);
    sign_envelope_payload(&mut wellformed, &scratch, key_id);

    let peer =
        FakePeer::serving(json!({ "events": [oversized.clone(), wellformed.clone()] }).to_string())
            .await?;
    // Point the registered peer at the now-known fake endpoint, keeping the key.
    paracord_db::federation::upsert_federated_server(
        &harness.db,
        9901,
        peer_name,
        peer_name,
        &peer.endpoint(),
        None,
        Some(key_id),
        true,
    )
    .await?;
    // Catch-up only pulls rooms this server has a space mapping for, and the
    // mapping's local guild is a real foreign key.
    let owner_token = common::create_authenticated_user_token(
        &harness.db,
        &harness.test_app.jwt_secret,
        "catchupowner",
        "OwnerPassw0rd!",
    )
    .await?;
    let (status, me) = harness
        .request(
            Request::builder()
                .uri("/api/v1/users/@me")
                .header(header::AUTHORIZATION, format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "fetch @me failed: {me}");
    let owner_id = me["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("@me response missing id"))?
        .parse::<i64>()?;
    let local_guild_id = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&harness.db, local_guild_id, "Catchup", owner_id, None)
        .await?;
    paracord_db::federation::upsert_space_mapping(&harness.db, peer_name, "4242", local_guild_id)
        .await?;

    paracord_api::routes::federation::run_federation_catchup_once(&harness.test_app.state, 128, 64)
        .await;

    let persisted = |id: &'static str| {
        let db = harness.db.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT event_id FROM federation_events WHERE event_id = $1",
            )
            .bind(id)
            .fetch_optional(&db)
            .await
        }
    };

    // Positive control first: without it, the negative assertion below could
    // pass simply because catch-up never reached the peer.
    assert!(
        persisted("$wellformed:catchup.example").await?.is_some(),
        "the well-formed catch-up event should have been ingested; \
         without it this test proves nothing"
    );
    assert!(
        persisted("$oversized:catchup.example").await?.is_none(),
        "a catch-up envelope whose content exceeds the collection cap must be \
         rejected exactly as one arriving over POST /event is"
    );

    Ok(())
}

// ── H8.3: inbound-triggered relay fan-out must be admission-controlled ───────

/// Every accepted inbound event used to `tokio::spawn` an unbounded fan-out
/// task holding a full envelope clone and walking every trusted peer. Receivers
/// re-relay what they accept and membership events go to all peers, so the mesh
/// amplifies O(peers²) with no ceiling on tasks or sockets.
#[tokio::test]
async fn inbound_relay_fanout_is_capped_and_sheds_when_saturated() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");
    std::env::set_var("PARACORD_FEDERATION_SIGNING_KEY_HEX", LOCAL_SIGNING_KEY_HEX);

    let harness = TestHarness::new().await?;
    let origin = "relayorigin.example";
    let target = "relaytarget.example";
    let key_id = "ed25519:relay";
    let origin_key = register_signed_peer(
        &harness.db,
        9911,
        origin,
        key_id,
        "https://relayorigin.example/_paracord/federation/v1",
    )
    .await?;
    register_signed_peer(
        &harness.db,
        9912,
        target,
        key_id,
        "https://relaytarget.example/_paracord/federation/v1",
    )
    .await?;

    let staged = |db: paracord_db::DbPool| async move {
        paracord_db::federation::fetch_due_outbound_events(
            &db,
            chrono::Utc::now().timestamp_millis() + 60_000,
            200,
        )
        .await
    };

    let membership_event = |event_id: &str| {
        let now_ms = chrono::Utc::now().timestamp_millis();
        paracord_federation::FederationEventEnvelope {
            event_id: event_id.to_string(),
            room_id: format!("!7777:{origin}"),
            event_type: "m.member.join".to_string(),
            sender: format!("@alice:{origin}"),
            origin_server: origin.to_string(),
            origin_ts: now_ms,
            content: json!({ "guild_id": "7777" }),
            depth: now_ms,
            state_key: Some(format!("@alice:{origin}")),
            signatures: json!({}),
        }
    };

    // Drain every relay slot. The semaphore is process-global, which is why this
    // file serializes on `env_lock`.
    let mut held = Vec::new();
    while let Some(permit) = paracord_federation::try_acquire_relay_fanout_slot() {
        held.push(permit);
    }
    assert_eq!(
        held.len(),
        paracord_federation::MAX_CONCURRENT_RELAY_FANOUTS,
        "the relay slot pool should be exactly the documented ceiling"
    );

    let mut shed = membership_event("$shed:relayorigin.example");
    let (body, ts, sig) = sign_event(&mut shed, &origin_key, key_id)?;
    let request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-paracord-origin", origin)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", ts.to_string())
        .header("x-paracord-signature", sig)
        .header("x-paracord-destination", TEST_DESTINATION)
        .body(Body::from(body))?;
    let (status, payload) = harness.request(request).await?;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "shedding the relay must not change the ingest result: {payload}"
    );

    // Give an unbounded implementation ample opportunity to stage the relay.
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    let rows = staged(harness.db.clone()).await?;
    assert!(
        rows.is_empty(),
        "with every relay slot taken the fan-out must be shed, not spawned anyway: {:?}",
        rows.iter()
            .map(|row| row.event_id.as_str())
            .collect::<Vec<_>>()
    );

    // Positive control: release the slots and the very next event relays
    // normally, so the assertion above is about admission control and not about
    // relaying being broken outright.
    drop(held);
    let mut relayed = membership_event("$relayed:relayorigin.example");
    let (body, ts, sig) = sign_event(&mut relayed, &origin_key, key_id)?;
    let request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-paracord-origin", origin)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", ts.to_string())
        .header("x-paracord-signature", sig)
        .header("x-paracord-destination", TEST_DESTINATION)
        .body(Body::from(body))?;
    let (status, payload) = harness.request(request).await?;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "control ingest failed: {payload}"
    );

    let mut relayed_ok = false;
    for _ in 0..200 {
        let rows = staged(harness.db.clone()).await?;
        if rows
            .iter()
            .any(|row| row.event_id == "$relayed:relayorigin.example")
        {
            relayed_ok = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(
        relayed_ok,
        "with slots available the relay must still stage the event for the peer"
    );

    Ok(())
}

// ── H9: the delivery-attempt log must be bounded ─────────────────────────────

/// `record_delivery_attempt` appends one row per outbound POST and there was no
/// `DELETE FROM federation_delivery_attempts` anywhere in the codebase. A peer
/// that is merely unreachable therefore wrote ~13 rows per event (1 immediate +
/// the 12 queue retries) and kept every one of them forever.
///
/// Driven through `process_outbound_queue_once` rather than by calling the
/// purge directly, so the test covers the wiring and not just the query.
#[tokio::test]
async fn delivery_attempt_log_is_pruned_by_the_outbound_queue_pass() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard;

    let harness = TestHarness::new().await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let retention = paracord_federation::DELIVERY_ATTEMPT_RETENTION_MS;

    // One attempt just inside the retention window and one an hour past it.
    let fresh_ts = now_ms - 60_000;
    let stale_ts = now_ms - retention - 3_600_000;
    for (event_id, ts) in [
        ("$fresh:peer.example", fresh_ts),
        ("$stale:peer.example", stale_ts),
    ] {
        paracord_db::federation::record_delivery_attempt(
            &harness.db,
            "peer.example",
            event_id,
            false,
            None,
            Some("connection refused"),
            Some(12),
            ts,
        )
        .await?;
    }

    local_service()
        .process_outbound_queue_once(&harness.db, 8)
        .await;

    let remaining: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT event_id FROM federation_delivery_attempts ORDER BY attempted_at_ms ASC",
    )
    .fetch_all(&harness.db)
    .await?;

    assert!(
        remaining.iter().any(|id| id == "$fresh:peer.example"),
        "an attempt inside the retention window must be kept: {remaining:?}"
    );
    assert!(
        !remaining.iter().any(|id| id == "$stale:peer.example"),
        "an attempt older than the retention window must be purged: {remaining:?}"
    );

    Ok(())
}

// ── MEDIUM: no unauthenticated parsing before the signature check ────────────

/// Six unauthenticated, internet-reachable federation endpoints ran
/// `serde_json::from_slice` over the whole request body *before* any signature
/// was checked, because they needed `body.origin_server` to pass as the expected
/// origin. Verification depends only on the raw bytes, so it now runs first and
/// the body/header origin binding is checked after parsing.
#[tokio::test]
async fn unauthenticated_federation_posts_are_rejected_before_the_body_is_parsed(
) -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");

    let harness = TestHarness::new().await?;

    // Syntactically broken JSON: a handler that parses first answers 400 and in
    // doing so admits it did the parsing work. A handler that verifies first
    // never gets far enough to look at the body.
    let malformed = "{\"origin_server\": \"peer.example\", ";
    for path in [
        "/_paracord/federation/v1/invite",
        "/_paracord/federation/v1/join",
        "/_paracord/federation/v1/leave",
        "/_paracord/federation/v1/media/token",
        "/_paracord/federation/v1/media/relay",
        "/_paracord/federation/v1/file/token",
    ] {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(malformed))?;
        let (status, payload) = harness.request(request).await?;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{path} must reject an unsigned request before parsing its body, got {status}: {payload}"
        );
    }

    Ok(())
}

/// Moving verification ahead of parsing must not weaken the binding between the
/// body's self-declared `origin_server` and the peer that actually signed the
/// transport. Both halves are asserted: a mismatch is refused, a match is not.
#[tokio::test]
async fn body_origin_is_still_bound_to_the_transport_signer() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");

    let harness = TestHarness::new().await?;
    let peer = "binding.example";
    let key_id = "ed25519:binding";
    let peer_key = register_signed_peer(
        &harness.db,
        9921,
        peer,
        key_id,
        "https://binding.example/_paracord/federation/v1",
    )
    .await?;

    let leave_body = |origin_server: &str| {
        serde_json::to_vec(&json!({
            "origin_server": origin_server,
            "room_id": format!("!123:{TEST_DESTINATION}"),
            "user_id": format!("@alice:{peer}"),
        }))
        .expect("leave body serializes")
    };

    // Signed by `peer`, but the body claims to speak for someone else.
    let (status, payload) = harness
        .request(signed_post(
            "/_paracord/federation/v1/leave",
            leave_body("someone.else.example"),
            peer,
            key_id,
            &peer_key,
        )?)
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a body origin that disagrees with the signing peer must be refused: {payload}"
    );

    // Same request with the origins agreeing goes through.
    let (status, payload) = harness
        .request(signed_post(
            "/_paracord/federation/v1/leave",
            leave_body(peer),
            peer,
            key_id,
            &peer_key,
        )?)
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "a correctly signed leave from the declared origin must still succeed: {payload}"
    );

    Ok(())
}

// ── MEDIUM: moderation-list applies must be batch-bounded ────────────────────

/// `apply_moderation_entries` does a peer-name resolution plus a trust-state
/// upsert per entry, over a list supplied by a subscribed (admin-configured but
/// possibly hostile) source whose body cap allows well over a hundred thousand
/// minimal entries.
#[tokio::test]
async fn moderation_list_apply_is_bounded_by_entry_count() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    let _env = FederationEnvGuard;

    let harness = TestHarness::new().await?;
    let token = common::create_authenticated_user_token(
        &harness.db,
        &harness.test_app.jwt_secret,
        "modadmin",
        "Adm1nPassw0rd!",
    )
    .await?;
    let me = harness
        .request(
            Request::builder()
                .uri("/api/v1/users/@me")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    let user_id = me.1["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("@me response missing id"))?
        .parse::<i64>()?;
    let user = paracord_db::users::get_user_by_id(&harness.db, user_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("admin user missing"))?;
    paracord_db::users::update_user_flags(
        &harness.db,
        user_id,
        user.flags | paracord_core::USER_FLAG_ADMIN,
    )
    .await?;

    let apply = |entries: Vec<Value>| {
        let token = token.clone();
        async move {
            Request::builder()
                .method("POST")
                .uri("/_paracord/federation/v1/moderation/apply")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(
                    json!({ "source": "test-list", "entries": entries }).to_string(),
                ))
        }
    };

    // Control first: a realistically-sized list still applies.
    let (status, payload) = harness
        .request(
            apply(
                (0..8)
                    .map(|i| json!({ "server_name": format!("blocked{i}.example"), "action": "block" }))
                    .collect(),
            )
            .await?,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "a small list must still apply: {payload}"
    );
    assert_eq!(payload["applied"], json!(8));

    // One entry past the cap is refused outright rather than truncated, so an
    // operator is never told a block landed when only part of the list did.
    let (status, payload) = harness
        .request(
            apply(
                (0..10_001)
                    .map(|i| json!({ "server_name": format!("flood{i}.example"), "action": "block" }))
                    .collect(),
            )
            .await?,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a list past the per-apply entry cap must be refused: {payload}"
    );

    Ok(())
}
