//! Regression tests for the Ed25519 login key as a *credential*.
//!
//! `users.public_key` is not a profile field: `POST /api/v1/auth/verify`
//! resolves an account purely from the presented key and mints a brand-new
//! session, so a planted key is a permanent way back into an account that
//! session revocation cannot evict. These tests pin the four properties that
//! keep that from being a backdoor:
//!
//! * attaching or removing a key requires the account password (and its second
//!   factor), not just a bearer session;
//! * password change and password reset both clear it;
//! * the owner can see it and remove it;
//! * the key login path enforces the same MFA / email-verification gates as the
//!   password login path — and the password path fails closed when the MFA read
//!   errors.

mod common;

use std::net::SocketAddr;

use axum::{
    body::{to_bytes, Body},
    extract::connect_info::ConnectInfo,
    http::{header, Request, StatusCode},
    Router,
};
use common::{build_test_app, TestApp, TestAppOptions};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

/// A backup code in the format `generate_backup_codes` emits.
const BACKUP_CODE: &str = "AAAA-BBBB-CCCC-DDDD";

struct Harness {
    app: Router,
    test_app: TestApp,
}

impl Harness {
    async fn new() -> anyhow::Result<Self> {
        Self::with_options(TestAppOptions::default()).await
    }

    async fn with_options(options: TestAppOptions) -> anyhow::Result<Self> {
        let test_app = build_test_app(options).await?;
        Ok(Self {
            app: test_app.app.clone(),
            test_app,
        })
    }

    /// Rebuild the router over a mutated copy of the harness `AppState`. The
    /// harness has no knob for `require_email_verification`, and `AppConfig` is
    /// cloned into the router rather than shared, so the only way to exercise
    /// that gate is to mount a second router with the flag flipped.
    fn with_config(&self, mutate: impl FnOnce(&mut paracord_core::AppConfig)) -> Router {
        let mut state = self.test_app.state.clone();
        mutate(&mut state.config);
        paracord_api::build_router().with_state(state)
    }

    fn db(&self) -> &paracord_db::DbPool {
        &self.test_app.db
    }

    async fn send(&self, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
        dispatch(&self.app, request).await
    }
}

async fn dispatch(app: &Router, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let payload = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
    };
    Ok((status, payload))
}

fn json_request(method: &str, uri: &str, body: Value, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::from(body.to_string())).expect("request")
}

fn get_request(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("request")
}

/// Stamp a fixed peer address so a hand-built router (see `with_config`) still
/// satisfies the `ConnectInfo` extractor the auth routes require.
fn with_peer(mut request: Request<Body>) -> Request<Body> {
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 9], 41234))));
    request
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key_hex(key: &SigningKey) -> String {
    hex_encode(key.verifying_key().as_bytes())
}

/// Fetch a challenge and sign it exactly as a client would.
async fn signed_challenge(
    harness: &Harness,
    key: &SigningKey,
) -> anyhow::Result<(String, i64, String)> {
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/challenge",
            json!({}),
            None,
        ))
        .await?;
    assert_eq!(status, StatusCode::OK, "challenge failed: {body}");

    let nonce = body["nonce"].as_str().expect("nonce").to_string();
    let timestamp = body["timestamp"].as_i64().expect("timestamp");
    let server_origin = body["server_origin"].as_str().expect("server_origin");
    let message = format!("{nonce}:{timestamp}:{server_origin}");
    let signature = hex_encode(&key.sign(message.as_bytes()).to_bytes());
    Ok((nonce, timestamp, signature))
}

struct Account {
    user: paracord_db::users::UserRow,
    password: String,
}

impl Account {
    fn id(&self) -> i64 {
        self.user.id
    }
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

/// Mint a live session token for `user_id`. Re-callable: every attach/detach
/// revokes all sessions, so later steps need a fresh one.
async fn session_token(
    db: &paracord_db::DbPool,
    jwt_secret: &str,
    user_id: i64,
) -> anyhow::Result<String> {
    let session_id = format!("sess-{}", uuid::Uuid::new_v4().simple());
    let jti = format!("jti-{}", uuid::Uuid::new_v4().simple());
    paracord_db::sessions::create_session(
        db,
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
        jwt_secret,
        3600,
        &session_id,
        &jti,
    )?)
}

/// Turn MFA on for `user_id` with one usable backup code ([`BACKUP_CODE`]).
///
/// The secret has to be real base32 of RFC-4226 length: both the re-auth path
/// and `mfa_login` build a `TOTP` from it before falling back to backup codes.
async fn enable_mfa_with_backup_code(db: &paracord_db::DbPool, user_id: i64) -> anyhow::Result<()> {
    let secret = match totp_rs::Secret::generate_secret().to_encoded() {
        totp_rs::Secret::Encoded(encoded) => encoded,
        other => format!("{other}"),
    };
    paracord_db::mfa::upsert_mfa_secret(db, user_id, &secret).await?;
    paracord_db::mfa::enable_mfa(db, user_id).await?;
    paracord_db::mfa::store_backup_codes(db, user_id, &[sha256_hex(&normalize(BACKUP_CODE))])
        .await?;
    Ok(())
}

