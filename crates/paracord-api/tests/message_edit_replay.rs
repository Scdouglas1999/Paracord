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

fn mutation(nonce: &str, counter: u32) -> Value {
    json!({"content":"", "e2ee":envelope(counter), "edit_nonce":nonce})
}

#[tokio::test]
async fn replay_preserves_a_newer_edit_and_receipts_survive_deletion() {
    let (app, alice, bob, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    let first = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("edit-one", 1)),
    )
    .await;
    assert_eq!(first.0, StatusCode::OK, "{first:?}");
    assert_eq!(first.1["edit_nonce"], "edit-one");
    assert_eq!(first.1["edit_replayed"], false);
    let latest = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("edit-two", 2)),
    )
    .await;
    assert_eq!(latest.0, StatusCode::OK, "{latest:?}");
    let replay = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("edit-one", 1)),
    )
    .await;
    assert_eq!(replay.0, StatusCode::OK, "{replay:?}");
    assert_eq!(replay.1["edit_nonce"], "edit-one");
    assert_eq!(replay.1["edit_replayed"], true);
    assert_eq!(replay.1["e2ee"], envelope(2));
    assert_eq!(replay.1["edited_at"], latest.1["edited_at"]);
    assert_eq!(replay.1["nonce"], "edit-atomicity-original");
    assert_eq!(
        paracord_db::messages::get_edit_history(&app.db, id)
            .await
            .unwrap()
            .len(),
        2
    );
    let conflict = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("edit-one", 3)),
    )
    .await;
    assert_eq!(conflict.0, StatusCode::CONFLICT, "{conflict:?}");
    assert_eq!(
        call(
            &app,
            &bob,
            Method::PATCH,
            &path,
            Some(mutation("edit-one", 1))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, &alice, Method::DELETE, &path, None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation("edit-one", 1))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_edit_receipts")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count, 2);
    assert!(paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn concurrent_identical_edits_apply_and_snapshot_once() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    let (a, b) = tokio::join!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation("simultaneous", 1))
        ),
        call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation("simultaneous", 1))
        )
    );
    assert_eq!(a.0, StatusCode::OK, "{a:?}");
    assert_eq!(b.0, StatusCode::OK, "{b:?}");
    assert_ne!(a.1["edit_replayed"], b.1["edit_replayed"]);
    assert_eq!(a.1["edited_at"], b.1["edited_at"]);
    assert_eq!(
        paracord_db::messages::get_edit_history(&app.db, id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_nonce_cannot_mutate_two_messages_even_when_the_requests_race() {
    let (app, alice, _, channel) = setup().await;
    let (first_path, first_id) = create(&app, &alice, channel).await;
    let second = call(
        &app,
        &alice,
        Method::POST,
        &format!("/api/v1/channels/{channel}/messages"),
        Some(json!({"content":"", "nonce":"another-original", "e2ee":envelope(0)})),
    )
    .await;
    assert_eq!(second.0, StatusCode::CREATED);
    let second_id: i64 = second.1["id"].as_str().unwrap().parse().unwrap();
    let second_path = format!("/api/v1/channels/{channel}/messages/{second_id}");
    let (a, b) = tokio::join!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &first_path,
            Some(mutation("same-nonce", 1))
        ),
        call(
            &app,
            &alice,
            Method::PATCH,
            &second_path,
            Some(mutation("same-nonce", 1))
        )
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT),
        "{a:?} {b:?}"
    );
    let histories = paracord_db::messages::get_edit_history(&app.db, first_id)
        .await
        .unwrap()
        .len()
        + paracord_db::messages::get_edit_history(&app.db, second_id)
            .await
            .unwrap()
            .len();
    assert_eq!(histories, 1);
    let loser = if a.0 == StatusCode::CONFLICT {
        first_id
    } else {
        second_id
    };
    assert!(paracord_db::messages::get_message(&app.db, loser)
        .await
        .unwrap()
        .unwrap()
        .edited_at
        .is_none());
}

async fn fail_insert(app: &TestApp, table: &str) {
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query(&format!("CREATE TRIGGER reject_edit_receipt AFTER INSERT ON {table} BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END")).execute(&app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query("CREATE FUNCTION reject_edit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END; $$").execute(&app.db).await.unwrap();
            sqlx::query(&format!("CREATE TRIGGER reject_edit_receipt AFTER INSERT ON {table} FOR EACH ROW EXECUTE FUNCTION reject_edit_receipt()")).execute(&app.db).await.unwrap();
        }
    }
}

