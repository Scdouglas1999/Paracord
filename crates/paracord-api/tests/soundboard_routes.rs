mod common;

use anyhow::Context;
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tower::ServiceExt;

const JWT_SECRET: &str = "soundboard-test-secret";

struct SoundboardTestContext {
    app: Router,
    db: paracord_db::DbPool,
    token: String,
    user_id: i64,
    event_bus: paracord_core::events::EventBus,
    _test_app: TestApp,
}

impl SoundboardTestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            jwt_secret: JWT_SECRET.to_string(),
            // The voice join route refuses every join without a media backend;
            // the native path needs no external server (the harness binds an
            // ephemeral QUIC endpoint) and still writes the voice_states row
            // the play route checks.
            native_media_enabled: true,
            ..Default::default()
        })
        .await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "soundboard",
            "SoundboardPass123!",
        )
        .await?;
        let user_id = paracord_core::auth::validate_token(&token, JWT_SECRET)?.sub;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            token,
            user_id,
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
        self.request_json_as(&self.token, method, path, body).await
    }

    async fn request_json_as(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    /// Create a second account and add it to the guild directly; joining via
    /// invite would need the invite round-trip, which is not what is under
    /// test.
    async fn add_member(&self, guild_id: i64, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, JWT_SECRET, prefix, "SoundboardPass123!")
                .await?;
        let user_id = paracord_core::auth::validate_token(&token, JWT_SECRET)?.sub;
        paracord_db::members::add_member(&self.db, user_id, guild_id).await?;
        Ok((token, user_id))
    }

    async fn create_guild_and_voice_channel(&self) -> anyhow::Result<(i64, i64)> {
        let (status, payload) = self
            .request_json(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Soundboard Test Guild", "icon": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild creation: {payload}");
        let guild_id: i64 = payload["id"]
            .as_str()
            .context("guild id should be a string")?
            .parse()?;

        let (status, payload) = self
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
        let channel_id: i64 = payload["id"]
            .as_str()
            .context("channel id should be a string")?
            .parse()?;
        Ok((guild_id, channel_id))
    }

    async fn join_voice_as(&self, token: &str, channel_id: i64) -> anyhow::Result<()> {
        let (status, payload) = self
            .request_json_as(
                token,
                Method::GET,
                &format!("/api/v1/voice/{channel_id}/join"),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "voice join: {payload}");
        Ok(())
    }

    async fn upload_sound(
        &self,
        token: &str,
        guild_id: i64,
        fields: &[(&str, &str)],
        file_name: &str,
        content_type: &str,
        data: &[u8],
    ) -> anyhow::Result<(StatusCode, Value)> {
        let boundary = "soundboardboundary";
        let mut body = Vec::new();
        for (key, value) in fields {
            body.extend_from_slice(
                format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n"
                )
                .as_bytes(),
            );
        }
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: {content_type}\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/api/v1/guilds/{guild_id}/sounds"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))?;
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await?;
        let payload = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }))
        };
        Ok((status, payload))
    }
}

/// A tiny PCM WAV: silence of `seconds` at 8 kHz mono s16.
fn wav_bytes(seconds: f64) -> Vec<u8> {
    let sample_rate = 8000u32;
    let frames = (seconds * sample_rate as f64) as u32;
    let data_len = frames * 2;
    let byte_rate = sample_rate * 2;
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend(std::iter::repeat_n(0u8, data_len as usize));
    out
}

async fn upload_ok(
    ctx: &SoundboardTestContext,
    guild_id: i64,
    name: &str,
) -> anyhow::Result<Value> {
    let (status, payload) = ctx
        .upload_sound(
            &ctx.token,
            guild_id,
            &[("name", name), ("emoji", "🔔"), ("volume", "80")],
            "ding.wav",
            "audio/wav",
            &wav_bytes(1.0),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "upload {name}: {payload}");
    Ok(payload)
}

