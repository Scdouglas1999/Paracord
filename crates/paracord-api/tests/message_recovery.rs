mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_db::{message_recovery, messages};
use paracord_models::id::{ChannelId, MessageId, UserId};
use serde_json::{json, Value};

struct Fixture {
    app: TestApp,
    token: String,
    owner: i64,
    channel: i64,
}
async fn call(app: &TestApp, token: &str, path: &str) -> (StatusCode, Value) {
    dispatch_json(
        &app.app,
        build_json_request(Method::GET, path, None, Some(token)).unwrap(),
    )
    .await
    .unwrap()
}
async fn setup() -> Fixture {
    let app = build_test_app(TestAppOptions {
        database_connections: 3,
        ..Default::default()
    })
    .await
    .unwrap();
    let token = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "recovery-owner",
        "RecoveryOwner123!",
    )
    .await
    .unwrap();
    let owner = call(&app, &token, "/api/v1/users/@me").await.1["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (status, guild) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({"name":"Message recovery"})),
            Some(&token),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild = guild["id"].as_str().unwrap();
    let channels = call(&app, &token, &format!("/api/v1/guilds/{guild}/channels"))
        .await
        .1;
    let channel = channels
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["type"] == 0)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    Fixture {
        app,
        token,
        owner,
        channel,
    }
}
async fn encrypted(f: &Fixture, id: i64, body: &str, nonce: &str) -> messages::MessageRow {
    messages::create_message_with_meta(
        &f.app.db,
        id,
        f.channel,
        f.owner,
        body,
        0,
        None,
        1,
        Some(nonce),
        Some("{\"initial\":true}"),
    )
    .await
    .unwrap()
}
async fn page(f: &Fixture, suffix: &str) -> (StatusCode, Value) {
    call(
        &f.app,
        &f.token,
        &format!("/api/v1/channels/{}/messages/recovery?{suffix}", f.channel),
    )
    .await
}