fn normalize(code: &str) -> String {
    code.trim().to_ascii_uppercase().replace(['-', ' '], "")
}

async fn stored_public_key(
    db: &paracord_db::DbPool,
    user_id: i64,
) -> anyhow::Result<Option<String>> {
    Ok(paracord_db::users::get_user_by_id(db, user_id)
        .await?
        .expect("user")
        .public_key)
}

// --- F1: attaching a key is a credential change, not a profile edit ---

/// A stolen session must not be enough to plant an Ed25519 key.
///
/// The signed challenge proves only that the caller holds the key they are
/// installing — which the attacker planting it trivially does — so it is not
/// authentication of the *account*. Without the account password this endpoint
/// hands anyone with one hijacked session a credential that survives password
/// rotation and session revocation.
#[tokio::test]
async fn attach_public_key_refuses_a_session_without_the_account_password() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "planted").await?;
    let token = session_token(harness.db(), &harness.test_app.jwt_secret, account.id()).await?;
    let attacker_key = signing_key(0x11);

    // No password at all.
    let (nonce, timestamp, signature) = signed_challenge(&harness, &attacker_key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({
                "public_key": public_key_hex(&attacker_key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "session alone must not attach a key: {body}"
    );
    assert_eq!(stored_public_key(harness.db(), account.id()).await?, None);

    // A guessed password is no better.
    let (nonce, timestamp, signature) = signed_challenge(&harness, &attacker_key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({
                "public_key": public_key_hex(&attacker_key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "password": "not-the-password",
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a wrong password must not attach a key: {body}"
    );
    assert_eq!(stored_public_key(harness.db(), account.id()).await?, None);

    // The account owner, with their password, still can.
    let owner_key = signing_key(0x22);
    let (nonce, timestamp, signature) = signed_challenge(&harness, &owner_key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({
                "public_key": public_key_hex(&owner_key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "password": account.password,
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(status, StatusCode::OK, "owner attach failed: {body}");
    assert_eq!(
        stored_public_key(harness.db(), account.id()).await?,
        Some(public_key_hex(&owner_key))
    );
    Ok(())
}

/// An account that already trusts a key must not have it silently replaced.
#[tokio::test]
async fn attach_public_key_cannot_overwrite_an_existing_key_without_the_password(
) -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "rotate").await?;
    let trusted_key = signing_key(0x33);
    paracord_db::users::update_user_public_key(
        harness.db(),
        account.id(),
        &public_key_hex(&trusted_key),
    )
    .await?;

    let token = session_token(harness.db(), &harness.test_app.jwt_secret, account.id()).await?;
    let attacker_key = signing_key(0x44);
    let (nonce, timestamp, signature) = signed_challenge(&harness, &attacker_key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({
                "public_key": public_key_hex(&attacker_key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "key rotation must re-authenticate: {body}"
    );
    assert_eq!(
        stored_public_key(harness.db(), account.id()).await?,
        Some(public_key_hex(&trusted_key)),
        "the trusted key must survive a refused rotation"
    );
    Ok(())
}

/// Password re-auth alone is not enough on an MFA account: the password is
/// exactly the thing a phisher has, and the key being installed outlives every
/// other recovery step.
#[tokio::test]
async fn attach_public_key_requires_the_second_factor_when_mfa_is_enabled() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "mfaattach").await?;
    enable_mfa_with_backup_code(harness.db(), account.id()).await?;
    let token = session_token(harness.db(), &harness.test_app.jwt_secret, account.id()).await?;
    let key = signing_key(0x55);

    let (nonce, timestamp, signature) = signed_challenge(&harness, &key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({
                "public_key": public_key_hex(&key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "password": account.password,
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "password without a second factor must not attach a key: {body}"
    );
    assert_eq!(stored_public_key(harness.db(), account.id()).await?, None);

    let (nonce, timestamp, signature) = signed_challenge(&harness, &key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({
                "public_key": public_key_hex(&key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "password": account.password,
                "mfa_code": "ZZZZ-ZZZZ-ZZZZ-ZZZZ",
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a wrong second factor must not attach a key: {body}"
    );
    assert_eq!(stored_public_key(harness.db(), account.id()).await?, None);

    let (nonce, timestamp, signature) = signed_challenge(&harness, &key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({
                "public_key": public_key_hex(&key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "password": account.password,
                "mfa_code": BACKUP_CODE,
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(status, StatusCode::OK, "owner attach failed: {body}");
    assert_eq!(
        stored_public_key(harness.db(), account.id()).await?,
        Some(public_key_hex(&key))
    );
    Ok(())
}

/// Changing the password is half of "I have been compromised, lock them out".
/// It only works if it also evicts a planted key.
#[tokio::test]
async fn changing_the_password_detaches_the_attached_key() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    // `verify` auto-registers unknown keys; turning registration off makes the
    // "key no longer authenticates" assertion unambiguous.
    harness
        .test_app
        .state
        .runtime
        .write()
        .await
        .registration_enabled = false;

    let account = create_account(harness.db(), "pwchange").await?;
    let planted = signing_key(0x66);
    paracord_db::users::update_user_public_key(
        harness.db(),
        account.id(),
        &public_key_hex(&planted),
    )
    .await?;

    let token = session_token(harness.db(), &harness.test_app.jwt_secret, account.id()).await?;
    let (status, body) = harness
        .send(json_request(
            "PUT",
            "/api/v1/users/@me/password",
            json!({
                "current_password": account.password,
                "new_password": "An0ther-Str0ng-Passw0rd!",
            }),
            Some(&token),
        ))
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "password change: {body}");

    assert_eq!(
        stored_public_key(harness.db(), account.id()).await?,
        None,
        "a password change must evict the attached key"
    );

    // And the planted key must no longer resolve to the victim's account.
    let (nonce, timestamp, signature) = signed_challenge(&harness, &planted).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/verify",
            json!({
                "public_key": public_key_hex(&planted),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "username": "plantedclient",
            }),
            None,
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the detached key must not authenticate anyone: {body}"
    );
    Ok(())
}

/// Same for the reset path, which is the flow a locked-out victim actually uses.
#[tokio::test]
async fn resetting_the_password_detaches_the_attached_key() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "pwreset").await?;
    let planted = signing_key(0x77);
    paracord_db::users::update_user_public_key(
        harness.db(),
        account.id(),
        &public_key_hex(&planted),
    )
    .await?;

    let reset_token = "reset-token-for-the-detach-regression-test";
    paracord_db::password_reset::create_reset_token(
        harness.db(),
        &sha256_hex(reset_token),
        account.id(),
        chrono::Utc::now() + chrono::Duration::hours(1),
    )
    .await?;

    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/reset-password",
            json!({ "token": reset_token, "new_password": "Recovery-Passw0rd!" }),
            None,
        ))
        .await?;
    assert_eq!(status, StatusCode::OK, "password reset: {body}");
    assert_eq!(
        stored_public_key(harness.db(), account.id()).await?,
        None,
        "a password reset must evict the attached key"
    );
    Ok(())
}

/// The victim could not previously even see the planted key.
#[tokio::test]
async fn me_exposes_whether_a_key_is_attached() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "visible").await?;
    let token = session_token(harness.db(), &harness.test_app.jwt_secret, account.id()).await?;

    let (status, body) = harness
        .send(get_request("/api/v1/users/@me", &token))
        .await?;
    assert_eq!(status, StatusCode::OK, "get_me: {body}");
    assert_eq!(body["has_public_key"], json!(false));
    assert_eq!(body["public_key"], Value::Null);

    let key = signing_key(0x88);
    paracord_db::users::update_user_public_key(harness.db(), account.id(), &public_key_hex(&key))
        .await?;

    let (status, body) = harness
        .send(get_request("/api/v1/users/@me", &token))
        .await?;
    assert_eq!(status, StatusCode::OK, "get_me: {body}");
    assert_eq!(body["has_public_key"], json!(true));
    assert_eq!(body["public_key"], json!(public_key_hex(&key)));
    Ok(())
}

/// And could not remove it. Detaching re-authenticates like attaching does, then
/// drops every session so anything minted through the key dies with it.
#[tokio::test]
async fn the_owner_can_detach_the_key_after_re_authenticating() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "detach").await?;
    let key = signing_key(0x99);
    paracord_db::users::update_user_public_key(harness.db(), account.id(), &public_key_hex(&key))
        .await?;

    let token = session_token(harness.db(), &harness.test_app.jwt_secret, account.id()).await?;

    // A session alone cannot detach either — removal is a credential change too.
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({ "detach": true }),
            Some(&token),
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "detach must re-authenticate: {body}"
    );
    assert!(stored_public_key(harness.db(), account.id())
        .await?
        .is_some());

    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/attach-public-key",
            json!({ "detach": true, "password": account.password }),
            Some(&token),
        ))
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "detach: {body}");
    assert_eq!(stored_public_key(harness.db(), account.id()).await?, None);

    // Detaching is trust-material churn: every session goes, this one included.
    let (status, _) = harness
        .send(get_request("/api/v1/users/@me", &token))
        .await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "detach must revoke the caller's session"
    );
    Ok(())
}

// --- F2: the key login path must apply the same gates as the password path ---

/// MFA was enforced on `/auth/login` and skipped entirely on `/auth/verify`,
/// which is the desktop client's normal login for remote servers. A key holder
/// walked straight past the account's second factor.
#[tokio::test]
async fn verify_requires_the_second_factor_when_the_account_has_mfa() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "mfaverify").await?;
    let key = signing_key(0xaa);
    paracord_db::users::update_user_public_key(harness.db(), account.id(), &public_key_hex(&key))
        .await?;
    enable_mfa_with_backup_code(harness.db(), account.id()).await?;

    let (nonce, timestamp, signature) = signed_challenge(&harness, &key).await?;
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/verify",
            json!({
                "public_key": public_key_hex(&key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "username": "mfaverifyclient",
            }),
            None,
        ))
        .await?;
    assert_eq!(status, StatusCode::OK, "verify: {body}");
    assert_eq!(
        body["user"]["mfa_required"],
        json!(true),
        "the key path must stop for the second factor: {body}"
    );
    assert_eq!(
        body["token"],
        json!(""),
        "no session token may be issued before MFA: {body}"
    );

    // The ticket completes through the shared MFA step, exactly like a password
    // login would.
    let ticket = body["user"]["mfa_ticket"].as_str().expect("ticket");
    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/mfa/login",
            json!({ "ticket": ticket, "code": BACKUP_CODE }),
            None,
        ))
        .await?;
    assert_eq!(status, StatusCode::OK, "mfa login: {body}");
    assert!(
        !body["token"].as_str().unwrap_or_default().is_empty(),
        "completing MFA must issue the session: {body}"
    );
    Ok(())
}

