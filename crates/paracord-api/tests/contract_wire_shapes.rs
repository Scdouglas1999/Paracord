//! Wire-contract assertions for the typed REST responses covered by
//! `paracord-contracts`: users (`@me`, settings, public profile),
//! relationships, invites, and emojis.
//!
//! These tests assert the *serialized* shape — decimal-string snowflakes,
//! required-but-nullable fields, summary vs detail bodies — rather than
//! deserializing into the Rust types, so a drift between the struct and its
//! Serde contract fails here. Like the rest of the suite they run on in-memory
//! SQLite by default and on PostgreSQL when `PARACORD_TEST_POSTGRES_URL` is
//! set, so the shape is verified on both engines.

mod common;

use anyhow::Context;
use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn request_json(
    app: &axum::Router,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let request = build_json_request(method, path, body, Some(token))?;
    dispatch_json(app, request).await
}

/// Assert a snowflake is serialized as its decimal string, never a number.
fn assert_snowflake(value: &Value, field: &str) -> anyhow::Result<String> {
    let s = value
        .as_str()
        .with_context(|| format!("{field} should serialize as a decimal string, got {value}"))?;
    s.parse::<i64>()
        .with_context(|| format!("{field} should be a parseable snowflake, got {s}"))?;
    Ok(s.to_string())
}

/// Every key in `fields` must exist (nullable fields count — presence is what
/// the contract promises, `null` is a valid value for them).
fn assert_required_keys(object: &Value, fields: &[&str], ctx: &str) -> anyhow::Result<()> {
    let map = object
        .as_object()
        .with_context(|| format!("{ctx} should be a JSON object, got {object}"))?;
    for field in fields {
        if !map.contains_key(*field) {
            anyhow::bail!("{ctx} is missing required field '{field}': {object}");
        }
    }
    Ok(())
}

async fn new_app() -> anyhow::Result<TestApp> {
    build_test_app(TestAppOptions::default()).await
}

async fn new_user(app: &TestApp, prefix: &str) -> anyhow::Result<(String, String)> {
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, prefix, "ContractPass123!")
            .await?;
    let (status, me) =
        request_json(&app.app, &token, Method::GET, "/api/v1/users/@me", None).await?;
    assert_eq!(status, StatusCode::OK, "could not read new user: {me}");
    let id = me["id"]
        .as_str()
        .context("user id should be a string")?
        .to_string();
    Ok((token, id))
}

