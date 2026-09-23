//! Who may create an account: invite-only versus open.
//!
//! A fresh config writes `registration_mode = "invite_only"`; a config from
//! before the setting existed has no key and stays open. These tests drive the
//! runtime value the server reads on every account-creating request
//! (`POST /auth/register`, and `POST /auth/verify` when the key is new), the
//! first-owner claim that must keep working, and the admin switch.
//!
//! Every request carries its own peer address, so a refusal that feeds the
//! auth guard in one step can never rate-limit the next.

mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU8, Ordering};

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
};
use chrono::Utc;
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use ed25519_dalek::{Signer, SigningKey};
use paracord_core::registration::RegistrationMode;
use serde_json::{json, Value};

const PASSWORD: &str = "Registerpass123!";
const CLAIM_TOKEN: &str = "INVITEONLYCLAIMTOKEN0123456789ABCDEFGHJKMNPQRST";

static PEER: AtomicU8 = AtomicU8::new(1);

/// A request from its own address, so auth-guard bookkeeping stays per step.
fn from_new_peer(mut request: Request<Body>) -> Request<Body> {
    let last = PEER.fetch_add(1, Ordering::Relaxed);
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([198, 51, 100, last], 40000))));
    request
}

async fn send(app: &TestApp, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
    dispatch_json(&app.app, from_new_peer(request)).await
}

async fn app_in(mode: RegistrationMode) -> anyhow::Result<TestApp> {
    let app = build_test_app(TestAppOptions::default()).await?;
    app.state.runtime.write().await.registration_mode = mode;
    Ok(app)
}

/// The instance's owner, a server, a text channel, and an invite to it.
struct Community {
    owner_token: String,
    guild_id: String,
    channel_id: String,
}

async fn community(app: &TestApp) -> anyhow::Result<Community> {
    let owner_token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "owner", PASSWORD).await?;
    let (status, guild) = send(
        app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Riverside" })),
            Some(&owner_token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "create guild: {guild}");
    let guild_id = guild["id"].as_str().expect("guild id").to_string();
    let (status, channels) = send(
        app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            None,
            Some(&owner_token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "list channels: {channels}");
    let channel_id = channels
        .as_array()
        .and_then(|list| list.iter().find(|c| c["type"] == 0))
        .and_then(|c| c["id"].as_str())
        .expect("a text channel")
        .to_string();
    Ok(Community {
        owner_token,
        guild_id,
        channel_id,
    })
}

async fn invite(
    app: &TestApp,
    community: &Community,
    max_uses: i64,
    max_age: i64,
) -> anyhow::Result<String> {
    let (status, body) = send(
        app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/channels/{}/invites", community.channel_id),
            Some(json!({ "max_uses": max_uses, "max_age": max_age })),
            Some(&community.owner_token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "create invite: {body}");
    Ok(body["code"].as_str().expect("invite code").to_string())
}

async fn register(
    app: &TestApp,
    username: &str,
    invite_code: Option<&str>,
) -> anyhow::Result<(StatusCode, Value)> {
    let mut body = json!({
        "email": format!("{username}@example.com"),
        "username": username,
        "password": PASSWORD,
    });
    if let Some(code) = invite_code {
        body["invite_code"] = json!(code);
    }
    send(
        app,
        build_json_request(Method::POST, "/api/v1/auth/register", Some(body), None)?,
    )
    .await
}

fn assert_invite_refusal(status: StatusCode, body: &Value, expected_message: &str) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "INVITE_REQUIRED", "{body}");
    assert_eq!(body["message"], expected_message, "{body}");
}

async fn user_count(app: &TestApp) -> anyhow::Result<i64> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&app.db)
        .await?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// Password registration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn invite_only_refuses_registration_without_an_invite() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::InviteOnly).await?;
    community(&app).await?;
    let before = user_count(&app).await?;

    let (status, body) = register(&app, "stranger", None).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_REQUIRED_MESSAGE,
    );
    // A blank code is the same as none.
    let (status, body) = register(&app, "stranger", Some("   ")).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_REQUIRED_MESSAGE,
    );
    assert_eq!(user_count(&app).await?, before, "no account was created");
    Ok(())
}

#[tokio::test]
async fn invite_only_accepts_a_live_invite_and_the_invite_still_joins() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::InviteOnly).await?;
    let community = community(&app).await?;
    let code = invite(&app, &community, 5, 0).await?;

    let (status, body) = register(&app, "friend", Some(&code)).await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let token = body["token"].as_str().expect("token").to_string();

    // Registering did not spend the invite: joining is what counts a use, so
    // the newcomer can still pass the server's own join questions.
    let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM invites WHERE code = $1")
        .bind(&code)
        .fetch_one(&app.db)
        .await?;
    assert_eq!(uses, 0);

    let (status, body) = send(
        &app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/invites/{code}"),
            Some(json!({})),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "accept invite: {body}");
    assert_eq!(body["guild"]["id"], community.guild_id.as_str());
    Ok(())
}

