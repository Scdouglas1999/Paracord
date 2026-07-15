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
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    owner_token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let owner_token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "owner",
            "OwnerPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            owner_token,
            _test_app: test_app,
        })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"]
            .as_str()
            .context("user id should be string")?
            .parse::<i64>()?)
    }

    async fn create_guild(&self, name: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
                &self.owner_token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "create guild failed: {payload}"
        );
        Ok(payload["id"]
            .as_str()
            .context("guild id should be string")?
            .parse::<i64>()?)
    }

    /// Create an additional authenticated user and join them to `guild_id`.
    async fn add_member(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
        Ok((token, uid))
    }
}

/// Create a role as the owner with an explicit permission bitset.
async fn create_role_as_owner(
    ctx: &TestContext,
    guild_id: i64,
    name: &str,
    permissions: i64,
) -> anyhow::Result<Value> {
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": name, "permissions": permissions })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create role failed: {payload}");
    Ok(payload)
}

#[tokio::test]
async fn sequentially_created_roles_get_distinct_ordered_positions() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Positions Guild").await?;

    let first = create_role_as_owner(&ctx, guild_id, "First", 0).await?;
    let second = create_role_as_owner(&ctx, guild_id, "Second", 0).await?;

    let pos_first = first["position"].as_i64().context("position missing")?;
    let pos_second = second["position"].as_i64().context("position missing")?;

    // @everyone sits at position 0, so the two new roles must be strictly above
    // it and above one another.
    assert!(
        pos_first >= 1,
        "first role position should be >= 1: {first}"
    );
    assert_ne!(
        pos_first, pos_second,
        "sequential roles must have distinct positions"
    );
    assert!(
        pos_second > pos_first,
        "second role should be ordered above the first"
    );
    Ok(())
}

#[tokio::test]
async fn manage_roles_holder_can_create_and_edit_lower_role() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Manager Guild").await?;

    // A manager role that grants MANAGE_ROLES but not ADMINISTRATOR.
    let manager_role =
        create_role_as_owner(&ctx, guild_id, "Manager", Permissions::MANAGE_ROLES.bits()).await?;
    let manager_role_id: i64 = manager_role["id"].as_str().unwrap().parse()?;

    let (manager_token, manager_uid) = ctx.add_member("manager").await?;
    paracord_db::members::add_member(&ctx.db, manager_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, manager_uid, guild_id, manager_role_id).await?;

    // Manager (non-admin) can create a role.
    let (status, created) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": "Peon", "permissions": 0 })),
            &manager_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "manager create role failed: {created}"
    );
    let created_id = created["id"].as_str().unwrap().to_string();
    // The manager-created role must land strictly below the manager's top role.
    let manager_pos = manager_role["position"].as_i64().unwrap();
    assert!(
        created["position"].as_i64().unwrap() < manager_pos,
        "manager-created role must be below manager's top role: {created}"
    );

    // Manager can edit that lower role.
    let (status, edited) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/roles/{created_id}"),
            Some(json!({ "name": "Peon2" })),
            &manager_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "manager edit role failed: {edited}");
    assert_eq!(edited["name"].as_str(), Some("Peon2"));
    Ok(())
}

