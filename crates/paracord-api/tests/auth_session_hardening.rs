mod common;

use std::net::SocketAddr;

use axum::{
    body::{to_bytes, Body},
    extract::connect_info::ConnectInfo,
    http::{header, HeaderMap, Request, StatusCode},
    Router,
};
use common::{build_test_app, TestApp, TestAppOptions};
use serde_json::{json, Value};
use tower::ServiceExt;

/// Fixed peer address so every request in a test shares one `ip:` auth-guard
/// bucket (the harness only stamps a synthetic address when none is present).
const PEER: [u8; 4] = [198, 51, 100, 77];

struct Harness {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    _test_app: TestApp,
}

impl Harness {
    async fn new(run_migrations: bool) -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            run_migrations,
            ..Default::default()
        })
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            _test_app: test_app,
        })
    }

    async fn send(&self, request: Request<Body>) -> anyhow::Result<(StatusCode, HeaderMap, Value)> {
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await?;
        let payload = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
        };
        Ok((status, headers, payload))
    }
}

fn post_json(
    uri: &str,
    body: Value,
    extra_headers: &[(&str, &str)],
) -> anyhow::Result<Request<Body>> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in extra_headers {
        builder = builder.header(*name, *value);
    }
    let mut request = builder.body(Body::from(body.to_string()))?;
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from((PEER, 49152))));
    Ok(request)
}

async fn create_password_user(
    db: &paracord_db::DbPool,
    username: &str,
    email: &str,
    password: &str,
) -> anyhow::Result<paracord_db::users::UserRow> {
    let user = paracord_db::users::create_user(
        db,
        paracord_util::snowflake::generate(1),
        username,
        1,
        email,
        &paracord_core::auth::hash_password(password)?,
    )
    .await?;
    Ok(user)
}

/// A throwaway account's successful login/registration must not wipe the shared
/// `ip:` failure counter accumulated while guessing another account's password.
///
/// Registration is enabled by default, so without this the attack loop is:
/// N wrong passwords against the victim -> log into a throwaway account from the
/// same IP -> the `ip:` guard row is deleted and the failure count restarts.
/// `ip:` is the only key that can hard-block (`device:` is a client-supplied
/// header the attacker rotates freely), so the exponential backoff would never
/// advance past its first tier.
#[tokio::test]
async fn throwaway_account_success_does_not_reset_ip_auth_guard() -> anyhow::Result<()> {
    let harness = Harness::new(true).await?;
    let victim_password = "V1ctimPassw0rd!";
    create_password_user(
        &harness.db,
        "guardvictim",
        "guard-victim@example.com",
        victim_password,
    )
    .await?;

    // Four wrong passwords: one short of the lockout threshold.
    for attempt in 0..4 {
        let (status, _, body) = harness
            .send(post_json(
                "/api/v1/auth/login",
                json!({ "email": "guard-victim@example.com", "password": "wrong-password" }),
                &[],
            )?)
            .await?;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "attempt {attempt} should be rejected: {body}"
        );
    }

    // The attacker's own throwaway account, registered from the same IP.
    let (register_status, _, register_body) = harness
        .send(post_json(
            "/api/v1/auth/register",
            json!({
                "email": "throwaway@example.com",
                "username": "throwaway",
                "password": "Thr0waway!Pass"
            }),
            &[],
        )?)
        .await?;
    assert_eq!(
        register_status,
        StatusCode::CREATED,
        "throwaway registration failed: {register_body}"
    );

    // Fifth wrong password. If the registration had cleared the shared `ip:`
    // counter this would be failure #1 and nothing would lock.
    let (status, _, _) = harness
        .send(post_json(
            "/api/v1/auth/login",
            json!({ "email": "guard-victim@example.com", "password": "wrong-password" }),
            &[],
        )?)
        .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The IP is now locked out: even the correct password is refused.
    let (status, _, body) = harness
        .send(post_json(
            "/api/v1/auth/login",
            json!({ "email": "guard-victim@example.com", "password": victim_password }),
            &[],
        )?)
        .await?;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "auth-guard lockout must survive an unrelated account's success: {body}"
    );

    Ok(())
}

/// A transient database failure must not be reported to clients as "your token
/// is invalid": they respond to 401 by clearing credentials, so a brief blip
/// would log out every session on the server.
#[tokio::test]
async fn database_failure_surfaces_as_5xx_not_401() -> anyhow::Result<()> {
    // No migrations: the session-revocation lookup in the auth extractor fails
    // with a database error, standing in for an unavailable database.
    let harness = Harness::new(false).await?;
    let token = paracord_core::auth::create_session_token(
        paracord_util::snowflake::generate(1),
        None,
        &harness.jwt_secret,
        3600,
        "session-id",
        "token-jti",
    )?;

    let mut request = Request::builder()
        .uri("/api/v1/users/@me")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())?;
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from((PEER, 49152))));

    let (status, _, body) = harness.send(request).await?;
    assert!(
        status.is_server_error(),
        "database failure must surface as 5xx, got {status}: {body}"
    );

    // A genuinely invalid credential still gets 401 (the fall-through path is
    // intact, not blanket-500'd).
    let mut bad = Request::builder()
        .uri("/api/v1/users/@me")
        .header(header::AUTHORIZATION, "Bearer not-a-jwt")
        .body(Body::empty())?;
    bad.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from((PEER, 49152))));
    let (status, _, _) = harness.send(bad).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    Ok(())
}

