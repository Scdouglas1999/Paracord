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

struct VoiceTestContext {
    app: Router,
    #[allow(dead_code)]
    db: paracord_db::DbPool,
    token: String,
    event_bus: paracord_core::events::EventBus,
    _test_app: TestApp,
}

impl VoiceTestContext {
    async fn new(native_media_enabled: bool, livekit_available: bool) -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            install_http_rate_limiter: true,
            jwt_secret: "voice-test-secret".to_string(),
            native_media_enabled,
            livekit_available,
            ..Default::default()
        })
        .await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "voicetest",
            "VoiceTestPass123!",
        )
        .await?;

        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            token,
            event_bus: test_app.event_bus.clone(),
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

    /// Record a directional friendship from the authenticated caller to `other_id`
    /// so the group-DM consent gate (friend-or-shared-guild) admits the recipient.
    async fn befriend(&self, other_id: i64) -> anyhow::Result<()> {
        let caller_id = paracord_core::auth::validate_token(&self.token, "voice-test-secret")?.sub;
        paracord_db::relationships::create_relationship(&self.db, caller_id, other_id, 1).await?;
        Ok(())
    }
}

async fn create_guild_and_voice_channel(
    ctx: &VoiceTestContext,
) -> anyhow::Result<(String, String)> {
    // Create a guild
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Voice Test Guild", "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "guild creation: {payload}");
    let guild_id = payload["id"]
        .as_str()
        .context("guild id should be a string")?
        .to_string();

    // Create a voice channel (channel_type=2)
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": "voice-test",
                "channel_type": 2,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "channel creation: {payload}");
    let channel_id = payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string();

    Ok((guild_id, channel_id))
}

async fn create_guild_and_stage_channel(
    ctx: &VoiceTestContext,
) -> anyhow::Result<(String, String, String)> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Stage Test Guild", "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "guild creation: {payload}");
    let guild_id = payload["id"].as_str().context("guild id")?.to_string();

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": "town-hall",
                "channel_type": 13,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "stage channel creation: {payload}"
    );
    let channel_id = payload["id"].as_str().context("channel id")?.to_string();

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/stage-instances",
            Some(json!({
                "channel_id": channel_id,
                "topic": "Release town hall",
                "privacy_level": 2,
            })),
        )
        .await?;
    if status != StatusCode::CREATED {
        let db_stage = paracord_db::stage_instances::get_stage_instance_by_channel(
            &ctx.db,
            channel_id.parse()?,
        )
        .await;
        anyhow::bail!("stage creation failed ({status}): {payload}; database row: {db_stage:?}");
    }
    let stage_id = payload["id"].as_str().context("stage id")?.to_string();
    Ok((guild_id, channel_id, stage_id))
}

async fn request_json_with_token(
    ctx: &VoiceTestContext,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let request = build_json_request(method, path, body, Some(token))?;
    dispatch_json(&ctx.app, request).await
}

