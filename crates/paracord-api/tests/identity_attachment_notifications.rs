//! Realtime notification coverage for `POST /api/v1/auth/attach-public-key`.
//!
//! The attach handler commits a new public identity and rotates the caller's
//! session, but used to return without telling anyone. A peer already viewing
//! a DM with the account kept `recipient.public_key = null` (and
//! `peers_ready = false`) until some unrelated refetch. These tests pin the
//! contract through the real router plus a live `EventBus` receiver:
//!
//! * a successful attach publishes one public `USER_UPDATE` to every
//!   authorized observer — self, shared-guild members, DM/group-DM recipients
//!   and accepted friends — and to nobody else;
//! * the event carries only public profile fields — never email, session ids,
//!   or tokens;
//! * a rejected or conflicting attach publishes nothing.

mod common;

use axum::http::{Method, StatusCode};
use common::{build_json_request, build_test_app, dispatch_json, TestApp, TestAppOptions};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast::Receiver;

struct Account {
    user: paracord_db::users::UserRow,
    password: String,
}

async fn create_account(db: &paracord_db::DbPool, label: &str) -> anyhow::Result<Account> {
    let id = paracord_util::snowflake::generate(1);
    let password = format!("Str0ng-{label}-Passw0rd!");
    let user = paracord_db::users::create_user(
        db,
        id,
        &format!("{label}{}", id % 100_000),
        1,
        &format!("{label}-{id}@example.com"),
        &paracord_core::auth::hash_password(&password)?,
    )
    .await?;
    Ok(Account { user, password })
}

/// Mint a live login session and a matching bearer token. Re-callable: every
/// successful attach revokes all of the account's sessions, so a follow-up
/// request needs a fresh one.
async fn session_token(app: &TestApp, user_id: i64) -> anyhow::Result<String> {
    let session_id = format!("sess-{}", uuid::Uuid::new_v4().simple());
    let jti = format!("jti-{}", uuid::Uuid::new_v4().simple());
    paracord_db::sessions::create_session(
        &app.db,
        &session_id,
        user_id,
        &format!("refresh-{}", uuid::Uuid::new_v4().simple()),
        &jti,
        None,
        None,
        None,
        None,
        chrono::Utc::now() + chrono::Duration::days(1),
    )
    .await?;
    Ok(paracord_core::auth::create_session_token(
        user_id,
        None,
        &app.jwt_secret,
        3600,
        &session_id,
        &jti,
    )?)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key_hex(key: &SigningKey) -> String {
    hex_encode(key.verifying_key().as_bytes())
}

/// Fetch a challenge and sign it exactly as a client would.
async fn signed_challenge(
    app: &TestApp,
    key: &SigningKey,
) -> anyhow::Result<(String, i64, String)> {
    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/challenge",
            Some(json!({})),
            None,
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "challenge failed: {body}");
    let nonce = body["nonce"].as_str().expect("nonce").to_string();
    let timestamp = body["timestamp"].as_i64().expect("timestamp");
    let server_origin = body["server_origin"].as_str().expect("server_origin");
    let signature = hex_encode(
        &key.sign(format!("{nonce}:{timestamp}:{server_origin}").as_bytes())
            .to_bytes(),
    );
    Ok((nonce, timestamp, signature))
}

async fn attach(
    app: &TestApp,
    token: &str,
    key: &SigningKey,
    password: &str,
    expected_public_key: Option<&str>,
) -> anyhow::Result<(StatusCode, Value)> {
    let (nonce, timestamp, signature) = signed_challenge(app, key).await?;
    let mut body = json!({
        "public_key": public_key_hex(key),
        "nonce": nonce,
        "timestamp": timestamp,
        "signature": signature,
        "password": password,
    });
    if let Some(expected) = expected_public_key {
        body["expected_public_key"] = json!(expected);
    }
    dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/attach-public-key",
            Some(body),
            Some(token),
        )?,
    )
    .await
}