#[tokio::test]
async fn sound_crud_and_file_roundtrip() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, _channel_id) = ctx.create_guild_and_voice_channel().await?;

    let (status, empty) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/sounds"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty, json!([]));

    let created = upload_ok(&ctx, guild_id, "ding").await?;
    assert!(created["id"].is_string());
    assert_eq!(created["guild_id"], guild_id.to_string());
    assert_eq!(created["name"], "ding");
    assert_eq!(created["emoji"], "🔔");
    assert_eq!(created["volume"], 80);
    assert_eq!(created["duration_ms"], 1000);
    assert_eq!(created["content_type"], "audio/wav");
    assert!(created["size"].as_i64().context("size")? > 0);
    assert_eq!(
        created["creator_id"].as_str().context("creator")?,
        ctx.user_id.to_string()
    );
    assert_eq!(
        created["sound_url"].as_str().context("sound_url")?,
        format!(
            "/api/v1/guilds/{guild_id}/sounds/{}/file",
            created["id"].as_str().unwrap()
        )
    );
    assert!(created["created_at"].is_string());
    let sound_id = created["id"].as_str().unwrap().to_string();

    let (status, listed) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/sounds"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list = listed.as_array().context("list should be an array")?;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["id"], sound_id);

    // The file route serves the stored bytes with the stored content type.
    let request = build_json_request(
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/sounds/{sound_id}/file"),
        None,
        Some(&ctx.token),
    )?;
    let response = ctx.app.clone().oneshot(request).await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "audio/wav"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(bytes.as_ref(), wav_bytes(1.0).as_slice());

    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/sounds/{sound_id}"),
            Some(json!({ "name": "louder ding", "volume": 40 })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "update: {updated}");
    assert_eq!(updated["name"], "louder ding");
    assert_eq!(updated["volume"], 40);
    assert_eq!(updated["emoji"], "🔔");

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/sounds/{sound_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, listed) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/sounds"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed, json!([]));

    let (status, _) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/sounds/{sound_id}/file"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn sound_upload_validation() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, _) = ctx.create_guild_and_voice_channel().await?;
    let wav = wav_bytes(1.0);

    // Name bounds: 1 char and 33 chars both fail.
    for name in ["x", &"a".repeat(33)] {
        let (status, payload) = ctx
            .upload_sound(
                &ctx.token,
                guild_id,
                &[("name", name)],
                "s.wav",
                "audio/wav",
                &wav,
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "name {name:?}: {payload}");
    }

    // Volume bounds.
    for volume in ["-1", "101"] {
        let (status, payload) = ctx
            .upload_sound(
                &ctx.token,
                guild_id,
                &[("name", "ding"), ("volume", volume)],
                "s.wav",
                "audio/wav",
                &wav,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "volume {volume}: {payload}"
        );
    }

    // Unaccepted content type.
    let (status, payload) = ctx
        .upload_sound(
            &ctx.token,
            guild_id,
            &[("name", "ding")],
            "s.txt",
            "text/plain",
            b"hello",
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "content type: {payload}");

    // Declared type must match the sniffed container.
    let (status, payload) = ctx
        .upload_sound(
            &ctx.token,
            guild_id,
            &[("name", "ding")],
            "s.mp3",
            "audio/mpeg",
            &wav,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "mismatch: {payload}");

    // Duration cap: 6 s of WAV is measured and refused.
    let (status, payload) = ctx
        .upload_sound(
            &ctx.token,
            guild_id,
            &[("name", "toolong")],
            "s.wav",
            "audio/wav",
            &wav_bytes(6.0),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "duration: {payload}");
    assert!(
        payload["message"]
            .as_str()
            .unwrap_or_default()
            .contains("5 seconds"),
        "duration message should name the cap: {payload}"
    );

    // Size cap: a >1 MB body is refused before it is ever probed.
    let mut oversized = wav_bytes(1.0);
    oversized.resize(1024 * 1024 + 1, 0);
    let (status, payload) = ctx
        .upload_sound(
            &ctx.token,
            guild_id,
            &[("name", "big")],
            "s.wav",
            "audio/wav",
            &oversized,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "size: {payload}");

    // A malformed emoji token is refused; a real unicode emoji is fine.
    let (status, payload) = ctx
        .upload_sound(
            &ctx.token,
            guild_id,
            &[("name", "ding"), ("emoji", "<broken")],
            "s.wav",
            "audio/wav",
            &wav,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "emoji: {payload}");

    // Missing fields.
    let (status, payload) = ctx
        .upload_sound(&ctx.token, guild_id, &[], "s.wav", "audio/wav", &wav)
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no name: {payload}");
    Ok(())
}

#[tokio::test]
async fn sound_cap_is_48_per_guild() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, _) = ctx.create_guild_and_voice_channel().await?;
    let wav = wav_bytes(0.1);
    for i in 0..48 {
        let (status, payload) = ctx
            .upload_sound(
                &ctx.token,
                guild_id,
                &[("name", &format!("s{i:02}"))],
                "s.wav",
                "audio/wav",
                &wav,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "sound {i}: {payload}");
    }
    let (status, payload) = ctx
        .upload_sound(
            &ctx.token,
            guild_id,
            &[("name", "one-too-many")],
            "s.wav",
            "audio/wav",
            &wav,
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT, "49th sound: {payload}");
    Ok(())
}

