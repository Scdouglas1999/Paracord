mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};

async fn call(
    app: &TestApp,
    token: Option<&str>,
    method: Method,
    body: Option<Value>,
) -> (StatusCode, Value) {
    dispatch_json(
        &app.app,
        build_json_request(method, "/api/v1/users/@me/keys", body, token).unwrap(),
    )
    .await
    .unwrap()
}

async fn setup() -> (TestApp, String, i64) {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "prekeyowner", "PrekeyOwner123!")
            .await
            .unwrap();
    let (_, user) = dispatch_json(
        &app.app,
        build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&token)).unwrap(),
    )
    .await
    .unwrap();
    let user_id = user["id"].as_str().unwrap().parse().unwrap();
    (app, token, user_id)
}

fn bundle(base: i64) -> Value {
    json!({
        "signed_prekey": { "id": base, "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" },
        "one_time_prekeys": [{ "id": base + 1, "public_key": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" }],
        "last_resort_prekey": { "id": base + 2, "public_key": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=" },
    })
}

#[tokio::test]
async fn own_snapshot_is_authenticated_scoped_and_does_not_consume_keys() {
    let (app, token, user_id) = setup().await;
    assert_eq!(
        call(&app, None, Method::GET, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, empty) = call(&app, Some(&token), Method::GET, None).await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(
        empty,
        json!({"identity_key":null,"signed_prekey":null,"one_time_prekeys":[],"last_resort_prekey":null})
    );
    let identity = "11".repeat(32);
    sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind(&identity)
        .bind(user_id)
        .execute(&app.db)
        .await
        .unwrap();
    let original = bundle(100);
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(original.clone()))
            .await
            .0,
        StatusCode::OK
    );
    for _ in 0..3 {
        let (status, own) = call(&app, Some(&token), Method::GET, None).await;
        assert_eq!(status, StatusCode::OK, "{own}");
        assert_eq!(own["identity_key"], identity);
        for key in ["signed_prekey", "one_time_prekeys", "last_resort_prekey"] {
            assert_eq!(own[key], original[key]);
        }
        assert!(!own.to_string().contains("private"));
        assert_eq!(
            paracord_db::prekeys::count_one_time_prekeys(&app.db, user_id)
                .await
                .unwrap(),
            1
        );
    }
    let other =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "prekeyother", "PrekeyOther123!")
            .await
            .unwrap();
    let (status, own) = call(&app, Some(&other), Method::GET, None).await;
    assert_eq!(status, StatusCode::OK, "{own}");
    assert_eq!(
        own, empty,
        "Another account must not see the first account's publication"
    );
    // Ordinary peer consumption still removes a disposable prekey; the owner's
    // snapshot then reflects the actual remaining state without consuming LRK.
    paracord_db::prekeys::consume_one_time_prekey(&app.db, user_id)
        .await
        .unwrap();
    let (_, own) = call(&app, Some(&token), Method::GET, None).await;
    assert_eq!(own["one_time_prekeys"], json!([]));
    assert_eq!(own["last_resort_prekey"], original["last_resort_prekey"]);
}

#[tokio::test]
async fn invalid_later_key_never_partially_publishes_an_earlier_key() {
    let (app, token, _) = setup().await;
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(bundle(100)))
            .await
            .0,
        StatusCode::OK
    );
    let (_, original) = call(&app, Some(&token), Method::GET, None).await;
    for kind in ["one_time_prekeys", "last_resort_prekey"] {
        let mut invalid = bundle(200);
        if kind == "one_time_prekeys" {
            invalid[kind][0]["public_key"] = json!("invalid");
        } else {
            invalid[kind]["public_key"] = json!("invalid");
        }
        let (status, response) = call(&app, Some(&token), Method::PUT, Some(invalid)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(
            call(&app, Some(&token), Method::GET, None).await.1,
            original
        );
    }
}

