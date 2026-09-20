//! Exploit-path regressions for transport authentication and federation namespaces.
mod common;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use common::{build_test_app, dispatch_json, TestApp, TestAppOptions};
use ed25519_dalek::SigningKey;
use paracord_federation::{
    FederationConfig, FederationEventEnvelope, FederationServerKey, FederationService,
};
use serde_json::json;
use std::sync::OnceLock;
use tokio::sync::{Mutex, MutexGuard};
use tower::ServiceExt;

const PEER: &str = "peer.example";
const KEY: &str = "ed25519:test";
const EVENT_PATH: &str = "/_paracord/federation/v1/event";

struct EnvGuard {
    _guard: MutexGuard<'static, ()>,
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        std::env::remove_var("PARACORD_FEDERATION_ENABLED");
        std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
        std::env::remove_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS");
    }
}
async fn environment() -> EnvGuard {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = LOCK.get_or_init(|| Mutex::new(())).lock().await;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");
    EnvGuard { _guard: guard }
}

fn service(signing_key: Option<SigningKey>) -> FederationService {
    FederationService::new(FederationConfig {
        enabled: true,
        server_name: "localhost".into(),
        domain: "localhost".into(),
        key_id: KEY.into(),
        signing_key,
        allow_discovery: false,
    })
}

async fn peer(app: &TestApp, name: &str) -> anyhow::Result<SigningKey> {
    let (key, public_key) = paracord_federation::signing::generate_keypair();
    paracord_db::federation::upsert_federated_server(
        &app.db,
        paracord_util::snowflake::generate(1),
        name,
        name,
        "https://federation.invalid/_paracord/federation/v1",
        Some(&public_key),
        Some(KEY),
        true,
    )
    .await?;
    service(None)
        .upsert_server_key(
            &app.db,
            &FederationServerKey {
                server_name: name.into(),
                key_id: KEY.into(),
                public_key,
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;
    Ok(key)
}

fn signed_request(
    method: &str,
    path: &str,
    body: Vec<u8>,
    origin: &str,
    key: &SigningKey,
    ts: i64,
) -> Request<Body> {
    let canonical =
        paracord_federation::transport::canonical_transport_bytes_with_body_and_destination(
            method,
            path,
            ts,
            &body,
            "localhost",
        );
    Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-paracord-origin", origin)
        .header("x-paracord-key-id", KEY)
        .header("x-paracord-timestamp", ts.to_string())
        .header(
            "x-paracord-signature",
            paracord_federation::signing::sign(key, &canonical),
        )
        .header("x-paracord-destination", "localhost")
        .body(Body::from(body))
        .unwrap()
}

fn message(origin: &str, guild: i64, channel: i64, id: &str) -> FederationEventEnvelope {
    let now = chrono::Utc::now().timestamp_millis();
    FederationEventEnvelope {
        event_id: format!("${id}:{origin}"),
        room_id: format!("!{guild}:{origin}"),
        event_type: "m.message".into(),
        sender: format!("@alice:{origin}"),
        origin_server: origin.into(),
        origin_ts: now,
        content: json!({"guild_id": guild.to_string(), "channel_id": channel.to_string(), "message_id": id, "body": "original", "channel_type": 0}),
        depth: now,
        state_key: None,
        signatures: json!({}),
    }
}

async fn ingest(
    app: &TestApp,
    key: &SigningKey,
    mut event: FederationEventEnvelope,
) -> anyhow::Result<StatusCode> {
    event.signatures = json!({event.origin_server.clone(): {KEY: paracord_federation::signing::sign(key, &paracord_federation::canonical_envelope_bytes(&event))}});
    let request = signed_request(
        "POST",
        EVENT_PATH,
        serde_json::to_vec(&event)?,
        &event.origin_server,
        key,
        chrono::Utc::now().timestamp_millis(),
    );
    Ok(dispatch_json(&app.app, request).await?.0)
}

#[tokio::test]
async fn extreme_unsigned_timestamps_are_rejected_without_panicking() -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let (key, _) = paracord_federation::signing::generate_keypair();
    for ts in [i64::MIN, i64::MAX, -1, 0] {
        let request = signed_request("POST", EVENT_PATH, b"{}".to_vec(), PEER, &key, ts);
        assert_eq!(
            dispatch_json(&app.app, request).await?.0,
            StatusCode::UNAUTHORIZED
        );
    }
    Ok(())
}

#[tokio::test]
async fn hexadecimal_case_and_duplicate_key_ids_do_not_bypass_replay_detection(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let alias = "ed25519:alias";
    service(None)
        .upsert_server_key(
            &app.db,
            &FederationServerKey {
                server_name: PEER.into(),
                key_id: alias.into(),
                public_key: paracord_federation::hex_encode(&key.verifying_key().to_bytes()),
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;
    let ts = chrono::Utc::now().timestamp_millis();
    let path = "/_paracord/federation/v1/invite";
    let body = serde_json::to_vec(
        &json!({"origin_server": PEER,"room_id":"!42:localhost","sender":"@alice:peer.example"}),
    )?;
    // Exactly one concurrent request authenticates and consumes its nonce,
    // even though guild 42 does not exist. The other sees the atomic replay claim.
    let (first, second) = tokio::join!(
        dispatch_json(
            &app.app,
            signed_request("POST", path, body.clone(), PEER, &key, ts)
        ),
        dispatch_json(
            &app.app,
            signed_request("POST", path, body.clone(), PEER, &key, ts)
        ),
    );
    let mut statuses = [first?.0.as_u16(), second?.0.as_u16()];
    statuses.sort_unstable();
    assert_eq!(
        statuses,
        [
            StatusCode::NOT_FOUND.as_u16(),
            StatusCode::CONFLICT.as_u16()
        ]
    );
    for (uppercase, key_id) in [(true, KEY), (false, alias)] {
        let mut request = signed_request("POST", path, body.clone(), PEER, &key, ts);
        if uppercase {
            let sig = request.headers()["x-paracord-signature"]
                .to_str()?
                .to_ascii_uppercase();
            request
                .headers_mut()
                .insert("x-paracord-signature", sig.parse()?);
        }
        request
            .headers_mut()
            .insert("x-paracord-key-id", key_id.parse()?);
        assert_eq!(
            dispatch_json(&app.app, request).await?.0,
            StatusCode::CONFLICT
        );
    }
    Ok(())
}

#[tokio::test]
async fn room_content_and_message_targets_cannot_cross_guilds_or_bypass_revocation(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 101, "first")).await?,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        ingest(&app, &key, message(PEER, 200, 201, "second")).await?,
        StatusCode::ACCEPTED
    );
    let first = paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "first")
        .await?
        .unwrap();
    let second = paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "second")
        .await?
        .unwrap();
    let mut wrong_guild = message(PEER, 100, 201, "wrong-guild");
    wrong_guild.content["guild_id"] = json!("200");
    assert_eq!(
        ingest(&app, &key, wrong_guild).await?,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 201, "wrong-channel")).await?,
        StatusCode::FORBIDDEN
    );
    let mut edit = message(PEER, 100, 101, "wrong-edit");
    edit.event_type = "m.message.edit".into();
    edit.content["message_id"] = json!("second");
    edit.content["body"] = json!("tampered");
    assert_eq!(ingest(&app, &key, edit).await?, StatusCode::FORBIDDEN);
    assert_eq!(
        paracord_db::messages::get_message(&app.db, second)
            .await?
            .unwrap()
            .content
            .as_deref(),
        Some("original")
    );

    std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
    for kind in ["m.message.edit", "m.message.delete", "m.reaction.add"] {
        let mut event = message(PEER, 100, 101, kind);
        event.event_type = kind.into();
        event.content = json!({"message_id": "first", "body": "tampered", "emoji": "x"});
        assert_eq!(ingest(&app, &key, event).await?, StatusCode::FORBIDDEN);
    }
    assert_eq!(
        paracord_db::messages::get_message(&app.db, first)
            .await?
            .unwrap()
            .content
            .as_deref(),
        Some("original")
    );
    assert!(
        paracord_db::reactions::get_message_reactions(&app.db, first)
            .await?
            .is_empty()
    );

    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");
    let mut legitimate = message(PEER, 100, 101, "valid-edit");
    legitimate.event_type = "m.message.edit".into();
    legitimate.content = json!({"message_id": "first", "body": "legitimate edit"});
    assert_eq!(ingest(&app, &key, legitimate).await?, StatusCode::ACCEPTED);
    assert_eq!(
        paracord_db::messages::get_message(&app.db, first)
            .await?
            .unwrap()
            .content
            .as_deref(),
        Some("legitimate edit")
    );
    Ok(())
}

