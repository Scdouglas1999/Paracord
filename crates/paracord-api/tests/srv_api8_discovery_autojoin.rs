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