#[tokio::test]
async fn ordered_envelopes_survive_edit_delete_and_fixed_fence_does_not_move() {
    let f = setup().await;
    let first = encrypted(&f, 51001, "initial-ciphertext", "initial-iv").await;
    let second = encrypted(&f, 51002, "dependent-ciphertext", "dependent-iv").await;
    assert_eq!((first.recovery_revision, second.recovery_revision), (1, 2));
    let edit = messages::update_message_authorized_with_meta(
        &f.app.db,
        first.id,
        f.channel,
        f.owner,
        "edited-ciphertext",
        Some("edit-iv"),
        Some("{\"independent\":true}"),
        Some(1),
        false,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(edit.recovery_revision, 3);
    messages::delete_message(&f.app.db, first.id).await.unwrap();
    let (status, start) = page(&f, "after=0&limit=2").await;
    assert_eq!(status, StatusCode::OK, "{start}");
    assert_eq!(start["through"], "4");
    assert_eq!(start["next"], "2");
    assert_eq!(start["complete"], false);
    assert_eq!(
        start["database_history_epoch"],
        f.app.state.database_history_epoch
    );
    let archived = &start["changes"][0]["archived_message"];
    assert_eq!(archived["content"], "");
    assert_eq!(archived["e2ee"]["ciphertext"], "initial-ciphertext");
    assert_eq!(archived["e2ee"]["nonce"], "initial-iv");
    assert_eq!(archived["e2ee"]["header"], "{\"initial\":true}");
    assert_eq!(archived["author"]["id"], f.owner.to_string());
    assert_eq!(start["states"][0]["state"], "deleted");
    encrypted(&f, 51003, "later-ciphertext", "later-iv").await;
    let (status, finish) = page(&f, "after=2&through=4&limit=2&known_ids=51003,51999").await;
    assert_eq!(status, StatusCode::OK, "{finish}");
    assert_eq!(finish["through"], "4");
    assert_eq!(finish["next"], "4");
    assert_eq!(finish["complete"], true);
    assert_eq!(finish["projection_head"], "5");
    assert_eq!(finish["changes"][0]["revision"], "3");
    assert_eq!(finish["changes"][0]["kind"], "update");
    assert_eq!(
        finish["changes"][0]["archived_message"]["e2ee"]["ciphertext"],
        "edited-ciphertext"
    );
    assert_eq!(finish["changes"][1]["revision"], "4");
    assert_eq!(finish["changes"][1]["kind"], "delete");
    assert!(finish["changes"][1]["archived_message"].is_null());
    let current = finish["states"]
        .as_array()
        .unwrap()
        .iter()
        .find(|state| state["message_id"] == "51003")
        .unwrap();
    assert_eq!(current["revision"], "5");
    assert_eq!(current["message"]["message_revision"], "5");
    assert_eq!(
        finish["states"].as_array().unwrap().last().unwrap()["state"],
        "deleted"
    );
}

#[tokio::test]
async fn deleted_plaintext_is_not_in_the_recovery_archive() {
    let f = setup().await;
    messages::create_message(
        &f.app.db,
        52001,
        f.channel,
        f.owner,
        "private original plaintext",
        0,
        None,
    )
    .await
    .unwrap();
    messages::update_message(&f.app.db, 52001, "private edited plaintext")
        .await
        .unwrap();
    messages::delete_message(&f.app.db, 52001).await.unwrap();
    let (status, body) = page(&f, "after=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["changes"].as_array().unwrap().len(), 3);
    assert!(!body.to_string().contains("private"));
    let retained: Vec<(Option<String>,)> =
        sqlx::query_as("SELECT encrypted_message FROM message_recovery WHERE channel_id = $1")
            .bind(f.channel)
            .fetch_all(&f.app.db)
            .await
            .unwrap();
    assert!(retained.iter().all(|row| row.0.is_none()));
    assert_eq!(body["states"][0]["state"], "deleted");
}

async fn reject_archive_writes(f: &Fixture) {
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query("CREATE TRIGGER reject_recovery BEFORE INSERT ON message_recovery BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END").execute(&f.app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query("CREATE FUNCTION reject_recovery_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected recovery failure'; END; $$").execute(&f.app.db).await.unwrap();
            sqlx::query("CREATE TRIGGER reject_recovery BEFORE INSERT ON message_recovery FOR EACH ROW EXECUTE FUNCTION reject_recovery_write()").execute(&f.app.db).await.unwrap();
        }
    }
}

#[tokio::test]
async fn failed_archive_write_rolls_back_create_edit_delete_receipt_and_channel_revision() {
    let f = setup().await;
    let original = encrypted(&f, 53001, "original", "original-iv").await;
    reject_archive_writes(&f).await;
    assert!(messages::create_message(
        &f.app.db,
        53002,
        f.channel,
        f.owner,
        "must roll back",
        0,
        None
    )
    .await
    .is_err());
    assert!(messages::get_message(&f.app.db, 53002)
        .await
        .unwrap()
        .is_none());
    assert!(messages::update_message_authorized_with_receipt(
        &f.app.db,
        MessageId::new(original.id),
        ChannelId::new(f.channel),
        UserId::new(f.owner),
        "must roll back",
        Some("new-iv"),
        Some("new-header"),
        Some(1),
        false,
        Some("failed-edit"),
        &[]
    )
    .await
    .is_err());
    assert!(messages::delete_message_with_receipt(
        &f.app.db,
        original.id,
        f.channel,
        f.owner,
        false,
        Some("failed-delete"),
        false
    )
    .await
    .is_err());
    let current = messages::get_message(&f.app.db, original.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.content.as_deref(), Some("original"));
    assert_eq!(current.nonce.as_deref(), Some("original-iv"));
    assert_eq!(current.recovery_revision, 1);
    assert_eq!(
        paracord_db::channels::get_channel(&f.app.db, f.channel)
            .await
            .unwrap()
            .unwrap()
            .message_revision,
        1
    );
    let edit_receipts: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM message_edit_receipts WHERE edit_nonce = 'failed-edit'",
    )
    .fetch_one(&f.app.db)
    .await
    .unwrap();
    let delete_receipts: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM message_delete_receipts WHERE delete_nonce = 'failed-delete'",
    )
    .fetch_one(&f.app.db)
    .await
    .unwrap();
    assert_eq!((edit_receipts.0, delete_receipts.0), (0, 0));
    let (status, body) = page(&f, "after=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["through"], "1");
}