#[tokio::test]
async fn stage_audience_can_raise_hand_and_moderator_can_promote() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, false).await?;
    let (guild_id, channel_id, stage_id) = create_guild_and_stage_channel(&ctx).await?;
    let guild_id_num: i64 = guild_id.parse()?;
    let channel_id_num: i64 = channel_id.parse()?;

    let audience_token = create_authenticated_user_token(
        &ctx.db,
        "voice-test-secret",
        "stageaudience",
        "StageAudiencePass123!",
    )
    .await?;
    let audience_id =
        paracord_core::auth::validate_token(&audience_token, "voice-test-secret")?.sub;
    paracord_db::members::add_member(&ctx.db, audience_id, guild_id_num).await?;

    let (status, join_payload) = request_json_with_token(
        &ctx,
        &audience_token,
        Method::GET,
        &format!("/api/v1/voice/{channel_id}/join"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "stage join: {join_payload}");
    assert_eq!(join_payload["suppress"], json!(true));

    let audience_state =
        paracord_db::voice_states::get_user_voice_state(&ctx.db, audience_id, Some(guild_id_num))
            .await?
            .context("audience voice state")?;
    assert_eq!(audience_state.channel_id, channel_id_num);
    assert!(audience_state.suppress);
    assert!(audience_state.request_to_speak_at.is_none());

    let (status, payload) = request_json_with_token(
        &ctx,
        &audience_token,
        Method::POST,
        &format!("/api/v1/stage-instances/{stage_id}/speaker-requests/@me"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "raise hand: {payload}");
    let requested_state =
        paracord_db::voice_states::get_user_voice_state(&ctx.db, audience_id, Some(guild_id_num))
            .await?
            .context("requested voice state")?;
    assert!(requested_state.request_to_speak_at.is_some());

    // A normal gateway voice-state sync (for example, deafening while waiting)
    // must accept stage channels and preserve both the audience role and hand raise.
    let (status, payload) = request_json_with_token(
        &ctx,
        &audience_token,
        Method::POST,
        "/api/v2/rt/commands",
        Some(json!({
            "command_id": "stage-audience-state-sync",
            "type": "voice_state_update",
            "payload": {
                "guild_id": guild_id,
                "channel_id": channel_id,
                "self_mute": true,
                "self_deaf": true,
                "self_video": false,
            }
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "stage state sync: {payload}");
    let synced_state =
        paracord_db::voice_states::get_user_voice_state(&ctx.db, audience_id, Some(guild_id_num))
            .await?
            .context("synced audience voice state")?;
    assert!(synced_state.suppress);
    assert!(synced_state.request_to_speak_at.is_some());

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/stage-instances/{stage_id}/speakers/{audience_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "promote speaker: {payload}");
    let promoted_state =
        paracord_db::voice_states::get_user_voice_state(&ctx.db, audience_id, Some(guild_id_num))
            .await?
            .context("promoted voice state")?;
    assert!(!promoted_state.suppress);
    assert!(promoted_state.request_to_speak_at.is_none());
    Ok(())
}

// ── Stage-instance GET is gated by VIEW_CHANNEL (info-disclosure regression) ──

#[tokio::test]
async fn stage_instance_get_requires_view_channel() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, false).await?;
    let (guild_id, channel_id, _stage_id) = create_guild_and_stage_channel(&ctx).await?;
    let guild_id_num: i64 = guild_id.parse()?;
    let channel_id_num: i64 = channel_id.parse()?;

    // A guild member who can view the stage channel reads the live instance.
    let member_token = create_authenticated_user_token(
        &ctx.db,
        "voice-test-secret",
        "stageviewer",
        "StageViewerPass123!",
    )
    .await?;
    let member_id = paracord_core::auth::validate_token(&member_token, "voice-test-secret")?.sub;
    paracord_db::members::add_member(&ctx.db, member_id, guild_id_num).await?;

    let (status, payload) = request_json_with_token(
        &ctx,
        &member_token,
        Method::GET,
        &format!("/api/v1/channels/{channel_id}/stage-instance"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "member with VIEW_CHANNEL should read the stage instance: {payload}"
    );
    assert_eq!(payload["channel_id"], json!(channel_id));

    // Deny VIEW_CHANNEL on this stage channel for the member via a member-scoped
    // permission overwrite. The member is still a guild member, so the old
    // `ensure_guild_member`-only gate would (incorrectly) still return the
    // instance; the new VIEW_CHANNEL gate must now forbid it.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        channel_id_num,
        member_id,
        paracord_core::permissions::OVERWRITE_TARGET_MEMBER,
        0,
        paracord_models::permissions::Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;

    let (status, payload) = request_json_with_token(
        &ctx,
        &member_token,
        Method::GET,
        &format!("/api/v1/channels/{channel_id}/stage-instance"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "member denied VIEW_CHANNEL must not read the stage instance: {payload}"
    );

    Ok(())
}

// ── Test D1: native=true + lk=true → native-only response with livekit_available ──

#[tokio::test]
async fn native_plus_livekit_returns_native_only_with_livekit_available() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, true).await?;
    let (_guild_id, channel_id) = create_guild_and_voice_channel(&ctx).await?;

    // Join via v1 GET (no ?fallback)
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/voice/{channel_id}/join"),
            None,
        )
        .await?;

    assert_eq!(status, StatusCode::OK, "voice join: {payload}");
    // Should be native media response
    assert_eq!(payload["native_media"], json!(true));
    assert!(
        payload["media_endpoint"].is_string(),
        "expected media_endpoint"
    );
    assert!(payload["media_token"].is_string(), "expected media_token");
    // Should indicate LiveKit is available as fallback
    assert_eq!(payload["livekit_available"], json!(true));
    // Should NOT contain LiveKit fields
    assert!(
        payload["token"].is_null(),
        "should not contain LiveKit token"
    );

    Ok(())
}

// ── Test D2: ?fallback=livekit routes to LiveKit path ──

#[tokio::test]
async fn fallback_livekit_query_routes_to_livekit_path() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, true).await?;
    let (_guild_id, channel_id) = create_guild_and_voice_channel(&ctx).await?;

    // Join with ?fallback=livekit — this will attempt the LiveKit path.
    // Without a real LiveKit server, the join_channel call to LiveKit will fail
    // with an internal error, but we can verify it doesn't return native media fields.
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/voice/{channel_id}/join?fallback=livekit"),
            None,
        )
        .await?;

    // The LiveKit join will fail (no real LiveKit server), resulting in 500.
    // The important thing is that it did NOT return native media fields.
    if status == StatusCode::OK {
        // If it somehow succeeded (unlikely without LiveKit), verify it's a LiveKit response
        assert!(payload["token"].is_string(), "expected LiveKit token");
        assert!(
            payload["native_media"].is_null(),
            "should not contain native_media in LiveKit fallback response"
        );
    } else {
        // Expected: 500 because LiveKit is not actually running.
        // This confirms the routing logic directed to the LiveKit branch.
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "expected 500 from LiveKit path (no server): {payload}"
        );
    }

    Ok(())
}