#[tokio::test]
async fn sound_management_requires_manage_emojis() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, _) = ctx.create_guild_and_voice_channel().await?;
    let (member_token, _member_id) = ctx.add_member(guild_id, "member").await?;
    let wav = wav_bytes(1.0);

    // A plain member can list sounds…
    let (status, list) = ctx
        .request_json_as(
            &member_token,
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/sounds"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "member list: {list}");

    // …but cannot upload, rename, or delete (MANAGE_EMOJIS required).
    let (status, payload) = ctx
        .upload_sound(
            &member_token,
            guild_id,
            &[("name", "ding")],
            "s.wav",
            "audio/wav",
            &wav,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "member upload: {payload}");

    let sound = upload_ok(&ctx, guild_id, "ding").await?;
    let sound_id = sound["id"].as_str().unwrap();
    let (status, payload) = ctx
        .request_json_as(
            &member_token,
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/sounds/{sound_id}"),
            Some(json!({ "name": "hijack" })),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "member patch: {payload}");
    let (status, payload) = ctx
        .request_json_as(
            &member_token,
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/sounds/{sound_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "member delete: {payload}");

    // A non-member cannot even list.
    let outsider_token =
        create_authenticated_user_token(&ctx.db, JWT_SECRET, "outsider", "SoundboardPass123!")
            .await?;
    let (status, _) = ctx
        .request_json_as(
            &outsider_token,
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/sounds"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
async fn play_requires_being_connected_to_the_channel() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, channel_id) = ctx.create_guild_and_voice_channel().await?;
    let sound = upload_ok(&ctx, guild_id, "ding").await?;

    // Not connected at all.
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "not connected: {payload}");

    // Connected to a *different* voice channel is not good enough.
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": "other-voice",
                "channel_type": 2,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let other_channel: i64 = payload["id"].as_str().unwrap().parse()?;
    ctx.join_voice_as(&ctx.token, other_channel).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "wrong channel: {payload}");
    Ok(())
}

#[tokio::test]
async fn play_requires_use_soundboard_permission() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, channel_id) = ctx.create_guild_and_voice_channel().await?;
    let sound = upload_ok(&ctx, guild_id, "ding").await?;
    let (member_token, member_id) = ctx.add_member(guild_id, "member").await?;
    ctx.join_voice_as(&member_token, channel_id).await?;

    // Deny USE_SOUNDBOARD to @everyone on this channel; the member holds no
    // other role, so the deny lands.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        channel_id,
        guild_id,
        paracord_core::permissions::OVERWRITE_TARGET_ROLE,
        0,
        Permissions::USE_SOUNDBOARD.bits(),
    )
    .await?;

    let (status, payload) = ctx
        .request_json_as(
            &member_token,
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "denied member: {payload}");

    // A member-targeted allow restores the bit (member overwrites win).
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        channel_id,
        member_id,
        paracord_core::permissions::OVERWRITE_TARGET_MEMBER,
        Permissions::USE_SOUNDBOARD.bits(),
        0,
    )
    .await?;
    let (status, payload) = ctx
        .request_json_as(
            &member_token,
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "allowed member: {payload}");
    Ok(())
}

#[tokio::test]
async fn play_dispatches_to_channel_participants_only() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, channel_id) = ctx.create_guild_and_voice_channel().await?;
    let sound = upload_ok(&ctx, guild_id, "ding").await?;
    let (member_token, member_id) = ctx.add_member(guild_id, "member").await?;
    let (_idle_token, idle_id) = ctx.add_member(guild_id, "idle").await?;
    let outsider_token =
        create_authenticated_user_token(&ctx.db, JWT_SECRET, "outsider", "SoundboardPass123!")
            .await?;
    let outsider_id = paracord_core::auth::validate_token(&outsider_token, JWT_SECRET)?.sub;

    ctx.join_voice_as(&ctx.token, channel_id).await?;
    ctx.join_voice_as(&member_token, channel_id).await?;

    // Sessions: the two connected users, an idle guild member, and an
    // outsider. Only the connected pair may see the event.
    let mut player_rx = ctx
        .event_bus
        .register_session("player-sess", ctx.user_id, &[guild_id])
        .expect("register player");
    let mut listener_rx = ctx
        .event_bus
        .register_session("listener-sess", member_id, &[guild_id])
        .expect("register listener");
    let mut idle_rx = ctx
        .event_bus
        .register_session("idle-sess", idle_id, &[guild_id])
        .expect("register idle");
    let mut outsider_rx = ctx
        .event_bus
        .register_session("outsider-sess", outsider_id, &[])
        .expect("register outsider");

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "play: {payload}");

    for (label, rx) in [("player", &mut player_rx), ("listener", &mut listener_rx)] {
        let event = rx
            .try_recv()
            .unwrap_or_else(|e| panic!("{label} should receive SOUNDBOARD_PLAY: {e}"));
        assert_eq!(event.event_type, "SOUNDBOARD_PLAY");
        assert_eq!(event.payload["channel_id"], channel_id.to_string());
        assert_eq!(event.payload["guild_id"], guild_id.to_string());
        assert_eq!(event.payload["sound_id"], sound["id"]);
        assert_eq!(event.payload["user_id"], ctx.user_id.to_string());
        assert_eq!(event.payload["sound"]["name"], "ding");
        assert!(event.payload["at"].is_i64() || event.payload["at"].is_u64());
    }
    assert!(
        idle_rx.try_recv().is_err(),
        "guild members outside the call must not see SOUNDBOARD_PLAY"
    );
    assert!(
        outsider_rx.try_recv().is_err(),
        "non-members must not see SOUNDBOARD_PLAY"
    );
    Ok(())
}

