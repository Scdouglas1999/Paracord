mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};

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

async fn setup() -> (TestApp, String, String, i64) {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let alice = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "deliveryalice",
        "DeliveryAlice123!",
    )
    .await
    .unwrap();
    let bob =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "deliverybob", "DeliveryBob123!")
            .await
            .unwrap();
    let (_, a) = call(&app, &alice, Method::GET, "/api/v1/users/@me", None).await;
    let (_, b) = call(&app, &bob, Method::GET, "/api/v1/users/@me", None).await;
    let channel = 901001;
    paracord_db::dms::create_dm_channel(
        &app.db,
        channel,
        a["id"].as_str().unwrap().parse().unwrap(),
        b["id"].as_str().unwrap().parse().unwrap(),
    )
    .await
    .unwrap();
    (app, alice, bob, channel)
}

fn envelope(n: u32) -> Value {
    json!({ "version": 2, "nonce": format!("bm9uY2U{n}"), "ciphertext": format!("Y2lwaGV{n}"), "header": json!({"dh":"cHVibGlja2V5", "pn":0, "n":n}).to_string() })
}

async fn create(app: &TestApp, token: &str, channel: i64) -> (String, i64) {
    let path = format!("/api/v1/channels/{channel}/messages");
    let (status, message) = call(
        app,
        token,
        Method::POST,
        &path,
        Some(json!({"content":"", "nonce":"edit-atomicity-original", "e2ee":envelope(0)})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    let id = message["id"].as_str().unwrap().parse().unwrap();
    (format!("{path}/{id}"), id)
}

async fn edit(app: &TestApp, token: &str, path: &str, counter: u32) -> (StatusCode, Value) {
    call(
        app,
        token,
        Method::PATCH,
        path,
        Some(json!({"content":"", "e2ee":envelope(counter)})),
    )
    .await
}

#[tokio::test]
async fn rejected_edit_cannot_add_a_history_snapshot() {
    let (app, alice, bob, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    let (status, body) = edit(&app, &bob, &path, 1).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
    let current = paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current.content.as_deref(),
        envelope(0)["ciphertext"].as_str()
    );
    assert!(current.edited_at.is_none());
}

#[tokio::test]
async fn simultaneous_edits_snapshot_each_committed_predecessor_once() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    let (first, second) = tokio::join!(edit(&app, &alice, &path, 1), edit(&app, &alice, &path, 2));
    assert_eq!(first.0, StatusCode::OK, "{first:?}");
    assert_eq!(second.0, StatusCode::OK, "{second:?}");
    let current = paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .unwrap();
    let history = paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(
        history[0].content,
        envelope(0)["ciphertext"].as_str().unwrap()
    );
    let last = if current.content.as_deref() == envelope(1)["ciphertext"].as_str() {
        1
    } else {
        2
    };
    assert_eq!(
        history[1].content,
        envelope(3 - last)["ciphertext"].as_str().unwrap()
    );
    assert_eq!(current.nonce.as_deref(), envelope(last)["nonce"].as_str());
    assert_eq!(
        current.e2ee_header.as_deref(),
        envelope(last)["header"].as_str()
    );
    assert_eq!(
        current.delivery_nonce.as_deref(),
        Some("edit-atomicity-original")
    );
}

async fn reject_write(app: &TestApp, snapshot: bool) {
    let (table, event, condition) = if snapshot {
        ("message_edits", "INSERT", "TRUE")
    } else {
        ("messages", "UPDATE", "NEW.content <> OLD.content")
    };
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query(&format!("CREATE TRIGGER reject_atomic_edit AFTER {event} ON {table} WHEN {condition} BEGIN SELECT RAISE(ABORT, 'injected edit failure'); END")).execute(&app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query(&format!("CREATE FUNCTION reject_atomic_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF {condition} THEN RAISE EXCEPTION 'injected edit failure'; END IF; RETURN NEW; END; $$")).execute(&app.db).await.unwrap();
            sqlx::query(&format!("CREATE TRIGGER reject_atomic_edit AFTER {event} ON {table} FOR EACH ROW EXECUTE FUNCTION reject_atomic_edit()")).execute(&app.db).await.unwrap();
        }
    }
}

async fn assert_failure_rolls_back(snapshot: bool) {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    reject_write(&app, snapshot).await;
    let (status, body) = edit(&app, &alice, &path, 1).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    let current = paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current.content.as_deref(),
        envelope(0)["ciphertext"].as_str()
    );
    assert_eq!(current.nonce.as_deref(), envelope(0)["nonce"].as_str());
    assert_eq!(
        current.e2ee_header.as_deref(),
        envelope(0)["header"].as_str()
    );
    assert!(current.edited_at.is_none());
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
    let table = if snapshot {
        "message_edits"
    } else {
        "messages"
    };
    let drop = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => "DROP TRIGGER reject_atomic_edit".to_string(),
        paracord_db::DatabaseEngine::Postgres => {
            format!("DROP TRIGGER reject_atomic_edit ON {table}")
        }
    };
    sqlx::query(&drop).execute(&app.db).await.unwrap();
    assert_eq!(edit(&app, &alice, &path, 1).await.0, StatusCode::OK);
    let history = paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0].content,
        envelope(0)["ciphertext"].as_str().unwrap()
    );
}