fn watch(
    app: &TestApp,
    session: &str,
    user_id: i64,
    guild_ids: &[i64],
) -> Receiver<paracord_core::events::ServerEvent> {
    app.event_bus
        .register_session(session.to_string(), user_id, guild_ids)
        .expect("session id must register")
}

/// Drain everything already published to a receiver. Dispatch is synchronous
/// inside the request handler, so by the time the HTTP call returns every
/// emitted event is queued.
fn drain(
    rx: &mut Receiver<paracord_core::events::ServerEvent>,
) -> Vec<paracord_core::events::ServerEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

fn assert_public_identity_event(
    event: &paracord_core::events::ServerEvent,
    user_id: i64,
    public_key: Option<&str>,
    context: &str,
) {
    assert_eq!(event.event_type, "USER_UPDATE", "{context}: {event:?}");
    let user = &event.payload["user"];
    assert_eq!(user["id"], user_id.to_string(), "{context}: {user}");
    assert_eq!(user["public_key"], json!(public_key), "{context}: {user}");
    // Public profile fields only — nothing account-private may ride along.
    for forbidden in [
        "email",
        "email_verified",
        "password",
        "token",
        "refresh_token",
        "session_id",
        "mfa",
    ] {
        assert!(
            user.get(forbidden).is_none(),
            "{context}: event leaks `{forbidden}`: {user}"
        );
    }
    let serialized = event.payload.to_string();
    for forbidden in ["email", "token", "session", "password"] {
        assert!(
            !serialized.contains(forbidden),
            "{context}: serialized event contains `{forbidden}`: {serialized}"
        );
    }
}

#[tokio::test]
async fn successful_attach_publishes_public_identity_only_to_authorized_peers() -> anyhow::Result<()>
{
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner = create_account(&app.db, "attachowner").await?;
    let dm_peer = create_account(&app.db, "attachdm").await?;
    let friend = create_account(&app.db, "attachfriend").await?;
    let group_peer = create_account(&app.db, "attachgroup").await?;
    let guild_peer = create_account(&app.db, "attachguild").await?;
    let outsider = create_account(&app.db, "attachoutsider").await?;

    // A 1:1 DM, an accepted friendship, a group DM and a shared guild are the
    // authorized audiences; the outsider shares nothing.
    paracord_db::dms::create_dm_channel(
        &app.db,
        paracord_util::snowflake::generate(1),
        owner.user.id,
        dm_peer.user.id,
    )
    .await?;
    for (a, b) in [
        (owner.user.id, friend.user.id),
        (friend.user.id, owner.user.id),
    ] {
        paracord_db::relationships::create_relationship(&app.db, a, b, 1).await?;
    }
    paracord_db::dms::create_group_dm_channel(
        &app.db,
        paracord_util::snowflake::generate(1),
        Some("attach-group"),
        owner.user.id,
        &[group_peer.user.id],
    )
    .await?;
    let guild_id = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&app.db, guild_id, "Attach Shared", owner.user.id, None)
        .await?;
    paracord_db::members::add_member(&app.db, owner.user.id, guild_id).await?;
    paracord_db::members::add_member(&app.db, guild_peer.user.id, guild_id).await?;
    // This peer shares both a DM and a guild, but needs only one event.
    paracord_db::members::add_member(&app.db, dm_peer.user.id, guild_id).await?;

    // Every observer's gateway session is registered before the attach, so a
    // missed dispatch cannot hide behind a late subscription.
    let mut owner_rx = watch(&app, "attach-owner-gw", owner.user.id, &[guild_id]);
    let mut dm_rx = watch(&app, "attach-dm-gw", dm_peer.user.id, &[guild_id]);
    let mut friend_rx = watch(&app, "attach-friend-gw", friend.user.id, &[]);
    let mut group_rx = watch(&app, "attach-group-gw", group_peer.user.id, &[]);
    let mut guild_rx = watch(&app, "attach-guild-gw", guild_peer.user.id, &[guild_id]);
    // A stale session index must not grant visibility after membership is gone.
    let mut outsider_rx = watch(&app, "attach-outsider-gw", outsider.user.id, &[guild_id]);

    let token = session_token(&app, owner.user.id).await?;
    let key = signing_key(0x2a);
    let (status, body) = attach(&app, &token, &key, &owner.password, None).await?;
    assert_eq!(status, StatusCode::OK, "attach failed: {body}");
    let expected_key = public_key_hex(&key);
    assert_eq!(body["user"]["public_key"], json!(expected_key));
    // The issued credential is a response field — it must never appear in the
    // broadcast event.
    let access_token = body["token"].as_str().expect("access token").to_string();

    for (name, rx) in [
        ("owner", &mut owner_rx),
        ("dm peer", &mut dm_rx),
        ("friend", &mut friend_rx),
        ("group dm peer", &mut group_rx),
        ("guild peer", &mut guild_rx),
    ] {
        let events = drain(rx);
        assert_eq!(
            events.len(),
            1,
            "{name} must receive exactly one notification"
        );
        for event in &events {
            assert_public_identity_event(event, owner.user.id, Some(&expected_key), name);
            assert!(
                !event.payload.to_string().contains(&access_token),
                "{name}: event leaks the rotated access token"
            );
        }
    }

    assert!(
        drain(&mut outsider_rx).is_empty(),
        "an unrelated user must not learn the new identity"
    );
    Ok(())
}