/// `require_email_verification` blocked `/auth/login` and not `/auth/verify`, so
/// attaching a key was a way to skip it forever. Auto-registration of a brand-new
/// key is deliberately still allowed: that account is created in this request
/// with a placeholder address that can never be verified.
#[tokio::test]
async fn verify_enforces_email_verification_for_existing_accounts() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let strict = harness.with_config(|config| config.require_email_verification = true);

    let account = create_account(harness.db(), "unverified").await?;
    let key = signing_key(0xbb);
    paracord_db::users::update_user_public_key(harness.db(), account.id(), &public_key_hex(&key))
        .await?;

    let (nonce, timestamp, signature) = signed_challenge(&harness, &key).await?;
    let (status, body) = dispatch(
        &strict,
        with_peer(json_request(
            "POST",
            "/api/v1/auth/verify",
            json!({
                "public_key": public_key_hex(&key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "username": "unverifiedclient",
            }),
            None,
        )),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an unverified account must not log in by key: {body}"
    );

    // Verifying the address unblocks it, proving the gate is the email state and
    // not the key path being broken outright.
    paracord_db::users::set_email_verified(harness.db(), account.id(), true).await?;
    let (nonce, timestamp, signature) = signed_challenge(&harness, &key).await?;
    let (status, body) = dispatch(
        &strict,
        with_peer(json_request(
            "POST",
            "/api/v1/auth/verify",
            json!({
                "public_key": public_key_hex(&key),
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": signature,
                "username": "unverifiedclient",
            }),
            None,
        )),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "verified key login: {body}");
    assert!(!body["token"].as_str().unwrap_or_default().is_empty());
    Ok(())
}