#[tokio::test]
async fn numeric_ids_cannot_claim_another_origins_mirrored_space_or_channel() -> anyhow::Result<()>
{
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let victim = peer(&app, PEER).await?;
    let attacker = peer(&app, "attacker.example").await?;
    assert_eq!(
        ingest(&app, &victim, message(PEER, 100, 101, "victim")).await?,
        StatusCode::ACCEPTED
    );
    let victim_space = paracord_db::federation::get_space_mapping_by_remote(&app.db, PEER, "100")
        .await?
        .unwrap();
    let victim_channel =
        paracord_db::federation::get_channel_mapping_by_remote(&app.db, PEER, "101")
            .await?
            .unwrap();
    let attack = message(
        "attacker.example",
        victim_space.local_guild_id,
        victim_channel.local_channel_id,
        "attack",
    );
    assert_eq!(ingest(&app, &attacker, attack).await?, StatusCode::ACCEPTED);
    let attack_space = paracord_db::federation::get_space_mapping_by_remote(
        &app.db,
        "attacker.example",
        &victim_space.local_guild_id.to_string(),
    )
    .await?
    .unwrap();
    let attack_channel = paracord_db::federation::get_channel_mapping_by_remote(
        &app.db,
        "attacker.example",
        &victim_channel.local_channel_id.to_string(),
    )
    .await?
    .unwrap();
    assert_ne!(victim_space.local_guild_id, attack_space.local_guild_id);
    assert_ne!(
        victim_channel.local_channel_id,
        attack_channel.local_channel_id
    );
    Ok(())
}

#[tokio::test]
async fn stolen_file_capability_requires_its_audiences_transport_signature() -> anyhow::Result<()> {
    use hmac::{Hmac, Mac};
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let outsider = peer(&app, "outsider.example").await?;
    paracord_db::attachments::create_attachment(
        &app.db,
        9001,
        None,
        "secret.txt",
        Some("text/plain"),
        6,
        "/unused",
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await?;
    app.state
        .storage_backend
        .store("attachments/9001.txt", b"secret")
        .await?;
    let payload = format!("v2:9001:{}:{PEER}", chrono::Utc::now().timestamp() + 300);
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(app.jwt_secret.as_bytes())?;
    mac.update(payload.as_bytes());
    let token = format!(
        "{payload}.{}",
        paracord_federation::hex_encode(&mac.finalize().into_bytes())
    );
    let path = format!("/_paracord/federation/v1/file/9001?token={token}");
    let unsigned = Request::builder()
        .uri(&path)
        .header("x-paracord-origin", PEER)
        .body(Body::empty())?;
    assert_eq!(
        app.app.clone().oneshot(unsigned).await?.status(),
        StatusCode::UNAUTHORIZED
    );
    let wrong_peer = signed_request(
        "GET",
        &path,
        vec![],
        "outsider.example",
        &outsider,
        chrono::Utc::now().timestamp_millis(),
    );
    assert_eq!(
        app.app.clone().oneshot(wrong_peer).await?.status(),
        StatusCode::UNAUTHORIZED
    );
    let signed = signed_request(
        "GET",
        &path,
        vec![],
        PEER,
        &key,
        chrono::Utc::now().timestamp_millis(),
    );
    let response = app.app.clone().oneshot(signed).await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 100).await?.as_ref(),
        b"secret"
    );

    // Real sender/receiver HTTP round trip: the sender addresses the receiver
    // by its federation identity, even though it is dialed on an IP endpoint.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = listener.local_addr()?;
    let router = app.app.clone();
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    std::env::set_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS", "true");
    let client =
        paracord_federation::client::FederationClient::new_signed(PEER.into(), KEY.into(), key)?;
    // Different spelling of the equivalent query gives this request its own
    // signed path and replay nonce, independent of millisecond clock granularity.
    let downloaded = client
        .download_federated_file_from_peer_with_limit(
            &format!("http://{endpoint}{path}&transfer=roundtrip"),
            "localhost",
            100,
        )
        .await;
    server.abort();
    assert_eq!(downloaded?.0, b"secret");
    Ok(())
}