// ── Test D3: native=false + lk=true → LiveKit response ──

#[tokio::test]
async fn native_disabled_livekit_available_returns_livekit_response() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(false, true).await?;
    let (_guild_id, channel_id) = create_guild_and_voice_channel(&ctx).await?;

    // Without native media, the default join should go to LiveKit path.
    // Without a real LiveKit server, this will fail with 500.
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/voice/{channel_id}/join"),
            None,
        )
        .await?;

    // Should NOT be a native media response
    assert!(
        payload["native_media"].is_null(),
        "should not return native_media when native is disabled: {payload}"
    );

    if status == StatusCode::OK {
        // If LiveKit were somehow available, it would have LiveKit fields
        assert!(payload["token"].is_string(), "expected LiveKit token");
    } else {
        // Expected: 500 because there is no real LiveKit server
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "expected 500 from LiveKit path: {payload}"
        );
    }

    Ok(())
}

// ── Test: native=true + lk=false → native-only, livekit_available=false ──

#[tokio::test]
async fn native_only_no_livekit_returns_native_without_fallback() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, false).await?;
    let (_guild_id, channel_id) = create_guild_and_voice_channel(&ctx).await?;

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/voice/{channel_id}/join"),
            None,
        )
        .await?;

    assert_eq!(status, StatusCode::OK, "voice join: {payload}");
    assert_eq!(payload["native_media"], json!(true));
    assert_eq!(
        payload["livekit_available"],
        json!(false),
        "livekit_available should be false"
    );

    Ok(())
}