// --- F4: the MFA gate on the password path must fail closed ---

/// `if let Ok(Some(config))` made a database error indistinguishable from "no
/// MFA configured", so a pool timeout or an undecodable row handed out a full
/// session on the password alone. An unparseable timestamp reproduces the read
/// failure deterministically.
#[tokio::test]
async fn login_fails_closed_when_the_mfa_lookup_errors() -> anyhow::Result<()> {
    let harness = Harness::new().await?;
    let account = create_account(harness.db(), "failclosed").await?;

    sqlx::query(
        "INSERT INTO mfa_configs (user_id, totp_secret, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)",
    )
    .bind(account.id())
    .bind("JBSWY3DPEHPK3PXP")
    .bind(true)
    .bind("not-a-timestamp")
    .execute(harness.db())
    .await?;

    assert!(
        paracord_db::mfa::get_mfa_config(harness.db(), account.id())
            .await
            .is_err(),
        "the fixture must actually make the MFA read fail"
    );

    let (status, body) = harness
        .send(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({ "email": account.user.email, "password": account.password }),
            None,
        ))
        .await?;
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "a failed MFA read must not produce a session: {body}"
    );
    assert!(
        body["token"].as_str().unwrap_or_default().is_empty(),
        "no token may leak on the failure path: {body}"
    );
    Ok(())
}