#[tokio::test]
async fn legacy_mirrors_with_persisted_room_evidence_continue_to_receive_messages(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    paracord_db::users::create_user(
        &app.db,
        0,
        "federation",
        0,
        "federation@local.invalid",
        "!federated!",
    )
    .await?;
    paracord_db::guilds::create_guild(&app.db, 100, "Legacy mirror", 0, None).await?;
    paracord_db::roles::create_role(
        &app.db,
        100,
        100,
        "@everyone",
        paracord_models::permissions::Permissions::default().bits(),
    )
    .await?;
    paracord_db::channels::create_channel(&app.db, 101, 100, "general", 0, 0, None, None).await?;
    paracord_db::federation::upsert_room_membership(
        &app.db,
        "!100:peer.example",
        "@legacy:peer.example",
        0,
        100,
    )
    .await?;
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 101, "legacy-next")).await?,
        StatusCode::ACCEPTED
    );
    let mapping = paracord_db::federation::get_channel_mapping_by_remote(&app.db, PEER, "101")
        .await?
        .unwrap();
    assert_eq!(mapping.local_channel_id, 101);
    let id = paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "legacy-next")
        .await?
        .unwrap();
    assert_eq!(
        paracord_db::messages::get_message(&app.db, id)
            .await?
            .unwrap()
            .channel_id,
        101
    );
    Ok(())
}

#[tokio::test]
async fn remote_quarantine_cannot_weaken_local_blocks_or_shorten_quarantines() -> anyhow::Result<()>
{
    let app = build_test_app(TestAppOptions::default()).await?;
    let now = chrono::Utc::now().timestamp_millis();
    for (name, mode, until) in [
        ("blocked.example", "block", None),
        ("quarantined.example", "quarantine", Some(now + 600_000)),
    ] {
        paracord_db::federation::upsert_peer_trust_state(
            &app.db,
            name,
            mode,
            Some("local restriction"),
            until,
            now,
        )
        .await?;
        paracord_db::federation::restrict_peer_trust_state(
            &app.db,
            name,
            "quarantine",
            Some("remote downgrade"),
            Some(now + 60_000),
            now + 1,
        )
        .await?;
        let entries = paracord_db::federation::list_peer_trust_states(&app.db).await?;
        let entry = entries
            .iter()
            .find(|entry| entry.server_name == name)
            .unwrap();
        assert_eq!(entry.mode, mode);
        assert_eq!(entry.quarantined_until_ms, until);
        assert_eq!(entry.reason.as_deref(), Some("local restriction"));
    }
    paracord_db::federation::restrict_peer_trust_state(
        &app.db,
        "quarantined.example",
        "block",
        Some("stronger restriction"),
        None,
        now + 2,
    )
    .await?;
    let entries = paracord_db::federation::list_peer_trust_states(&app.db).await?;
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.server_name == "quarantined.example")
            .unwrap()
            .mode,
        "block"
    );
    Ok(())
}

#[tokio::test]
async fn blocked_peer_never_receives_initial_outbound_delivery() -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    paracord_db::federation::upsert_peer_trust_state(
        &app.db,
        PEER,
        "block",
        None,
        None,
        chrono::Utc::now().timestamp_millis(),
    )
    .await?;
    let mut event = message("localhost", 100, 101, "outbound");
    event.event_type = "m.member.join".into();
    service(Some(key))
        .forward_envelope_to_peers(&app.db, &event)
        .await;
    let staged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM federation_outbound_queue")
        .fetch_one(&app.db)
        .await?;
    assert_eq!(
        staged, 0,
        "moderation must prevent the first send, before queue retries"
    );
    Ok(())
}

#[tokio::test]
async fn local_accounts_cannot_squat_federation_system_or_remote_identity_credentials(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let digest = paracord_federation::transport::sha256_hex(b"@alice:peer.example");
    paracord_db::users::create_user(
        &app.db,
        5001,
        "federated",
        0,
        "federated@local.invalid",
        "hash",
    )
    .await?;
    paracord_db::users::create_user(
        &app.db,
        5002,
        &format!("alice_{}", &digest[..6]),
        0,
        &format!("fed+{}@remote.invalid", &digest[..24]),
        "hash",
    )
    .await?;
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 101, "unsquattable")).await?,
        StatusCode::ACCEPTED
    );
    let mapping = paracord_db::federation::get_remote_user_mapping(&app.db, "@alice:peer.example")
        .await?
        .unwrap();
    assert_ne!(mapping.local_user_id, 5002);
    let user = paracord_db::users::get_user_by_id(&app.db, mapping.local_user_id)
        .await?
        .unwrap();
    assert!(paracord_util::validation::is_valid_new_username(&user.username).is_err());
    let auth_user = paracord_db::users::get_user_auth_by_id(&app.db, mapping.local_user_id)
        .await?
        .unwrap();
    assert!(paracord_util::validation::validate_email(&auth_user.email).is_err());
    assert!(
        paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "unsquattable")
            .await?
            .is_some()
    );
    Ok(())
}

