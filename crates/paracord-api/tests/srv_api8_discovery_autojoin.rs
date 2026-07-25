mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::json;

/// Regression: a public guild that sets discovery tags must still auto-join new
/// users on registration. Previously discovery tags and role-gating role IDs
/// shared the `allowed_roles` column, which could make a tagged public guild
/// look role-gated and silently suppress auto-join. Discovery tags now live in
/// their own column, leaving `allowed_roles` unambiguous.
#[tokio::test]
async fn public_guild_with_discovery_tags_still_auto_joins_new_users() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;

    let owner_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "owner",
        "OwnerPass123!",
    )
    .await?;

    // Owner creates a guild and publishes it with discovery tags set.
    let (status, created) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Public Space" })),
            Some(&owner_token),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "guild create failed: {created}"
    );
    let guild_id = created["id"].as_str().expect("guild id").to_string();

    let (status, published) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "visibility": "public", "discovery_tags": ["gaming"] })),
            Some(&owner_token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "publish failed: {published}");
    assert_eq!(
        published["visibility"], "public",
        "guild should be public: {published}"
    );
    assert_eq!(
        published["discovery_tags"],
        json!(["gaming"]),
        "discovery tags should round-trip: {published}"
    );

    // A brand-new user registers; auto-join must add them to the tagged public
    // guild.
    let (status, registered) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": "joiner@example.com",
                "username": "joiner",
                "password": "JoinerPass123!"
            })),
            None,
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "registration failed: {registered}"
    );
    let joiner_token = registered["token"]
        .as_str()
        .expect("register response token")
        .to_string();

    // The new user's guild list must include the tagged public guild.
    let (status, guilds) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::GET,
            "/api/v1/users/@me/guilds",
            None,
            Some(&joiner_token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "list guilds failed: {guilds}");
    let joined = guilds
        .as_array()
        .expect("guild list should be an array")
        .iter()
        .any(|g| g["id"].as_str() == Some(guild_id.as_str()));
    assert!(
        joined,
        "new user should be auto-joined to the tagged public guild: {guilds}"
    );

    Ok(())
}

/// Security regression (ban evasion): a user banned from a public guild must not
/// be able to silently rejoin via the invite-less self-join endpoint
/// (`PUT /guilds/{id}/members/@me`). The handler previously checked only
/// visibility + role-gating and never consulted the `bans` table, so a banned
/// user could rejoin at will — evading the ban. The invite-accept path already
/// blocks banned users; this proves the self-join path now does too, while
/// legitimate (non-banned) users can still join.
#[tokio::test]
async fn banned_user_cannot_self_join_public_guild() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;

    // Owner creates a guild and publishes it as an open, role-ungated public guild.
    let owner_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "owner",
        "OwnerPass123!",
    )
    .await?;
    let owner_id = paracord_core::auth::validate_token(&owner_token, &test_app.jwt_secret)?.sub;

    let (status, created) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Public Space" })),
            Some(&owner_token),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "guild create failed: {created}"
    );
    let guild_id_str = created["id"].as_str().expect("guild id").to_string();
    let guild_id: i64 = guild_id_str.parse()?;

    let (status, published) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id_str}"),
            Some(json!({ "visibility": "public" })),
            Some(&owner_token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "publish failed: {published}");
    assert_eq!(published["visibility"], "public", "guild should be public");

    // Create a user and ban them from the guild. `create_authenticated_user_token`
    // creates the user directly (no registration auto-join), so the ban row is
    // their only relationship to the guild — mirroring a real ban, which removes
    // the member row and leaves the user on the non-member path.
    let banned_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "banned",
        "BannedPass123!",
    )
    .await?;
    let banned_id = paracord_core::auth::validate_token(&banned_token, &test_app.jwt_secret)?.sub;
    paracord_db::bans::create_ban(
        &test_app.db,
        banned_id,
        guild_id,
        Some("ban evasion regression"),
        owner_id,
    )
    .await?;

    // The banned user attempts an invite-less self-join — must be rejected.
    let (status, body) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id_str}/members/@me"),
            None,
            Some(&banned_token),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "banned user must not self-join a public guild: {body}"
    );

    // ...and must NOT have been added to the members table.
    let member = paracord_db::members::get_member(&test_app.db, banned_id, guild_id).await?;
    assert!(
        member.is_none(),
        "banned user must not be added to members after a rejected self-join"
    );

    // A normal (non-banned) user can still self-join the public guild.
    let joiner_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "joiner",
        "JoinerPass123!",
    )
    .await?;
    let joiner_id = paracord_core::auth::validate_token(&joiner_token, &test_app.jwt_secret)?.sub;
    let (status, body) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id_str}/members/@me"),
            None,
            Some(&joiner_token),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "non-banned user should be able to self-join: {body}"
    );
    let member = paracord_db::members::get_member(&test_app.db, joiner_id, guild_id).await?;
    assert!(
        member.is_some(),
        "non-banned user should be added to members after joining"
    );

    Ok(())
}