async fn allow_insert(app: &TestApp, table: &str) {
    let command = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => "DROP TRIGGER reject_edit_receipt".into(),
        paracord_db::DatabaseEngine::Postgres => {
            format!("DROP TRIGGER reject_edit_receipt ON {table}")
        }
    };
    sqlx::query(&command).execute(&app.db).await.unwrap();
}

#[tokio::test]
async fn failed_receipt_persistence_rolls_back_the_edit_and_allows_an_exact_retry() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    fail_insert(&app, "message_edit_receipts").await;
    let failed = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("retry-after-disk-failure", 1)),
    )
    .await;
    assert_eq!(failed.0, StatusCode::INTERNAL_SERVER_ERROR, "{failed:?}");
    let current = paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current.content.as_deref(),
        envelope(0)["ciphertext"].as_str()
    );
    assert!(current.edited_at.is_none());
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
    allow_insert(&app, "message_edit_receipts").await;
    let retry = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("retry-after-disk-failure", 1)),
    )
    .await;
    assert_eq!(retry.0, StatusCode::OK, "{retry:?}");
    assert_eq!(retry.1["edit_replayed"], false);
    assert_eq!(
        paracord_db::messages::get_edit_history(&app.db, id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn invalid_edit_nonces_do_not_mutate_or_snapshot() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    for nonce in [
        "".to_owned(),
        " leading".into(),
        "trailing ".into(),
        "x".repeat(65),
        "é".repeat(33),
    ] {
        let result = call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation(&nonce, 1)),
        )
        .await;
        assert_eq!(result.0, StatusCode::BAD_REQUEST, "{result:?}");
    }
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
}

