//! The desktop app's control channel and the admin status routes
//! (docs/setup-spec.md §2.5, §8.5, §9.1): the loopback + token guard, the
//! status shape, backups, the backup toggle and the escrow pre-checks.
//!
//! The escrow write is S4's (`paracord_core::storage_key`), the reachability
//! retry S5's (`paracord_core::reachability`).

mod common;

use std::net::SocketAddr;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{header, Method, Request, StatusCode},
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_contracts::host::HostStatus;
use paracord_core::HostRuntimeConfig;
use serde_json::{json, Value};

const TOKEN: &str = "test-control-token-0123456789abcdef";

struct Host {
    app: TestApp,
    token_file: std::path::PathBuf,
    escrow_file: std::path::PathBuf,
    _dir: tempfile::TempDir,
    _database_dir: Option<tempfile::TempDir>,
}

async fn host() -> anyhow::Result<Host> {
    host_with_database(None).await
}

/// The backup tests (which need a database file) live in `host_backups.rs`.
async fn host_with_database(database_url: Option<String>) -> anyhow::Result<Host> {
    let dir = tempfile::tempdir()?;
    let token_file = dir.path().join("host-control.token");
    let escrow_file = dir.path().join("storage-key.escrow");
    std::fs::write(&token_file, format!("{TOKEN}\n"))?;
    let app = build_test_app(TestAppOptions {
        database_url,
        host: Some(HostRuntimeConfig {
            enabled: true,
            instance_id: Some("11111111-2222-4333-8444-555555555555".into()),
            control_token_file: Some(token_file.to_string_lossy().into()),
            escrow_file: Some(escrow_file.to_string_lossy().into()),
        }),
        ..Default::default()
    })
    .await?;
    Ok(Host {
        app,
        token_file,
        escrow_file,
        _dir: dir,
        _database_dir: None,
    })
}

fn loopback() -> ConnectInfo<SocketAddr> {
    ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 49_152)))
}

/// A request as the desktop app sends it: loopback peer, `Authorization: Host`.
fn host_request(
    method: Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Host {token}"));
    }
    let mut request = if let Some(body) = body {
        builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    } else {
        builder.body(Body::empty()).unwrap()
    };
    request.extensions_mut().insert(loopback());
    request
}

async fn call(host: &Host, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
    dispatch_json(&host.app.app, request).await
}

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ── The guard ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn host_routes_do_not_exist_on_a_server_that_is_not_a_host() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let request = host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN));
    let (status, payload) = dispatch_json(&app.app, request).await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{payload}");
    assert_eq!(payload["code"], "host_disabled");
    Ok(())
}

#[tokio::test]
async fn every_host_route_refuses_a_caller_without_the_token() -> anyhow::Result<()> {
    let host = host().await?;
    let routes = [
        (Method::GET, "/api/v1/host/status"),
        (Method::POST, "/api/v1/host/reachability/retry"),
        (Method::POST, "/api/v1/host/backup-now"),
        (Method::POST, "/api/v1/host/storage-key/escrow"),
    ];
    for (method, path) in routes {
        let body = (method != Method::GET).then(|| json!({ "wrapping_key": b64url(&[7u8; 32]) }));
        for token in [None, Some("wrong"), Some("")] {
            let (status, payload) = call(
                &host,
                host_request(method.clone(), path, body.clone(), token),
            )
            .await?;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {path} {token:?}: {payload}"
            );
            assert_eq!(payload["code"], "host_auth");
        }
    }
    Ok(())
}

#[tokio::test]
async fn a_user_session_is_not_a_host_token() -> anyhow::Result<()> {
    let host = host().await?;
    let session = create_authenticated_user_token(
        &host.app.db,
        &host.app.jwt_secret,
        "hostcaller",
        "Correct-Horse-1",
    )
    .await?;
    let mut request = host_request(Method::GET, "/api/v1/host/status", None, None);
    request
        .headers_mut()
        .insert(header::AUTHORIZATION, format!("Bearer {session}").parse()?);
    let (status, payload) = call(&host, request).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{payload}");
    assert_eq!(payload["code"], "host_auth");
    Ok(())
}