#[tokio::test]
async fn native_dm_voice_token_uses_revocable_zero_guild_room() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, false).await?;
    let recipient_id = paracord_util::snowflake::generate(1);
    paracord_db::users::create_user(
        &ctx.db,
        recipient_id,
        "dmvoicepeer",
        1,
        "dmvoicepeer@example.com",
        "hash",
    )
    .await?;
    ctx.befriend(recipient_id).await?;

    let (status, dm_payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_id.to_string()],
                "name": "Native DM Voice",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "group DM create: {dm_payload}");
    let channel_id = dm_payload["id"]
        .as_str()
        .context("group DM id should be a string")?
        .to_string();
    let expected_room = format!("0:{channel_id}");
    let mut events = ctx.event_bus.subscribe_system();

    let (status, join_payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/dms/{channel_id}/voice/join"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "DM voice join: {join_payload}");
    assert_eq!(join_payload["native_media"], json!(true));
    assert_eq!(join_payload["room_name"], json!(expected_room));
    let session_id = join_payload["session_id"]
        .as_str()
        .context("native DM voice join should return a session_id")?;
    let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .context("timed out waiting for native DM voice join event")??;
    assert_eq!(event.event_type, "VOICE_STATE_UPDATE");
    assert_eq!(event.guild_id, None);
    let mut targets = event
        .target_user_ids
        .clone()
        .context("DM voice events should target DM recipients")?;
    targets.sort_unstable();
    let (status, me_payload) = ctx
        .request_json(Method::GET, "/api/v1/users/@me", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "get current user: {me_payload}");
    let user_id = me_payload["id"]
        .as_str()
        .context("expected /users/@me id")?
        .parse::<i64>()?;
    let mut expected_targets = vec![recipient_id, user_id];
    expected_targets.sort_unstable();
    assert_eq!(targets, expected_targets);
    assert_eq!(event.payload["user_id"], json!(user_id.to_string()));
    assert_eq!(event.payload["channel_id"], json!(channel_id));
    assert_eq!(event.payload["session_id"], json!(session_id));

    let token = join_payload["media_token"]
        .as_str()
        .context("native DM voice join should return a media_token")?;
    let token_data = jsonwebtoken::decode::<serde_json::Value>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(b"voice-test-secret"),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )?;
    assert_eq!(token_data.claims["sid"], json!(session_id));
    assert_eq!(token_data.claims["room"], json!(expected_room));

    let state_after_join =
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, None)
            .await?
            .context("native DM voice join should create a revocable voice state")?;
    assert_eq!(state_after_join.session_id, session_id);
    assert_eq!(state_after_join.channel_id.to_string(), channel_id);

    let (status, leave_payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/dms/{channel_id}/voice/leave"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "DM voice leave should succeed: {leave_payload}"
    );
    let state_after_leave =
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, None).await?;
    assert!(
        state_after_leave.is_none(),
        "DM voice leave should revoke the media-token backing voice state"
    );

    Ok(())
}

