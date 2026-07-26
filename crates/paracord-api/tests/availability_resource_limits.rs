//! Availability regressions for the two environmental multipliers: a request
//! that runs forever, and a pool wait that queues forever.
//!
//! Neither had a bound. A handler holds its database connection for as long as
//! it is querying, so with no request timeout and sqlx's 30s default acquire
//! timeout a slow request occupied a pool slot to completion while everything
//! behind it queued. Both tests reproduce that by holding the test pool's only
//! connection, which is the same starvation an attacker manufactures by
//! occupying every slot.
//!
//! Every test in this file drives a router built with a deliberately short
//! request timeout (`PARACORD_HTTP_REQUEST_TIMEOUT_SECS`) so the bound can be
//! observed without waiting out the 30s production default.

mod common;

use std::sync::Once;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use common::{build_json_request, build_test_app, create_authenticated_user_token, TestAppOptions};
use tower::ServiceExt;

/// Shorten the request timeout for every router this binary builds. `build_router`
/// reads the variable once per call, so it has to be set before the first one.
fn use_short_request_timeout() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        std::env::set_var("PARACORD_HTTP_REQUEST_TIMEOUT_SECS", "1");
    });
}

#[tokio::test]
async fn a_stalled_request_is_cut_off_instead_of_holding_its_pool_slot() -> anyhow::Result<()> {
    use_short_request_timeout();
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "stalled",
        "StalledPass123!",
    )
    .await?;

    // The test pool has exactly one connection; holding it is the same state a
    // saturated pool is in, and every DB-touching handler now blocks on acquire.
    let _hog = test_app.db.acquire().await?;

    let request = build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&token))?;
    let started = Instant::now();
    let response = test_app.app.clone().oneshot(request).await?;
    let elapsed = started.elapsed();

    assert_eq!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "a request that cannot make progress must be shed, not run to completion"
    );
    assert!(
        elapsed < Duration::from_secs(4),
        "the request timeout must fire on its own schedule, not wait out the \
         pool's acquire timeout; took {elapsed:?}"
    );

    Ok(())
}

#[tokio::test]
async fn streaming_and_upload_routes_are_exempt_from_the_request_timeout() -> anyhow::Result<()> {
    use_short_request_timeout();
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "exempt",
        "ExemptPass123!",
    )
    .await?;

    let _hog = test_app.db.acquire().await?;

    // `/channels/{id}/summary` calls out to an LLM under its own timeout, which
    // clamps as high as 120s, so it is on the exempt list. Under the same stall
    // that sheds an ordinary request in one second it must instead run on until
    // the pool itself gives up.
    let request = build_json_request(
        Method::GET,
        "/api/v1/channels/1/summary",
        None,
        Some(&token),
    )?;
    let started = Instant::now();
    let response = test_app.app.clone().oneshot(request).await?;
    let elapsed = started.elapsed();

    assert_ne!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "an exempt route must not be shed by the request timeout"
    );
    assert!(
        elapsed > Duration::from_secs(2),
        "an exempt route must outlive the 1s request timeout; took {elapsed:?}"
    );

    Ok(())
}

#[tokio::test]
async fn pool_acquire_gives_up_instead_of_queueing_for_sqlx_s_default() -> anyhow::Result<()> {
    // `ACTIVE_DB_ENGINE` is a process-global `OnceLock` set by the first pool
    // built in the binary. Creating a SQLite pool here while the other tests in
    // this file run against a provisioned PostgreSQL database would pin the
    // global to SQLite for all of them, and they would then take SQLite-only
    // code paths (`sqlite_master`, the checksum-repair pass) against Postgres.
    // The acquire timeout being asserted is engine-agnostic, so covering it on
    // SQLite alone loses nothing.
    if std::env::var("PARACORD_TEST_POSTGRES_URL")
        .ok()
        .is_some_and(|v| !v.trim().is_empty())
    {
        eprintln!("skipping pool-acquire test: it would pin the global engine to SQLite");
        return Ok(());
    }
    let pool = paracord_db::create_pool("sqlite::memory:", 1).await?;
    let _hog = pool.acquire().await?;

    // sqlx's default is 30s: every waiter parks for half a minute while still
    // holding its own request task, so a burst that outruns the pool becomes a
    // growing backlog rather than a few fast failures.
    let started = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(12), pool.acquire()).await;
    let elapsed = started.elapsed();

    let inner = outcome.expect("acquire must give up on its own, well inside 12s");
    assert!(
        inner.is_err(),
        "acquiring a second connection from a one-connection pool must fail"
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "acquire must be bounded well below sqlx's 30s default; took {elapsed:?}"
    );

    Ok(())
}