#[tokio::test]
async fn invite_only_refuses_an_expired_invite() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::InviteOnly).await?;
    let community = community(&app).await?;
    let code = invite(&app, &community, 0, 60).await?;
    // Created two minutes ago with a one-minute lifetime.
    sqlx::query("UPDATE invites SET created_at = $1 WHERE code = $2")
        .bind(
            (Utc::now() - chrono::Duration::minutes(2))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        )
        .bind(&code)
        .execute(&app.db)
        .await?;

    let (status, body) = register(&app, "late", Some(&code)).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_NOT_USABLE_MESSAGE,
    );
    Ok(())
}

#[tokio::test]
async fn invite_only_refuses_an_exhausted_or_unknown_invite() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::InviteOnly).await?;
    let community = community(&app).await?;
    let code = invite(&app, &community, 2, 0).await?;
    sqlx::query("UPDATE invites SET uses = 2 WHERE code = $1")
        .bind(&code)
        .execute(&app.db)
        .await?;

    let (status, body) = register(&app, "toolate", Some(&code)).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_NOT_USABLE_MESSAGE,
    );

    let (status, body) = register(&app, "guesser", Some("notarealcode")).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_NOT_USABLE_MESSAGE,
    );
    Ok(())
}

/// Registration does not spend a use, so the account count is bounded
/// separately: a one-use invite makes one account, not one per attempt.
#[tokio::test]
async fn a_limited_invite_creates_no_more_accounts_than_it_has_uses() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::InviteOnly).await?;
    let community = community(&app).await?;
    let code = invite(&app, &community, 1, 0).await?;

    let (status, body) = register(&app, "first", Some(&code)).await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = register(&app, "second", Some(&code)).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_NOT_USABLE_MESSAGE,
    );

    // An unlimited invite has no such bound.
    let open_code = invite(&app, &community, 0, 0).await?;
    for name in ["third", "fourth"] {
        let (status, body) = register(&app, name, Some(&open_code)).await?;
        assert_eq!(status, StatusCode::CREATED, "{name}: {body}");
    }
    Ok(())
}

#[tokio::test]
async fn open_mode_is_unchanged() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::Open).await?;
    community(&app).await?;
    let (status, body) = register(&app, "walkin", None).await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    // An invite code, even a bogus one, is simply not looked at.
    let (status, body) = register(&app, "walkin2", Some("whatever")).await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    Ok(())
}

/// An instance built without saying anything (the runtime default, which is
/// what a config lacking the key produces) is open, exactly as before.
#[tokio::test]
async fn an_instance_that_never_chose_stays_open() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    assert_eq!(
        app.state.runtime.read().await.registration_mode,
        RegistrationMode::Open
    );
    community(&app).await?;
    let (status, body) = register(&app, "oldfriend", None).await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    let (status, options) = send(
        &app,
        build_json_request(Method::GET, "/api/v1/auth/options", None, None)?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(options["registration_mode"], "open");
    assert_eq!(options["registration_enabled"], true);
    Ok(())
}

/// With `[setup] require_claim = false` the first account registered becomes
/// the owner. Nobody exists yet who could have sent it an invite.
#[tokio::test]
async fn the_first_account_on_an_unclaimed_by_design_instance_needs_no_invite() -> anyhow::Result<()>
{
    let app = app_in(RegistrationMode::InviteOnly).await?;
    let (status, body) = register(&app, "founder", None).await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = register(&app, "second", None).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_REQUIRED_MESSAGE,
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Key-based registration (`POST /auth/verify` with a key nobody has)
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn verify_new_key(
    app: &TestApp,
    seed: u8,
    username: &str,
    invite_code: Option<&str>,
) -> anyhow::Result<(StatusCode, Value)> {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let (status, challenge) = send(
        app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/challenge",
            Some(json!({})),
            None,
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "challenge: {challenge}");
    let nonce = challenge["nonce"].as_str().expect("nonce");
    let timestamp = challenge["timestamp"].as_i64().expect("timestamp");
    let origin = challenge["server_origin"].as_str().expect("origin");
    let signature = hex_encode(
        &key.sign(format!("{nonce}:{timestamp}:{origin}").as_bytes())
            .to_bytes(),
    );
    let mut body = json!({
        "public_key": hex_encode(key.verifying_key().as_bytes()),
        "nonce": nonce,
        "timestamp": timestamp,
        "signature": signature,
        "username": username,
    });
    if let Some(code) = invite_code {
        body["invite_code"] = json!(code);
    }
    send(
        app,
        build_json_request(Method::POST, "/api/v1/auth/verify", Some(body), None)?,
    )
    .await
}

#[tokio::test]
async fn key_registration_follows_the_same_rule() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::InviteOnly).await?;
    let community = community(&app).await?;

    let (status, body) = verify_new_key(&app, 7, "keyless", None).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_REQUIRED_MESSAGE,
    );

    let code = invite(&app, &community, 1, 0).await?;
    let (status, body) = verify_new_key(&app, 8, "keyfriend", Some(&code)).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["user"]["username"], "keyfriend");

    // The one-use invite has made its one account.
    let (status, body) = verify_new_key(&app, 9, "keyextra", Some(&code)).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_NOT_USABLE_MESSAGE,
    );

    // A key that already has an account signs in with no invite at all.
    let (status, body) = verify_new_key(&app, 8, "keyfriend", None).await?;
    assert_eq!(status, StatusCode::OK, "returning key: {body}");
    Ok(())
}

