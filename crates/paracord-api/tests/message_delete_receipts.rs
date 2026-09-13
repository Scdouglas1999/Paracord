mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

const NONCE: &str = "879b7b92-14b8-4aa6-a386-b18cb063015a";
const OTHER_NONCE: &str = "fee16c43-fd24-4528-a2aa-5847dfe6b65e";

async fn call(
    app: &TestApp,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    dispatch_json(
        &app.app,
        build_json_request(method, path, body, Some(token)).unwrap(),
    )
    .await
    .unwrap()
}

struct Fixture {
    app: TestApp,
    owner: String,
    member: String,
    owner_id: i64,
    member_id: i64,
    guild: i64,
    channel: i64,
}
async fn setup() -> Fixture {
    let app = build_test_app(TestAppOptions {
        database_connections: 3,
        ..Default::default()
    })
    .await
    .unwrap();
    let owner =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "deleteowner", "DeleteOwner123!")
            .await
            .unwrap();
    let member = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "deletemember",
        "DeleteMember123!",
    )
    .await
    .unwrap();
    let owner_id = call(&app, &owner, Method::GET, "/api/v1/users/@me", None)
        .await
        .1["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let member_id = call(&app, &member, Method::GET, "/api/v1/users/@me", None)
        .await
        .1["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (status, guild) = call(
        &app,
        &owner,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Deletion receipts"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild = guild["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::add_member(&app.db, member_id, guild)
        .await
        .unwrap();
    let channels = call(
        &app,
        &owner,
        Method::GET,
        &format!("/api/v1/guilds/{guild}/channels"),
        None,
    )
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
        owner,
        member,
        owner_id,
        member_id,
        guild,
        channel,
    }
}

async fn send(f: &Fixture, nonce: &str) -> i64 {
    let (status, message) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", f.channel),
        Some(json!({"content":format!("<@{}> retained context", f.member_id), "nonce":nonce})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    message["id"].as_str().unwrap().parse().unwrap()
}

fn path(f: &Fixture, id: i64) -> String {
    format!("/api/v1/channels/{}/messages/{id}", f.channel)
}
async fn delete(f: &Fixture, token: &str, id: i64, nonce: &str) -> (StatusCode, Value) {
    call(
        &f.app,
        token,
        Method::DELETE,
        &path(f, id),
        Some(json!({"delete_nonce":nonce})),
    )
    .await
}
async fn resolve(f: &Fixture, token: &str, id: i64, nonce: &str) -> (StatusCode, Value) {
    call(
        &f.app,
        token,
        Method::POST,
        &format!("{}/deletions/{nonce}/resolve", path(f, id)),
        None,
    )
    .await
}
async fn receipts(f: &Fixture) -> i64 {
    sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM message_delete_receipts")
        .fetch_one(&f.app.db)
        .await
        .unwrap()
        .0
}
async fn activity(f: &Fixture) -> (Option<i64>, i64) {
    let channel = paracord_db::channels::get_channel(&f.app.db, f.channel)
        .await
        .unwrap()
        .unwrap();
    (channel.last_message_id, channel.message_revision)
}
async fn mentions(f: &Fixture) -> i32 {
    paracord_db::read_states::get_read_state(&f.app.db, f.member_id, f.channel)
        .await
        .unwrap()
        .map_or(0, |row| row.mention_count)
}
async fn overwrite(f: &Fixture, allow: Permissions, deny: Permissions) {
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &f.app.db,
        f.channel,
        f.member_id,
        1,
        allow.bits(),
        deny.bits(),
    )
    .await
    .unwrap();
    paracord_core::permissions::invalidate_user(&f.app.state.permission_cache, f.member_id).await;
}

#[tokio::test]
async fn lost_delete_response_resolves_and_replays_without_deleting_new_activity() {
    let f = setup().await;
    let id = send(&f, "original").await;
    let mut events = f
        .app
        .event_bus
        .register_session("delete-observer", f.member_id, &[f.guild])
        .unwrap();
    let pending = resolve(&f, &f.owner, id, NONCE).await;
    assert_eq!(pending.0, StatusCode::OK, "{pending:?}");
    assert_eq!(pending.1["state"], "pending");
    assert_eq!(receipts(&f).await, 0);
    assert_eq!(activity(&f).await, (Some(id), 1));
    let committed = delete(&f, &f.owner, id, NONCE).await;
    assert_eq!(committed.0, StatusCode::OK, "{committed:?}");
    assert_eq!(
        committed.1,
        json!({"channel_id":f.channel.to_string(), "message_id":id.to_string(), "actor_id":f.owner_id.to_string(), "delete_nonce":NONCE, "state":"deleted", "delete_replayed":false})
    );
    assert_eq!(activity(&f).await, (None, 2));
    assert_eq!(mentions(&f).await, 0);
    let resolved = resolve(&f, &f.owner, id, NONCE).await;
    assert_eq!(resolved.0, StatusCode::OK, "{resolved:?}");
    assert_eq!(resolved.1["state"], "deleted");
    assert_eq!(resolved.1["delete_replayed"], true);
    let newer = send(&f, "newer").await;
    let replay = delete(&f, &f.owner, id, NONCE).await;
    assert_eq!(replay.0, StatusCode::OK, "{replay:?}");
    assert_eq!(replay.1["delete_replayed"], true);
    assert_eq!(activity(&f).await, (Some(newer), 3));
    assert_eq!(mentions(&f).await, 1);
    assert_eq!(receipts(&f).await, 1);
    let mut deleted = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.event_type == "MESSAGE_DELETE" {
            deleted.push(event);
        }
    }
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].payload["channel_activity"]["revision"], "2");
}

