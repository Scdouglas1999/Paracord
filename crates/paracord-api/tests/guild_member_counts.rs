mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};

async fn create_guild(app: &TestApp, token: &str, name: &str) -> anyhow::Result<String> {
    let (status, created) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name })),
            Some(token),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "guild create failed: {created}"
    );
    Ok(created["id"].as_str().expect("guild id").to_string())
}

async fn make_guild_public(app: &TestApp, token: &str, guild_id: &str) -> anyhow::Result<()> {
    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "visibility": "public" })),
            Some(token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "publish failed: {body}");
    Ok(())
}

async fn join_public_guild(app: &TestApp, token: &str, guild_id: &str) -> anyhow::Result<Value> {
    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/members/@me"),
            None,
            Some(token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "public join failed: {body}");
    Ok(body)
}

async fn list_guilds(app: &TestApp, token: &str) -> anyhow::Result<Vec<Value>> {
    let (status, guilds) = dispatch_json(
        &app.app,
        build_json_request(Method::GET, "/api/v1/users/@me/guilds", None, Some(token))?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "list guilds failed: {guilds}");
    Ok(guilds.as_array().expect("guild list array").clone())
}

/// The guild list previously omitted `member_count` entirely. Every entry must
/// now carry the database count — two guilds with different membership prove
/// the values are per-guild, and a guild the caller cannot see must not leak.
#[tokio::test]
async fn list_guilds_reports_actual_member_counts() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "owner", "OwnerPass123!").await?;
    let member =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "member", "MemberPass123!")
            .await?;
    let outsider =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "outsider", "OutPass123!")
            .await?;

    let alpha = create_guild(&app, &owner, "Alpha Guild").await?;
    let beta = create_guild(&app, &owner, "Beta Guild").await?;
    make_guild_public(&app, &owner, &beta).await?;
    join_public_guild(&app, &member, &beta).await?;

    // A guild the listing user is not a member of must stay invisible.
    let hidden = create_guild(&app, &outsider, "Hidden Guild").await?;

    let guilds = list_guilds(&app, &owner).await?;
    assert_eq!(
        guilds.len(),
        2,
        "owner should see exactly two guilds: {guilds:?}"
    );
    for guild in &guilds {
        assert!(
            guild.get("member_count").is_some(),
            "member_count must be present on every guild entry: {guild}"
        );
    }

    let count_of = |id: &str| -> Option<i64> {
        guilds
            .iter()
            .find(|g| g["id"].as_str() == Some(id))
            .and_then(|g| g["member_count"].as_i64())
    };
    assert_eq!(count_of(&alpha), Some(1), "Alpha has only its owner");
    assert_eq!(count_of(&beta), Some(2), "Beta has owner + joined member");
    assert!(
        guilds
            .iter()
            .all(|g| g["id"].as_str() != Some(hidden.as_str())),
        "guild the caller cannot see must not appear: {guilds:?}"
    );
    Ok(())
}

/// Guild detail must return the real count, and the member gate is unchanged:
/// a non-member is still rejected before any count is produced.
#[tokio::test]
async fn get_guild_reports_member_count_and_preserves_authorization() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "owner", "OwnerPass123!").await?;
    let member =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "member", "MemberPass123!")
            .await?;
    let outsider =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "outsider", "OutPass123!")
            .await?;

    let guild_id = create_guild(&app, &owner, "Counted Guild").await?;
    make_guild_public(&app, &owner, &guild_id).await?;
    join_public_guild(&app, &member, &guild_id).await?;

    let (status, guild) = dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}"),
            None,
            Some(&owner),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "get guild failed: {guild}");
    assert_eq!(guild["member_count"], json!(2), "detail count: {guild}");

    let (status, _) = dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}"),
            None,
            Some(&outsider),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "non-member detail access must stay forbidden"
    );
    Ok(())
}

/// Create and update responses must carry the real count. Update previously
/// serialized the guild with no count at all.
#[tokio::test]
async fn create_and_update_guild_report_member_count() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "owner", "OwnerPass123!").await?;
    let member =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "member", "MemberPass123!")
            .await?;

    let (status, created) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Mutable Guild" })),
            Some(&owner),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "create failed: {created}");
    assert_eq!(
        created["member_count"],
        json!(1),
        "a new guild has exactly its owner: {created}"
    );
    let guild_id = created["id"].as_str().expect("guild id").to_string();

    make_guild_public(&app, &owner, &guild_id).await?;
    join_public_guild(&app, &member, &guild_id).await?;

    let (status, updated) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "name": "Renamed Guild" })),
            Some(&owner),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "update failed: {updated}");
    assert_eq!(updated["name"], json!("Renamed Guild"));
    assert_eq!(
        updated["member_count"],
        json!(2),
        "update must report the real count: {updated}"
    );
    Ok(())
}

/// The invite-less public join returns the guild payload; its count must move
/// with actual joins and stay stable on an idempotent re-join.
#[tokio::test]
async fn join_public_guild_reports_growing_member_count() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "owner", "OwnerPass123!").await?;
    let joiner_a =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "joinera", "JoinPass123!")
            .await?;
    let joiner_b =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "joinerb", "JoinPass123!")
            .await?;

    let guild_id = create_guild(&app, &owner, "Open Guild").await?;
    make_guild_public(&app, &owner, &guild_id).await?;

    let joined = join_public_guild(&app, &joiner_a, &guild_id).await?;
    assert_eq!(
        joined["member_count"],
        json!(2),
        "first join: owner + new member: {joined}"
    );

    let joined = join_public_guild(&app, &joiner_b, &guild_id).await?;
    assert_eq!(joined["member_count"], json!(3), "second join: {joined}");

    // Re-joining as an existing member hits the early-return path; the count
    // must reflect reality rather than incrementing again.
    let rejoined = join_public_guild(&app, &joiner_a, &guild_id).await?;
    assert_eq!(
        rejoined["member_count"],
        json!(3),
        "idempotent re-join must not inflate the count: {rejoined}"
    );
    Ok(())
}

/// Failure injection on the update path. With the members table renamed away,
/// the owner still passes every authorization step (permission computation
/// short-circuits for the owner), so the member-count read is the statement
/// that fails. The route must surface a server error — never a 200 with a
/// fabricated `member_count: 0` — and because the count is read before the
/// write, the rename must not have committed.
#[tokio::test]
async fn update_guild_count_failure_surfaces_as_server_error() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "owner", "OwnerPass123!").await?;

    let guild_id = create_guild(&app, &owner, "Fragile Guild").await?;

    sqlx::query("ALTER TABLE members RENAME TO members_broken")
        .execute(&app.db)
        .await?;

    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "name": "Should Not Stick" })),
            Some(&owner),
        )?,
    )
    .await?;
    assert!(
        status.is_server_error(),
        "update count failure must be a server error, got {status}: {body}"
    );

    sqlx::query("ALTER TABLE members_broken RENAME TO members")
        .execute(&app.db)
        .await?;

    let (status, guild) = dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}"),
            None,
            Some(&owner),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "get guild failed: {guild}");
    assert_eq!(
        guild["member_count"],
        json!(1),
        "count after recovery: {guild}"
    );
    assert_eq!(
        guild["name"],
        json!("Fragile Guild"),
        "rejected update must not have committed: {guild}"
    );
    Ok(())
}