#[tokio::test]
async fn late_database_failure_rolls_back_the_whole_publication() {
    let (app, token, _) = setup().await;
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(bundle(100)))
            .await
            .0,
        StatusCode::OK
    );
    let (_, original) = call(&app, Some(&token), Method::GET, None).await;
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query("CREATE TRIGGER reject_test_prekey BEFORE INSERT ON one_time_prekeys WHEN NEW.id = 202 BEGIN SELECT RAISE(ABORT, 'injected key storage failure'); END").execute(&app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query(
                "ALTER TABLE one_time_prekeys ADD CONSTRAINT reject_test_prekey CHECK (id <> 202)",
            )
            .execute(&app.db)
            .await
            .unwrap();
        }
    }
    let (status, response) = call(&app, Some(&token), Method::PUT, Some(bundle(200))).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{response}");
    assert_eq!(
        call(&app, Some(&token), Method::GET, None).await.1,
        original,
        "SPK replacement, OPK insertion, and old LRK deletion must all roll back"
    );
}

#[tokio::test]
async fn identical_client_generated_signed_key_ids_are_independent_across_accounts() {
    let (app, first, _) = setup().await;
    let second = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "prekeysecond",
        "PrekeySecond123!",
    )
    .await
    .unwrap();
    let (a, b) = tokio::join!(
        call(&app, Some(&first), Method::PUT, Some(bundle(100))),
        call(&app, Some(&second), Method::PUT, Some(bundle(100))),
    );
    assert_eq!(a.0, StatusCode::OK, "{a:?}");
    assert_eq!(b.0, StatusCode::OK, "{b:?}");
    assert_eq!(a.1["signed_prekey_id"], 100);
    assert_eq!(b.1["signed_prekey_id"], 100);
    assert_eq!(
        call(&app, Some(&first), Method::PUT, Some(bundle(200)))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, Some(&second), Method::GET, None).await.1["signed_prekey"]["id"],
        100
    );
}

#[tokio::test]
async fn concurrent_publications_do_not_mix_signed_and_last_resort_keys() {
    let (app, token, _) = setup().await;
    let (a, b) = tokio::join!(
        call(&app, Some(&token), Method::PUT, Some(bundle(100))),
        call(&app, Some(&token), Method::PUT, Some(bundle(200))),
    );
    assert_eq!(a.0, StatusCode::OK, "{a:?}");
    assert_eq!(b.0, StatusCode::OK, "{b:?}");
    let (status, state) = call(&app, Some(&token), Method::GET, None).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(state["one_time_prekeys"].as_array().unwrap().len(), 2);
    assert_eq!(
        state["last_resort_prekey"]["id"].as_i64().unwrap(),
        state["signed_prekey"]["id"].as_i64().unwrap() + 2
    );
}

#[tokio::test]
async fn ownership_migration_preserves_existing_signed_keys_and_their_timestamps() {
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
            .filter(|migration| migration.version < 20260909000002)
            .cloned()
            .collect(),
    );
    previous.run(&app.db).await.unwrap();
    paracord_db::users::create_user(
        &app.db,
        70001,
        "oldkeyowner",
        1,
        "oldkeys@example.com",
        "hash",
    )
    .await
    .unwrap();
    let original = paracord_db::prekeys::upsert_signed_prekey(
        &app.db,
        4242,
        70001,
        "old-public-key",
        "old-signature",
    )
    .await
    .unwrap();
    paracord_db::run_migrations(&app.db).await.unwrap();
    let migrated = paracord_db::prekeys::get_signed_prekey(&app.db, 70001)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(migrated.id, original.id);
    assert_eq!(migrated.public_key, original.public_key);
    assert_eq!(migrated.signature, original.signature);
    assert_eq!(migrated.created_at, original.created_at);
    paracord_db::users::create_user(
        &app.db,
        70002,
        "newkeyowner",
        1,
        "newkeys@example.com",
        "hash",
    )
    .await
    .unwrap();
    paracord_db::prekeys::upsert_signed_prekey(
        &app.db,
        4242,
        70002,
        "other-public-key",
        "other-signature",
    )
    .await
    .unwrap();
    assert_eq!(
        paracord_db::prekeys::get_signed_prekey(&app.db, 70001)
            .await
            .unwrap()
            .unwrap()
            .public_key,
        original.public_key
    );
}