#[tokio::test]
async fn concurrent_identical_deletes_commit_once_across_real_connections() {
    let f = setup().await;
    let id = send(&f, "concurrent").await;
    let (a, b) = tokio::join!(
        delete(&f, &f.owner, id, NONCE),
        delete(&f, &f.owner, id, NONCE)
    );
    assert_eq!(a.0, StatusCode::OK, "{a:?}");
    assert_eq!(b.0, StatusCode::OK, "{b:?}");
    assert_ne!(a.1["delete_replayed"], b.1["delete_replayed"]);
    assert_eq!(activity(&f).await, (None, 2));
    assert_eq!(receipts(&f).await, 1);
}

#[tokio::test]
async fn a_nonce_cannot_retarget_even_when_two_deletions_race() {
    let f = setup().await;
    let first = send(&f, "first").await;
    let second = send(&f, "second").await;
    let (a, b) = tokio::join!(
        delete(&f, &f.owner, first, NONCE),
        delete(&f, &f.owner, second, NONCE)
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT),
        "{a:?} {b:?}"
    );
    let surviving = if a.0 == StatusCode::OK { second } else { first };
    assert_eq!(activity(&f).await, (Some(surviving), 3));
    assert_eq!(
        resolve(&f, &f.owner, surviving, NONCE).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(receipts(&f).await, 1);
}

#[tokio::test]
async fn resolve_and_delete_serialize_without_cancelling_the_operation() {
    let f = setup().await;
    let id = send(&f, "resolve-race").await;
    let (resolution, deletion) = tokio::join!(
        resolve(&f, &f.owner, id, NONCE),
        delete(&f, &f.owner, id, NONCE)
    );
    assert_eq!(resolution.0, StatusCode::OK, "{resolution:?}");
    assert!([json!("pending"), json!("deleted")].contains(&resolution.1["state"]));
    assert_eq!(deletion.0, StatusCode::OK, "{deletion:?}");
    assert_eq!(resolve(&f, &f.owner, id, NONCE).await.1["state"], "deleted");
}