/// Create a guild with one channel; returns (guild_id, channel_id).
async fn new_guild(app: &TestApp, token: &str) -> anyhow::Result<(String, String)> {
    let (status, guild) = request_json(
        &app.app,
        token,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({ "name": "Contract Guild", "icon": Value::Null })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected guild payload: {guild}"
    );
    let guild_id = guild["id"]
        .as_str()
        .context("guild id should be a string")?
        .to_string();

    let (status, channel) = request_json(
        &app.app,
        token,
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        Some(json!({
            "name": "contracts",
            "channel_type": 0,
            "parent_id": Value::Null,
            "required_role_ids": Value::Null,
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected channel payload: {channel}"
    );
    let channel_id = channel["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string();
    Ok((guild_id, channel_id))
}

#[tokio::test]
async fn current_user_and_update_match_contract() -> anyhow::Result<()> {
    let app = new_app().await?;
    let (token, user_id) = new_user(&app, "contract_me").await?;

    let (status, me) =
        request_json(&app.app, &token, Method::GET, "/api/v1/users/@me", None).await?;
    assert_eq!(status, StatusCode::OK, "unexpected /users/@me: {me}");

    assert_eq!(assert_snowflake(&me["id"], "id")?, user_id);
    assert!(me["username"].is_string());
    assert!(
        me["discriminator"].is_number(),
        "discriminator should be a number"
    );
    for field in [
        "display_name",
        "avatar_hash",
        "banner_hash",
        "bio",
        "pronouns",
        "public_key",
    ] {
        assert!(
            me.get(field)
                .map(|v| v.is_null() || v.is_string())
                .unwrap_or(false),
            "{field} must be present and null-or-string: {me}"
        );
    }
    assert!(me["linked_accounts"].is_array());
    assert!(me["flags"].is_number());
    assert!(me["bot"].is_boolean());
    assert!(me["system"].is_boolean());
    assert!(me["created_at"].is_string());
    assert!(me["email"].is_string());
    assert!(me["email_verified"].is_boolean());
    assert!(me["has_public_key"].is_boolean());

    let (status, updated) = request_json(
        &app.app,
        &token,
        Method::PATCH,
        "/api/v1/users/@me",
        Some(json!({ "display_name": "Contract Tester", "bio": "wire shape" })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected PATCH /users/@me: {updated}"
    );
    assert_eq!(assert_snowflake(&updated["id"], "id")?, user_id);
    assert_eq!(updated["display_name"], "Contract Tester");
    assert_eq!(updated["bio"], "wire shape");
    assert!(updated["email"].is_string());
    assert_required_keys(
        &updated,
        &[
            "username",
            "discriminator",
            "avatar_hash",
            "banner_hash",
            "flags",
            "bot",
            "system",
            "created_at",
        ],
        "UpdatedCurrentUser",
    )?;

    // Omitted request fields must not clear stored values.
    let (status, untouched) = request_json(
        &app.app,
        &token,
        Method::PATCH,
        "/api/v1/users/@me",
        Some(json!({})),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "empty PATCH should succeed: {untouched}"
    );
    assert_eq!(untouched["display_name"], "Contract Tester");
    assert_eq!(untouched["bio"], "wire shape");
    Ok(())
}

#[tokio::test]
async fn user_settings_match_contract() -> anyhow::Result<()> {
    let app = new_app().await?;
    let (token, user_id) = new_user(&app, "contract_settings").await?;

    let (status, settings) = request_json(
        &app.app,
        &token,
        Method::GET,
        "/api/v1/users/@me/settings",
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected settings: {settings}");
    assert_eq!(assert_snowflake(&settings["user_id"], "user_id")?, user_id);
    // Defaults are synthesized when no row exists; the shape is identical.
    assert!(settings["theme"].is_string());
    assert!(settings["locale"].is_string());
    assert!(settings["status"].is_string());
    assert!(settings["message_display_compact"].is_boolean());
    assert!(settings["crypto_auth_enabled"].is_boolean());
    for field in ["custom_css", "custom_status"] {
        assert!(
            settings
                .get(field)
                .map(|v| v.is_null() || v.is_string())
                .unwrap_or(false),
            "{field} must be present and null-or-string: {settings}"
        );
    }
    assert!(settings["notifications"].is_object());
    assert!(settings["keybinds"].is_object());

    let (status, updated) = request_json(
        &app.app,
        &token,
        Method::PATCH,
        "/api/v1/users/@me/settings",
        Some(json!({
            "theme": "amoled",
            "status": "idle",
            "custom_status": "testing wires",
            "notifications": { "muted": true },
            "message_display_compact": true
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected PATCH settings: {updated}"
    );
    assert_eq!(updated["theme"], "amoled");
    assert_eq!(updated["status"], "idle");
    assert_eq!(updated["custom_status"], "testing wires");
    assert_eq!(updated["notifications"]["muted"], true);
    assert_eq!(updated["message_display_compact"], true);

    // Omitted fields keep their stored values (PATCH semantics, not PUT).
    let (status, partial) = request_json(
        &app.app,
        &token,
        Method::PATCH,
        "/api/v1/users/@me/settings",
        Some(json!({ "locale": "fr-FR" })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "partial PATCH should succeed: {partial}"
    );
    assert_eq!(partial["locale"], "fr-FR");
    assert_eq!(partial["theme"], "amoled");
    assert_eq!(partial["status"], "idle");
    Ok(())
}

#[tokio::test]
async fn public_profile_matches_contract() -> anyhow::Result<()> {
    let app = new_app().await?;
    let (viewer_token, _viewer_id) = new_user(&app, "contract_viewer").await?;
    let (_subject_token, subject_id) = new_user(&app, "contract_subject").await?;

    let (status, profile) = request_json(
        &app.app,
        &viewer_token,
        Method::GET,
        &format!("/api/v1/users/{subject_id}/profile"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected profile: {profile}");

    let user = &profile["user"];
    assert_eq!(assert_snowflake(&user["id"], "user.id")?, subject_id);
    assert!(user["username"].is_string());
    assert!(user["discriminator"].is_number());
    assert!(user["flags"].is_number());
    assert!(user["bot"].is_boolean());
    assert!(user["system"].is_boolean());
    assert!(user["created_at"].is_string());
    for field in [
        "display_name",
        "avatar_hash",
        "banner_hash",
        "bio",
        "pronouns",
    ] {
        assert!(
            user.get(field)
                .map(|v| v.is_null() || v.is_string())
                .unwrap_or(false),
            "user.{field} must be present and null-or-string: {profile}"
        );
    }
    assert!(user["linked_accounts"].is_array());
    assert!(profile["roles"].is_array());
    assert!(profile["mutual_guilds"].is_array());
    assert!(profile["mutual_friends"].is_array());
    assert!(profile["created_at"].is_string());
    Ok(())
}

#[tokio::test]
async fn relationship_list_matches_contract() -> anyhow::Result<()> {
    let app = new_app().await?;
    let (alice_token, alice_id) = new_user(&app, "contract_alice").await?;
    let (bob_token, bob_id) = new_user(&app, "contract_bob").await?;

    // Empty list is a valid RelationshipList.
    let (status, empty) = request_json(
        &app.app,
        &alice_token,
        Method::GET,
        "/api/v1/users/@me/relationships",
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(empty
        .as_array()
        .context("relationships should be an array")?
        .is_empty());

    // A request without user_id or username is a 400.
    let (status, bad) = request_json(
        &app.app,
        &alice_token,
        Method::POST,
        "/api/v1/users/@me/relationships",
        Some(json!({ "type": 1 })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "missing target should fail: {bad}"
    );

    // Alice -> Bob friend request (pending outgoing), then Bob accepts.
    let (status, sent) = request_json(
        &app.app,
        &alice_token,
        Method::POST,
        "/api/v1/users/@me/relationships",
        Some(json!({ "user_id": bob_id, "type": 1 })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "friend request failed: {sent}"
    );

    let (status, bob_rels) = request_json(
        &app.app,
        &bob_token,
        Method::GET,
        "/api/v1/users/@me/relationships",
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let incoming = bob_rels
        .as_array()
        .context("relationships should be an array")?
        .iter()
        .find(|r| r["target_id"].as_str() == Some(alice_id.as_str()))
        .context("bob should see alice's pending request")?
        .clone();
    assert_eq!(
        incoming["type"], 3,
        "incoming request should serialize type 3"
    );
    assert_eq!(incoming["rel_type"], 3);

    let (status, accepted) = request_json(
        &app.app,
        &bob_token,
        Method::PUT,
        &format!("/api/v1/users/@me/relationships/{alice_id}"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "accept failed: {accepted}");

    let (status, rels) = request_json(
        &app.app,
        &alice_token,
        Method::GET,
        "/api/v1/users/@me/relationships",
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected relationships: {rels}");
    let entry = rels
        .as_array()
        .context("relationships should be an array")?
        .iter()
        .find(|r| r["target_id"].as_str() == Some(bob_id.as_str()))
        .context("alice should list bob as a friend")?;

    // Composite id "<user>:<target>", both kinds of type field, string ids.
    assert_eq!(entry["id"], format!("{alice_id}:{bob_id}"));
    assert_eq!(entry["type"], 1);
    assert_eq!(entry["rel_type"], 1);
    assert_eq!(assert_snowflake(&entry["user_id"], "user_id")?, alice_id);
    assert_eq!(assert_snowflake(&entry["target_id"], "target_id")?, bob_id);
    assert!(entry["created_at"].is_string());
    chrono::DateTime::parse_from_rfc3339(entry["created_at"].as_str().unwrap())
        .context("created_at should be RFC 3339")?;

    let nested = &entry["user"];
    assert_eq!(assert_snowflake(&nested["id"], "user.id")?, bob_id);
    assert!(nested["username"].is_string());
    assert!(nested["discriminator"].is_number());
    for field in ["display_name", "avatar_hash"] {
        assert!(
            nested
                .get(field)
                .map(|v| v.is_null() || v.is_string())
                .unwrap_or(false),
            "user.{field} must be present and null-or-string: {nested}"
        );
    }

    // Blocks ride the same contract.
    let (carol_token, carol_id) = new_user(&app, "contract_carol").await?;
    let (status, blocked) = request_json(
        &app.app,
        &alice_token,
        Method::POST,
        "/api/v1/users/@me/relationships",
        Some(json!({ "user_id": carol_id, "type": 2 })),
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "block failed: {blocked}");
    let (status, rels) = request_json(
        &app.app,
        &alice_token,
        Method::GET,
        "/api/v1/users/@me/relationships",
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let block_entry = rels
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["target_id"].as_str() == Some(carol_id.as_str()))
        .context("alice should list carol as blocked")?;
    assert_eq!(block_entry["type"], 2);
    assert_eq!(block_entry["rel_type"], 2);

    // Carol sees nothing from Alice — blocks don't leak a reverse row.
    let (status, carol_rels) = request_json(
        &app.app,
        &carol_token,
        Method::GET,
        "/api/v1/users/@me/relationships",
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(carol_rels
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["target_id"].as_str() != Some(alice_id.as_str())));
    Ok(())
}

#[tokio::test]
async fn invite_responses_match_contract() -> anyhow::Result<()> {
    let app = new_app().await?;
    let (owner_token, _owner_id) = new_user(&app, "contract_invite_owner").await?;
    let (joiner_token, _joiner_id) = new_user(&app, "contract_joiner").await?;
    let (guild_id, channel_id) = new_guild(&app, &owner_token).await?;

    let (status, invite) = request_json(
        &app.app,
        &owner_token,
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/invites"),
        Some(json!({ "max_uses": 5, "max_age": 3600 })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create invite must be 201: {invite}"
    );

    // GuildInvite: decimal-string ids, nullable inviter, numeric limits.
    assert!(invite["code"].is_string());
    assert_eq!(assert_snowflake(&invite["guild_id"], "guild_id")?, guild_id);
    assert_eq!(
        assert_snowflake(&invite["channel_id"], "channel_id")?,
        channel_id
    );
    assert!(
        invite
            .get("inviter_id")
            .map(|v| v.is_null() || v.is_string())
            .unwrap_or(false),
        "inviter_id must be present and null-or-string: {invite}"
    );
    assert_eq!(invite["max_uses"], 5);
    assert_eq!(invite["max_age"], 3600);
    assert_eq!(invite["uses"], 0);
    assert!(invite["created_at"].is_string());
    let code = invite["code"].as_str().unwrap().to_string();

    // GET /invites/{code} resolves to InvitePreview.
    let (status, preview) = request_json(
        &app.app,
        &joiner_token,
        Method::GET,
        &format!("/api/v1/invites/{code}"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected invite preview: {preview}"
    );
    assert_eq!(preview["code"], code);
    let guild = &preview["guild"];
    assert!(
        guild.is_object(),
        "guild preview should be present: {preview}"
    );
    assert_eq!(assert_snowflake(&guild["id"], "guild.id")?, guild_id);
    assert!(guild["name"].is_string());
    assert!(
        guild
            .get("icon_hash")
            .map(|v| v.is_null() || v.is_string())
            .unwrap_or(false),
        "icon_hash must be present and null-or-string: {guild}"
    );
    assert!(guild["member_count"].is_number());

    // GET /guilds/{id}/invites lists the same GuildInvite shape.
    let (status, list) = request_json(
        &app.app,
        &owner_token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/invites"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected invite list: {list}");
    let listed = list
        .as_array()
        .context("invite list should be an array")?
        .iter()
        .find(|i| i["code"].as_str() == Some(code.as_str()))
        .context("created invite should be listed")?;
    assert_eq!(assert_snowflake(&listed["guild_id"], "guild_id")?, guild_id);
    assert_required_keys(
        listed,
        &[
            "channel_id",
            "inviter_id",
            "max_uses",
            "uses",
            "max_age",
            "created_at",
        ],
        "GuildInvite",
    )?;

    // POST /invites/{code} with no body still accepts (body is optional) and
    // returns InviteAcceptResponse.
    let request = build_json_request(
        Method::POST,
        &format!("/api/v1/invites/{code}"),
        None,
        Some(&joiner_token),
    )?;
    let (status, accepted) = dispatch_json(&app.app, request).await?;
    assert_eq!(status, StatusCode::OK, "accept invite failed: {accepted}");
    let accepted_guild = &accepted["guild"];
    assert!(
        accepted_guild.is_object(),
        "accept should return {{guild}}: {accepted}"
    );
    assert_eq!(
        assert_snowflake(&accepted_guild["id"], "guild.id")?,
        guild_id
    );
    assert!(accepted_guild["name"].is_string());
    assert!(accepted_guild["owner_id"].is_string());
    assert!(accepted_guild["created_at"].is_string());
    assert!(accepted_guild["member_count"].is_number());
    for field in ["description", "icon_hash", "default_channel_id"] {
        assert!(
            accepted_guild
                .get(field)
                .map(|v| v.is_null() || v.is_string())
                .unwrap_or(false),
            "guild.{field} must be present and null-or-string: {accepted_guild}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn emoji_responses_match_contract() -> anyhow::Result<()> {
    let app = new_app().await?;
    let (owner_token, owner_id) = new_user(&app, "contract_emoji_owner").await?;
    let (guild_id, _channel_id) = new_guild(&app, &owner_token).await?;

    let (status, empty) = request_json(
        &app.app,
        &owner_token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/emojis"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(empty
        .as_array()
        .context("emojis should be an array")?
        .is_empty());

    // Multipart create: name + a PNG-signature image part.
    let boundary = "contractboundary";
    let png = {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0u8; 32]);
        bytes
    };
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\npartyparrot\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"e.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
    body.extend_from_slice(&png);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/v1/guilds/{guild_id}/emojis"))
        .header(header::AUTHORIZATION, format!("Bearer {owner_token}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))?;
    let response = app.app.clone().oneshot(request).await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let created: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("emoji create should return JSON, got {bytes:?}"))?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create emoji must be 201: {created}"
    );

    let assert_emoji = |emoji: &Value| -> anyhow::Result<()> {
        assert!(emoji["id"].is_string());
        assert_snowflake(&emoji["id"], "id")?;
        assert_eq!(assert_snowflake(&emoji["guild_id"], "guild_id")?, guild_id);
        assert_eq!(emoji["name"], "partyparrot");
        assert_eq!(emoji["animated"], false);
        assert!(
            emoji
                .get("creator_id")
                .map(|v| v.is_null() || v.is_string())
                .unwrap_or(false),
            "creator_id must be present and null-or-string: {emoji}"
        );
        assert_eq!(
            emoji["creator_id"]
                .as_str()
                .context("creator should be the uploader")?,
            owner_id
        );
        assert!(emoji["created_at"].is_string());
        Ok(())
    };
    assert_emoji(&created)?;
    let emoji_id = created["id"].as_str().unwrap().to_string();

    let (status, list) = request_json(
        &app.app,
        &owner_token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/emojis"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected emoji list: {list}");
    let listed = list
        .as_array()
        .context("emoji list should be an array")?
        .iter()
        .find(|e| e["id"].as_str() == Some(emoji_id.as_str()))
        .context("created emoji should be listed")?;
    assert_emoji(listed)?;

    let (status, renamed) = request_json(
        &app.app,
        &owner_token,
        Method::PATCH,
        &format!("/api/v1/guilds/{guild_id}/emojis/{emoji_id}"),
        Some(json!({ "name": "ultraparrot" })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected emoji update: {renamed}");
    assert_eq!(renamed["name"], "ultraparrot");
    assert_eq!(assert_snowflake(&renamed["id"], "id")?, emoji_id);
    assert_required_keys(
        &renamed,
        &["guild_id", "animated", "creator_id", "created_at"],
        "GuildEmoji",
    )?;

    // Name bounds are validated on the typed request body.
    let (status, bad) = request_json(
        &app.app,
        &owner_token,
        Method::PATCH,
        &format!("/api/v1/guilds/{guild_id}/emojis/{emoji_id}"),
        Some(json!({ "name": "" })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "empty name should fail: {bad}"
    );
    Ok(())
}