#[tokio::test]
async fn stored_history_honors_revoked_federation_and_private_channel_controls(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 101, "history")).await?,
        StatusCode::ACCEPTED
    );
    let space = paracord_db::federation::get_space_mapping_by_remote(&app.db, PEER, "100")
        .await?
        .unwrap();
    let channel = paracord_db::federation::get_channel_mapping_by_remote(&app.db, PEER, "101")
        .await?
        .unwrap();
    paracord_db::federation::upsert_room_membership(
        &app.db,
        "!100:peer.example",
        "@reader:peer.example",
        0,
        space.local_guild_id,
    )
    .await?;
    let path = "/_paracord/federation/v1/events?room_id=!100:peer.example";
    let read = || {
        signed_request(
            "GET",
            path,
            vec![],
            PEER,
            &key,
            chrono::Utc::now().timestamp_millis(),
        )
    };
    assert_eq!(
        dispatch_json(&app.app, read()).await?.1["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut edit = message(PEER, 100, 101, "history-edit");
    edit.event_type = "m.message.edit".into();
    edit.content = json!({"message_id": "history", "body": "edited history"});
    assert_eq!(ingest(&app, &key, edit).await?, StatusCode::ACCEPTED);
    std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
    assert!(dispatch_json(&app.app, read()).await?.1["events"]
        .as_array()
        .unwrap()
        .is_empty());
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &app.db,
        channel.local_channel_id,
        space.local_guild_id,
        0,
        0,
        paracord_models::permissions::Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;
    assert!(dispatch_json(&app.app, read()).await?.1["events"]
        .as_array()
        .unwrap()
        .is_empty());
    let get = signed_request(
        "GET",
        "/_paracord/federation/v1/event/$history:peer.example",
        vec![],
        PEER,
        &key,
        chrono::Utc::now().timestamp_millis(),
    );
    assert_eq!(dispatch_json(&app.app, get).await?.0, StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn zero_depth_envelopes_keep_valid_signatures_and_event_ids_cannot_be_squatted(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let attacker = peer(&app, "attacker.example").await?;
    let mut forged = message("attacker.example", 300, 301, "forged");
    forged.event_id = "$legacy:peer.example".into();
    assert_eq!(
        ingest(&app, &attacker, forged).await?,
        StatusCode::FORBIDDEN
    );
    let mut legacy = message(PEER, 100, 101, "legacy");
    legacy.depth = 0;
    let valid_signature = paracord_federation::signing::sign(
        &key,
        &paracord_federation::canonical_envelope_bytes(&legacy),
    );
    legacy.signatures = json!({PEER: {KEY: valid_signature, "ed25519:000-expired": "00"}});
    let request = signed_request(
        "POST",
        EVENT_PATH,
        serde_json::to_vec(&legacy)?,
        PEER,
        &key,
        chrono::Utc::now().timestamp_millis(),
    );
    assert_eq!(
        dispatch_json(&app.app, request).await?.0,
        StatusCode::ACCEPTED
    );
    let stored = service(None)
        .fetch_event(&app.db, &legacy.event_id)
        .await?
        .unwrap();
    assert_eq!(stored.depth, 0);
    paracord_federation::signing::verify(
        &paracord_federation::canonical_envelope_bytes(&stored),
        &valid_signature,
        &paracord_federation::hex_encode(&key.verifying_key().to_bytes()),
    )?;
    assert_eq!(
        service(None)
            .list_room_events(&app.db, &legacy.room_id, 0, 10)
            .await?
            .len(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn federated_file_cache_encrypts_at_rest_and_decrypts_cache_hits() -> anyhow::Result<()> {
    use axum::{
        extract::{Path, Query, State},
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let _env = environment().await;
    std::env::set_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS", "true");
    let app = build_test_app(TestAppOptions::default()).await?;
    let mut state = app.state.clone();
    state.federation_service = Some(service(Some(SigningKey::from_bytes(&[7; 32]))));
    state.config.file_cryptor = Some(paracord_util::at_rest::FileCryptor::from_master_key(
        &[4; 32], false,
    ));
    state.config.federation_file_cache_enabled = true;
    state.config.federation_file_cache_max_size = 1024;
    state.config.federation_file_cache_ttl_hours = 1;
    paracord_db::server_settings::set_setting(&app.db, "federation_file_cache_enabled", "true")
        .await?;
    paracord_db::users::create_user(&app.db, 123, "reader", 0, "reader@example.test", "hash")
        .await?;
    paracord_db::guilds::create_guild(&app.db, 100, "Mirror", 123, None).await?;
    paracord_db::members::add_member(&app.db, 123, 100).await?;
    paracord_db::channels::create_channel(&app.db, 101, 100, "general", 0, 0, None, None).await?;
    paracord_db::federation::upsert_space_mapping(&app.db, PEER, "100", 100).await?;
    let hits = Arc::new(AtomicUsize::new(0));
    let hit_counter = hits.clone();
    let remote = Router::new()
        .route(
            "/_paracord/federation/v1/file/token",
            post(|| async {
                Json(json!({"token":"test","download_url":"/content", "expires_in_seconds":300}))
            }),
        )
        .route(
            "/content",
            get(move || {
                let counter = hit_counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    "sensitive cached file"
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/_paracord/federation/v1", listener.local_addr()?);
    let server = tokio::spawn(async move { axum::serve(listener, remote).await });
    paracord_db::federation::upsert_federated_server(
        &app.db, 7, PEER, PEER, &endpoint, None, None, true,
    )
    .await?;
    for attempt in 0..5 {
        if attempt >= 2 {
            let cryptor = state.config.file_cryptor.as_ref().unwrap();
            let replacement = match attempt {
                2 => b"legacy plaintext under strict encryption".to_vec(),
                3 => {
                    let mut legacy = cryptor.encrypt(b"unrelated legacy attachment")?;
                    legacy[..8].copy_from_slice(b"PRCENC01");
                    legacy
                }
                _ => cryptor
                    .encrypt_with_aad(b"unrelated cache", b"federation-cache:peer.example:9002")?,
            };
            state
                .storage_backend
                .store("fed-cache/peer.example/9001", &replacement)
                .await?;
        }
        let response = paracord_api::routes::files::download_federated_file(
            State(state.clone()),
            paracord_api::middleware::AuthUser {
                user_id: 123,
                session_id: None,
                token_jti: None,
            },
            Path((PEER.to_string(), "9001".to_string())),
            Query(paracord_api::routes::files::FederatedFileQuery {
                channel_id: Some(101),
            }),
        )
        .await?
        .into_response();
        assert_eq!(
            to_bytes(response.into_body(), 100).await?.as_ref(),
            b"sensitive cached file"
        );
    }
    server.abort();
    assert_eq!(
        hits.load(Ordering::SeqCst),
        4,
        "the valid cache hits once; plaintext, V1 and relocated V2 each refetch"
    );
    let cached = paracord_db::federation_file_cache::get_cached_file(&app.db, PEER, "9001")
        .await?
        .unwrap();
    let bytes = state.storage_backend.retrieve(&cached.storage_key).await?;
    assert!(paracord_util::at_rest::FileCryptor::payload_is_encrypted(
        &bytes
    ));
    let cryptor = state.config.file_cryptor.as_ref().unwrap();
    assert_eq!(
        cryptor.decrypt_with_aad(&bytes, b"federation-cache:peer.example:9001")?,
        b"sensitive cached file"
    );
    assert!(cryptor
        .decrypt_with_aad(&bytes, b"federation-cache:peer.example:9002")
        .is_err());
    Ok(())
}

#[tokio::test]
async fn participants_can_reply_to_locally_owned_rooms_without_cloning_them() -> anyhow::Result<()>
{
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    paracord_db::users::create_user(&app.db, 123, "owner", 0, "owner@example.test", "hash").await?;
    for (guild, channel) in [(100, 101), (200, 201)] {
        paracord_db::guilds::create_guild(&app.db, guild, "Local guild", 123, None).await?;
        paracord_db::roles::create_role(
            &app.db,
            guild,
            guild,
            "@everyone",
            paracord_models::permissions::Permissions::default().bits(),
        )
        .await?;
        paracord_db::channels::create_channel(&app.db, channel, guild, "general", 0, 0, None, None)
            .await?;
    }
    paracord_db::federation::upsert_room_membership(
        &app.db,
        "!100:localhost",
        "@alice:peer.example",
        123,
        100,
    )
    .await?;
    std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "100");
    let mut reply = message(PEER, 100, 101, "local-reply");
    reply.room_id = "!100:localhost".into();
    assert_eq!(
        ingest(&app, &key, reply.clone()).await?,
        StatusCode::ACCEPTED
    );
    let local_id =
        paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "local-reply")
            .await?
            .unwrap();
    let stored = paracord_db::messages::get_message(&app.db, local_id)
        .await?
        .unwrap();
    assert_eq!(stored.channel_id, 101);
    let mut edit = reply.clone();
    edit.event_id = "$local-reply-edit:peer.example".into();
    edit.event_type = "m.message.edit".into();
    edit.content["body"] = json!("edited reply");
    assert_eq!(ingest(&app, &key, edit).await?, StatusCode::ACCEPTED);
    assert_eq!(
        paracord_db::messages::get_message(&app.db, local_id)
            .await?
            .unwrap()
            .content
            .as_deref(),
        Some("edited reply")
    );
    for channel in [201, 999] {
        let mut invalid = reply.clone();
        invalid.event_id = format!("$bad-channel-{channel}:peer.example");
        invalid.content["channel_id"] = json!(channel.to_string());
        assert_eq!(ingest(&app, &key, invalid).await?, StatusCode::FORBIDDEN);
    }
    assert_eq!(
        paracord_db::guilds::list_all_guilds(&app.db).await?.len(),
        2
    );
    assert!(
        paracord_db::federation::get_space_mapping_by_remote(&app.db, "localhost", "100")
            .await?
            .is_none()
    );
    Ok(())
}

#[tokio::test]
async fn history_pages_skip_hidden_events_and_resume_equal_depth_events() -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let depth = chrono::Utc::now().timestamp_millis();
    for (id, channel) in [("A-hidden", 101), ("B-visible", 102), ("a-visible", 102)] {
        let mut event = message(PEER, 100, channel, id);
        event.origin_ts = depth;
        event.depth = depth;
        assert_eq!(ingest(&app, &key, event).await?, StatusCode::ACCEPTED);
    }
    let space = paracord_db::federation::get_space_mapping_by_remote(&app.db, PEER, "100")
        .await?
        .unwrap();
    let hidden = paracord_db::federation::get_channel_mapping_by_remote(&app.db, PEER, "101")
        .await?
        .unwrap();
    paracord_db::federation::upsert_room_membership(
        &app.db,
        "!100:peer.example",
        "@reader:peer.example",
        0,
        space.local_guild_id,
    )
    .await?;
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &app.db,
        hidden.local_channel_id,
        space.local_guild_id,
        0,
        0,
        paracord_models::permissions::Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;
    let path = "/_paracord/federation/v1/events?room_id=!100:peer.example&limit=1";
    let request = signed_request(
        "GET",
        path,
        vec![],
        PEER,
        &key,
        chrono::Utc::now().timestamp_millis(),
    );
    let (status, first) = dispatch_json(&app.app, request).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["events"][0]["event_id"], "$B-visible:peer.example");
    assert_eq!(first["events"].as_array().unwrap().len(), 1);
    let path = format!(
        "{path}&since_depth={}&since_event_id={}",
        first["next_depth"],
        first["next_event_id"].as_str().unwrap()
    );
    let request = signed_request(
        "GET",
        &path,
        vec![],
        PEER,
        &key,
        chrono::Utc::now().timestamp_millis(),
    );
    let (status, second) = dispatch_json(&app.app, request).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["events"][0]["event_id"], "$a-visible:peer.example");
    assert_eq!(second["events"].as_array().unwrap().len(), 1);
    // The persistent cursor uses the same tie-breaker and cannot move backwards.
    paracord_db::federation::upsert_room_sync_position(
        &app.db,
        PEER,
        "!100:peer.example",
        depth,
        Some("$B-visible:peer.example"),
        depth,
    )
    .await?;
    paracord_db::federation::upsert_room_sync_position(
        &app.db,
        PEER,
        "!100:peer.example",
        depth,
        Some("$a-visible:peer.example"),
        depth,
    )
    .await?;
    paracord_db::federation::upsert_room_sync_position(
        &app.db,
        PEER,
        "!100:peer.example",
        depth,
        Some("$A-hidden:peer.example"),
        depth,
    )
    .await?;
    assert_eq!(
        paracord_db::federation::get_room_sync_position(&app.db, PEER, "!100:peer.example").await?,
        (depth, Some("$a-visible:peer.example".into()))
    );
    Ok(())
}

#[tokio::test]
async fn catchup_advances_hidden_pages_without_accepting_poisoned_cursors() -> anyhow::Result<()> {
    use axum::{routing::get, Json, Router};
    use std::sync::Arc;
    let _env = environment().await;
    std::env::set_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS", "true");
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 101, "bootstrap")).await?,
        StatusCode::ACCEPTED
    );
    let mut state = app.state.clone();
    state.federation_service = Some(service(Some(SigningKey::from_bytes(&[7; 32]))));
    let depth = chrono::Utc::now().timestamp_millis();
    let page = Arc::new(tokio::sync::RwLock::new(
        json!({"events": [], "next_depth": depth, "next_event_id": "$hidden:peer.example"}),
    ));
    let current_page = page.clone();
    let remote = Router::new().route(
        "/_paracord/federation/v1/events",
        get(move || {
            let current_page = current_page.clone();
            async move { Json(current_page.read().await.clone()) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/_paracord/federation/v1", listener.local_addr()?);
    let server = tokio::spawn(async move { axum::serve(listener, remote).await });
    paracord_db::federation::upsert_federated_server(
        &app.db,
        999,
        PEER,
        PEER,
        &endpoint,
        Some(&paracord_federation::hex_encode(
            &key.verifying_key().to_bytes(),
        )),
        Some(KEY),
        true,
    )
    .await?;
    paracord_api::routes::federation::run_federation_catchup_once(&state, 1, 1).await;
    let position =
        paracord_db::federation::get_room_sync_position(&app.db, PEER, "!100:peer.example").await?;
    assert_eq!(position, (depth, Some("$hidden:peer.example".into())));
    for invalid in [
        json!({"events": [], "next_depth": i64::MAX, "next_event_id": "$poison:peer.example"}),
        json!({"events": [], "next_depth": -1, "next_event_id": "$poison:peer.example"}),
        json!({"events": [], "next_depth": depth, "next_event_id": "$earlier:peer.example"}),
        json!({"events": [], "next_depth": depth + 1, "next_event_id": "a".repeat(256)}),
    ] {
        *page.write().await = invalid;
        paracord_api::routes::federation::run_federation_catchup_once(&state, 1, 1).await;
        assert_eq!(
            paracord_db::federation::get_room_sync_position(&app.db, PEER, "!100:peer.example")
                .await?,
            position
        );
    }
    let mut visible = message(PEER, 100, 101, "visible-after-hidden");
    visible.depth = depth;
    visible.signatures = json!({PEER: {KEY: paracord_federation::signing::sign(&key, &paracord_federation::canonical_envelope_bytes(&visible))}});
    *page.write().await = json!({"events": [visible], "next_depth": depth, "next_event_id": "$visible-after-hidden:peer.example"});
    paracord_api::routes::federation::run_federation_catchup_once(&state, 1, 1).await;
    assert!(paracord_db::federation::get_local_message_id_by_remote(
        &app.db,
        PEER,
        "visible-after-hidden"
    )
    .await?
    .is_some());
    assert_eq!(
        paracord_db::federation::get_room_sync_position(&app.db, PEER, "!100:peer.example").await?,
        (depth, Some("$visible-after-hidden:peer.example".into()))
    );
    server.abort();
    Ok(())
}

#[tokio::test]
async fn manually_pinned_peers_authenticate_without_discovery_and_reject_invalid_keys(
) -> anyhow::Result<()> {
    use axum::{
        extract::{ConnectInfo, State},
        http::HeaderMap,
        Json,
    };
    use paracord_api::routes::federation::{add_server, AddServerRequest};
    let _env = environment().await;
    std::env::set_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS", "true");
    let app = build_test_app(TestAppOptions::default()).await?;
    let (key, public_key) = paracord_federation::signing::generate_keypair();
    let public_key = public_key.to_ascii_uppercase();
    let register = |name: &str, key: String| AddServerRequest {
        server_name: name.into(),
        domain: name.into(),
        federation_endpoint: "http://127.0.0.1:9/_paracord/federation/v1".into(),
        public_key_hex: Some(key),
        key_id: Some(KEY.into()),
        trusted: true,
        discover: false,
    };
    let result = add_server(
        paracord_api::middleware::AdminUser { user_id: 123 },
        State(app.state.clone()),
        ConnectInfo("127.0.0.1:12345".parse()?),
        HeaderMap::new(),
        Json(register(PEER, public_key.clone())),
    )
    .await?;
    assert_eq!(result.0, StatusCode::CREATED);
    let keys = service(None).list_server_keys(&app.db, PEER).await?;
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].public_key, public_key);
    assert_eq!(keys[0].key_id, KEY);
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 101, "manual-pin")).await?,
        StatusCode::ACCEPTED
    );
    assert!(
        paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "manual-pin")
            .await?
            .is_some()
    );
    for (index, invalid) in [
        "ff".to_string(),
        "gg".repeat(32),
        "00".repeat(32),
        format!("01{}", "00".repeat(31)),
    ]
    .into_iter()
    .enumerate()
    {
        let name = format!("invalid-{index}.example");
        let result = add_server(
            paracord_api::middleware::AdminUser { user_id: 123 },
            State(app.state.clone()),
            ConnectInfo("127.0.0.1:12345".parse()?),
            HeaderMap::new(),
            Json(register(&name, invalid)),
        )
        .await;
        assert!(matches!(
            result,
            Err(paracord_api::error::ApiError::BadRequest(_))
        ));
        assert!(
            paracord_db::federation::get_federated_server(&app.db, &name)
                .await?
                .is_none()
        );
    }
    // Rotating to a different key ID retires the unlimited old manual pin,
    // while a separately registered grace key keeps its bounded expiry.
    let grace_expiry = chrono::Utc::now().timestamp_millis() + 60_000;
    service(None)
        .upsert_server_key(
            &app.db,
            &FederationServerKey {
                server_name: PEER.into(),
                key_id: "ed25519:grace".into(),
                public_key: public_key.clone(),
                valid_until: grace_expiry,
            },
        )
        .await?;
    let (_, rotated_public) = paracord_federation::signing::generate_keypair();
    let mut rotated = register(PEER, rotated_public);
    rotated.key_id = Some("ed25519:rotated".into());
    let (status, _) = add_server(
        paracord_api::middleware::AdminUser { user_id: 123 },
        State(app.state.clone()),
        ConnectInfo("127.0.0.1:12345".parse()?),
        HeaderMap::new(),
        Json(rotated),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED);
    let keys = service(None).list_server_keys(&app.db, PEER).await?;
    assert_eq!(keys.len(), 2);
    assert!(!keys.iter().any(|key| key.key_id == KEY));
    assert_eq!(
        keys.iter()
            .find(|key| key.key_id == "ed25519:grace")
            .unwrap()
            .valid_until,
        grace_expiry
    );
    assert_eq!(
        ingest(&app, &key, message(PEER, 100, 101, "retired-pin")).await?,
        StatusCode::FORBIDDEN
    );
    assert!(paracord_db::federation::delete_federated_server(&app.db, PEER).await?);
    assert!(service(None)
        .list_server_keys(&app.db, PEER)
        .await?
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn operator_admits_mirror_and_remote_attachments_survive_history_reload() -> anyhow::Result<()>
{
    use axum::http::Method;
    use common::{build_json_request, create_authenticated_user_token};
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let admin =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "admin", "Valid!Passw0rd")
            .await?;
    let admin_id = paracord_core::auth::validate_token(&admin, &app.jwt_secret)?.sub;
    paracord_db::users::update_user_flags(&app.db, admin_id, paracord_core::USER_FLAG_ADMIN)
        .await?;
    let user =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "reader", "Valid!Passw0rd")
            .await?;
    let mut events = app.event_bus.subscribe_system();
    let mut event = message(PEER, 7601, 7602, "attachments");
    event.content["attachments"] = json!([
        {"id":"7603","filename":"photo.bin","size":42,"content_type":"application/octet-stream","origin_url":"https://attacker.invalid/steal","origin_server":"attacker.invalid"},
        {"id":"../../escape","filename":"escape.bin","size":1},
        {"id":"7604","filename":"bad\r\nname","size":1}
    ]);
    assert_eq!(ingest(&app, &key, event).await?, StatusCode::ACCEPTED);
    let mapping = paracord_db::federation::get_space_mapping_by_remote(&app.db, PEER, "7601")
        .await?
        .unwrap();
    let channel = paracord_db::federation::get_channel_mapping_by_remote(&app.db, PEER, "7602")
        .await?
        .unwrap();
    let join = format!("/api/v1/guilds/{}/members/@me", mapping.local_guild_id);
    let settings = format!("/api/v1/admin/guilds/{}", mapping.local_guild_id);
    assert_eq!(
        dispatch_json(
            &app.app,
            build_json_request(Method::PUT, &join, None, Some(&user))?
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    let public = Some(json!({"visibility":"public"}));
    assert_eq!(
        dispatch_json(
            &app.app,
            build_json_request(Method::PATCH, &settings, public.clone(), Some(&user))?
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        dispatch_json(
            &app.app,
            build_json_request(Method::PATCH, &settings, public, Some(&admin))?
        )
        .await?
        .0,
        StatusCode::OK
    );
    assert_eq!(
        dispatch_json(
            &app.app,
            build_json_request(Method::PUT, &join, None, Some(&user))?
        )
        .await?
        .0,
        StatusCode::OK
    );
    let history = format!("/api/v1/channels/{}/messages", channel.local_channel_id);
    let (status, messages) = dispatch_json(
        &app.app,
        build_json_request(Method::GET, &history, None, Some(&user))?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let loaded = &messages.as_array().unwrap()[0];
    assert_eq!(loaded["federation"]["origin_server"], PEER);
    let attachments = loaded["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["origin_server"], PEER);
    assert_eq!(
        attachments[0]["url"],
        format!(
            "/api/v1/federated-files/{PEER}/7603?channel_id={}",
            channel.local_channel_id
        )
    );
    let mut realtime = None;
    while let Ok(event) = events.try_recv() {
        if event.event_type == "MESSAGE_CREATE" {
            realtime = Some(event.payload);
        }
    }
    let realtime = realtime.expect("message create event");
    assert_eq!(realtime["attachments"], loaded["attachments"]);
    assert_eq!(realtime["federation"], loaded["federation"]);
    assert_eq!(
        dispatch_json(
            &app.app,
            build_json_request(Method::DELETE, &join, None, Some(&user))?
        )
        .await?
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        dispatch_json(
            &app.app,
            build_json_request(Method::GET, &history, None, Some(&user))?
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    Ok(())
}

#[tokio::test]
async fn same_origin_cannot_edit_or_delete_another_federated_sender() -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let alice = message(PEER, 7701, 7702, "alice-original");
    assert_eq!(
        ingest(&app, &key, alice.clone()).await?,
        StatusCode::ACCEPTED
    );
    let mut bob = message(PEER, 7701, 7702, "bob-original");
    bob.sender = format!("@bob:{PEER}");
    assert_eq!(ingest(&app, &key, bob.clone()).await?, StatusCode::ACCEPTED);
    let id =
        paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "alice-original")
            .await?
            .unwrap();
    for (kind, suffix) in [("m.message.edit", "edit"), ("m.message.delete", "delete")] {
        let mut attack = bob.clone();
        attack.event_id = format!("$bob-{suffix}:{PEER}");
        attack.event_type = kind.into();
        attack.content["message_id"] = json!("alice-original");
        attack.content["body"] = json!("tampered");
        assert_eq!(ingest(&app, &key, attack).await?, StatusCode::ACCEPTED);
        assert_eq!(
            paracord_db::messages::get_message(&app.db, id)
                .await?
                .unwrap()
                .content
                .as_deref(),
            Some("original")
        );
    }
    let mut edit = alice;
    edit.event_id = format!("$alice-edit:{PEER}");
    edit.event_type = "m.message.edit".into();
    edit.content["body"] = json!("legitimate edit");
    assert_eq!(ingest(&app, &key, edit).await?, StatusCode::ACCEPTED);
    assert_eq!(
        paracord_db::messages::get_message(&app.db, id)
            .await?
            .unwrap()
            .content
            .as_deref(),
        Some("legitimate edit")
    );
    Ok(())
}

#[tokio::test]
async fn origin_ban_rejects_peer_join_message_and_membership_replay() -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    paracord_db::users::create_user(&app.db, 123, "owner", 0, "owner@example.test", "hash").await?;
    paracord_db::guilds::create_guild(&app.db, 100, "Origin", 123, None).await?;
    paracord_db::roles::create_role(
        &app.db,
        100,
        100,
        "@everyone",
        paracord_models::permissions::Permissions::default().bits(),
    )
    .await?;
    paracord_db::channels::create_channel(&app.db, 101, 100, "general", 0, 0, None, None).await?;
    let path = "/_paracord/federation/v1/join";
    let body = serde_json::to_vec(
        &json!({"origin_server":PEER,"room_id":"!100:localhost","user_id":"@alice:peer.example"}),
    )?;
    let (status, joined) = dispatch_json(
        &app.app,
        signed_request(
            "POST",
            path,
            body.clone(),
            PEER,
            &key,
            chrono::Utc::now().timestamp_millis(),
        ),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let user_id = joined["local_user_id"].as_str().unwrap().parse::<i64>()?;
    paracord_db::bans::create_ban(&app.db, user_id, 100, Some("Origin operator ban"), 123).await?;
    paracord_db::members::remove_member(&app.db, user_id, 100).await?;
    let status = dispatch_json(
        &app.app,
        signed_request(
            "POST",
            path,
            body,
            PEER,
            &key,
            chrono::Utc::now().timestamp_millis() + 1,
        ),
    )
    .await?
    .0;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for (kind, id) in [
        ("m.message", "banned-message"),
        ("m.member.join", "banned-membership"),
    ] {
        let mut event = message(PEER, 100, 101, id);
        event.room_id = "!100:localhost".into();
        event.event_type = kind.into();
        assert_eq!(ingest(&app, &key, event).await?, StatusCode::FORBIDDEN);
    }
    assert!(paracord_db::members::get_member(&app.db, user_id, 100)
        .await?
        .is_none());
    paracord_db::bans::delete_ban(&app.db, user_id, 100).await?;
    let body = serde_json::to_vec(
        &json!({"origin_server":PEER,"room_id":"!100:localhost","user_id":"@alice:peer.example"}),
    )?;
    assert_eq!(
        dispatch_json(
            &app.app,
            signed_request(
                "POST",
                path,
                body,
                PEER,
                &key,
                chrono::Utc::now().timestamp_millis() + 2
            )
        )
        .await?
        .0,
        StatusCode::OK
    );
    Ok(())
}

#[tokio::test]
async fn only_room_authority_can_endorse_membership_and_cannot_admit_local_accounts(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let key = peer(&app, PEER).await?;
    let other_key = peer(&app, "other.example").await?;
    paracord_db::users::create_user(&app.db, 901, "localperson", 0, "local@example.test", "hash")
        .await?;
    let mut endorsement = message(PEER, 7801, 7802, "endorsement");
    endorsement.event_type = "m.member.join".into();
    endorsement.content["membership_user_id"] = json!("@bob:other.example");
    assert_eq!(
        ingest(&app, &key, endorsement.clone()).await?,
        StatusCode::ACCEPTED
    );
    let mapping = paracord_db::federation::get_space_mapping_by_remote(&app.db, PEER, "7801")
        .await?
        .unwrap();
    assert!(
        paracord_db::federation::has_room_membership(
            &app.db,
            &endorsement.room_id,
            "@bob:other.example",
            mapping.local_guild_id
        )
        .await?
    );
    let mut reply = message("other.example", 7801, 7802, "endorsed-reply");
    reply.sender = "@bob:other.example".into();
    reply.room_id = endorsement.room_id.clone();
    assert_eq!(
        ingest(&app, &other_key, reply.clone()).await?,
        StatusCode::ACCEPTED
    );
    let mut invalid = reply;
    invalid.event_type = "m.member.join".into();
    invalid.event_id = "$invalid-endorsement:other.example".into();
    invalid.content["membership_user_id"] = json!("@mallory:fourth.example");
    assert_eq!(
        ingest(&app, &other_key, invalid).await?,
        StatusCode::FORBIDDEN
    );
    let mut other_member = endorsement.clone();
    other_member.event_id = "$other-member:peer.example".into();
    other_member.content["membership_user_id"] = json!("@carol:other.example");
    assert_eq!(
        ingest(&app, &key, other_member).await?,
        StatusCode::ACCEPTED
    );
    let mut departure = endorsement.clone();
    departure.event_id = "$bob-departed:peer.example".into();
    departure.event_type = "m.member.leave".into();
    assert_eq!(ingest(&app, &key, departure).await?, StatusCode::ACCEPTED);
    for kind in ["m.message", "m.member.join"] {
        let mut departed = message("other.example", 7801, 7802, kind);
        departed.sender = "@bob:other.example".into();
        departed.room_id = endorsement.room_id.clone();
        departed.event_type = kind.into();
        assert_eq!(
            ingest(&app, &other_key, departed).await?,
            StatusCode::FORBIDDEN
        );
    }
    let mut admitted = message("other.example", 7801, 7802, "still-admitted");
    admitted.sender = "@carol:other.example".into();
    admitted.room_id = endorsement.room_id.clone();
    assert_eq!(
        ingest(&app, &other_key, admitted).await?,
        StatusCode::ACCEPTED
    );
    endorsement.event_id = "$local-endorsement:peer.example".into();
    endorsement.content["membership_user_id"] = json!("@localperson:localhost");
    assert_eq!(ingest(&app, &key, endorsement).await?, StatusCode::ACCEPTED);
    assert!(
        paracord_db::members::get_member(&app.db, 901, mapping.local_guild_id)
            .await?
            .is_none()
    );
    Ok(())
}

#[tokio::test]
async fn mirrored_attachment_tokens_bind_shared_room_and_authoritative_membership(
) -> anyhow::Result<()> {
    let _env = environment().await;
    let app = build_test_app(TestAppOptions::default()).await?;
    let authority = peer(&app, PEER).await?;
    let other = peer(&app, "other.example").await?;
    assert_eq!(
        ingest(&app, &authority, message(PEER, 8400, 8401, "file-room")).await?,
        StatusCode::ACCEPTED
    );
    let mid = paracord_db::federation::get_local_message_id_by_remote(&app.db, PEER, "file-room")
        .await?
        .unwrap();
    let mapping = paracord_db::federation::get_space_mapping_by_remote(&app.db, PEER, "8400")
        .await?
        .unwrap();
    paracord_db::attachments::create_attachment(
        &app.db,
        8402,
        Some(mid),
        "mirror.bin",
        None,
        4,
        "/file",
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await?;
    let path = "/_paracord/federation/v1/file/token";
    for (origin, key, room, expected) in [
        (
            PEER,
            &authority,
            "!8403:peer.example",
            StatusCode::FORBIDDEN,
        ),
        (
            "other.example",
            &other,
            "!8400:peer.example",
            StatusCode::FORBIDDEN,
        ),
        (PEER, &authority, "!8400:peer.example", StatusCode::OK),
    ] {
        let body = serde_json::to_vec(
            &json!({"origin_server":origin,"attachment_id":"8402","room_id":room,"user_id":format!("@owner:{origin}")}),
        )?;
        let req = signed_request(
            "POST",
            path,
            body,
            origin,
            key,
            chrono::Utc::now().timestamp_millis(),
        );
        assert_eq!(dispatch_json(&app.app, req).await?.0, expected);
    }
    let owner = paracord_db::federation::get_remote_user_mapping(&app.db, "@owner:peer.example")
        .await?
        .unwrap();
    paracord_db::bans::create_ban(
        &app.db,
        owner.local_user_id,
        mapping.local_guild_id,
        Some("local mirror ban"),
        0,
    )
    .await?;
    let body = serde_json::to_vec(
        &json!({"origin_server":PEER,"attachment_id":"8402","room_id":"!8400:peer.example","user_id":"@owner:peer.example"}),
    )?;
    let req = signed_request(
        "POST",
        path,
        body,
        PEER,
        &authority,
        chrono::Utc::now().timestamp_millis() + 1,
    );
    assert_eq!(dispatch_json(&app.app, req).await?.0, StatusCode::FORBIDDEN);
    Ok(())
}
