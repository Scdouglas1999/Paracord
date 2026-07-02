mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use common::{build_test_app, TestApp, TestAppOptions};
use std::time::Duration;
use tower::ServiceExt;

struct TestHarness {
    app: Router,
    _test_app: TestApp,
}

impl TestHarness {
    async fn new_without_migrations() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            run_migrations: false,
            install_http_rate_limiter: true,
            ..Default::default()
        })
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            _test_app: test_app,
        })
    }

    async fn new_with_migrations() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            run_migrations: true,
            install_http_rate_limiter: true,
            ..Default::default()
        })
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            _test_app: test_app,
        })
    }
}

#[tokio::test]
async fn rate_limit_tiers_cover_auth_bot_and_bot_write_paths() -> anyhow::Result<()> {
    // Regression guard: auth/refresh should still reach handler stack even if DB isn't migrated.
    let no_migration_harness = TestHarness::new_without_migrations().await?;
    let refresh_request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/refresh")
        .body(Body::empty())?;
    let refresh_response = no_migration_harness
        .app
        .clone()
        .oneshot(refresh_request)
        .await?;
    assert_eq!(refresh_response.status(), StatusCode::UNAUTHORIZED);

    let harness = TestHarness::new_with_migrations().await?;

    // 1) Auth tier (60/min) on /auth/* endpoints.
    let mut auth_tier_limited = false;
    for _ in 0..80 {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/challenge")
            .body(Body::empty())?;
        let response = harness.app.clone().oneshot(request).await?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            auth_tier_limited = true;
            break;
        }
    }
    assert!(
        auth_tier_limited,
        "expected auth-tier rate limiting to trigger within burst window"
    );

    // Avoid overlap with the global 1s limiter bucket between tiers.
    tokio::time::sleep(Duration::from_millis(1100)).await;

    // 2) Bot write tier (5/s) on write methods with Bot auth header.
    let mut bot_write_tier_limited = false;
    for _ in 0..20 {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/challenge")
            .header("authorization", "Bot coverage-bot-write-token")
            .body(Body::empty())?;
        let response = harness.app.clone().oneshot(request).await?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            bot_write_tier_limited = true;
            break;
        }
    }
    assert!(
        bot_write_tier_limited,
        "expected bot write-tier rate limiting to trigger for POST requests"
    );

    tokio::time::sleep(Duration::from_millis(1100)).await;

    // 3) Bot tier (300/min) on all bot requests. Pace requests to stay below global 120/s.
    let mut bot_tier_limited = false;
    for _ in 0..360 {
        let request = Request::builder()
            .method("GET")
            .uri("/api/v1/health")
            .header("authorization", "Bot coverage-bot-tier-token")
            .body(Body::empty())?;
        let response = harness.app.clone().oneshot(request).await?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            bot_tier_limited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        bot_tier_limited,
        "expected bot-tier per-minute rate limiting to trigger"
    );

    Ok(())
}