#[tokio::test]
async fn play_enforces_per_user_cooldown() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, channel_id) = ctx.create_guild_and_voice_channel().await?;
    let sound = upload_ok(&ctx, guild_id, "ding").await?;
    ctx.join_voice_as(&ctx.token, channel_id).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "first play: {payload}");

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "second play: {payload}"
    );
    assert_eq!(payload["code"], "RATE_LIMITED");
    assert!(
        payload["retry_after"].as_i64().context("retry_after")? >= 1,
        "retry_after should name seconds: {payload}"
    );

    // The cooldown keys on (user, channel): a different connected member is
    // still free to play.
    let (member_token, _) = ctx.add_member(guild_id, "member").await?;
    ctx.join_voice_as(&member_token, channel_id).await?;
    let (status, payload) = ctx
        .request_json_as(
            &member_token,
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "other member: {payload}");
    Ok(())
}

#[tokio::test]
async fn play_enforces_channel_window() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, channel_id) = ctx.create_guild_and_voice_channel().await?;
    let sound = upload_ok(&ctx, guild_id, "ding").await?;

    // Six members each play once: the per-user cooldown never bites, so the
    // sixth rejection can only come from the 5-per-10 s channel window.
    let mut tokens = Vec::new();
    for i in 0..6 {
        let (token, _) = ctx.add_member(guild_id, &format!("p{i}")).await?;
        ctx.join_voice_as(&token, channel_id).await?;
        tokens.push(token);
    }
    for (i, token) in tokens.iter().enumerate().take(5) {
        let (status, payload) = ctx
            .request_json_as(
                token,
                Method::POST,
                &format!("/api/v1/channels/{channel_id}/soundboard/play"),
                Some(json!({ "sound_id": sound["id"] })),
            )
            .await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "play {i}: {payload}");
    }
    let (status, payload) = ctx
        .request_json_as(
            &tokens[5],
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": sound["id"] })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "sixth play: {payload}"
    );
    assert_eq!(payload["code"], "RATE_LIMITED");
    Ok(())
}

#[tokio::test]
async fn play_rejects_sounds_from_other_guilds() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (_guild_id, channel_id) = ctx.create_guild_and_voice_channel().await?;

    // A second guild with its own sound.
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Other Guild", "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let other_guild: i64 = payload["id"].as_str().unwrap().parse()?;
    let foreign = upload_ok(&ctx, other_guild, "foreign").await?;

    ctx.join_voice_as(&ctx.token, channel_id).await?;
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": foreign["id"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "foreign sound: {payload}");

    // Nonexistent and malformed ids are also refused cleanly.
    let (status, _) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": "123" })),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/soundboard/play"),
            Some(json!({ "sound_id": "not-a-snowflake" })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    Ok(())
}

#[tokio::test]
async fn sound_changes_dispatch_guild_sounds_update() -> anyhow::Result<()> {
    let ctx = SoundboardTestContext::new().await?;
    let (guild_id, _) = ctx.create_guild_and_voice_channel().await?;
    let mut rx = ctx
        .event_bus
        .register_session("watcher", ctx.user_id, &[guild_id])
        .expect("register watcher");

    let sound = upload_ok(&ctx, guild_id, "ding").await?;
    let event = rx.try_recv().context("create should dispatch")?;
    assert_eq!(event.event_type, "GUILD_SOUNDS_UPDATE");
    assert_eq!(event.payload["guild_id"], guild_id.to_string());
    assert_eq!(event.payload["sound"]["id"], sound["id"]);

    let sound_id = sound["id"].as_str().unwrap();
    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/sounds/{sound_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let event = rx.try_recv().context("delete should dispatch")?;
    assert_eq!(event.event_type, "GUILD_SOUNDS_UPDATE");
    assert_eq!(event.payload["deleted_sound_id"], sound_id);
    Ok(())
}
