//! `POST /host/backup-now` and backup pruning (docs/setup-spec.md §2.5, §8.5).
//!
//! Its own test binary: a backup snapshots the database *file*, so these run on
//! a SQLite file even when `PARACORD_TEST_POSTGRES_URL` points the rest of the
//! suite at PostgreSQL. The database engine is process-wide
//! (`paracord_db`'s active engine is set once), so a SQLite file cannot share a
//! process with the suite's PostgreSQL apps (moved out of `host_control.rs`).

mod common;

use std::net::SocketAddr;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{header, Method, Request, StatusCode},
};
use common::{build_test_app, dispatch_json, TestApp, TestAppOptions};
use paracord_core::HostRuntimeConfig;
use serde_json::Value;

const TOKEN: &str = "test-control-token-0123456789abcdef";

struct Host {
    app: TestApp,
    _dir: tempfile::TempDir,
    _database_dir: tempfile::TempDir,
}

async fn file_database_host() -> anyhow::Result<Host> {
    let dir = tempfile::tempdir()?;
    let database_dir = tempfile::tempdir()?;
    let token_file = dir.path().join("host-control.token");
    std::fs::write(&token_file, format!("{TOKEN}\n"))?;
    let app = build_test_app(TestAppOptions {
        database_url: Some(format!(
            "sqlite://{}?mode=rwc",
            database_dir.path().join("backup-test.sqlite").display()
        )),
        host: Some(HostRuntimeConfig {
            enabled: true,
            instance_id: Some("11111111-2222-4333-8444-555555555555".into()),
            control_token_file: Some(token_file.to_string_lossy().into()),
            escrow_file: Some(
                dir.path()
                    .join("storage-key.escrow")
                    .to_string_lossy()
                    .into(),
            ),
        }),
        ..Default::default()
    })
    .await?;
    Ok(Host {
        app,
        _dir: dir,
        _database_dir: database_dir,
    })
}

fn host_request(method: Method, path: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Host {token}"));
    }
    let mut request = builder.body(Body::empty()).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 49_152))));
    request
}

async fn call(host: &Host, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
    dispatch_json(&host.app.app, request).await
}

#[tokio::test]
async fn backup_now_makes_an_archive_and_status_remembers_it() -> anyhow::Result<()> {
    let host = file_database_host().await?;
    let (status, payload) = call(
        &host,
        host_request(Method::POST, "/api/v1/host/backup-now", Some(TOKEN)),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{payload}");
    let name = payload["name"].as_str().expect("archive name").to_string();
    assert!(name.ends_with(".tar.gz"), "{name}");
    assert!(std::path::Path::new(&host.app.state.config.backup_dir)
        .join(&name)
        .exists());

    let (_, status_payload) = call(
        &host,
        host_request(Method::GET, "/api/v1/host/status", Some(TOKEN)),
    )
    .await?;
    assert!(
        status_payload["backups"]["last_backup_at"].is_string(),
        "{status_payload}"
    );
    assert!(status_payload["backups"]["last_error"].is_null());
    Ok(())
}

#[tokio::test]
async fn backup_pruning_never_removes_the_backup_just_made() -> anyhow::Result<()> {
    let host = file_database_host().await?;
    for _ in 0..3 {
        paracord_api::routes::host_status::run_backup(&host.app.state, false, 2).await?;
        // Archive names carry the second they were made in.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    }
    let kept = paracord_core::backup::list_backups(&host.app.state.config.backup_dir).await?;
    assert_eq!(kept.len(), 2);
    paracord_api::routes::host_status::run_backup(&host.app.state, false, 0).await?;
    let kept = paracord_core::backup::list_backups(&host.app.state.config.backup_dir).await?;
    assert_eq!(
        kept.len(),
        1,
        "a configured 0 keeps the newest, not nothing"
    );
    Ok(())
}
