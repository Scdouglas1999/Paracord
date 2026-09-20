//! The server is the only party that can say who is currently in a group.
//!
//! A group sender key is readable by everybody it was wrapped to, so publishing
//! one against a roster that has since lost a member hands the group key to
//! somebody who has left. A client cannot settle that on its own — its roster is
//! whatever it was last told — so the publish names the membership it was minted
//! against and the server, which owns `dm_recipients`, refuses it if that has
//! moved.

mod common;

use anyhow::Context;
use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
};
use serde_json::{json, Value};

struct Ctx {
    app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        Ok(Self {
            app: build_test_app(Default::default()).await?,
        })
    }

    async fn call(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(
            &self.app.app,
            build_json_request(method, path, body, Some(token))?,
        )
        .await
    }

    async fn user(&self, name: &str) -> anyhow::Result<(String, i64)> {
        let token = create_authenticated_user_token(
            &self.app.db,
            &self.app.jwt_secret,
            name,
            "GroupPass123!",
        )
        .await?;
        let (status, body) = self
            .call(&token, Method::GET, "/api/v1/users/@me", None)
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let id = body["id"].as_str().context("user id")?.parse()?;
        Ok((token, id))
    }
}

fn envelope(recipient_id: i64) -> Value {
    json!({
        "recipient_id": recipient_id.to_string(),
        "ciphertext": "Y2lwaGVydGV4dA==",
        "header": "{\"v\":3,\"nonce\":\"bm9uY2Vub25jZW4=\"}",
    })
}

/// Build a three-person group and return (owner token, channel id, version, members).
async fn group_of_three(ctx: &Ctx) -> anyhow::Result<(String, String, String, Vec<i64>)> {
    let (owner_token, owner_id) = ctx.user("groupowner").await?;
    let (_, bob_id) = ctx.user("groupbob").await?;
    let (_, carol_id) = ctx.user("groupcarol").await?;
    for peer in [bob_id, carol_id] {
        paracord_db::relationships::create_relationship(&ctx.app.db, owner_id, peer, 1).await?;
    }

    let (status, payload) = ctx
        .call(
            &owner_token,
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [bob_id.to_string(), carol_id.to_string()],
                "name": "Three of us",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{payload}");

    let channel_id = payload["id"].as_str().context("channel id")?.to_string();
    let version = payload["members_version"]
        .as_str()
        .context("a group DM must name its membership")?
        .to_string();
    Ok((
        owner_token,
        channel_id,
        version,
        vec![owner_id, bob_id, carol_id],
    ))
}

#[tokio::test]
async fn publishing_against_the_current_membership_succeeds() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (token, channel_id, version, members) = group_of_three(&ctx).await?;

    let (status, payload) = ctx
        .call(
            &token,
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            Some(json!({
                "epoch": 0,
                "members_version": version,
                "envelopes": [envelope(members[1]), envelope(members[2])],
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{payload}");
    Ok(())
}

#[tokio::test]
async fn publishing_against_a_departed_members_roster_is_refused() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (token, channel_id, version, members) = group_of_three(&ctx).await?;
    let carol = members[2];

    // Carol leaves. The publisher still holds the version it read before that,
    // and a key minted against it would be one Carol could also read.
    let (status, payload) = ctx
        .call(
            &token,
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/recipients/{carol}"),
            None,
        )
        .await?;
    assert!(
        status.is_success(),
        "removing a group recipient failed: {status} {payload}"
    );

    let (status, payload) = ctx
        .call(
            &token,
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            Some(json!({
                "epoch": 1,
                "members_version": version,
                "envelopes": [envelope(members[1])],
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a key minted against a stale roster must be refused: {payload}"
    );

    // Nothing was stored, so no key exists that the departed member could have
    // been handed.
    let pending = paracord_db::group_e2ee::list_pending_for_recipient(
        &ctx.app.db,
        channel_id.parse::<i64>()?,
        members[1],
        None,
    )
    .await?;
    assert!(
        pending.is_empty(),
        "a refused publish must store nothing: {pending:?}"
    );
    Ok(())
}

#[tokio::test]
async fn the_refusal_names_the_version_that_would_have_worked() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (token, channel_id, _, members) = group_of_three(&ctx).await?;

    let (status, payload) = ctx
        .call(
            &token,
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            Some(json!({
                "epoch": 0,
                "members_version": "not-the-current-one",
                "envelopes": [envelope(members[1])],
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT, "{payload}");

    // The reader route reports the same value, so a client that was refused can
    // mint against the truth instead of guessing at it.
    let (status, keys) = ctx
        .call(
            &token,
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{keys}");
    let current = keys["members_version"]
        .as_str()
        .context("the reader route must report the membership version")?;
    assert!(
        payload.to_string().contains(current),
        "the refusal must name the current version so the client can retry: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn a_publish_that_names_no_membership_is_refused() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (token, channel_id, _, members) = group_of_three(&ctx).await?;

    // An older client cannot promise it wrapped the key to the right people.
    // This is the one endpoint where being wrong hands out the group key.
    let (status, payload) = ctx
        .call(
            &token,
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            Some(json!({
                "epoch": 0,
                "envelopes": [envelope(members[1])],
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an undeclared membership must be refused: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn adding_a_member_moves_the_version() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (token, channel_id, version, members) = group_of_three(&ctx).await?;
    let (_, dave_id) = ctx.user("groupdave").await?;
    paracord_db::relationships::create_relationship(&ctx.app.db, members[0], dave_id, 1).await?;

    let (status, payload) = ctx
        .call(
            &token,
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/recipients/{dave_id}"),
            None,
        )
        .await?;
    assert!(status.is_success(), "adding a recipient failed: {payload}");

    let (status, keys) = ctx
        .call(
            &token,
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{keys}");
    assert_ne!(
        keys["members_version"].as_str().context("version")?,
        version,
        "a joining member must move the membership version"
    );
    Ok(())
}
