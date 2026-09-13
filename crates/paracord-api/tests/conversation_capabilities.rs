mod common;
use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_models::permissions::Permissions;
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
async fn user(app: &TestApp, name: &str) -> (String, i64) {
    let token = create_authenticated_user_token(&app.db, &app.jwt_secret, name, "Capabilities123!")
        .await
        .unwrap();
    let (status, body) = call(app, &token, Method::GET, "/api/v1/users/@me", None).await;
    assert_eq!(status, StatusCode::OK);
    (token, body["id"].as_str().unwrap().parse().unwrap())
}
async fn caps(app: &TestApp, token: &str, channel: i64) -> Value {
    let (status, body) = call(
        app,
        token,
        Method::GET,
        &format!("/api/v1/channels/{channel}/capabilities"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
async fn guild_channel(app: &TestApp, token: &str, kind: i16) -> (i64, i64) {
    let (status, guild) = call(
        app,
        token,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Capabilities"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild_id = guild["id"].as_str().unwrap().parse().unwrap();
    let (status, channel) = call(
        app,
        token,
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        Some(json!({"name":"actions", "channel_type":kind})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{channel}");
    (guild_id, channel["id"].as_str().unwrap().parse().unwrap())
}
fn poll() -> Value {
    json!({"question":"Lunch?", "options":[{"text":"Soup"},{"text":"Salad"}]})
}

#[tokio::test]
async fn encrypted_dm_actions_are_scoped_and_unsupported_requests_leave_no_plaintext() {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let (alice, a) = user(&app, "actionalice").await;
    let (_, b) = user(&app, "actionbob").await;
    let (outsider, _) = user(&app, "actionoutsider").await;
    paracord_db::dms::create_dm_channel(&app.db, 901, a, b)
        .await
        .unwrap();
    paracord_db::dms::create_group_dm_channel(&app.db, 902, Some("Group"), a, &[b])
        .await
        .unwrap();
    for channel in [901, 902] {
        let body = caps(&app, &alice, channel).await;
        assert_eq!(body["channel_id"], channel.to_string());
        assert_eq!(body["user_id"], a.to_string());
        assert_eq!(body["version"], 1);
        assert_eq!(body["encrypted"], true);
        assert_eq!(body["own_identity_enrolled"], false);
        assert_eq!(body["peers_ready"], false);
        for action in ["poll", "summary"] {
            assert_eq!(body["actions"][action]["supported"], false);
            assert_eq!(body["actions"][action]["allowed"], false);
            assert!(body["actions"][action]["reason"]
                .as_str()
                .unwrap()
                .contains("encrypted"));
        }
        let (status, error) = call(
            &app,
            &alice,
            Method::POST,
            &format!("/api/v1/channels/{channel}/polls"),
            Some(poll()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert!(error.to_string().contains("encrypted direct messages"));
        let (status, error) = call(
            &app,
            &alice,
            Method::GET,
            &format!("/api/v1/channels/{channel}/summary"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert!(error.to_string().contains("encrypted direct messages"));
        let status = call(
            &app,
            &outsider,
            Method::GET,
            &format!("/api/v1/channels/{channel}/capabilities"),
            None,
        )
        .await
        .0;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id IN (901, 902)")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn member_overwrite_decisions_match_poll_enforcement_and_hide_inaccessible_channels() {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let (owner, _) = user(&app, "actionowner").await;
    let (member, id) = user(&app, "actionmember").await;
    let (guild, channel) = guild_channel(&app, &owner, 0).await;
    paracord_db::members::add_member(&app.db, id, guild)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&app.db, id, guild, guild)
        .await
        .unwrap();
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &app.db,
        channel,
        id,
        1,
        0,
        (Permissions::SEND_MESSAGES | Permissions::ATTACH_FILES).bits(),
    )
    .await
    .unwrap();
    let body = caps(&app, &member, channel).await;
    for action in ["send", "poll", "schedule", "attach"] {
        assert_eq!(body["actions"][action]["supported"], true);
        assert_eq!(body["actions"][action]["allowed"], false);
    }
    assert_eq!(
        call(
            &app,
            &member,
            Method::POST,
            &format!("/api/v1/channels/{channel}/polls"),
            Some(poll())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let owner_caps = caps(&app, &owner, channel).await;
    assert_eq!(owner_caps["actions"]["poll"]["allowed"], true);
    assert_eq!(owner_caps["actions"]["summary"]["supported"], false);
    assert_eq!(owner_caps["actions"]["voice"]["supported"], false);
    // A separate never-viewed channel verifies the authorization boundary,
    // independently of the cache populated by the first read.
    let (_, hidden) = guild_channel(&app, &owner, 0).await;
    assert_eq!(
        call(
            &app,
            &member,
            Method::GET,
            &format!("/api/v1/channels/{hidden}/capabilities"),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn unavailable_media_and_voice_channel_poll_are_reported_before_requesting_tokens() {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let (owner, _) = user(&app, "actionvoice").await;
    let (_, channel) = guild_channel(&app, &owner, 2).await;
    let body = caps(&app, &owner, channel).await;
    for action in ["voice", "video", "screen_share"] {
        assert_eq!(body["actions"][action]["supported"], false);
        assert!(body["actions"][action]["reason"]
            .as_str()
            .unwrap()
            .contains("not configured"));
    }
    assert_eq!(body["actions"]["poll"]["supported"], false);
    assert_eq!(
        call(
            &app,
            &owner,
            Method::POST,
            &format!("/api/v1/channels/{channel}/polls"),
            Some(poll())
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn summary_capability_uses_the_same_configuration_validation_as_execution() {
    for (provider, key, expected) in [
        ("unknown", None, false),
        ("anthropic", None, false),
        ("anthropic", Some("  "), false),
        ("anthropic", Some("configured-test-key"), true),
        ("ollama", None, true),
        ("openai_compatible", None, true),
    ] {
        let app = build_test_app(TestAppOptions {
            ai_provider: Some(provider.into()),
            ai_base_url: Some("http://127.0.0.1:9".into()),
            ai_api_key: key.map(str::to_string),
            ..Default::default()
        })
        .await
        .unwrap();
        let (owner, _) = user(&app, "actionai").await;
        let (_, channel) = guild_channel(&app, &owner, 0).await;
        assert_eq!(
            caps(&app, &owner, channel).await["actions"]["summary"]["allowed"],
            expected,
            "{provider}, {key:?}"
        );
    }
}

#[tokio::test]
async fn a_block_disables_existing_dm_calls_and_is_enforced_before_creating_a_session() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let (alice, a) = user(&app, "actionblocked").await;
    let (_, b) = user(&app, "actionblocker").await;
    paracord_db::dms::create_dm_channel(&app.db, 903, a, b)
        .await
        .unwrap();
    assert_eq!(
        caps(&app, &alice, 903).await["actions"]["voice"]["allowed"],
        true
    );
    paracord_db::relationships::create_relationship(&app.db, b, a, 2)
        .await
        .unwrap();
    let body = caps(&app, &alice, 903).await;
    for action in [
        "send",
        "attach",
        "schedule",
        "voice",
        "video",
        "screen_share",
    ] {
        assert_eq!(body["actions"][action]["supported"], true);
        assert_eq!(body["actions"][action]["allowed"], false);
    }
    let (status, error) = call(
        &app,
        &alice,
        Method::POST,
        "/api/v1/dms/903/voice/join",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM voice_states WHERE channel_id = 903")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let (status, error) = call(&app, &alice, Method::POST, "/api/v1/channels/903/scheduled-messages", Some(json!({"content":"blocked", "send_at":(chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
}

#[tokio::test]
async fn timeouts_disable_composition_and_reject_new_schedules_without_hiding_history() {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let (owner, _) = user(&app, "actionmoderator").await;
    let (member, id) = user(&app, "actiontimeout").await;
    let (guild, channel) = guild_channel(&app, &owner, 0).await;
    paracord_db::members::add_member(&app.db, id, guild)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&app.db, id, guild, guild)
        .await
        .unwrap();
    paracord_db::members::set_member_timeout(
        &app.db,
        id,
        guild,
        Some(chrono::Utc::now() + chrono::Duration::hours(1)),
    )
    .await
    .unwrap();
    let body = caps(&app, &member, channel).await;
    for action in ["send", "poll", "schedule", "attach"] {
        assert_eq!(body["actions"][action]["allowed"], false);
        assert!(body["actions"][action]["reason"]
            .as_str()
            .unwrap()
            .contains("timed out"));
    }
    let (status, error) = call(&app, &member, Method::POST, &format!("/api/v1/channels/{channel}/scheduled-messages"), Some(json!({"content":"later", "send_at":(chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339()}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert!(error.to_string().contains("timed out"));
    let (status, error) = call(
        &app,
        &member,
        Method::POST,
        &format!("/api/v1/channels/{channel}/polls"),
        Some(poll()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(
        call(
            &app,
            &member,
            Method::GET,
            &format!("/api/v1/channels/{channel}/messages"),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}
