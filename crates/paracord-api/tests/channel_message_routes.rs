mod common;

use anyhow::Context;
use axum::{
    http::{Method, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};

struct TestContext {
    app: Router,
    token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            install_http_rate_limiter: true,
            ..Default::default()
        })
        .await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "integration",
            "IntegrationPass123!",
        )
        .await?;

        Ok(Self {
            app: test_app.app.clone(),
            token,
            _test_app: test_app,
        })
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(&self.token))?;
        dispatch_json(&self.app, request).await
    }
}

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    Ok(payload["id"]
        .as_str()
        .context("guild id should be a string")?
        .to_string())
}

async fn create_text_channel(
    ctx: &TestContext,
    guild_id: &str,
    name: &str,
) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": name,
                "channel_type": 0,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    Ok(payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string())
}

#[tokio::test]
async fn create_guild_channel_send_message_flow_works_end_to_end() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Flow Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "flow-chat").await?;

    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "integration hello world" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = message["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected response payload: {messages}"
    );
    let list = messages
        .as_array()
        .context("messages list should be an array")?;
    assert!(list
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    Ok(())
}

#[tokio::test]
async fn channel_crud_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Channel CRUD Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "general").await?;

    let (status, channel) = ctx
        .request_json(Method::GET, &format!("/api/v1/channels/{channel_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(channel["id"], channel_id);
    assert_eq!(channel["name"], "general");

    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            Some(json!({
                "name": "renamed-general",
                "topic": "Updated integration topic",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "renamed-general");
    assert_eq!(updated["topic"], "Updated integration topic");

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = ctx
        .request_json(Method::GET, &format!("/api/v1/channels/{channel_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    Ok(())
}

#[tokio::test]
async fn message_crud_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Message CRUD Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;

    let (status, created) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "original body" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = created["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (status, edited) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}"),
            Some(json!({ "content": "edited body" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "unexpected PATCH payload: {edited}");
    assert_eq!(edited["content"], "edited body");

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list = messages
        .as_array()
        .context("messages list should be an array")?;
    assert!(list
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, messages_after_delete) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list_after_delete = messages_after_delete
        .as_array()
        .context("messages list should be an array")?;
    assert!(!list_after_delete
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    Ok(())
}

#[tokio::test]
async fn thread_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Thread Routes Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "thread-parent").await?;

    let (status, created_thread) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/threads"),
            Some(json!({
                "name": "first-thread",
                "auto_archive_duration": 1440
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected thread payload: {created_thread}"
    );
    let thread_id = created_thread["id"]
        .as_str()
        .context("thread id should be a string")?
        .to_string();
    assert_eq!(created_thread["parent_id"], channel_id);
    assert!(created_thread["owner_id"].is_string());

    let (status, threads) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/threads"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let active_threads = threads
        .as_array()
        .context("threads response should be an array")?;
    assert!(active_threads
        .iter()
        .any(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id.as_str())));

    let (status, archived) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/threads/{thread_id}"),
            Some(json!({ "archived": true })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected archived payload: {archived}"
    );
    assert_eq!(archived["id"], thread_id);

    let (status, archived_threads) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/threads/archived"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let archived_list = archived_threads
        .as_array()
        .context("archived threads response should be an array")?;
    assert!(archived_list
        .iter()
        .any(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id.as_str())));

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/threads/{thread_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    Ok(())
}