// ---------------------------------------------------------------------------
// First-owner claim, and an unclaimed instance
// ---------------------------------------------------------------------------

async fn pending_app() -> anyhow::Result<TestApp> {
    let app = build_test_app(TestAppOptions {
        instance_setup_complete: false,
        ..Default::default()
    })
    .await?;
    app.state.runtime.write().await.registration_mode = RegistrationMode::InviteOnly;
    let hash = paracord_core::instance_setup::hash_claim_token(CLAIM_TOKEN);
    assert!(
        paracord_db::instance_setup::set_claim_token(
            &app.db,
            &hash,
            paracord_db::instance_setup::TOKEN_SOURCE_CONFIG,
            Utc::now(),
        )
        .await?
    );
    Ok(app)
}

fn claim_body(mode: Option<&str>) -> Value {
    let mut body = json!({
        "token": CLAIM_TOKEN,
        "username": "owner",
        "email": "owner@example.com",
        "password": PASSWORD,
        "instance_name": "Riverside",
        "initial_space_name": "The Lounge",
    });
    if let Some(mode) = mode {
        body["registration_mode"] = json!(mode);
    }
    body
}

#[tokio::test]
async fn the_owner_claim_works_in_invite_only_mode() -> anyhow::Result<()> {
    let app = pending_app().await?;

    let (status, setup) = send(
        &app,
        build_json_request(Method::GET, "/api/v1/setup/status", None, None)?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(setup["setup_required"], true);
    assert_eq!(setup["registration_mode"], "invite_only");
    assert!(setup["router_forwarding"].is_boolean(), "{setup}");

    let (status, body) = send(
        &app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(None)),
            None,
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Once claimed, the setup status says nothing about how it is configured.
    let (_, setup) = send(
        &app,
        build_json_request(Method::GET, "/api/v1/setup/status", None, None)?,
    )
    .await?;
    assert_eq!(setup["setup_required"], false);
    assert!(setup.get("registration_mode").is_none(), "{setup}");
    assert!(setup.get("router_forwarding").is_none(), "{setup}");

    // And it is still invite-only for everyone after the owner.
    let (status, body) = register(&app, "stranger", None).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_REQUIRED_MESSAGE,
    );
    Ok(())
}

#[tokio::test]
async fn the_owners_choice_at_setup_is_saved() -> anyhow::Result<()> {
    let app = pending_app().await?;
    let (status, body) = send(
        &app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(Some("open"))),
            None,
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        app.state.runtime.read().await.registration_mode,
        RegistrationMode::Open
    );
    assert_eq!(
        paracord_db::server_settings::get_setting(&app.db, "registration_mode")
            .await?
            .as_deref(),
        Some("open")
    );
    let (status, body) = register(&app, "walkin", None).await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    Ok(())
}

/// A new key on an unclaimed instance used to become its administrator,
/// skipping the setup claim entirely.
#[tokio::test]
async fn a_new_key_cannot_register_on_an_unclaimed_instance() -> anyhow::Result<()> {
    let app = pending_app().await?;
    app.state.runtime.write().await.registration_mode = RegistrationMode::Open;
    let (status, body) = verify_new_key(&app, 21, "squatter", None).await?;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(user_count(&app).await?, 0, "no account was created");
    Ok(())
}

// ---------------------------------------------------------------------------
// The admin switch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_admin_switch_changes_the_mode_and_refuses_anything_else() -> anyhow::Result<()> {
    let app = app_in(RegistrationMode::Open).await?;
    let admin = paracord_db::users::create_user(
        &app.db,
        paracord_util::snowflake::generate(1),
        "boss",
        1,
        "boss@example.com",
        &paracord_core::auth::hash_password(PASSWORD)?,
    )
    .await?;
    paracord_db::users::update_user_flags(&app.db, admin.id, paracord_core::USER_FLAG_ADMIN)
        .await?;
    let (status, login) = send(
        &app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/login",
            Some(json!({ "email": "boss@example.com", "password": PASSWORD })),
            None,
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{login}");
    let token = login["token"].as_str().expect("token").to_string();

    let (status, body) = send(
        &app,
        build_json_request(
            Method::PATCH,
            "/api/v1/admin/settings",
            Some(json!({ "registration_mode": "sometimes" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, body) = send(
        &app,
        build_json_request(
            Method::PATCH,
            "/api/v1/admin/settings",
            Some(json!({ "registration_mode": "invite_only" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["registration_mode"], "invite_only");

    let (_, options) = send(
        &app,
        build_json_request(Method::GET, "/api/v1/auth/options", None, None)?,
    )
    .await?;
    assert_eq!(options["registration_mode"], "invite_only");
    let (status, body) = register(&app, "stranger", None).await?;
    assert_invite_refusal(
        status,
        &body,
        paracord_core::registration::INVITE_REQUIRED_MESSAGE,
    );
    Ok(())
}