#[tokio::test]
async fn bulk_deletion_has_unique_revisions_and_replays_do_not_append_again() {
    let f = setup().await;
    let a = encrypted(&f, 54001, "a", "a-iv").await;
    encrypted(&f, 54002, "b", "b-iv").await;
    let replay = messages::create_message_with_meta(
        &f.app.db,
        54999,
        f.channel,
        f.owner,
        "a",
        0,
        None,
        1,
        Some("a-iv"),
        Some("{\"initial\":true}"),
    )
    .await
    .unwrap();
    assert_eq!(replay.id, a.id);
    assert_eq!(replay.recovery_revision, 1);
    assert_eq!(
        messages::bulk_delete_messages(&f.app.db, f.channel, &[54002, 54001, 54999])
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        messages::bulk_delete_messages(&f.app.db, f.channel, &[54002, 54001])
            .await
            .unwrap(),
        0
    );
    let (status, body) = page(&f, "after=2&limit=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["next"], "3");
    assert_eq!(body["complete"], false);
    let (_, body) = page(&f, "after=3&through=4&limit=1").await;
    assert_eq!(body["next"], "4");
    assert_eq!(body["complete"], true);
}

#[tokio::test]
async fn bounded_retention_reports_gap_without_silently_advancing() {
    let f = setup().await;
    for id in 1..=message_recovery::RETAINED_MESSAGE_MUTATIONS + 1 {
        messages::create_message(
            &f.app.db,
            55000 + id,
            f.channel,
            f.owner,
            "bounded",
            0,
            None,
        )
        .await
        .unwrap();
    }
    let count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM message_recovery WHERE channel_id = $1")
            .bind(f.channel)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(count.0, message_recovery::RETAINED_MESSAGE_MUTATIONS);
    let (status, body) = page(&f, "after=0").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "MESSAGE_RECOVERY_GAP");
    assert_eq!(body["floor"], "1");
    assert_eq!(body["reason"], "retention");
    assert!(body.get("next").is_none());
    let (status, body) = page(&f, "after=1&limit=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["changes"][0]["revision"], "2");
}

#[tokio::test]
async fn recovery_requires_current_channel_history_permissions_and_valid_fences() {
    let f = setup().await;
    let outsider = create_authenticated_user_token(
        &f.app.db,
        &f.app.jwt_secret,
        "recovery-outsider",
        "RecoveryOutside123!",
    )
    .await
    .unwrap();
    encrypted(&f, 58001, "private", "private-iv").await;
    let (status, body) = call(
        &f.app,
        &outsider,
        &format!("/api/v1/channels/{}/messages/recovery?after=0", f.channel),
    )
    .await;
    assert!(
        matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
        "{status}: {body}"
    );
    for query in [
        "after=-1",
        "after=01",
        "after=0&limit=101",
        "after=2&through=1",
        "after=0&known_ids=0",
    ] {
        assert_eq!(page(&f, query).await.0, StatusCode::BAD_REQUEST, "{query}");
    }
    assert_eq!(
        page(&f, "after=0&through=999").await.0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn pre_feed_migration_marks_unprovable_history_without_inventing_envelopes() {
    let app = build_test_app(TestAppOptions {
        run_migrations: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let mut previous = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => sqlx::migrate!("../paracord-db/migrations"),
        paracord_db::DatabaseEngine::Postgres => sqlx::migrate!("../paracord-db/migrations_pg"),
    };
    previous.migrations = std::borrow::Cow::Owned(
        previous
            .iter()
            .filter(|migration| migration.version < 20260909000013)
            .cloned()
            .collect(),
    );
    previous.run(&app.db).await.unwrap();
    paracord_db::users::create_user(
        &app.db,
        59001,
        "legacy-recovery",
        1,
        "legacy-recovery@example.com",
        "hash",
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO channels(id, channel_type) VALUES(59002, 1)")
        .execute(&app.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO messages(id, channel_id, author_id, content) VALUES(59003, 59002, 59001, 'existing plaintext')").execute(&app.db).await.unwrap();
    paracord_db::run_migrations(&app.db).await.unwrap();
    assert!(matches!(
        message_recovery::get_page(&app.db, 59002, 0, None, 100, &[])
            .await
            .unwrap(),
        message_recovery::RecoveryResult::Gap {
            before_migration: true,
            floor: 1,
            ..
        }
    ));
    let archived: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM message_recovery WHERE channel_id = 59002")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(archived.0, 0);
}

#[tokio::test]
async fn projection_head_and_message_state_wait_for_the_same_committed_snapshot() {
    let f = setup().await;
    encrypted(&f, 60001, "snapshot", "snapshot-iv").await;
    let mut writer = f.app.db.begin().await.unwrap();
    sqlx::query("UPDATE channels SET message_revision = message_revision + 1 WHERE id = $1")
        .bind(f.channel)
        .execute(&mut *writer)
        .await
        .unwrap();
    // Pause a real writer between its revision and body writes. A recovery
    // reader must wait, not combine that revision with the previous body row.
    let pool = f.app.db.clone();
    let channel = f.channel;
    let mut reader = tokio::spawn(async move {
        message_recovery::get_page(&pool, channel, 0, Some(1), 100, &[60001])
            .await
            .unwrap()
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), &mut reader)
            .await
            .is_err()
    );
    sqlx::query("UPDATE messages SET pinned = TRUE, recovery_revision = 2 WHERE id = 60001")
        .execute(&mut *writer)
        .await
        .unwrap();
    sqlx::query("INSERT INTO message_recovery(channel_id, revision, message_id, kind, encrypted_message) SELECT channel_id, 2, message_id, 'update', encrypted_message FROM message_recovery WHERE channel_id = $1 AND revision = 1")
        .bind(channel).execute(&mut *writer).await.unwrap();
    writer.commit().await.unwrap();
    let message_recovery::RecoveryResult::Page(page) = reader.await.unwrap() else {
        panic!("expected coherent page");
    };
    assert_eq!(page.through, 1);
    assert_eq!(page.projection_head, 2);
    let current = page.states[0].1.as_ref().unwrap();
    assert_eq!(current.recovery_revision, 2);
    assert!(current.pinned);
}

#[tokio::test]
async fn publications_use_exact_mutation_revisions_and_only_committed_bulk_targets() {
    let f = setup().await;
    encrypted(&f, 61001, "first", "first-iv").await;
    encrypted(&f, 61002, "second", "second-iv").await;
    let mut events = f.app.event_bus.subscribe_system();
    f.app
        .event_bus
        .dispatch_message(
            &f.app.db,
            "MESSAGE_CREATE",
            json!({"id":"61001", "channel_id":f.channel.to_string()}),
            None,
        )
        .await;
    let created = events.recv().await.unwrap();
    assert_eq!(created.payload["message_revision"], "1");
    assert_eq!(created.payload["channel_activity"]["revision"], "2");
    let (status, body) = dispatch_json(
        &f.app.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/channels/{}/messages/bulk-delete", f.channel),
            Some(json!({"message_ids":["61002","61001","61999"]})),
            Some(&f.token),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(status.is_success(), "{status}: {body}");
    let deleted = events.recv().await.unwrap();
    assert_eq!(deleted.event_type, "MESSAGE_DELETE_BULK");
    let ids = deleted.payload["ids"].as_array().unwrap();
    assert_eq!(ids.len(), 2);
    assert!(!ids.contains(&json!("61999")));
    let revisions = deleted.payload["message_revisions"].as_object().unwrap();
    let mut ordered: Vec<_> = revisions
        .values()
        .map(|revision| revision.as_str().unwrap().parse::<i64>().unwrap())
        .collect();
    ordered.sort();
    assert_eq!(ordered, [3, 4]);
}

#[tokio::test]
async fn metadata_after_sender_erasure_preserves_original_crypto_sender_without_rearchiving() {
    let f = setup().await;
    encrypted(&f, 62001, "immutable-ciphertext", "immutable-iv").await;
    // Account erasure reattributes visible message rows to this reserved user.
    paracord_db::users::create_user(
        &f.app.db,
        paracord_db::users::DELETED_USER_ID,
        "deleted-recovery-user",
        0,
        "deleted-recovery@example.test",
        "unused",
    )
    .await
    .unwrap();
    sqlx::query("UPDATE messages SET author_id = $1 WHERE id = 62001")
        .bind(paracord_db::users::DELETED_USER_ID)
        .execute(&f.app.db)
        .await
        .unwrap();
    assert!(messages::pin_message(&f.app.db, 62001, f.channel)
        .await
        .unwrap());
    messages::update_message_embeds(&f.app.db, 62001, "[]")
        .await
        .unwrap();
    messages::update_message_components(&f.app.db, 62001, "[]")
        .await
        .unwrap();
    assert!(messages::unpin_message(&f.app.db, 62001, f.channel)
        .await
        .unwrap());
    let current = messages::get_message(&f.app.db, 62001)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.recovery_revision, 5);
    assert_eq!(current.author_id, paracord_db::users::DELETED_USER_ID);
    assert_eq!(current.content.as_deref(), Some("immutable-ciphertext"));
    assert_eq!(current.nonce.as_deref(), Some("immutable-iv"));
    let (status, body) = page(&f, "after=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["changes"][0]["archived_message"]["author"]["id"],
        f.owner.to_string()
    );
    for change in body["changes"].as_array().unwrap().iter().skip(1) {
        assert_eq!(change["kind"], "update");
        assert!(change["archived_message"].is_null());
    }
    assert_eq!(body["states"][0]["revision"], "5");
    assert_eq!(body["states"][0]["message"]["author"]["id"], "-1");
}