async fn moderated() -> (TestApp, String, String, i64, i64, i64) {
    let (app, alice, bob, _) = setup().await;
    let (_, a) = call(&app, &alice, Method::GET, "/api/v1/users/@me", None).await;
    let (_, b) = call(&app, &bob, Method::GET, "/api/v1/users/@me", None).await;
    let alice_id = a["id"].as_str().unwrap().parse().unwrap();
    let bob_id = b["id"].as_str().unwrap().parse().unwrap();
    let guild = call(
        &app,
        &alice,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Replay moderation"})),
    )
    .await;
    assert_eq!(guild.0, StatusCode::CREATED);
    let gid: i64 = guild.1["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::add_member(&app.db, bob_id, gid)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&app.db, bob_id, gid, gid)
        .await
        .unwrap();
    let channel = call(
        &app,
        &alice,
        Method::POST,
        &format!("/api/v1/guilds/{gid}/channels"),
        Some(json!({"name":"edits", "channel_type":0})),
    )
    .await;
    assert_eq!(channel.0, StatusCode::CREATED);
    let cid: i64 = channel.1["id"].as_str().unwrap().parse().unwrap();
    let created = call(
        &app,
        &bob,
        Method::POST,
        &format!("/api/v1/channels/{cid}/messages"),
        Some(json!({"content":"Original message"})),
    )
    .await;
    assert_eq!(created.0, StatusCode::CREATED);
    let mid = created.1["id"].as_str().unwrap().parse().unwrap();
    paracord_db::automod::create_rule(
        &app.db,
        991002,
        gid,
        "Track edits",
        alice_id,
        1,
        1,
        &json!({"kind":"keyword", "keywords":["triggerword"]}).to_string(),
        &json!([{"kind":"alert_channel", "channel_id":cid.to_string()}]).to_string(),
        true,
        "[]",
        "[]",
    )
    .await
    .unwrap();
    (app, alice, bob, gid, cid, mid)
}

#[tokio::test]
async fn concurrent_replay_records_moderation_and_dispatches_alerts_once() {
    let (app, _, bob, _, channel, id) = moderated().await;
    let path = format!("/api/v1/channels/{channel}/messages/{id}");
    let body = json!({"content":"triggerword edit", "edit_nonce":"moderated-edit"});
    let (a, b) = tokio::join!(
        call(&app, &bob, Method::PATCH, &path, Some(body.clone())),
        call(&app, &bob, Method::PATCH, &path, Some(body.clone()))
    );
    assert_eq!(a.0, StatusCode::OK, "{a:?}");
    assert_eq!(b.0, StatusCode::OK, "{b:?}");
    let (hits,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM automod_hits")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(hits, 1);
    let (alerts,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND id <> $2")
            .bind(channel)
            .bind(id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(alerts, 1);
    // A committed operation remains acknowledged even if a rule is now invalid.
    sqlx::query("UPDATE automod_rules SET trigger_metadata = 'broken' WHERE id = 991002")
        .execute(&app.db)
        .await
        .unwrap();
    let replay = call(&app, &bob, Method::PATCH, &path, Some(body)).await;
    assert_eq!(replay.0, StatusCode::OK, "{replay:?}");
    assert_eq!(replay.1["edit_replayed"], true);
    assert_eq!(
        paracord_db::messages::get_edit_history(&app.db, id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn broken_moderation_cannot_allow_an_edit_or_send_without_filtering() {
    let (app, _, bob, _, channel, id) = moderated().await;
    sqlx::query("UPDATE automod_rules SET trigger_metadata = 'broken' WHERE id = 991002")
        .execute(&app.db)
        .await
        .unwrap();
    let result = call(
        &app,
        &bob,
        Method::PATCH,
        &format!("/api/v1/channels/{channel}/messages/{id}"),
        Some(json!({"content":"triggerword edit", "edit_nonce":"broken-filter"})),
    )
    .await;
    assert_eq!(result.0, StatusCode::INTERNAL_SERVER_ERROR, "{result:?}");
    let sent = call(
        &app,
        &bob,
        Method::POST,
        &format!("/api/v1/channels/{channel}/messages"),
        Some(json!({"content":"triggerword send"})),
    )
    .await;
    assert_eq!(sent.0, StatusCode::INTERNAL_SERVER_ERROR, "{sent:?}");
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        paracord_db::messages::get_message(&app.db, id)
            .await
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        Some("Original message")
    );
}

#[tokio::test]
async fn failed_moderation_hit_rolls_back_message_history_and_receipt() {
    let (app, _, bob, _, channel, id) = moderated().await;
    fail_insert(&app, "automod_hits").await;
    let path = format!("/api/v1/channels/{channel}/messages/{id}");
    let body = json!({"content":"triggerword edit", "edit_nonce":"failed-hit"});
    let failed = call(&app, &bob, Method::PATCH, &path, Some(body.clone())).await;
    assert_eq!(failed.0, StatusCode::INTERNAL_SERVER_ERROR, "{failed:?}");
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
    let (receipts,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_edit_receipts")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(receipts, 0);
    let (messages,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(messages, 1);
    allow_insert(&app, "automod_hits").await;
    assert_eq!(
        call(&app, &bob, Method::PATCH, &path, Some(body)).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn broken_moderation_also_blocks_webhook_execution() {
    let (app, _, bob, guild, channel, _) = moderated().await;
    let (_, profile) = call(&app, &bob, Method::GET, "/api/v1/users/@me", None).await;
    let creator = profile["id"].as_str().unwrap().parse().unwrap();
    paracord_db::webhooks::create_webhook(
        &app.db,
        993001,
        guild,
        channel,
        "Test hook",
        "test-hook-token",
        creator,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE automod_rules SET trigger_metadata = 'broken' WHERE id = 991002")
        .execute(&app.db)
        .await
        .unwrap();
    let result = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/webhooks/993001/test-hook-token",
            Some(json!({"content":"triggerword webhook"})),
            None,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(result.0, StatusCode::INTERNAL_SERVER_ERROR, "{result:?}");
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn a_timeout_does_not_prevent_acknowledgement_of_an_already_committed_edit() {
    let (app, _, bob, guild, channel, id) = moderated().await;
    let path = format!("/api/v1/channels/{channel}/messages/{id}");
    let body = json!({"content":"A committed edit", "edit_nonce":"before-timeout"});
    assert_eq!(
        call(&app, &bob, Method::PATCH, &path, Some(body.clone()))
            .await
            .0,
        StatusCode::OK
    );
    let (_, profile) = call(&app, &bob, Method::GET, "/api/v1/users/@me", None).await;
    let actor = profile["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::set_member_timeout(
        &app.db,
        actor,
        guild,
        Some(chrono::Utc::now() + chrono::Duration::minutes(5)),
    )
    .await
    .unwrap();
    let replay = call(&app, &bob, Method::PATCH, &path, Some(body)).await;
    assert_eq!(replay.0, StatusCode::OK, "{replay:?}");
    assert_eq!(replay.1["edit_replayed"], true);
    let fresh = call(
        &app,
        &bob,
        Method::PATCH,
        &path,
        Some(json!({"content":"New disallowed edit", "edit_nonce":"after-timeout"})),
    )
    .await;
    assert_eq!(fresh.0, StatusCode::BAD_REQUEST, "{fresh:?}");
    assert_eq!(
        paracord_db::messages::get_edit_history(&app.db, id)
            .await
            .unwrap()
            .len(),
        1
    );
    paracord_db::members::remove_member(&app.db, actor, guild)
        .await
        .unwrap();
    let hidden = call(
        &app,
        &bob,
        Method::PATCH,
        &path,
        Some(json!({"content":"A committed edit", "edit_nonce":"before-timeout"})),
    )
    .await;
    assert_eq!(hidden.0, StatusCode::FORBIDDEN, "{hidden:?}");
}

#[tokio::test]
async fn failed_receipt_rolls_back_moderation_hits_before_any_alert_is_dispatched() {
    let (app, _, bob, _, channel, id) = moderated().await;
    fail_insert(&app, "message_edit_receipts").await;
    let path = format!("/api/v1/channels/{channel}/messages/{id}");
    let body = json!({"content":"triggerword edit", "edit_nonce":"failed-moderated-receipt"});
    let failed = call(&app, &bob, Method::PATCH, &path, Some(body.clone())).await;
    assert_eq!(failed.0, StatusCode::INTERNAL_SERVER_ERROR, "{failed:?}");
    let (hits,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM automod_hits")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(hits, 0);
    let (messages,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(messages, 1);
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
    allow_insert(&app, "message_edit_receipts").await;
    assert_eq!(
        call(&app, &bob, Method::PATCH, &path, Some(body)).await.0,
        StatusCode::OK
    );
    let (hits,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM automod_hits")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(hits, 1);
}

#[tokio::test]
async fn resolving_an_absent_edit_seals_it_without_changing_content_or_history() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    let resolution = format!("{path}/edits/cancelled-edit/resolve");
    let (status, result) = call(&app, &alice, Method::POST, &resolution, None).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["state"], "cancelled");
    assert_eq!(result["message_id"], id.to_string());
    assert_eq!(result["channel_id"], channel.to_string());
    assert_eq!(result["edit_nonce"], "cancelled-edit");
    assert!(paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap()
        .is_empty());
    let original = paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .unwrap();
    assert!(original.edited_at.is_none());
    assert_eq!(
        original.content.as_deref(),
        envelope(0)["ciphertext"].as_str()
    );
    let later = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("replacement-edit", 2)),
    )
    .await;
    assert_eq!(later.0, StatusCode::OK, "{later:?}");
    let delayed = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("cancelled-edit", 1)),
    )
    .await;
    assert_eq!(delayed.0, StatusCode::GONE, "{delayed:?}");
    assert_eq!(delayed.1["code"], "EDIT_CANCELLED");
    let history = paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(
        paracord_db::messages::get_message(&app.db, id)
            .await
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        envelope(2)["ciphertext"].as_str()
    );
    assert_eq!(
        call(&app, &alice, Method::POST, &resolution, None).await.1,
        result
    );
}

#[tokio::test]
async fn edit_resolution_reports_committed_and_deleted_operations_without_reapplying_them() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    assert_eq!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation("committed-edit", 1))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation("newer-edit", 2))
        )
        .await
        .0,
        StatusCode::OK
    );
    let resolve = format!("{path}/edits/committed-edit/resolve");
    let response = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.1["state"], "applied");
    assert_eq!(
        paracord_db::messages::get_message(&app.db, id)
            .await
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        envelope(2)["ciphertext"].as_str()
    );
    assert_eq!(
        paracord_db::messages::get_edit_history(&app.db, id)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        call(&app, &alice, Method::DELETE, &path, None).await.0,
        StatusCode::NO_CONTENT
    );
    let response = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.1["state"], "deleted");
}

#[tokio::test]
async fn resolving_and_applying_the_same_edit_have_one_atomic_winner() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    let resolve = format!("{path}/edits/racing-edit/resolve");
    let (applied, resolved) = tokio::join!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation("racing-edit", 1))
        ),
        call(&app, &alice, Method::POST, &resolve, None)
    );
    assert_eq!(resolved.0, StatusCode::OK, "{resolved:?}");
    let history = paracord_db::messages::get_edit_history(&app.db, id)
        .await
        .unwrap();
    match resolved.1["state"].as_str().unwrap() {
        "cancelled" => {
            assert_eq!(applied.0, StatusCode::GONE, "{applied:?}");
            assert!(history.is_empty());
        }
        "applied" => {
            assert_eq!(applied.0, StatusCode::OK, "{applied:?}");
            assert_eq!(history.len(), 1);
        }
        other => panic!("Unexpected resolution: {other}"),
    }
    let repeated = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(repeated.1, resolved.1);
}