#[tokio::test]
async fn attach_notification_skips_pending_and_blocked_relationships() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner = create_account(&app.db, "pendowner").await?;
    let pending = create_account(&app.db, "pendpending").await?;
    let blocked = create_account(&app.db, "pendblocked").await?;

    // Outgoing-pending (4) and blocked (2) rows are not accepted friendships.
    paracord_db::relationships::create_relationship(&app.db, owner.user.id, pending.user.id, 4)
        .await?;
    paracord_db::relationships::create_relationship(&app.db, owner.user.id, blocked.user.id, 2)
        .await?;

    let mut pending_rx = watch(&app, "pend-pending-gw", pending.user.id, &[]);
    let mut blocked_rx = watch(&app, "pend-blocked-gw", blocked.user.id, &[]);

    let token = session_token(&app, owner.user.id).await?;
    let key = signing_key(0x3b);
    let (status, body) = attach(&app, &token, &key, &owner.password, None).await?;
    assert_eq!(status, StatusCode::OK, "attach failed: {body}");

    assert!(
        drain(&mut pending_rx).is_empty(),
        "a pending relationship is not an accepted peer"
    );
    assert!(
        drain(&mut blocked_rx).is_empty(),
        "a blocked relationship is not an accepted peer"
    );
    Ok(())
}