/// A taken username must answer with the same generic 400 as a taken email —
/// not a 500 from the unmapped `UNIQUE(username, discriminator)` violation,
/// which distinguishes taken names from free ones.
#[tokio::test]
async fn duplicate_username_registration_is_generic_400() -> anyhow::Result<()> {
    let harness = Harness::new(true).await?;

    let (status, _, body) = harness
        .send(post_json(
            "/api/v1/auth/register",
            json!({
                "email": "first@example.com",
                "username": "takenname",
                "password": "F1rstPassw0rd!"
            }),
            &[],
        )?)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "first registration: {body}");

    let (dup_status, _, dup_body) = harness
        .send(post_json(
            "/api/v1/auth/register",
            json!({
                "email": "second@example.com",
                "username": "takenname",
                "password": "Sec0ndPassw0rd!"
            }),
            &[],
        )?)
        .await?;
    assert_eq!(
        dup_status,
        StatusCode::BAD_REQUEST,
        "duplicate username must not 500: {dup_body}"
    );

    // Same wording as the duplicate-email path, so neither field can be probed.
    let (email_status, _, email_body) = harness
        .send(post_json(
            "/api/v1/auth/register",
            json!({
                "email": "first@example.com",
                "username": "anothername",
                "password": "Th1rdPassw0rd!"
            }),
            &[],
        )?)
        .await?;
    assert_eq!(email_status, StatusCode::BAD_REQUEST);
    assert_eq!(
        dup_body.get("message").or_else(|| dup_body.get("error")),
        email_body
            .get("message")
            .or_else(|| email_body.get("error")),
        "username and email collisions must be indistinguishable: {dup_body} vs {email_body}"
    );

    Ok(())
}

/// Same-site browser clients get the refresh token only as an `HttpOnly` cookie;
/// echoing it in the JSON body hands a 30-day credential to any XSS on the page.
/// Cross-origin and native clients, which `SameSite=Lax` cuts off from the
/// cookie, still receive it.
#[tokio::test]
async fn refresh_token_body_copy_is_withheld_from_same_site_clients() -> anyhow::Result<()> {
    let harness = Harness::new(true).await?;
    let password = "C00kiePolicy!Pass";
    create_password_user(
        &harness.db,
        "cookieuser",
        "cookie-user@example.com",
        password,
    )
    .await?;

    let credentials = json!({ "email": "cookie-user@example.com", "password": password });

    let (status, headers, body) = harness
        .send(post_json(
            "/api/v1/auth/login",
            credentials.clone(),
            &[
                (header::HOST.as_str(), "chat.example.com"),
                (header::ORIGIN.as_str(), "https://chat.example.com"),
            ],
        )?)
        .await?;
    assert_eq!(status, StatusCode::OK, "same-site login failed: {body}");
    let set_cookies: Vec<String> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(str::to_string)
        .collect();
    assert!(
        set_cookies
            .iter()
            .any(|cookie| cookie.starts_with("paracord_refresh=") && cookie.contains("HttpOnly")),
        "refresh cookie must still be set: {set_cookies:?}"
    );
    assert!(
        body.get("refresh_token").is_none(),
        "same-site clients must not receive the refresh token in the body: {body}"
    );

    // Cross-origin client (e.g. the Vite dev proxy or a second server entry).
    let (status, _, body) = harness
        .send(post_json(
            "/api/v1/auth/login",
            credentials.clone(),
            &[
                (header::HOST.as_str(), "chat.example.com"),
                (header::ORIGIN.as_str(), "http://localhost:1420"),
            ],
        )?)
        .await?;
    assert_eq!(status, StatusCode::OK, "cross-origin login failed: {body}");
    assert!(
        body.get("refresh_token").and_then(Value::as_str).is_some(),
        "cross-origin clients cannot use the cookie and still need the body copy: {body}"
    );

    // Native client: no Origin header at all.
    let (status, _, body) = harness
        .send(post_json("/api/v1/auth/login", credentials, &[])?)
        .await?;
    assert_eq!(status, StatusCode::OK, "native login failed: {body}");
    assert!(
        body.get("refresh_token").and_then(Value::as_str).is_some(),
        "native clients have no cookie jar for this origin: {body}"
    );

    Ok(())
}
