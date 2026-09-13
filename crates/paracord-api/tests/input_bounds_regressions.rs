//! Values the API stored because nothing looked at them.
//!
//! Each case here was accepted by a release candidate and persisted: a reaction
//! that is not an emoji, a room of a type no client can render, a role colour
//! outside the 24 bits every consumer reads, a message scheduled for the year
//! 9999, a permission overwrite whose bits this server does not define, and one
//! naming a role that no longer exists.

mod common;

use axum::http::{Method, StatusCode};
use common::{build_json_request, build_test_app, dispatch_json, TestAppOptions};
use serde_json::{json, Value};

struct Space {
    token: String,
    guild_id: String,
    channel_id: String,
    message_id: String,
    user_id: String,
}

async fn owned_space(app: &common::TestApp) -> anyhow::Result<Space> {
    let (status, account) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "username": "boundsowner",
                "email": "bounds-owner@example.com",
                "password": "Sup3rStr0ng!Passw0rd",
                "display_name": "Bounds owner",
            })),
            None,
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "register: {account}");
    let token = account["token"].as_str().unwrap().to_string();
    let user_id = account["user"]["id"].as_str().unwrap().to_string();

    let (status, guild) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Bounds" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();

    let (status, channels) = dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            None,
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "channels: {channels}");
    let channel_id = channels
        .as_array()
        .unwrap()
        .iter()
        .find(|channel| channel["channel_type"].as_i64() == Some(0))
        .expect("the first space has a text room")["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, message) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "react to me" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "message: {message}");

    Ok(Space {
        token,
        guild_id,
        channel_id,
        message_id: message["id"].as_str().unwrap().to_string(),
        user_id,
    })
}

async fn put(
    app: &common::TestApp,
    path: &str,
    body: Option<Value>,
    token: &str,
) -> anyhow::Result<(StatusCode, Value)> {
    dispatch_json(
        &app.app,
        build_json_request(Method::PUT, path, body, Some(token))?,
    )
    .await
}

#[tokio::test]
async fn a_reaction_has_to_be_an_emoji() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let space = owned_space(&app).await?;
    let base = format!(
        "/api/v1/channels/{}/messages/{}/reactions",
        space.channel_id, space.message_id
    );

    for segment in ["notanemoji", "%3Cscript%3E", "%3Ashipit%3A", "1"] {
        let (status, body) =
            put(&app, &format!("{base}/{segment}/@me"), None, &space.token).await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{segment} was accepted as a reaction: {body}"
        );
    }

    // A custom emoji that does not exist is refused too — it used to be stored
    // and then rendered as a permanently broken image on the message.
    let (status, body) = put(
        &app,
        &format!("{base}/%3C%3Ashipit%3A123%3E/@me"),
        None,
        &space.token,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "dangling custom emoji: {body}"
    );

    // 👍 still works.
    let (status, body) = put(
        &app,
        &format!("{base}/%F0%9F%91%8D/@me"),
        None,
        &space.token,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "a real emoji: {body}");
    Ok(())
}