#[tokio::test]
async fn edit_cancellation_is_actor_owned_and_cannot_cancel_another_authors_nonce() {
    let (app, alice, bob, channel) = setup().await;
    let (path, _) = create(&app, &alice, channel).await;
    let resolve = format!("{path}/edits/shared-edit/resolve");
    let cancelled = call(&app, &bob, Method::POST, &resolve, None).await;
    assert_eq!(cancelled.0, StatusCode::OK, "{cancelled:?}");
    let applied = call(
        &app,
        &alice,
        Method::PATCH,
        &path,
        Some(mutation("shared-edit", 1)),
    )
    .await;
    assert_eq!(applied.0, StatusCode::OK, "{applied:?}");
    let resolved = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(resolved.1["state"], "applied");
    assert_ne!(resolved.1["actor_id"], cancelled.1["actor_id"]);
}

#[tokio::test]
async fn edit_resolution_rejects_a_nonce_bound_to_a_different_target() {
    let (app, alice, _, channel) = setup().await;
    let (path, _) = create(&app, &alice, channel).await;
    let resolve = format!("{path}/edits/reused-edit/resolve");
    assert_eq!(
        call(&app, &alice, Method::POST, &resolve, None).await.0,
        StatusCode::OK
    );
    let other = format!("/api/v1/channels/{channel}/messages/123/edits/reused-edit/resolve");
    let conflict = call(&app, &alice, Method::POST, &other, None).await;
    assert_eq!(conflict.0, StatusCode::CONFLICT, "{conflict:?}");
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_edit_receipts")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count.0, 1);
}

