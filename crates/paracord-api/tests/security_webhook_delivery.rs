mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

struct Fixture {
    app: TestApp,
    guild: i64,
    channel: i64,
    owner: i64,
    member: i64,
    path: String,
}

fn sid() -> i64 {
    paracord_util::snowflake::generate(1)
}

impl Fixture {
    async fn new() -> Self {
        let app = build_test_app(TestAppOptions::default()).await.unwrap();
        let owner_token = create_authenticated_user_token(
            &app.db,
            &app.jwt_secret,
            "hookowner",
            "OwnerPassword123!",
        )
        .await
        .unwrap();
        let member_token = create_authenticated_user_token(
            &app.db,
            &app.jwt_secret,
            "hookmember",
            "MemberPassword123!",
        )
        .await
        .unwrap();
        let owner = paracord_core::auth::validate_token(&owner_token, &app.jwt_secret)
            .unwrap()
            .sub;
        let member = paracord_core::auth::validate_token(&member_token, &app.jwt_secret)
            .unwrap()
            .sub;
        let guild = sid();
        let channel = sid();
        paracord_db::guilds::create_guild(&app.db, guild, "Webhooks", owner, None)
            .await
            .unwrap();
        for user in [owner, member] {
            paracord_db::members::add_member(&app.db, user, guild)
                .await
                .unwrap();
        }
        paracord_db::roles::create_role(
            &app.db,
            guild,
            guild,
            "@everyone",
            (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES).bits(),
        )
        .await
        .unwrap();
        paracord_db::channels::create_channel(&app.db, channel, guild, "general", 0, 0, None, None)
            .await
            .unwrap();
        let hook = sid();
        let token = uuid::Uuid::new_v4().to_string();
        paracord_db::webhooks::create_webhook(
            &app.db,
            hook,
            guild,
            channel,
            "test hook",
            &token,
            member,
        )
        .await
        .unwrap();
        Self {
            app,
            guild,
            channel,
            owner,
            member,
            path: format!("/api/v1/webhooks/{hook}/{token}"),
        }
    }

    async fn call(&self, method: Method, suffix: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request =
            build_json_request(method, &format!("{}{suffix}", self.path), body, None).unwrap();
        dispatch_json(&self.app.app, request).await.unwrap()
    }

    async fn send(&self, content: &str) -> i64 {
        let (status, message) = self
            .call(Method::POST, "", Some(json!({"content": content})))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{message}");
        message["id"].as_str().unwrap().parse().unwrap()
    }
}

#[tokio::test]
async fn webhook_edits_enforce_automod_and_validate_embeds_before_writing() {
    let f = Fixture::new().await;
    paracord_db::automod::create_rule(
        &f.app.db,
        sid(),
        f.guild,
        "blocked words",
        f.owner,
        1,
        1,
        r#"{"kind":"keyword","keywords":["forbiddenword"]}"#,
        r#"[{"kind":"block_message","reason":"blocked"}]"#,
        true,
        "[]",
        "[]",
    )
    .await
    .unwrap();
    let message = f.send("original").await;
    let path = format!("/messages/{message}");
    let (status, payload) = f
        .call(
            Method::PATCH,
            &path,
            Some(json!({"content":"forbiddenword"})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{payload}");
    assert_eq!(
        paracord_db::messages::get_message(&f.app.db, message)
            .await
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        Some("original")
    );
    let (status, payload) = f
        .call(
            Method::PATCH,
            &path,
            Some(json!({"content":"changed", "embeds":vec![json!({}); 11]})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert_eq!(
        paracord_db::messages::get_message(&f.app.db, message)
            .await
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        Some("original")
    );
    let (status, payload) = f
        .call(
            Method::PATCH,
            &path,
            Some(json!({"content":"allowed edit", "embeds":[{"title":"valid"}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(payload["content"], "allowed edit");
}

#[tokio::test]
async fn webhook_delivery_respects_timeout_and_lost_channel_visibility() {
    let f = Fixture::new().await;
    let message = f.send("before revocation").await;
    let deletable = f.send("removable during timeout").await;
    paracord_db::members::set_member_timeout(
        &f.app.db,
        f.member,
        f.guild,
        Some(chrono::Utc::now() + chrono::Duration::minutes(5)),
    )
    .await
    .unwrap();
    let (status, payload) = f
        .call(Method::POST, "", Some(json!({"content":"timeout bypass"})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    // Match ordinary messages: a timeout prevents edits, while deletion remains
    // available so the author can remove an old post.
    let path = format!("/messages/{message}");
    let (status, payload) = f
        .call(Method::PATCH, &path, Some(json!({"content":"correction"})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    let (status, payload) = f
        .call(Method::DELETE, &format!("/messages/{deletable}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{payload}");
    paracord_db::members::set_member_timeout(&f.app.db, f.member, f.guild, None)
        .await
        .unwrap();
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &f.app.db,
        f.channel,
        f.member,
        1,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    f.app
        .state
        .permission_cache
        .invalidate_channel(f.channel)
        .await;
    for (method, suffix, body) in [
        (
            Method::POST,
            "",
            Some(json!({"content":"hidden channel bypass"})),
        ),
        (
            Method::PATCH,
            path.as_str(),
            Some(json!({"content":"hidden channel edit"})),
        ),
        (Method::DELETE, path.as_str(), None),
    ] {
        let (status, payload) = f.call(method, suffix, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{payload}");
    }
    assert_eq!(
        paracord_db::messages::get_message(&f.app.db, message)
            .await
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        Some("before revocation")
    );
}

#[tokio::test]
async fn webhook_cannot_post_to_a_locked_thread_but_can_revive_an_archived_thread() {
    let f = Fixture::new().await;
    let parent = sid();
    paracord_db::channels::create_channel(&f.app.db, parent, f.guild, "parent", 0, 0, None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE channels SET channel_type = 6, parent_id = $2 WHERE id = $1")
        .bind(f.channel)
        .bind(parent)
        .execute(&f.app.db)
        .await
        .unwrap();
    paracord_db::channels::update_thread(&f.app.db, f.channel, None, Some(true), Some(true))
        .await
        .unwrap();
    let (status, payload) = f
        .call(Method::POST, "", Some(json!({"content":"locked bypass"})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    paracord_db::channels::update_thread(&f.app.db, f.channel, None, Some(true), Some(false))
        .await
        .unwrap();
    f.send("revive thread").await;
    let channel = paracord_db::channels::get_channel(&f.app.db, f.channel)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(channel.thread_state(), (false, false));
}