#[tokio::test]
async fn a_room_has_to_be_a_kind_this_server_serves() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let space = owned_space(&app).await?;
    let path = format!("/api/v1/guilds/{}/channels", space.guild_id);

    for channel_type in [9999, -1, 1, 3, 6] {
        let (status, body) = dispatch_json(
            &app.app,
            build_json_request(
                Method::POST,
                &path,
                Some(json!({ "name": "odd", "channel_type": channel_type })),
                Some(&space.token),
            )?,
        )
        .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "channel_type {channel_type} was accepted: {body}"
        );
    }

    for channel_type in [0, 2, 4, 5, 7, 13] {
        let (status, body) = dispatch_json(
            &app.app,
            build_json_request(
                Method::POST,
                &path,
                Some(
                    json!({ "name": format!("room{channel_type}"), "channel_type": channel_type }),
                ),
                Some(&space.token),
            )?,
        )
        .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "channel_type {channel_type} should be creatable: {body}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_role_colour_stays_inside_twenty_four_bits() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let space = owned_space(&app).await?;
    let path = format!("/api/v1/guilds/{}/roles", space.guild_id);

    for color in [999_999_999, -1, 0x1_00_00_00] {
        let (status, body) = dispatch_json(
            &app.app,
            build_json_request(
                Method::POST,
                &path,
                Some(json!({ "name": "Loud", "color": color })),
                Some(&space.token),
            )?,
        )
        .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "color {color}: {body}");
    }

    let (status, role) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            &path,
            Some(json!({ "name": "Calm", "color": 0x5865F2 })),
            Some(&space.token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "a real colour: {role}");
    let role_id = role["id"].as_str().unwrap().to_string();

    // The edit route was unguarded for the same reason the create route was.
    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{}/roles/{role_id}", space.guild_id),
            Some(json!({ "color": -1 })),
            Some(&space.token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "edit to -1: {body}");
    Ok(())
}

#[tokio::test]
async fn a_scheduled_message_has_a_ceiling_as_well_as_a_floor() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let space = owned_space(&app).await?;
    let path = format!("/api/v1/channels/{}/scheduled-messages", space.channel_id);

    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            &path,
            Some(json!({ "content": "see you then", "send_at": "9999-01-01T00:00:00Z" })),
            Some(&space.token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "the year 9999: {body}");

    let soon = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            &path,
            Some(json!({ "content": "see you soon", "send_at": soon })),
            Some(&space.token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "an hour from now: {body}");
    Ok(())
}

#[tokio::test]
async fn an_overwrite_names_a_real_target_with_bits_this_server_defines() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let space = owned_space(&app).await?;

    // The owner took an early return above the bitset check, so `-1` stored
    // every unknown bit and then took part in permission math forever.
    let (status, body) = put(
        &app,
        &format!(
            "/api/v1/channels/{}/overwrites/{}",
            space.channel_id, space.guild_id
        ),
        Some(json!({ "target_type": 0, "allow_perms": -1, "deny_perms": 0 })),
        &space.token,
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "allow_perms -1: {body}");

    // A role that was deleted — or never existed — is not a target.
    let (status, body) = put(
        &app,
        &format!("/api/v1/channels/{}/overwrites/424242", space.channel_id),
        Some(json!({ "target_type": 0, "allow_perms": 0, "deny_perms": 0 })),
        &space.token,
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "unknown role: {body}");

    // Neither is someone who is not in this space.
    let (status, body) = put(
        &app,
        &format!("/api/v1/channels/{}/overwrites/424243", space.channel_id),
        Some(json!({ "target_type": 1, "allow_perms": 0, "deny_perms": 0 })),
        &space.token,
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "unknown member: {body}");

    // The @everyone role and the owner themselves still work.
    for (target, target_type) in [(space.guild_id.as_str(), 0), (space.user_id.as_str(), 1)] {
        let (status, body) = put(
            &app,
            &format!("/api/v1/channels/{}/overwrites/{target}", space.channel_id),
            Some(json!({
                "target_type": target_type,
                "allow_perms": 0,
                "deny_perms": 0,
            })),
            &space.token,
        )
        .await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "{target}: {body}");
    }
    Ok(())
}

#[tokio::test]
async fn creating_an_automod_rule_answers_created() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let space = owned_space(&app).await?;

    let (status, rule) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/guilds/{}/automod/rules", space.guild_id),
            Some(json!({
                "name": "No shouting",
                "event_type": 1,
                "trigger_type": 1,
                "trigger_metadata": { "kind": "keyword", "keywords": ["shout"] },
                "actions": [{ "kind": "block_message" }],
                "enabled": true,
            })),
            Some(&space.token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "automod rule: {rule}");
    assert_eq!(rule["name"], "No shouting");
    Ok(())
}
