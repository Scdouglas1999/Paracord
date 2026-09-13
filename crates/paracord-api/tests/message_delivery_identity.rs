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

#[tokio::test]
async fn encrypted_creation_replay_preserves_edit_and_never_resurrects_a_deleted_message() {
    let (app, alice, _, channel) = setup().await;
    let path = format!("/api/v1/channels/{channel}/messages");
    let original =
        json!({ "content": "", "nonce": "original-client-request", "e2ee": envelope(0) });
    let (status, created) = call(&app, &alice, Method::POST, &path, Some(original.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["nonce"], "original-client-request");
    assert_eq!(created["e2ee"], envelope(0));
    let message_path = format!("{path}/{}", created["id"].as_str().unwrap());
    let (status, edited) = call(
        &app,
        &alice,
        Method::PATCH,
        &message_path,
        Some(json!({ "content": "", "e2ee": envelope(1) })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["nonce"], "original-client-request");
    assert_eq!(
        edited["e2ee"],
        envelope(1),
        "An edit must replace nonce, ciphertext and ratchet header together"
    );
    let (status, replay) = call(&app, &alice, Method::POST, &path, Some(original.clone())).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], created["id"]);
    assert_eq!(replay["e2ee"], envelope(1));
    assert_eq!(
        call(&app, &alice, Method::DELETE, &message_path, None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let (status, replay) = call(&app, &alice, Method::POST, &path, Some(original)).await;
    assert_eq!(status, StatusCode::GONE, "{replay}");
    assert_eq!(replay["code"], "DELIVERY_ALREADY_DELETED");
    assert!(replay.to_string().contains("already delivered"));
    assert_eq!(
        paracord_db::messages::count_messages(&app.db)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn simultaneous_identical_posts_deliver_once_and_do_not_share_another_authors_receipt() {
    let (app, alice, bob, channel) = setup().await;
    let path = format!("/api/v1/channels/{channel}/messages");
    let original = json!({ "content": "", "nonce": "same-client-request", "e2ee": envelope(0) });
    let (first, second) = tokio::join!(
        call(&app, &alice, Method::POST, &path, Some(original.clone())),
        call(&app, &alice, Method::POST, &path, Some(original.clone())),
    );
    assert!(first.0.is_success(), "{first:?}");
    assert!(second.0.is_success(), "{second:?}");
    assert_eq!(first.1["id"], second.1["id"]);
    let (status, other) = call(&app, &bob, Method::POST, &path, Some(original)).await;
    assert_eq!(status, StatusCode::CREATED, "{other}");
    assert_ne!(other["id"], first.1["id"]);
    assert_ne!(other["author"]["id"], first.1["author"]["id"]);
    assert_eq!(
        paracord_db::messages::count_messages(&app.db)
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn resolution_seals_an_absent_delivery_and_scopes_it_to_its_author() {
    let (app, alice, bob, channel) = setup().await;
    let nonce = "cancel-before-post";
    let resolve = format!("/api/v1/channels/{channel}/message-deliveries/{nonce}/resolve");
    let path = format!("/api/v1/channels/{channel}/messages");
    let (status, sealed) = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(status, StatusCode::OK, "{sealed}");
    assert_eq!(sealed["state"], "cancelled");
    assert_eq!(sealed["nonce"], nonce);
    assert_eq!(sealed["channel_id"], channel.to_string());
    assert!(sealed.get("message_id").is_none());
    assert_eq!(
        call(&app, &alice, Method::POST, &resolve, None).await.1,
        sealed
    );
    let payload = json!({ "content": "", "nonce": nonce, "e2ee": envelope(0) });
    let (status, replay) = call(&app, &alice, Method::POST, &path, Some(payload.clone())).await;
    assert_eq!(status, StatusCode::GONE, "{replay}");
    assert_eq!(replay["code"], "DELIVERY_CANCELLED");
    assert_eq!(
        paracord_db::messages::count_messages(&app.db)
            .await
            .unwrap(),
        0
    );
    let channel_row = paracord_db::channels::get_channel(&app.db, channel)
        .await
        .unwrap()
        .unwrap();
    assert!(channel_row.last_message_id.is_none());
    let (status, other) = call(&app, &bob, Method::POST, &path, Some(payload)).await;
    assert_eq!(status, StatusCode::CREATED, "{other}");
    assert_ne!(other["author"]["id"], sealed["author_id"]);
}

#[tokio::test]
async fn resolution_reports_committed_and_deleted_messages_without_mutating_them() {
    let (app, alice, _, channel) = setup().await;
    let nonce = "committed-before-resolution";
    let resolve = format!("/api/v1/channels/{channel}/message-deliveries/{nonce}/resolve");
    let path = format!("/api/v1/channels/{channel}/messages");
    let (status, created) = call(
        &app,
        &alice,
        Method::POST,
        &path,
        Some(json!({ "content": "", "nonce": nonce, "e2ee": envelope(0) })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = created["id"].as_str().unwrap();
    let edit_path = format!("{path}/{message_id}");
    assert_eq!(
        call(
            &app,
            &alice,
            Method::PATCH,
            &edit_path,
            Some(json!({ "content": "", "e2ee": envelope(1) }))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, resolved) = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resolved["state"], "delivered");
    assert_eq!(resolved["message_id"], message_id);
    let stored = paracord_db::messages::get_message(&app.db, message_id.parse().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.e2ee_header.as_deref(),
        envelope(1)["header"].as_str()
    );
    assert_eq!(
        call(&app, &alice, Method::DELETE, &edit_path, None).await.0,
        StatusCode::NO_CONTENT
    );
    let (_, resolved) = call(&app, &alice, Method::POST, &resolve, None).await;
    assert_eq!(resolved["state"], "deleted");
    assert_eq!(resolved["message_id"], message_id);
}

#[tokio::test]
async fn simultaneous_resolution_and_creation_choose_one_permanent_outcome() {
    let (app, alice, _, channel) = setup().await;
    for index in 0..8 {
        let nonce = format!("race-{index}");
        let resolve = format!("/api/v1/channels/{channel}/message-deliveries/{nonce}/resolve");
        let path = format!("/api/v1/channels/{channel}/messages");
        let payload = json!({ "content": "", "nonce": nonce, "e2ee": envelope(index) });
        let (resolution, creation) = tokio::join!(
            call(&app, &alice, Method::POST, &resolve, None),
            call(&app, &alice, Method::POST, &path, Some(payload.clone())),
        );
        assert_eq!(resolution.0, StatusCode::OK, "{resolution:?}");
        match resolution.1["state"].as_str().unwrap() {
            "cancelled" => {
                assert_eq!(creation.0, StatusCode::GONE, "{creation:?}");
                assert_eq!(creation.1["code"], "DELIVERY_CANCELLED");
            }
            "delivered" => {
                assert_eq!(creation.0, StatusCode::CREATED, "{creation:?}");
                assert_eq!(resolution.1["message_id"], creation.1["id"]);
            }
            other => panic!("Unexpected resolution: {other}"),
        }
        let replay = call(&app, &alice, Method::POST, &path, Some(payload)).await;
        assert_eq!(
            replay.0,
            if creation.0 == StatusCode::CREATED {
                StatusCode::OK
            } else {
                StatusCode::GONE
            }
        );
        assert_eq!(replay.1["id"], creation.1["id"]);
        assert_eq!(
            call(&app, &alice, Method::POST, &resolve, None).await.1,
            resolution.1
        );
    }
}

#[tokio::test]
async fn outsiders_and_invalid_nonces_cannot_reserve_delivery_receipts() {
    let (app, alice, _, channel) = setup().await;
    let outsider = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "deliveryoutsider",
        "OutsidePassword123!",
    )
    .await
    .unwrap();
    let resolve = format!("/api/v1/channels/{channel}/message-deliveries/private-nonce/resolve");
    assert_eq!(
        call(&app, &outsider, Method::POST, &resolve, None).await.0,
        StatusCode::FORBIDDEN
    );
    for nonce in ["x".repeat(65), "%20leading".into(), "trailing%20".into()] {
        let path = format!("/api/v1/channels/{channel}/message-deliveries/{nonce}/resolve");
        assert_eq!(
            call(&app, &alice, Method::POST, &path, None).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_delivery_receipts")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn failed_reservation_does_not_prevent_a_later_create() {
    let (app, alice, _, channel) = setup().await;
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query("CREATE TRIGGER reject_delivery_resolution AFTER INSERT ON message_delivery_receipts WHEN NEW.cancelled BEGIN SELECT RAISE(ABORT, 'injected resolution failure'); END").execute(&app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query("CREATE FUNCTION reject_delivery_resolution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.cancelled THEN RAISE EXCEPTION 'injected resolution failure'; END IF; RETURN NEW; END; $$").execute(&app.db).await.unwrap();
            sqlx::query("CREATE TRIGGER reject_delivery_resolution AFTER INSERT ON message_delivery_receipts FOR EACH ROW EXECUTE FUNCTION reject_delivery_resolution()").execute(&app.db).await.unwrap();
        }
    }
    let nonce = "failed-resolution";
    let resolve = format!("/api/v1/channels/{channel}/message-deliveries/{nonce}/resolve");
    assert_eq!(
        call(&app, &alice, Method::POST, &resolve, None).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_delivery_receipts")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let path = format!("/api/v1/channels/{channel}/messages");
    assert_eq!(
        call(
            &app,
            &alice,
            Method::POST,
            &path,
            Some(json!({ "content": "", "nonce": nonce, "e2ee": envelope(0) }))
        )
        .await
        .0,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn resolution_requires_visibility_but_not_permission_to_send() {
    use paracord_models::permissions::Permissions;
    let (app, alice, bob, _) = setup().await;
    let (_, a) = call(&app, &alice, Method::GET, "/api/v1/users/@me", None).await;
    let (_, b) = call(&app, &bob, Method::GET, "/api/v1/users/@me", None).await;
    let author: i64 = a["id"].as_str().unwrap().parse().unwrap();
    let owner: i64 = b["id"].as_str().unwrap().parse().unwrap();
    let (guild, channel, role) = (902001, 902002, 902003);
    paracord_db::guilds::create_guild(&app.db, guild, "Resolution permissions", owner, None)
        .await
        .unwrap();
    paracord_db::members::add_member(&app.db, author, guild)
        .await
        .unwrap();
    paracord_db::roles::create_role(
        &app.db,
        role,
        guild,
        "Read only",
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    paracord_db::roles::add_member_role(&app.db, author, guild, role)
        .await
        .unwrap();
    paracord_db::channels::create_channel(&app.db, channel, guild, "read-only", 0, 0, None, None)
        .await
        .unwrap();
    let resolve = format!("/api/v1/channels/{channel}/message-deliveries/revoked-send/resolve");
    assert_eq!(
        call(&app, &alice, Method::POST, &resolve, None).await.0,
        StatusCode::OK
    );
    let path = format!("/api/v1/channels/{channel}/messages");
    assert_eq!(
        call(
            &app,
            &alice,
            Method::POST,
            &path,
            Some(json!({ "content": "denied", "nonce": "other" }))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &app.db,
        channel,
        role,
        paracord_core::permissions::OVERWRITE_TARGET_ROLE,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    paracord_core::permissions::invalidate_channel(&app.state.permission_cache, channel).await;
    assert_eq!(
        call(&app, &alice, Method::POST, &resolve, None).await.0,
        StatusCode::FORBIDDEN
    );
    paracord_db::members::remove_member(&app.db, author, guild)
        .await
        .unwrap();
    assert_eq!(
        call(&app, &alice, Method::POST, &resolve, None).await.0,
        StatusCode::FORBIDDEN
    );
}
