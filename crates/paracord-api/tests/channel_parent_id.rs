//! A new room's `parent_id`: the id shape, and the category it is allowed to be.
//!
//! `CreateChannelRequest.parent_id` was the one id on the API typed as a JSON
//! number. Two things followed.
//!
//! The client sends it as a string, like every other id it sends — including
//! `required_role_ids` in the same body — so "create a channel inside this
//! category" was a 422 from the settings screen every time, and a room could
//! not be put in a category at all. A caller that obliged with a raw number hit
//! the other half: a snowflake is larger than 2^53, so JavaScript rounds it and
//! the parent that arrives is not the parent that was chosen.
//!
//! And the value was written to the row unchecked. `resolve_permission_gate`
//! reads a room's overwrites and required roles through its parent, so the
//! parent is an access-control input — which is why the sibling
//! channel-positions route validates existence, space and type (see
//! `channel_position_authz.rs`). This route validated none of it: another
//! space's category went in, a plain text room went in, and an id belonging to
//! nothing came back as a 500 from the foreign key.

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

struct Ctx {
    app: Router,
    _test_app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        Ok(Self {
            app: test_app.app.clone(),
            _test_app: test_app,
        })
    }

    async fn token(&self, name: &str) -> anyhow::Result<String> {
        create_authenticated_user_token(
            &self._test_app.db,
            &self._test_app.jwt_secret,
            name,
            "ParentPass123!",
        )
        .await
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn guild(&self, token: &str, name: &str) -> anyhow::Result<String> {
        let (status, payload) = self
            .call(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild create: {payload}");
        Ok(payload["id"]
            .as_str()
            .context("guild id should be a string")?
            .to_string())
    }

    async fn create_channel(
        &self,
        token: &str,
        guild_id: &str,
        name: &str,
        channel_type: i16,
        parent_id: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.call(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": name,
                "channel_type": channel_type,
                "parent_id": parent_id,
                "required_role_ids": Value::Null,
            })),
            token,
        )
        .await
    }
}

fn message(payload: &Value) -> String {
    payload["message"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn a_room_can_be_created_inside_a_category_by_its_string_id() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let token = ctx.token("parentowner").await?;
    let guild_id = ctx.guild(&token, "Parent Space").await?;

    let (status, category) = ctx
        .create_channel(&token, &guild_id, "Staff", 4, Value::Null)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "category: {category}");
    let category_id = category["id"]
        .as_str()
        .context("category id should be a string")?
        .to_string();

    let (status, room) = ctx
        .create_channel(
            &token,
            &guild_id,
            "staff-room",
            0,
            Value::String(category_id.clone()),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "room: {room}");
    assert_eq!(
        room["parent_id"],
        json!(category_id),
        "the room should land in the category it named: {room}"
    );

    // No parent at all stays legal and stays null.
    let (status, loose) = ctx
        .create_channel(&token, &guild_id, "loose-room", 0, Value::Null)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "loose: {loose}");
    assert_eq!(loose["parent_id"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn a_parent_that_is_not_this_space_s_category_is_refused() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let mine = ctx.token("parentmine").await?;
    let theirs = ctx.token("parenttheirs").await?;
    let my_guild = ctx.guild(&mine, "My Space").await?;
    let their_guild = ctx.guild(&theirs, "Their Space").await?;

    let (_, their_category) = ctx
        .create_channel(&theirs, &their_guild, "Private", 4, Value::Null)
        .await?;
    let their_category_id = their_category["id"]
        .as_str()
        .context("category id should be a string")?
        .to_string();

    let (_, my_category) = ctx
        .create_channel(&mine, &my_guild, "Mine", 4, Value::Null)
        .await?;
    let my_text = ctx
        .create_channel(&mine, &my_guild, "chat-room", 0, Value::Null)
        .await?
        .1;
    let my_text_id = my_text["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string();

    for (label, parent, expected_fragment) in [
        (
            "a category in another space",
            Value::String(their_category_id),
            "category in this space",
        ),
        (
            "a text room, not a category",
            Value::String(my_text_id),
            "must be a category",
        ),
        (
            "an id belonging to nothing",
            Value::String("910000000000000001".into()),
            "Invalid parent_id",
        ),
        (
            "not an id at all",
            Value::String("not-a-snowflake".into()),
            "Invalid parent_id",
        ),
    ] {
        let (status, payload) = ctx
            .create_channel(&mine, &my_guild, "intruder", 0, parent)
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {payload}");
        assert!(
            message(&payload).contains(expected_fragment),
            "{label} refused for the wrong reason: {payload}"
        );
    }

    // The legitimate parent still works after all that.
    let my_category_id = my_category["id"]
        .as_str()
        .context("category id should be a string")?
        .to_string();
    let (status, room) = ctx
        .create_channel(
            &mine,
            &my_guild,
            "good-room",
            0,
            Value::String(my_category_id),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "good room: {room}");
    Ok(())
}