#[tokio::test]
async fn rejected_or_conflicting_attach_publishes_no_identity_change() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner = create_account(&app.db, "rejectowner").await?;
    let peer = create_account(&app.db, "rejectpeer").await?;
    paracord_db::dms::create_dm_channel(
        &app.db,
        paracord_util::snowflake::generate(1),
        owner.user.id,
        peer.user.id,
    )
    .await?;
    let mut owner_rx = watch(&app, "reject-owner-gw", owner.user.id, &[]);
    let mut peer_rx = watch(&app, "reject-peer-gw", peer.user.id, &[]);

    // Wrong account password: re-authentication fails before any proof check.
    let token = session_token(&app, owner.user.id).await?;
    let key = signing_key(0x4c);
    let (status, body) = attach(&app, &token, &key, "not-the-password", None).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(drain(&mut owner_rx).is_empty());
    assert!(drain(&mut peer_rx).is_empty());

    // Right password, but a proof signed by a different key.
    let forger = signing_key(0x77);
    let challenge_body = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/challenge",
            Some(json!({})),
            None,
        )?,
    )
    .await?
    .1;
    let nonce = challenge_body["nonce"].as_str().unwrap().to_string();
    let timestamp = challenge_body["timestamp"].as_i64().unwrap();
    let origin = challenge_body["server_origin"].as_str().unwrap();
    let forged = hex_encode(
        &forger
            .sign(format!("{nonce}:{timestamp}:{origin}").as_bytes())
            .to_bytes(),
    );
    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/attach-public-key",
            Some(json!({
                "public_key": public_key_hex(&key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": forged,
                "password": owner.password,
            })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(drain(&mut owner_rx).is_empty());
    assert!(drain(&mut peer_rx).is_empty());

    // A legitimate attach publishes, then a conflicting replacement does not.
    let (status, body) = attach(&app, &token, &key, &owner.password, None).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!drain(&mut owner_rx).is_empty());
    assert!(!drain(&mut peer_rx).is_empty());

    // Attachment revoked every session; the retry needs a fresh one.
    let token = session_token(&app, owner.user.id).await?;
    let replacement = signing_key(0x5d);
    let wrong_expected = "00".repeat(32);
    let (status, body) = attach(
        &app,
        &token,
        &replacement,
        &owner.password,
        Some(&wrong_expected),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(
        drain(&mut owner_rx).is_empty(),
        "a rejected replacement must not announce an identity"
    );
    assert!(
        drain(&mut peer_rx).is_empty(),
        "a rejected replacement must not announce an identity"
    );

    let stored = paracord_db::users::get_user_by_id(&app.db, owner.user.id)
        .await?
        .expect("owner row")
        .public_key;
    assert_eq!(stored, Some(public_key_hex(&key)));
    Ok(())
}

#[tokio::test]
async fn detach_notifies_peers_only_after_successful_credential_change() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner = create_account(&app.db, "removeowner").await?;
    let peer = create_account(&app.db, "removepeer").await?;
    paracord_db::dms::create_dm_channel(
        &app.db,
        paracord_util::snowflake::generate(1),
        owner.user.id,
        peer.user.id,
    )
    .await?;
    let mut owner_rx = watch(&app, "remove-owner-gw", owner.user.id, &[]);
    let mut peer_rx = watch(&app, "remove-peer-gw", peer.user.id, &[]);
    let token = session_token(&app, owner.user.id).await?;
    let key = signing_key(0x61);
    let (status, body) = attach(&app, &token, &key, &owner.password, None).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let token = body["token"].as_str().expect("replacement token");
    drain(&mut owner_rx);
    drain(&mut peer_rx);

    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/attach-public-key",
            Some(json!({ "detach": true, "password": "incorrect" })),
            Some(token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(drain(&mut owner_rx).is_empty());
    assert!(drain(&mut peer_rx).is_empty());
    assert_eq!(
        paracord_db::users::get_user_by_id(&app.db, owner.user.id)
            .await?
            .unwrap()
            .public_key,
        Some(public_key_hex(&key)),
    );

    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/attach-public-key",
            Some(json!({ "detach": true, "password": owner.password })),
            Some(token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    for (name, receiver) in [("owner", &mut owner_rx), ("peer", &mut peer_rx)] {
        let events = drain(receiver);
        assert_eq!(events.len(), 1, "{name}: {events:?}");
        assert_public_identity_event(&events[0], owner.user.id, None, name);
    }
    assert!(paracord_db::users::get_user_by_id(&app.db, owner.user.id)
        .await?
        .unwrap()
        .public_key
        .is_none());
    let (active_sessions,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(owner.user.id)
    .fetch_one(&app.db)
    .await?;
    assert_eq!(active_sessions, 0, "detach must revoke every login session");
    Ok(())
}

#[tokio::test]
async fn notification_audience_failure_rolls_back_identity_and_session_changes(
) -> anyhow::Result<()> {
    for detach in [false, true] {
        let app = build_test_app(TestAppOptions::default()).await?;
        let owner =
            create_account(&app.db, if detach { "faildetach" } else { "failattach" }).await?;
        let mut token = session_token(&app, owner.user.id).await?;
        let key = signing_key(0x62);
        let mut owner_rx = watch(&app, "failure-owner-gw", owner.user.id, &[]);
        if detach {
            let (status, body) = attach(&app, &token, &key, &owner.password, None).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            token = body["token"].as_str().unwrap().to_string();
            drain(&mut owner_rx);
        }
        // This table is first read by the observer query, after the credential
        // and session writes. Both engines must roll those writes back.
        sqlx::query("ALTER TABLE relationships RENAME TO identity_test_relationships")
            .execute(&app.db)
            .await?;
        let result = if detach {
            dispatch_json(
                &app.app,
                build_json_request(
                    Method::POST,
                    "/api/v1/auth/attach-public-key",
                    Some(json!({ "detach": true, "password": owner.password })),
                    Some(&token),
                )?,
            )
            .await
        } else {
            attach(&app, &token, &key, &owner.password, None).await
        };
        sqlx::query("ALTER TABLE identity_test_relationships RENAME TO relationships")
            .execute(&app.db)
            .await?;
        let (status, body) = result?;
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "detach={detach}: {body}"
        );
        assert!(drain(&mut owner_rx).is_empty());
        assert_eq!(
            paracord_db::users::get_user_by_id(&app.db, owner.user.id)
                .await?
                .unwrap()
                .public_key,
            detach.then(|| public_key_hex(&key)),
        );
        let (active_sessions,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL",
        )
        .bind(owner.user.id)
        .fetch_one(&app.db)
        .await?;
        assert_eq!(
            active_sessions, 1,
            "failed change must preserve the original session"
        );
        let (status, body) = dispatch_json(
            &app.app,
            build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&token))?,
        )
        .await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "original credential was revoked: {body}"
        );
    }
    Ok(())
}