#[tokio::test]
async fn the_right_token_from_another_machine_is_refused() -> anyhow::Result<()> {
    let host = host().await?;
    for peer in [
        SocketAddr::from(([192, 168, 1, 40], 50_000)),
        SocketAddr::from(([10, 0, 0, 2], 50_000)),
        "[2001:db8::1]:50000".parse()?,
    ] {
        let mut request = host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN));
        request.extensions_mut().insert(ConnectInfo(peer));
        let (status, payload) = call(&host, request).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{peer}: {payload}");
        assert_eq!(payload["code"], "host_auth");
    }
    // No peer address at all (not a TCP connection) is refused too.
    let mut request = host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN));
    request.extensions_mut().remove::<ConnectInfo<SocketAddr>>();
    let (status, _) = call(&host, request).await?;
    // The harness stamps a 10.x peer when none is present: still not loopback.
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn a_proxied_request_is_refused_even_from_a_loopback_peer() -> anyhow::Result<()> {
    let host = host().await?;
    for header_name in ["x-forwarded-for", "forwarded", "x-real-ip"] {
        let mut request = host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN));
        request
            .headers_mut()
            .insert(header_name, "203.0.113.9".parse()?);
        let (status, payload) = call(&host, request).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{header_name}: {payload}");
    }
    // The TLS listener tags every request `https`; that is not a proxy.
    let mut request = host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN));
    request
        .headers_mut()
        .insert("x-forwarded-proto", "https".parse()?);
    let (status, payload) = call(&host, request).await?;
    assert_eq!(status, StatusCode::OK, "{payload}");
    Ok(())
}

#[tokio::test]
async fn a_new_start_replaces_the_token_and_the_old_one_stops_working() -> anyhow::Result<()> {
    let host = host().await?;
    let (status, _) = call(
        &host,
        host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN)),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    std::fs::write(&host.token_file, "token-of-the-next-start-abcdef012345")?;
    let (status, payload) = call(
        &host,
        host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN)),
    )
    .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{payload}");
    let (status, _) = call(
        &host,
        host_request(
            Method::GET,
            "/api/v1/host/status",
            None,
            Some("token-of-the-next-start-abcdef012345"),
        ),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn an_unreadable_or_empty_token_file_lets_nobody_in() -> anyhow::Result<()> {
    let host = host().await?;
    std::fs::write(&host.token_file, "")?;
    let (status, payload) = call(
        &host,
        host_request(Method::GET, "/api/v1/host/status", None, Some("anything")),
    )
    .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{payload}");

    std::fs::remove_file(&host.token_file)?;
    let (status, payload) = call(
        &host,
        host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN)),
    )
    .await?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{payload}");
    assert_eq!(payload["code"], "host_token_unavailable");
    Ok(())
}

// ── Status ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn status_has_the_contract_shape() -> anyhow::Result<()> {
    let host = host().await?;
    let (status, payload) = call(
        &host,
        host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN)),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{payload}");
    let parsed: HostStatus = serde_json::from_value(payload.clone())?;
    assert_eq!(parsed.version, env!("CARGO_PKG_VERSION"));
    assert!(!parsed.setup_required, "the harness completes setup");
    assert!(!parsed.backups.enabled);
    assert_eq!(parsed.backups.keep, 10);
    assert_eq!(parsed.backups.interval_seconds, 86_400);
    assert!(!parsed.storage.escrowed);
    assert_eq!(payload["reachability"]["state"], "off");
    // TLS is off in the harness: an empty fingerprint says so.
    assert_eq!(parsed.tls.fingerprint_sha256, "");
    Ok(())
}

#[tokio::test]
async fn status_reports_an_escrow_that_exists() -> anyhow::Result<()> {
    let host = host().await?;
    std::fs::write(&host.escrow_file, "{}")?;
    let (_, payload) = call(
        &host,
        host_request(Method::GET, "/api/v1/host/status", None, Some(TOKEN)),
    )
    .await?;
    assert_eq!(payload["storage"]["escrowed"], true, "{payload}");
    Ok(())
}