#[tokio::test]
async fn manager_cannot_grant_permissions_they_lack() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Escalation Guild").await?;

    // Manager has MANAGE_ROLES but not BAN_MEMBERS.
    let manager_role =
        create_role_as_owner(&ctx, guild_id, "Manager", Permissions::MANAGE_ROLES.bits()).await?;
    let manager_role_id: i64 = manager_role["id"].as_str().unwrap().parse()?;

    let (manager_token, manager_uid) = ctx.add_member("manager").await?;
    paracord_db::members::add_member(&ctx.db, manager_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, manager_uid, guild_id, manager_role_id).await?;

    // Attempt to create a role granting a permission the manager does not hold.
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": "Overlord", "permissions": Permissions::BAN_MEMBERS.bits() })),
            &manager_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "manager should not grant perms they lack: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn manager_cannot_edit_role_at_or_above_top_role() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Hierarchy Guild").await?;

    // Positions are assigned in creation order: "Lower" (created first) sits
    // below "Upper" (created second). The manager holds "Lower", so its top role
    // is beneath "Upper".
    let lower_role =
        create_role_as_owner(&ctx, guild_id, "Lower", Permissions::MANAGE_ROLES.bits()).await?;
    let lower_role_id: i64 = lower_role["id"].as_str().unwrap().parse()?;
    let upper_role =
        create_role_as_owner(&ctx, guild_id, "Upper", Permissions::MANAGE_ROLES.bits()).await?;
    let upper_role_id = upper_role["id"].as_str().unwrap().to_string();
    assert!(
        upper_role["position"].as_i64().unwrap() > lower_role["position"].as_i64().unwrap(),
        "Upper must be positioned above Lower"
    );

    let (manager_token, manager_uid) = ctx.add_member("manager").await?;
    paracord_db::members::add_member(&ctx.db, manager_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, manager_uid, guild_id, lower_role_id).await?;

    // Editing "Upper" (at/above the actor's top role) must be forbidden.
    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/roles/{upper_role_id}"),
            Some(json!({ "name": "Hacked" })),
            &manager_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "manager must not edit a role at/above their top role: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn non_owner_cannot_assign_role_at_or_above_top_role() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Assign Guild").await?;

    // The member-roles branch requires ADMINISTRATOR to reach the hierarchy
    // check, so the actor holds an ADMINISTRATOR role ("AdminLow"). "High" is
    // created afterwards so it is positioned above the actor's top role.
    let admin_low = create_role_as_owner(
        &ctx,
        guild_id,
        "AdminLow",
        Permissions::ADMINISTRATOR.bits(),
    )
    .await?;
    let admin_low_id: i64 = admin_low["id"].as_str().unwrap().parse()?;
    let high_role = create_role_as_owner(&ctx, guild_id, "High", 0).await?;
    let high_role_id = high_role["id"].as_str().unwrap().to_string();
    assert!(
        high_role["position"].as_i64().unwrap() > admin_low["position"].as_i64().unwrap(),
        "High must be positioned above AdminLow"
    );

    let (admin_token, admin_uid) = ctx.add_member("adminlow").await?;
    paracord_db::members::add_member(&ctx.db, admin_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, admin_uid, guild_id, admin_low_id).await?;

    let (_target_token, target_uid) = ctx.add_member("target").await?;
    paracord_db::members::add_member(&ctx.db, target_uid, guild_id).await?;

    // Assigning "High" (above the actor's top role) to a member must be blocked.
    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{target_uid}"),
            Some(json!({ "roles": [high_role_id] })),
            &admin_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "actor must not assign a role at/above their top role: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn non_owner_cannot_strip_role_at_or_above_top_role() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Demote Guild").await?;

    // The actor holds an ADMINISTRATOR role ("AdminLow") so it satisfies the
    // MANAGE_ROLES gate, but "High" is created afterwards so it is positioned
    // above the actor's top role.
    let admin_low = create_role_as_owner(
        &ctx,
        guild_id,
        "AdminLow",
        Permissions::ADMINISTRATOR.bits(),
    )
    .await?;
    let admin_low_id: i64 = admin_low["id"].as_str().unwrap().parse()?;
    let high_role = create_role_as_owner(&ctx, guild_id, "High", 0).await?;
    let high_role_id: i64 = high_role["id"].as_str().unwrap().parse()?;
    assert!(
        high_role["position"].as_i64().unwrap() > admin_low["position"].as_i64().unwrap(),
        "High must be positioned above AdminLow"
    );

    let (admin_token, admin_uid) = ctx.add_member("adminlow").await?;
    paracord_db::members::add_member(&ctx.db, admin_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, admin_uid, guild_id, admin_low_id).await?;

    // The target already holds the superior "High" role.
    let (_target_token, target_uid) = ctx.add_member("target").await?;
    paracord_db::members::add_member(&ctx.db, target_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, target_uid, guild_id, high_role_id).await?;

    // Submitting a roles array that omits "High" would strip it. Because "High"
    // is at/above the actor's top role, removal must be blocked (hierarchy is
    // enforced on removal, not only on assignment).
    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{target_uid}"),
            Some(json!({ "roles": [] })),
            &admin_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "actor must not strip a role at/above their top role: {payload}"
    );

    // The superior role must survive the rejected request.
    let roles = paracord_db::roles::get_member_roles(&ctx.db, target_uid, guild_id).await?;
    assert!(
        roles.iter().any(|r| r.id == high_role_id),
        "target must retain the High role after the rejected strip"
    );
    Ok(())
}

#[tokio::test]
async fn update_member_on_non_member_target_404s() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("NonMember Guild").await?;

    // A registered user who never joined the guild.
    let (_stranger_token, stranger_uid) = ctx.add_member("stranger").await?;

    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{stranger_uid}"),
            Some(json!({ "nick": "ShouldFail" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "updating a non-member target must 404: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn failed_role_change_does_not_apply_nick() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Atomic Guild").await?;

    // Target member.
    let (_target_token, target_uid) = ctx.add_member("victim").await?;
    paracord_db::members::add_member(&ctx.db, target_uid, guild_id).await?;

    // A non-admin actor tries to set a nick AND change roles in one request. The
    // role change requires ADMINISTRATOR, so the whole request must be rejected
    // and the nick must NOT be persisted.
    let member_role = create_role_as_owner(
        &ctx,
        guild_id,
        "Nicknamer",
        Permissions::MANAGE_NICKNAMES.bits(),
    )
    .await?;
    let member_role_id: i64 = member_role["id"].as_str().unwrap().parse()?;
    let (actor_token, actor_uid) = ctx.add_member("nickactor").await?;
    paracord_db::members::add_member(&ctx.db, actor_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, actor_uid, guild_id, member_role_id).await?;

    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{target_uid}"),
            Some(json!({ "nick": "PartiallyApplied", "roles": [member_role_id.to_string()] })),
            &actor_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "non-admin role change must be rejected: {payload}"
    );

    // The nickname must not have been applied.
    let member = paracord_db::members::get_member(&ctx.db, target_uid, guild_id)
        .await?
        .expect("target should still be a member");
    assert_ne!(
        member.nick.as_deref(),
        Some("PartiallyApplied"),
        "nick must not be applied when a later authz branch fails"
    );
    Ok(())
}

#[tokio::test]
async fn owner_retains_full_role_management() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Owner Guild").await?;

    // Owner can create a role granting ADMINISTRATOR.
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": "SuperAdmin", "permissions": Permissions::ADMINISTRATOR.bits() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "owner create admin role failed: {payload}"
    );
    Ok(())
}