fn reset_token_hash(token: &str) -> String {
    hex_encode(&Sha256::digest(token.as_bytes()))
}

async fn create_reset_link(app: &TestApp, user_id: i64) -> anyhow::Result<String> {
    let token = format!("identity-reset-{}", uuid::Uuid::new_v4());
    paracord_db::password_reset::create_reset_token(
        &app.db,
        &reset_token_hash(&token),
        user_id,
        chrono::Utc::now() + chrono::Duration::minutes(15),
    )
    .await?;
    Ok(token)
}

async fn password_mutation(
    app: &TestApp,
    account: &Account,
    session: &str,
    reset_link: Option<&str>,
    new_password: &str,
) -> anyhow::Result<(StatusCode, Value)> {
    let request = match reset_link {
        Some(token) => build_json_request(
            Method::POST,
            "/api/v1/auth/reset-password",
            Some(json!({ "token": token, "new_password": new_password })),
            None,
        )?,
        None => build_json_request(
            Method::PUT,
            "/api/v1/users/@me/password",
            Some(json!({ "current_password": account.password, "new_password": new_password })),
            Some(session),
        )?,
    };
    dispatch_json(&app.app, request).await
}

#[tokio::test]
async fn password_change_and_reset_notify_peers_and_revoke_the_correct_sessions(
) -> anyhow::Result<()> {
    for reset in [false, true] {
        let app = build_test_app(TestAppOptions::default()).await?;
        let owner = create_account(&app.db, "credentialowner").await?;
        let peer = create_account(&app.db, "credentialpeer").await?;
        paracord_db::dms::create_dm_channel(
            &app.db,
            paracord_util::snowflake::generate(1),
            owner.user.id,
            peer.user.id,
        )
        .await?;
        paracord_db::users::update_user_public_key(
            &app.db,
            owner.user.id,
            &public_key_hex(&signing_key(0x63)),
        )
        .await?;
        let caller = session_token(&app, owner.user.id).await?;
        let other_session = session_token(&app, owner.user.id).await?;
        let link = if reset {
            Some(create_reset_link(&app, owner.user.id).await?)
        } else {
            None
        };
        let mut self_rx = watch(&app, "credential-self-gw", owner.user.id, &[]);
        let mut peer_rx = watch(&app, "credential-peer-gw", peer.user.id, &[]);
        let new_password = "Updated-Credential-123!";
        let (status, body) =
            password_mutation(&app, &owner, &caller, link.as_deref(), new_password).await?;
        assert_eq!(
            status,
            if reset {
                StatusCode::OK
            } else {
                StatusCode::NO_CONTENT
            },
            "{body}"
        );
        for (label, receiver) in [("self", &mut self_rx), ("DM peer", &mut peer_rx)] {
            let events = drain(receiver);
            assert_eq!(events.len(), 1, "{label}: {events:?}");
            assert_public_identity_event(&events[0], owner.user.id, None, label);
        }
        let stored = paracord_db::users::get_user_auth_by_id(&app.db, owner.user.id)
            .await?
            .unwrap();
        assert!(stored.public_key.is_none());
        assert!(paracord_core::auth::verify_password(
            new_password,
            &stored.password_hash
        )?);
        let caller_status = dispatch_json(
            &app.app,
            build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&caller))?,
        )
        .await?
        .0;
        assert_eq!(
            caller_status,
            if reset {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::OK
            }
        );
        assert_eq!(
            dispatch_json(
                &app.app,
                build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&other_session),)?
            )
            .await?
            .0,
            StatusCode::UNAUTHORIZED
        );
        if reset {
            let repeated = password_mutation(
                &app,
                &owner,
                &caller,
                link.as_deref(),
                "Another-Password-123!",
            )
            .await?;
            assert_eq!(repeated.0, StatusCode::BAD_REQUEST, "{repeated:?}");
            assert!(drain(&mut peer_rx).is_empty());
        }
    }
    Ok(())
}