// ── Backups ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn admins_switch_automatic_backups_and_the_choice_beats_the_config() -> anyhow::Result<()> {
    let host = host().await?;
    let admin = admin_token(&host, "backupadmin").await?;
    let member = create_authenticated_user_token(
        &host.app.db,
        &host.app.jwt_secret,
        "plainmember",
        "Correct-Horse-1",
    )
    .await?;

    // Not an admin: refused.
    let request = build_json_request(
        Method::PATCH,
        "/api/v1/admin/backups",
        Some(json!({ "enabled": true })),
        Some(&member),
    )?;
    let (status, _) = call(&host, request).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!paracord_api::routes::host_status::auto_backup_enabled(&host.app.state).await);

    for enabled in [true, false, true] {
        let request = build_json_request(
            Method::PATCH,
            "/api/v1/admin/backups",
            Some(json!({ "enabled": enabled })),
            Some(&admin),
        )?;
        let (status, payload) = call(&host, request).await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "{payload}");
        // The effective value the scheduler reads each tick.
        assert_eq!(
            paracord_api::routes::host_status::auto_backup_enabled(&host.app.state).await,
            enabled
        );
        let request =
            build_json_request(Method::GET, "/api/v1/admin/host-status", None, Some(&admin))?;
        let (_, payload) = call(&host, request).await?;
        assert_eq!(payload["backups"]["enabled"], enabled, "{payload}");
    }
    Ok(())
}

// ── Escrow and retry ───────────────────────────────────────────────────────

#[tokio::test]
async fn escrow_checks_its_input_before_anything_else() -> anyhow::Result<()> {
    let host = host().await?;
    let path = "/api/v1/host/storage-key/escrow";

    for bad in [
        json!({ "wrapping_key": "not base64 !!" }),
        json!({ "wrapping_key": b64url(&[1u8; 16]) }),
    ] {
        let (status, payload) = call(
            &host,
            host_request(Method::POST, path, Some(bad), Some(TOKEN)),
        )
        .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    }

    // One call per instance: a present escrow is never replaced.
    std::fs::write(&host.escrow_file, "{}")?;
    let (status, payload) = call(
        &host,
        host_request(
            Method::POST,
            path,
            Some(json!({ "wrapping_key": b64url(&[1u8; 32]) })),
            Some(TOKEN),
        ),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT, "{payload}");
    assert_eq!(std::fs::read_to_string(&host.escrow_file)?, "{}");
    Ok(())
}

/// An escrow names the owner's identity key, so a server nobody has claimed
/// has nothing to escrow under, and says so instead of writing anything.
#[tokio::test]
async fn the_escrow_needs_an_owner() -> anyhow::Result<()> {
    let host = host().await?;
    let (status, payload) = call(
        &host,
        host_request(
            Method::POST,
            "/api/v1/host/storage-key/escrow",
            Some(json!({ "wrapping_key": b64url(&[1u8; 32]) })),
            Some(TOKEN),
        ),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT, "{payload}");
    assert!(!host.escrow_file.exists(), "nothing half-written");
    Ok(())
}

/// With no router being asked there is nothing to retry, and the control
/// channel says so instead of accepting a request that does nothing.
#[tokio::test]
async fn a_retry_with_no_router_in_play_is_refused_not_swallowed() -> anyhow::Result<()> {
    let host = host().await?;
    let (status, payload) = call(
        &host,
        host_request(
            Method::POST,
            "/api/v1/host/reachability/retry",
            None,
            Some(TOKEN),
        ),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT, "{payload}");
    Ok(())
}

// ── Admin routes ───────────────────────────────────────────────────────────

async fn admin_token(host: &Host, prefix: &str) -> anyhow::Result<String> {
    let token = create_authenticated_user_token(
        &host.app.db,
        &host.app.jwt_secret,
        prefix,
        "Correct-Horse-1",
    )
    .await?;
    let claims = paracord_core::auth::validate_token(&token, &host.app.jwt_secret)?;
    paracord_db::users::update_user_flags(&host.app.db, claims.sub, paracord_core::USER_FLAG_ADMIN)
        .await?;
    Ok(token)
}

