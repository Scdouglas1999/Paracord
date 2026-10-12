//! Backups report their status to the reachability hub, so admins hear about a
//! change as `INSTANCE_STATUS_UPDATE` (docs/setup-spec.md §5.5, §8.5): after
//! the switch changes and after every backup.
//!
//! Its own test binary: the hub is process-wide, and other tests that toggle
//! backups or make archives would race these assertions.

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use paracord_contracts::host::{InstanceStatusUpdate, StorageStatus};
use paracord_core::reachability::{hub, spawn_status_broadcaster};
use paracord_models::gateway::EVENT_INSTANCE_STATUS_UPDATE;
use serde_json::json;
use tokio::sync::broadcast;

async fn next_status_update(
    events: &mut broadcast::Receiver<paracord_core::events::ServerEvent>,
) -> anyhow::Result<InstanceStatusUpdate> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .map_err(|_| anyhow::anyhow!("no INSTANCE_STATUS_UPDATE within 5 s"))??;
        if event.event_type == EVENT_INSTANCE_STATUS_UPDATE {
            return Ok(serde_json::from_value((*event.payload).clone())?);
        }
    }
}

#[tokio::test]
async fn backup_changes_reach_admins_as_instance_status_updates() -> anyhow::Result<()> {
    // A file database, because a backup snapshots the database file.
    let database_dir = tempfile::tempdir()?;
    let url = format!(
        "sqlite://{}?mode=rwc",
        database_dir.path().join("backup-event.sqlite").display()
    );
    let app = build_test_app(TestAppOptions {
        database_url: Some(url),
        ..Default::default()
    })
    .await?;

    // Storage is reported by the at-rest boot in the real server; the payload
    // exists only once every part is known.
    hub().set_storage(StorageStatus {
        enabled: false,
        sqlite_encrypted: false,
        files_encrypted: false,
        key_source: None,
        protection: None,
        escrowed: false,
    });
    let mut events = app.event_bus.subscribe_system();
    let broadcaster = spawn_status_broadcaster(hub().clone(), app.event_bus.clone());

    // Startup: the server publishes once.
    paracord_api::routes::host_status::publish_backups(&app.state).await;
    let update = next_status_update(&mut events).await?;
    let configured = app.state.config.auto_backup_enabled;
    assert_eq!(update.backups.enabled, configured);
    assert_eq!(update.backups.keep, app.state.config.max_backups);

    let admin = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "backupevents",
        "Correct-Horse-1",
    )
    .await?;
    let claims = paracord_core::auth::validate_token(&admin, &app.jwt_secret)?;
    paracord_db::users::update_user_flags(&app.db, claims.sub, paracord_core::USER_FLAG_ADMIN)
        .await?;

    // Each switch is a change, so each one is announced.
    for enabled in [!configured, configured] {
        let request = build_json_request(
            Method::PATCH,
            "/api/v1/admin/backups",
            Some(json!({ "enabled": enabled })),
            Some(&admin),
        )?;
        let (status, payload) = dispatch_json(&app.app, request).await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "{payload}");
        let update = next_status_update(&mut events).await?;
        assert_eq!(update.backups.enabled, enabled, "switch {enabled}");
    }

    // A backup: the time of the last one moves.
    assert_eq!(
        hub()
            .subscribe()
            .borrow()
            .backups
            .as_ref()
            .and_then(|b| b.last_backup_at.clone()),
        None
    );
    paracord_api::routes::host_status::run_backup(&app.state, false, 2).await?;
    let update = next_status_update(&mut events).await?;
    assert!(update.backups.last_backup_at.is_some(), "{update:?}");
    assert!(update.backups.last_error.is_none());

    broadcaster.abort();
    Ok(())
}