async fn enroll_test_identity(app: &TestApp, user_id: i64) -> String {
    let key = "22".repeat(32);
    sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind(&key)
        .bind(user_id)
        .execute(&app.db)
        .await
        .unwrap();
    key
}
fn identified_bundle(base: i64, identity: &str) -> Value {
    let mut value = bundle(base);
    value["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    value["expected_identity_key"] = json!(identity);
    value
}

#[tokio::test]
async fn publication_replay_preserves_consumption_and_newer_signed_keys() {
    let (app, token, user_id) = setup().await;
    let identity = enroll_test_identity(&app, user_id).await;
    let original = identified_bundle(100, &identity);
    let (status, receipt) = call(&app, Some(&token), Method::PUT, Some(original.clone())).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["request_id"], original["request_id"]);
    paracord_db::prekeys::consume_one_time_prekey(&app.db, user_id)
        .await
        .unwrap();
    assert_eq!(
        paracord_db::prekeys::count_one_time_prekeys(&app.db, user_id)
            .await
            .unwrap(),
        0
    );
    let (status, replay) = call(&app, Some(&token), Method::PUT, Some(original.clone())).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay, receipt);
    assert_eq!(
        paracord_db::prekeys::count_one_time_prekeys(&app.db, user_id)
            .await
            .unwrap(),
        0,
        "Consumed OPKs must not be republished by retries"
    );
    let newer = identified_bundle(200, &identity);
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(newer)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(original.clone()))
            .await
            .1,
        receipt
    );
    assert_eq!(
        call(&app, Some(&token), Method::GET, None).await.1["signed_prekey"]["id"],
        200
    );
    let mut changed = original;
    changed["signed_prekey"]["id"] = json!(300);
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(changed)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, Some(&token), Method::GET, None).await.1["signed_prekey"]["id"],
        200
    );
}

#[tokio::test]
async fn publication_rejects_changed_identity_without_mutating_keys() {
    let (app, token, user_id) = setup().await;
    let identity = enroll_test_identity(&app, user_id).await;
    let original = identified_bundle(100, &identity);
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(original.clone()))
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind("33".repeat(32))
        .bind(user_id)
        .execute(&app.db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(original))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM prekey_publication_receipts WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let mut missing_identity = bundle(200);
    missing_identity["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(missing_identity))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn simultaneous_publication_replays_share_one_receipt() {
    let (app, token, user_id) = setup().await;
    let identity = enroll_test_identity(&app, user_id).await;
    let body = identified_bundle(100, &identity);
    let (a, b) = tokio::join!(
        call(&app, Some(&token), Method::PUT, Some(body.clone())),
        call(&app, Some(&token), Method::PUT, Some(body))
    );
    assert_eq!(a.0, StatusCode::OK, "{a:?}");
    assert_eq!(b.0, StatusCode::OK, "{b:?}");
    assert_eq!(a.1, b.1);
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM prekey_publication_receipts WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn publication_receipt_storage_failure_rolls_back_all_keys_before_retry() {
    let (app, token, user_id) = setup().await;
    let identity = enroll_test_identity(&app, user_id).await;
    let body = identified_bundle(100, &identity);
    let fail = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => "CREATE TRIGGER reject_publication_receipt BEFORE INSERT ON prekey_publication_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
        paracord_db::DatabaseEngine::Postgres => "ALTER TABLE prekey_publication_receipts ADD CONSTRAINT reject_publication_receipt CHECK (FALSE)",
    };
    sqlx::query(fail).execute(&app.db).await.unwrap();
    let (status, result) = call(&app, Some(&token), Method::PUT, Some(body.clone())).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{result}");
    let (_, state) = call(&app, Some(&token), Method::GET, None).await;
    assert!(state["signed_prekey"].is_null());
    assert!(state["last_resort_prekey"].is_null());
    assert_eq!(state["one_time_prekeys"], json!([]));
    let repair = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => "DROP TRIGGER reject_publication_receipt",
        paracord_db::DatabaseEngine::Postgres => {
            "ALTER TABLE prekey_publication_receipts DROP CONSTRAINT reject_publication_receipt"
        }
    };
    sqlx::query(repair).execute(&app.db).await.unwrap();
    let (status, receipt) = call(&app, Some(&token), Method::PUT, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["request_id"], body["request_id"]);
}