#[tokio::test]
async fn failed_edit_resolution_does_not_claim_that_cancellation_committed() {
    let (app, alice, _, channel) = setup().await;
    let (path, id) = create(&app, &alice, channel).await;
    fail_insert(&app, "message_edit_receipts").await;
    let resolve = format!("{path}/edits/failed-cancellation/resolve");
    let failed = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(failed.0, StatusCode::INTERNAL_SERVER_ERROR, "{failed:?}");
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_edit_receipts")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count.0, 0);
    assert!(paracord_db::messages::get_message(&app.db, id)
        .await
        .unwrap()
        .unwrap()
        .edited_at
        .is_none());
    allow_insert(&app, "message_edit_receipts").await;
    assert_eq!(
        call(&app, &alice, Method::POST, &resolve, None).await.1["state"],
        "cancelled"
    );
    assert_eq!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &path,
            Some(mutation("failed-cancellation", 1))
        )
        .await
        .0,
        StatusCode::GONE
    );
}

#[tokio::test]
async fn resolving_edits_requires_visibility_but_remains_available_during_timeout() {
    let (app, _, bob, guild, channel, id) = moderated().await;
    let (_, profile) = call(&app, &bob, Method::GET, "/api/v1/users/@me", None).await;
    let actor = profile["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::set_member_timeout(
        &app.db,
        actor,
        guild,
        Some(chrono::Utc::now() + chrono::Duration::hours(1)),
    )
    .await
    .unwrap();
    let path = format!("/api/v1/channels/{channel}/messages/{id}/edits/timed-out-edit/resolve");
    assert_eq!(
        call(&app, &bob, Method::POST, &path, None).await.1["state"],
        "cancelled"
    );
    paracord_db::members::remove_member(&app.db, actor, guild)
        .await
        .unwrap();
    let rejected = call(&app, &bob, Method::POST, &path, None).await;
    assert_eq!(rejected.0, StatusCode::FORBIDDEN, "{rejected:?}");
}

#[tokio::test]
async fn invalid_edit_resolution_identity_is_rejected_without_a_receipt() {
    let (app, alice, _, channel) = setup().await;
    let (path, _) = create(&app, &alice, channel).await;
    for nonce in [
        "%20bad".to_string(),
        "bad%20".to_string(),
        "x".repeat(65),
        "%C3%A9".repeat(33),
    ] {
        let result = call(
            &app,
            &alice,
            Method::POST,
            &format!("{path}/edits/{nonce}/resolve"),
            None,
        )
        .await;
        assert_eq!(result.0, StatusCode::BAD_REQUEST, "{result:?}");
    }
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_edit_receipts")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count.0, 0);
}