#[tokio::test]
async fn dm_voice_leave_requires_membership_and_preserves_other_active_dm() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, false).await?;
    let recipient_one_id = paracord_util::snowflake::generate(1);
    paracord_db::users::create_user(
        &ctx.db,
        recipient_one_id,
        "dmvoicepeerone",
        1,
        "dmvoicepeerone@example.com",
        "hash",
    )
    .await?;
    let recipient_two_id = paracord_util::snowflake::generate(1);
    paracord_db::users::create_user(
        &ctx.db,
        recipient_two_id,
        "dmvoicepeertwo",
        1,
        "dmvoicepeertwo@example.com",
        "hash",
    )
    .await?;
    ctx.befriend(recipient_one_id).await?;
    ctx.befriend(recipient_two_id).await?;
    let outsider_token = create_authenticated_user_token(
        &ctx.db,
        "voice-test-secret",
        "dmvoiceoutsider",
        "VoiceTestPass123!",
    )
    .await?;

    let (status, dm_one) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_one_id.to_string()],
                "name": "Native DM Voice One",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "first group DM create: {dm_one}"
    );
    let channel_one_id = dm_one["id"]
        .as_str()
        .context("first group DM id should be a string")?
        .to_string();

    let (status, dm_two) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_two_id.to_string()],
                "name": "Native DM Voice Two",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "second group DM create: {dm_two}"
    );
    let channel_two_id = dm_two["id"]
        .as_str()
        .context("second group DM id should be a string")?
        .to_string();

    let (status, join_payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/dms/{channel_one_id}/voice/join"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "first DM voice join: {join_payload}"
    );

    let (status, me_payload) = ctx
        .request_json(Method::GET, "/api/v1/users/@me", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "get current user: {me_payload}");
    let user_id = me_payload["id"]
        .as_str()
        .context("expected /users/@me id")?
        .parse::<i64>()?;

    let outsider_leave = build_json_request(
        Method::POST,
        &format!("/api/v1/dms/{channel_one_id}/voice/leave"),
        None,
        Some(&outsider_token),
    )?;
    let (status, outsider_payload) = dispatch_json(&ctx.app, outsider_leave).await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "non-member DM voice leave should be forbidden: {outsider_payload}"
    );

    let mut no_op_events = ctx.event_bus.subscribe_system();
    let (status, wrong_leave_payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/dms/{channel_two_id}/voice/leave"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "leaving a different DM should be a no-op: {wrong_leave_payload}"
    );
    let active_after_wrong_leave =
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, None)
            .await?
            .context("wrong-channel DM leave must not revoke the active DM voice state")?;
    assert_eq!(
        active_after_wrong_leave.channel_id.to_string(),
        channel_one_id
    );
    let no_op_event =
        tokio::time::timeout(std::time::Duration::from_millis(100), no_op_events.recv()).await;
    assert!(
        no_op_event.is_err(),
        "leaving a different DM should not emit a voice-state event"
    );
    let mut events = ctx.event_bus.subscribe_system();

    let (status, leave_payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/dms/{channel_one_id}/voice/leave"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "leaving the active DM should succeed: {leave_payload}"
    );
    let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .context("timed out waiting for native DM voice leave event")??;
    assert_eq!(event.event_type, "VOICE_STATE_UPDATE");
    assert_eq!(event.guild_id, None);
    let mut targets = event
        .target_user_ids
        .clone()
        .context("DM voice leave events should target DM recipients")?;
    targets.sort_unstable();
    let mut expected_targets = vec![recipient_one_id, user_id];
    expected_targets.sort_unstable();
    assert_eq!(targets, expected_targets);
    assert_eq!(event.payload["user_id"], json!(user_id.to_string()));
    assert_eq!(event.payload["channel_id"], Value::Null);

    let state_after_leave =
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, None).await?;
    assert!(
        state_after_leave.is_none(),
        "active-channel DM leave should revoke the active DM voice state"
    );

    Ok(())
}

// ── Test: native-only (livekit unavailable) serves the full native contract ──
// for BOTH a guild voice join and a DM voice join, with no LiveKit binary text.

#[tokio::test]
async fn native_only_guild_and_dm_join_serve_full_native_contract() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, false).await?;

    // ── Guild voice join ────────────────────────────────────────────────
    let (_guild_id, channel_id) = create_guild_and_voice_channel(&ctx).await?;
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/voice/{channel_id}/join"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "guild native join: {payload}");
    assert_eq!(payload["native_media"], json!(true));
    assert_eq!(payload["livekit_available"], json!(false));
    let candidates = payload["media_endpoint_candidates"]
        .as_array()
        .context("guild join must return media_endpoint_candidates")?;
    assert!(
        !candidates.is_empty(),
        "guild media_endpoint_candidates must be non-empty: {payload}"
    );
    assert!(
        payload["media_token"].is_string(),
        "guild join must return a media_token: {payload}"
    );
    assert!(
        payload["cert_hash"].is_string(),
        "guild join must return a cert_hash: {payload}"
    );
    assert!(
        !payload.to_string().contains("livekit-server"),
        "guild native join must not mention the livekit-server binary: {payload}"
    );

    // ── DM voice join ───────────────────────────────────────────────────
    let recipient_id = paracord_util::snowflake::generate(1);
    paracord_db::users::create_user(
        &ctx.db,
        recipient_id,
        "nativecontractpeer",
        1,
        "nativecontractpeer@example.com",
        "hash",
    )
    .await?;
    ctx.befriend(recipient_id).await?;
    let (status, dm_payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_id.to_string()],
                "name": "Native Contract DM",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "group DM create: {dm_payload}");
    let dm_channel_id = dm_payload["id"]
        .as_str()
        .context("group DM id should be a string")?
        .to_string();

    let (status, dm_join) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/dms/{dm_channel_id}/voice/join"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "DM native join: {dm_join}");
    assert_eq!(dm_join["native_media"], json!(true));
    assert_eq!(dm_join["livekit_available"], json!(false));
    let dm_candidates = dm_join["media_endpoint_candidates"]
        .as_array()
        .context("DM join must return media_endpoint_candidates")?;
    assert!(
        !dm_candidates.is_empty(),
        "DM media_endpoint_candidates must be non-empty: {dm_join}"
    );
    assert!(
        dm_join["media_token"].is_string(),
        "DM join must return a media_token: {dm_join}"
    );
    assert!(
        dm_join["cert_hash"].is_string(),
        "DM join must return a cert_hash: {dm_join}"
    );
    assert!(
        !dm_join.to_string().contains("livekit-server"),
        "DM native join must not mention the livekit-server binary: {dm_join}"
    );

    Ok(())
}