/// Re-enrollment for a device that proved the account's enrolled identity but
/// holds none of the private halves of the published bundle (a recovery-phrase
/// restore). The published inventory is replaced wholesale, because prekeys
/// nobody can open would otherwise keep being handed to peers ahead of the new
/// ones -- `consume_one_time_prekey` serves the oldest first.
#[tokio::test]
async fn a_proven_identity_replaces_the_whole_published_bundle() {
    let (app, token, user_id) = setup().await;
    let identity = "22".repeat(32);
    sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind(&identity)
        .bind(user_id)
        .execute(&app.db)
        .await
        .unwrap();
    // The lost device's publication.
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(bundle(100)))
            .await
            .0,
        StatusCode::OK
    );
    let (_, lost) = call(&app, Some(&token), Method::GET, None).await;
    assert_eq!(lost["one_time_prekeys"][0]["id"], 101);

    let mut replacement = bundle(300);
    replacement["replace_existing"] = json!(true);
    replacement["request_id"] = json!("2f2d6f4e-5b1a-4c0e-9c4c-1f4e0f9a7c21");
    replacement["expected_identity_key"] = json!(identity);
    let (status, response) = call(&app, Some(&token), Method::PUT, Some(replacement.clone())).await;
    assert_eq!(status, StatusCode::OK, "{response}");

    let (_, own) = call(&app, Some(&token), Method::GET, None).await;
    assert_eq!(own["signed_prekey"]["id"], 300);
    assert_eq!(
        own["one_time_prekeys"],
        json!([{ "id": 301, "public_key": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" }]),
        "every prekey from the lost device must be gone, not merely outnumbered"
    );
    assert_eq!(own["last_resort_prekey"]["id"], 302);
    assert_eq!(
        paracord_db::prekeys::count_one_time_prekeys(&app.db, user_id)
            .await
            .unwrap(),
        1
    );
    // A peer starting a new conversation can only be handed the new device's key.
    let handed = paracord_db::prekeys::consume_one_time_prekey(&app.db, user_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(handed.id, 301);

    // The publication stays idempotent: a replayed replacement returns its
    // receipt without deleting the keys it already stored.
    let (status, replayed) = call(&app, Some(&token), Method::PUT, Some(replacement)).await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(
        call(&app, Some(&token), Method::GET, None).await.1["last_resort_prekey"]["id"],
        302
    );
}

#[tokio::test]
async fn a_replacement_is_refused_unless_it_is_a_complete_identity_bound_bundle() {
    let (app, token, user_id) = setup().await;
    let identity = "33".repeat(32);
    sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind(&identity)
        .bind(user_id)
        .execute(&app.db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(bundle(100)))
            .await
            .0,
        StatusCode::OK
    );
    let (_, original) = call(&app, Some(&token), Method::GET, None).await;

    let identified = |mut body: Value| {
        body["replace_existing"] = json!(true);
        body["request_id"] = json!("8c1a1c22-2b7e-4a53-8f37-2cf0a9b50d11");
        body["expected_identity_key"] = json!(identity);
        body
    };
    // An incremental top-up would leave the account with no last-resort key.
    for missing in ["signed_prekey", "one_time_prekeys", "last_resort_prekey"] {
        let mut partial = identified(bundle(300));
        partial[missing] = Value::Null;
        let (status, response) = call(&app, Some(&token), Method::PUT, Some(partial)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{missing}: {response}");
    }
    // Unidentified replacement: the server's only check that this device speaks
    // for the enrolled identity is the expected-identity match.
    let mut anonymous = bundle(300);
    anonymous["replace_existing"] = json!(true);
    assert_eq!(
        call(&app, Some(&token), Method::PUT, Some(anonymous))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // A replacement naming a different enrolled identity is refused outright.
    let mut wrong = identified(bundle(300));
    wrong["expected_identity_key"] = json!("44".repeat(32));
    let (status, response) = call(&app, Some(&token), Method::PUT, Some(wrong)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{response}");

    assert_eq!(
        call(&app, Some(&token), Method::GET, None).await.1,
        original,
        "a refused replacement must leave the published bundle untouched"
    );
    assert_eq!(
        paracord_db::prekeys::count_one_time_prekeys(&app.db, user_id)
            .await
            .unwrap(),
        1
    );
}