#[tokio::test]
async fn admin_host_status_is_for_admins() -> anyhow::Result<()> {
    let host = host().await?;
    let path = "/api/v1/admin/host-status";

    let (status, _) = call(&host, build_json_request(Method::GET, path, None, None)?).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let member = create_authenticated_user_token(
        &host.app.db,
        &host.app.jwt_secret,
        "statusmember",
        "Correct-Horse-1",
    )
    .await?;
    let (status, _) = call(
        &host,
        build_json_request(Method::GET, path, None, Some(&member))?,
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let admin = admin_token(&host, "statusadmin").await?;
    let (status, payload) = call(
        &host,
        build_json_request(Method::GET, path, None, Some(&admin))?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{payload}");
    let _: HostStatus = serde_json::from_value(payload)?;

    // The admin routes work on a server that is not a host, too.
    let plain = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &plain.db,
        &plain.jwt_secret,
        "plainadmin",
        "Correct-Horse-1",
    )
    .await?;
    let claims = paracord_core::auth::validate_token(&token, &plain.jwt_secret)?;
    paracord_db::users::update_user_flags(&plain.db, claims.sub, paracord_core::USER_FLAG_ADMIN)
        .await?;
    let (status, payload) = dispatch_json(
        &plain.app,
        build_json_request(Method::GET, path, None, Some(&token))?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{payload}");
    Ok(())
}

#[tokio::test]
async fn only_the_owner_may_escrow_the_storage_key() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let escrow_file = dir.path().join("storage-key.escrow");
    let app = build_test_app(TestAppOptions {
        instance_setup_complete: false,
        host: Some(HostRuntimeConfig {
            enabled: true,
            instance_id: Some("11111111-2222-4333-8444-555555555555".into()),
            control_token_file: None,
            escrow_file: Some(escrow_file.to_string_lossy().into()),
        }),
        ..Default::default()
    })
    .await?;
    let mut tokens = Vec::new();
    for prefix in ["owner", "otheradmin"] {
        let token =
            create_authenticated_user_token(&app.db, &app.jwt_secret, prefix, "Correct-Horse-1")
                .await?;
        let claims = paracord_core::auth::validate_token(&token, &app.jwt_secret)?;
        paracord_db::users::update_user_flags(&app.db, claims.sub, paracord_core::USER_FLAG_ADMIN)
            .await?;
        tokens.push((token, claims.sub));
    }
    assert!(
        paracord_db::instance_setup::complete_claim(
            &app.db,
            tokens[0].1,
            "Test",
            chrono::Utc::now()
        )
        .await?
    );

    let body = json!({ "wrapping_key": b64url(&[9u8; 32]) });
    let path = "/api/v1/admin/storage-key/escrow";

    let (status, payload) = dispatch_json(
        &app.app,
        build_json_request(Method::POST, path, Some(body.clone()), Some(&tokens[1].0))?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "another admin is not the owner: {payload}"
    );

    // The owner passes the guard and the checks; the write itself is S4's.
    let (status, payload) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            path,
            Some(json!({ "wrapping_key": "short" })),
            Some(&tokens[0].0),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");

    // The owner's escrow, under the S1 vector identity: the storage key comes
    // back with the escrow key derived from that identity, and only once.
    const INSTANCE: &str = "11111111-2222-4333-8444-555555555555";
    let identity_private = paracord_util::hex::hex_decode(
        "d2cb3a96fd540c24f68825716fdb1e8c2549542d67fd5d25107635c2959f8d9c",
    )
    .unwrap();
    let identity_public = "ad1556f6b39cd51a513052c0be97b86e668adb99fadb813e0c02ebddf7037fd4";
    paracord_db::users::update_user_public_key(&app.db, tokens[0].1, identity_public).await?;
    let master_key = paracord_util::at_rest::generate_master_key();
    paracord_core::storage_key::init(paracord_core::storage_key::StorageKeyRuntime {
        enabled: true,
        sqlite_encrypted: true,
        files_encrypted: true,
        instance_id: Some(INSTANCE.into()),
        escrow_file: Some(escrow_file.clone()),
        master_key: Some(master_key),
        ..Default::default()
    });
    let escrow_key = paracord_util::at_rest::derive_escrow_key(&identity_private, INSTANCE);
    let body = json!({ "wrapping_key": b64url(&escrow_key) });
    let (status, payload) = dispatch_json(
        &app.app,
        build_json_request(Method::POST, path, Some(body.clone()), Some(&tokens[0].0))?,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{payload}");
    let escrow = paracord_core::storage_key::read_escrow_file(&escrow_file)?;
    assert_eq!(escrow.instance_id, INSTANCE);
    assert_eq!(escrow.owner_public_key, identity_public);
    assert_eq!(
        paracord_core::storage_key::unwrap_escrow(&escrow, &escrow_key).unwrap(),
        master_key
    );

    let (status, payload) = dispatch_json(
        &app.app,
        build_json_request(Method::POST, path, Some(body), Some(&tokens[0].0))?,
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT, "write-once: {payload}");
    Ok(())
}
