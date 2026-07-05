//! Regression tests for the Discord-parity default member permission set.
//!
//! A plain member of someone else's guild — holding nothing but the implicit
//! default (@everyone-equivalent) role — must be able to create an invite and
//! upload an attachment. Before `Permissions::default()` gained
//! CREATE_INSTANT_INVITE / ATTACH_FILES / EMBED_LINKS / USE_EXTERNAL_EMOJIS,
//! both requests failed with 403 for non-owners.

mod common;

use anyhow::Context;
use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::{json, Value};

#[tokio::test]
async fn plain_member_can_create_invite_and_upload_attachment() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let app = test_app.app.clone();

    // Owner creates the guild.
    let owner_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "defperm_owner",
        "OwnerPass123!",
    )
    .await?;
    let request = build_json_request(
        Method::POST,
        "/api/v1/guilds",
        Some(json!({ "name": "Default Perm Guild", "icon": Value::Null })),
        Some(&owner_token),
    )?;
    let (status, guild) = dispatch_json(&app, request).await?;
    assert_eq!(status, StatusCode::CREATED, "create guild failed: {guild}");
    let guild_id: i64 = guild["id"]
        .as_str()
        .context("guild id should be a string")?
        .parse()?;

    // Owner creates a text channel.
    let request = build_json_request(
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        Some(json!({
            "name": "member-perms",
            "channel_type": 0,
            "parent_id": Value::Null,
            "required_role_ids": Value::Null,
        })),
        Some(&owner_token),
    )?;
    let (status, channel) = dispatch_json(&app, request).await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create channel failed: {channel}"
    );
    let channel_id: i64 = channel["id"]
        .as_str()
        .context("channel id should be a string")?
        .parse()?;

    // A second user joins as a plain member: no explicit roles, only the
    // implicit default role (id == guild_id) that every member holds.
    let member_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "defperm_member",
        "MemberPass123!",
    )
    .await?;
    let request = build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&member_token))?;
    let (status, me) = dispatch_json(&app, request).await?;
    assert_eq!(status, StatusCode::OK, "fetch @me failed: {me}");
    let member_id: i64 = me["id"]
        .as_str()
        .context("user id should be a string")?
        .parse()?;
    paracord_db::members::add_member(&test_app.db, member_id, guild_id).await?;

    // The plain member can create an invite (CREATE_INSTANT_INVITE default).
    let request = build_json_request(
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/invites"),
        Some(json!({})),
        Some(&member_token),
    )?;
    let (status, invite) = dispatch_json(&app, request).await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "plain member should be able to create an invite by default: {invite}"
    );
    assert!(
        invite["code"].as_str().is_some_and(|c| !c.is_empty()),
        "invite response should contain a code: {invite}"
    );

    // The plain member can upload a small attachment (ATTACH_FILES default).
    let boundary = "----paracord-default-member-perms-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"hello.txt\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
    body.extend_from_slice(b"hello from a plain member");
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/v1/channels/{channel_id}/attachments"))
        .header(header::AUTHORIZATION, format!("Bearer {member_token}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))?;
    let (status, attachment) = dispatch_json(&app, request).await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "plain member should be able to upload an attachment by default: {attachment}"
    );
    assert!(
        attachment["id"].as_str().is_some_and(|id| !id.is_empty()),
        "attachment response should contain an id: {attachment}"
    );

    Ok(())
}