#[tokio::test]
async fn receipts_are_actor_owned_and_absent_targets_are_not_proof() {
    let f = setup().await;
    let id = send(&f, "actor-owned").await;
    assert_eq!(
        resolve(&f, &f.member, id, NONCE).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        delete(&f, &f.member, id, NONCE).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(delete(&f, &f.owner, id, NONCE).await.0, StatusCode::OK);
    assert_eq!(
        resolve(&f, &f.member, id, NONCE).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        delete(&f, &f.owner, id, OTHER_NONCE).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        resolve(&f, &f.owner, id, OTHER_NONCE).await.0,
        StatusCode::NOT_FOUND
    );
    let legacy = send(&f, "legacy").await;
    assert_eq!(
        call(&f.app, &f.owner, Method::DELETE, &path(&f, legacy), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        resolve(&f, &f.owner, legacy, OTHER_NONCE).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(receipts(&f).await, 1);
}

#[tokio::test]
async fn moderator_replay_requires_visibility_but_not_a_new_delete_permission() {
    let f = setup().await;
    let id = send(&f, "moderator").await;
    overwrite(&f, Permissions::MANAGE_MESSAGES, Permissions::empty()).await;
    assert_eq!(delete(&f, &f.member, id, NONCE).await.0, StatusCode::OK);
    let next = send(&f, "revoked-moderator").await;
    overwrite(&f, Permissions::empty(), Permissions::MANAGE_MESSAGES).await;
    assert_eq!(
        resolve(&f, &f.member, id, NONCE).await.1["state"],
        "deleted"
    );
    assert_eq!(delete(&f, &f.member, id, NONCE).await.0, StatusCode::OK);
    assert_eq!(
        resolve(&f, &f.member, next, OTHER_NONCE).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        delete(&f, &f.member, next, OTHER_NONCE).await.0,
        StatusCode::FORBIDDEN
    );
    overwrite(&f, Permissions::empty(), Permissions::VIEW_CHANNEL).await;
    assert_eq!(
        resolve(&f, &f.member, id, NONCE).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        delete(&f, &f.member, id, NONCE).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(receipts(&f).await, 1);
}

#[tokio::test]
async fn dm_membership_is_required_for_new_deletion_legacy_deletion_and_receipt_lookup() {
    let f = setup().await;
    let dm = 992_004;
    paracord_db::dms::create_dm_channel(&f.app.db, dm, f.owner_id, f.member_id)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for id in [992_005, 992_006] {
        paracord_db::messages::create_message(
            &f.app.db,
            id,
            dm,
            f.member_id,
            "ciphertext",
            0,
            None,
        )
        .await
        .unwrap();
        ids.push(id);
    }
    let first_path = format!("/api/v1/channels/{dm}/messages/{}", ids[0]);
    let second_path = format!("/api/v1/channels/{dm}/messages/{}", ids[1]);
    assert_eq!(
        call(
            &f.app,
            &f.member,
            Method::DELETE,
            &first_path,
            Some(json!({"delete_nonce":NONCE}))
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query("DELETE FROM dm_recipients WHERE channel_id = $1 AND user_id = $2")
        .bind(dm)
        .bind(f.member_id)
        .execute(&f.app.db)
        .await
        .unwrap();
    for body in [None, Some(json!({"delete_nonce":OTHER_NONCE}))] {
        assert_eq!(
            call(&f.app, &f.member, Method::DELETE, &second_path, body)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &f.app,
            &f.member,
            Method::POST,
            &format!("{first_path}/deletions/{NONCE}/resolve"),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.app,
            &f.member,
            Method::DELETE,
            &first_path,
            Some(json!({"delete_nonce":NONCE}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert!(paracord_db::messages::get_message(&f.app.db, ids[1])
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn invalid_durable_requests_cannot_silently_become_legacy_deletion() {
    let f = setup().await;
    let id = send(&f, "validation").await;
    for body in [
        json!({}),
        json!(null),
        json!({"delete_nonce":""}),
        json!({"delete_nonce":"not-a-uuid"}),
        json!({"delete_nonce":"00000000-0000-0000-0000-000000000000"}),
        json!({"delete_nonce":NONCE, "content":"unexpected"}),
    ] {
        let mut request =
            build_json_request(Method::DELETE, &path(&f, id), Some(body), Some(&f.owner)).unwrap();
        request
            .headers_mut()
            .remove(axum::http::header::CONTENT_TYPE);
        assert_eq!(
            dispatch_json(&f.app.app, request).await.unwrap().0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(activity(&f).await, (Some(id), 1));
    assert_eq!(receipts(&f).await, 0);
}

async fn injected_failure_rolls_back(tail: bool) {
    let f = setup().await;
    let id = send(&f, "rollback").await;
    let (table, action) = if tail {
        ("channels", "BEFORE UPDATE OF last_message_id")
    } else {
        ("message_delete_receipts", "AFTER INSERT")
    };
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            let condition = if tail {
                " WHEN NEW.last_message_id IS NULL AND OLD.last_message_id IS NOT NULL"
            } else {
                ""
            };
            sqlx::query(&format!("CREATE TRIGGER reject_deletion {action} ON {table}{condition} BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END")).execute(&f.app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            let body = if tail {
                "IF NEW.last_message_id IS NULL AND OLD.last_message_id IS NOT NULL THEN RAISE EXCEPTION 'injected deletion failure'; END IF; RETURN NEW;"
            } else {
                "RAISE EXCEPTION 'injected deletion failure';"
            };
            sqlx::query(&format!("CREATE FUNCTION reject_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN {body} END; $$")).execute(&f.app.db).await.unwrap();
            sqlx::query(&format!("CREATE TRIGGER reject_deletion {action} ON {table} FOR EACH ROW EXECUTE FUNCTION reject_deletion()")).execute(&f.app.db).await.unwrap();
        }
    }
    assert_eq!(
        delete(&f, &f.owner, id, NONCE).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(activity(&f).await, (Some(id), 1));
    assert_eq!(mentions(&f).await, 1);
    assert_eq!(receipts(&f).await, 0);
    assert!(paracord_db::messages::get_message(&f.app.db, id)
        .await
        .unwrap()
        .is_some());
    let drop = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => "DROP TRIGGER reject_deletion".to_string(),
        paracord_db::DatabaseEngine::Postgres => format!("DROP TRIGGER reject_deletion ON {table}"),
    };
    sqlx::query(&drop).execute(&f.app.db).await.unwrap();
    assert_eq!(resolve(&f, &f.owner, id, NONCE).await.1["state"], "pending");
    assert_eq!(delete(&f, &f.owner, id, NONCE).await.0, StatusCode::OK);
    assert_eq!(activity(&f).await, (None, 2));
    assert_eq!(receipts(&f).await, 1);
}

#[tokio::test]
async fn receipt_failure_rolls_back_the_message_mentions_and_tail() {
    injected_failure_rolls_back(false).await;
}

#[tokio::test]
async fn tail_failure_rolls_back_the_receipt_message_and_mentions() {
    injected_failure_rolls_back(true).await;
}