async fn reject_credential_revocation(
    db: &paracord_db::DbPool,
    install: bool,
) -> anyhow::Result<()> {
    match (paracord_db::active_database_engine(), install) {
        (paracord_db::DatabaseEngine::Sqlite, true) => {
            sqlx::query("CREATE TRIGGER reject_credential_revocation BEFORE UPDATE ON auth_sessions WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected revocation failure'); END").execute(db).await?;
        }
        (paracord_db::DatabaseEngine::Postgres, true) => {
            sqlx::query("CREATE FUNCTION reject_credential_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'injected revocation failure'; END IF; RETURN NEW; END; $$").execute(db).await?;
            sqlx::query("CREATE TRIGGER reject_credential_revocation BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION reject_credential_revocation()").execute(db).await?;
        }
        (paracord_db::DatabaseEngine::Sqlite, false) => {
            sqlx::query("DROP TRIGGER reject_credential_revocation")
                .execute(db)
                .await?;
        }
        (paracord_db::DatabaseEngine::Postgres, false) => {
            sqlx::query("DROP TRIGGER reject_credential_revocation ON auth_sessions")
                .execute(db)
                .await?;
            sqlx::query("DROP FUNCTION reject_credential_revocation()")
                .execute(db)
                .await?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn password_recovery_failures_preserve_password_key_sessions_and_reset_link(
) -> anyhow::Result<()> {
    for reset in [false, true] {
        for failure in ["revocation", "observers"] {
            let app = build_test_app(TestAppOptions::default()).await?;
            let owner = create_account(&app.db, "atomicpassword").await?;
            let key = public_key_hex(&signing_key(0x64));
            paracord_db::users::update_user_public_key(&app.db, owner.user.id, &key).await?;
            let caller = session_token(&app, owner.user.id).await?;
            // Change-password keeps the caller, so an actual second session is
            // needed for the injected revocation error to exercise a write.
            let second = session_token(&app, owner.user.id).await?;
            let link = if reset {
                Some(create_reset_link(&app, owner.user.id).await?)
            } else {
                None
            };
            let original_hash = paracord_db::users::get_user_auth_by_id(&app.db, owner.user.id)
                .await?
                .unwrap()
                .password_hash;
            let mut receiver = watch(&app, "atomic-password-gw", owner.user.id, &[]);
            if failure == "revocation" {
                reject_credential_revocation(&app.db, true).await?;
            } else {
                sqlx::query("ALTER TABLE relationships RENAME TO credential_test_relationships")
                    .execute(&app.db)
                    .await?;
            }
            let result = password_mutation(
                &app,
                &owner,
                &caller,
                link.as_deref(),
                "Updated-Credential-123!",
            )
            .await;
            if failure == "revocation" {
                reject_credential_revocation(&app.db, false).await?;
            } else {
                sqlx::query("ALTER TABLE credential_test_relationships RENAME TO relationships")
                    .execute(&app.db)
                    .await?;
            }
            let (status, body) = result?;
            assert_eq!(
                status,
                StatusCode::INTERNAL_SERVER_ERROR,
                "reset={reset}, failure={failure}: {body}"
            );
            assert!(drain(&mut receiver).is_empty());
            let stored = paracord_db::users::get_user_auth_by_id(&app.db, owner.user.id)
                .await?
                .unwrap();
            assert_eq!(stored.password_hash, original_hash);
            assert_eq!(stored.public_key, Some(key));
            for token in [&caller, &second] {
                assert_eq!(
                    dispatch_json(
                        &app.app,
                        build_json_request(Method::GET, "/api/v1/users/@me", None, Some(token),)?
                    )
                    .await?
                    .0,
                    StatusCode::OK,
                    "failed mutation revoked a session"
                );
            }
            if let Some(link) = &link {
                assert!(
                    paracord_db::password_reset::get_valid_reset_token(
                        &app.db,
                        &reset_token_hash(link),
                        chrono::Utc::now(),
                    )
                    .await?
                    .is_some(),
                    "failed reset consumed the recovery link"
                );
            }
            let retry = password_mutation(
                &app,
                &owner,
                &caller,
                link.as_deref(),
                "Updated-Credential-123!",
            )
            .await?;
            assert_eq!(
                retry.0,
                if reset {
                    StatusCode::OK
                } else {
                    StatusCode::NO_CONTENT
                },
                "{retry:?}"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn concurrent_reset_requests_consume_one_link_and_publish_one_identity_update(
) -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions {
        database_connections: 3,
        ..TestAppOptions::default()
    })
    .await?;
    let owner = create_account(&app.db, "resetconcurrent").await?;
    paracord_db::users::update_user_public_key(
        &app.db,
        owner.user.id,
        &public_key_hex(&signing_key(0x65)),
    )
    .await?;
    let caller = session_token(&app, owner.user.id).await?;
    let link = create_reset_link(&app, owner.user.id).await?;
    let mut receiver = watch(&app, "reset-concurrent-gw", owner.user.id, &[]);
    let passwords = ["First-Recovery-Password-1!", "Second-Recovery-Password-2!"];
    let (first, second) = tokio::join!(
        password_mutation(&app, &owner, &caller, Some(&link), passwords[0]),
        password_mutation(&app, &owner, &caller, Some(&link), passwords[1]),
    );
    let results = [first?, second?];
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::OK)
            .count(),
        1,
        "{results:?}"
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result.0 == StatusCode::BAD_REQUEST)
            .count(),
        1,
        "{results:?}"
    );
    let winner = results
        .iter()
        .position(|result| result.0 == StatusCode::OK)
        .unwrap();
    let stored = paracord_db::users::get_user_auth_by_id(&app.db, owner.user.id)
        .await?
        .unwrap();
    assert!(paracord_core::auth::verify_password(
        passwords[winner],
        &stored.password_hash
    )?);
    assert_eq!(drain(&mut receiver).len(), 1);
    Ok(())
}