#[tokio::test]
async fn failed_snapshot_rolls_back_the_edit_and_all_crypto_metadata() {
    assert_failure_rolls_back(true).await;
}

#[tokio::test]
async fn failed_edit_rolls_back_its_snapshot() {
    assert_failure_rolls_back(false).await;
}

#[tokio::test]
async fn competing_delete_and_edit_never_leave_orphaned_history_or_resurrect_a_message() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    let (edited, deleted) = tokio::join!(
        edit(&app, &alice, &path, 1),
        call(&app, &alice, Method::DELETE, &path, None)
    );
    assert_eq!(deleted.0, StatusCode::NO_CONTENT, "{deleted:?}");
    assert!(
        matches!(edited.0, StatusCode::OK | StatusCode::NOT_FOUND),
        "{edited:?}"
    );
    assert!(paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .is_none());
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn unauthorized_and_timed_out_edits_do_not_trigger_automod() {
    let (app, alice, bob, _) = setup().await;
    let (_, a) = call(&app, &alice, Method::GET, "/api/v1/users/@me", None).await;
    let (_, b) = call(&app, &bob, Method::GET, "/api/v1/users/@me", None).await;
    let alice_id = a["id"].as_str().unwrap().parse().unwrap();
    let bob_id = b["id"].as_str().unwrap().parse().unwrap();
    let (status, guild) = call(
        &app,
        &alice,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Edit authorization"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild_id: i64 = guild["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::add_member(&app.db, bob_id, guild_id)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&app.db, bob_id, guild_id, guild_id)
        .await
        .unwrap();
    let (status, channel) = call(
        &app,
        &alice,
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        Some(json!({"name":"edits", "channel_type":0})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{channel}");
    let channel_id = channel["id"].as_str().unwrap();
    let base = format!("/api/v1/channels/{channel_id}/messages");
    let (status, original) = call(
        &app,
        &alice,
        Method::POST,
        &base,
        Some(json!({"content":"Original owner message"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{original}");
    let (status, own) = call(
        &app,
        &bob,
        Method::POST,
        &base,
        Some(json!({"content":"Original member message"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{own}");
    paracord_db::automod::create_rule(
        &app.db,
        911002,
        guild_id,
        "Edit guard",
        alice_id,
        1,
        1,
        &json!({"kind":"keyword", "keywords":["triggerword"]}).to_string(),
        &json!([{"kind":"block_message", "reason":"Test rule"}]).to_string(),
        true,
        "[]",
        "[]",
    )
    .await
    .unwrap();
    let target = format!("{base}/{}", original["id"].as_str().unwrap());
    let own_path = format!("{base}/{}", own["id"].as_str().unwrap());
    let payload = json!({"content":"triggerword"});
    let denied = call(&app, &bob, Method::PATCH, &target, Some(payload.clone())).await;
    assert_eq!(denied.0, StatusCode::FORBIDDEN, "{denied:?}");
    assert_eq!(denied.1["code"], "FORBIDDEN");
    paracord_db::members::set_member_timeout(
        &app.db,
        bob_id,
        guild_id,
        Some(chrono::Utc::now() + chrono::Duration::minutes(5)),
    )
    .await
    .unwrap();
    let timed_out = call(&app, &bob, Method::PATCH, &own_path, Some(payload.clone())).await;
    assert_eq!(timed_out.0, StatusCode::BAD_REQUEST, "{timed_out:?}");
    assert!(timed_out.1.to_string().contains("timed out"));
    let (hits,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM automod_hits")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(hits, 0);
    let (snapshots,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_edits")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(snapshots, 0);
    paracord_db::members::set_member_timeout(&app.db, bob_id, guild_id, None)
        .await
        .unwrap();
    let moderated = call(&app, &bob, Method::PATCH, &own_path, Some(payload)).await;
    assert_eq!(moderated.0, StatusCode::FORBIDDEN, "{moderated:?}");
    assert_eq!(moderated.1["code"], "AUTOMOD_BLOCKED");
    let (hits,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM automod_hits")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(hits, 1, "The same authorized edit must still be moderated");
    let allowed = call(
        &app,
        &bob,
        Method::PATCH,
        &own_path,
        Some(json!({"content":"Allowed revision"})),
    )
    .await;
    assert_eq!(allowed.0, StatusCode::OK, "{allowed:?}");
    let history = call(&app, &bob, Method::GET, &format!("{own_path}/edits"), None).await;
    assert_eq!(history.0, StatusCode::OK, "{history:?}");
    assert_eq!(history.1.as_array().unwrap().len(), 1);
    assert_eq!(history.1[0]["content"], "Original member message");
    chrono::DateTime::parse_from_rfc3339(history.1[0]["edited_at"].as_str().unwrap()).unwrap();
}