// ── Test: v2 POST join also accepts ?fallback=livekit ──

#[tokio::test]
async fn v2_join_accepts_fallback_query_param() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, true).await?;
    let (_guild_id, channel_id) = create_guild_and_voice_channel(&ctx).await?;

    // v2 POST without fallback → native media
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/join"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "v2 join: {payload}");
    assert_eq!(payload["native_media"], json!(true));
    assert_eq!(payload["livekit_available"], json!(true));

    // Leave first
    let _ = ctx
        .request_json(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/leave"),
            None,
        )
        .await;

    // v2 POST with ?fallback=livekit → LiveKit path
    let (status, _payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/join?fallback=livekit"),
            None,
        )
        .await?;
    // Should attempt LiveKit path (500 without real server or 200 with LiveKit fields)
    assert_ne!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "should not get service unavailable when livekit_available=true"
    );

    Ok(())
}

#[tokio::test]
async fn v2_leave_ignores_stale_session_id() -> anyhow::Result<()> {
    let ctx = VoiceTestContext::new(true, true).await?;
    let (guild_id, channel_id) = create_guild_and_voice_channel(&ctx).await?;

    let (status, join_one) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/join"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "first join: {join_one}");
    let session_one = join_one["session_id"]
        .as_str()
        .context("expected first join session_id")?
        .to_string();

    let (status, join_two) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/join"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "second join: {join_two}");
    let session_two = join_two["session_id"]
        .as_str()
        .context("expected second join session_id")?
        .to_string();
    assert_ne!(
        session_one, session_two,
        "rejoin should mint a fresh session"
    );

    let (status, stale_leave_payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/leave?session_id={session_one}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "stale leave should be no-op: {stale_leave_payload}"
    );

    let (_status, me_payload) = ctx
        .request_json(Method::GET, "/api/v1/users/@me", None)
        .await?;
    let user_id = me_payload["id"]
        .as_str()
        .context("expected /users/@me id")?
        .parse::<i64>()?;
    let guild_id_i64 = guild_id.parse::<i64>()?;

    let state_after_stale =
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, Some(guild_id_i64))
            .await?;
    let state_after_stale = state_after_stale.context("voice state should survive stale leave")?;
    assert_eq!(state_after_stale.session_id, session_two);
    assert_eq!(state_after_stale.channel_id.to_string(), channel_id);

    let (status, fresh_leave_payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/leave?session_id={session_two}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "fresh leave should clear state: {fresh_leave_payload}"
    );

    let state_after_fresh =
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, Some(guild_id_i64))
            .await?;
    assert!(
        state_after_fresh.is_none(),
        "voice state should be gone after matching-session leave"
    );

    Ok(())
}
