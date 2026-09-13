//! Call receipts scope membership changes independently of login and gateway sessions.
mod common;

use std::sync::Arc;

use anyhow::Context;
use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    routing::post,
    Json, Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use paracord_media::{LiveKitConfig, VoiceManager};
use paracord_relay::participant::MediaParticipant;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

struct Fixture {
    ctx: TestApp,
    token: String,
    user: i64,
    guild: i64,
    voice: i64,
    other_voice: i64,
    dm: i64,
    other_dm: i64,
    livekit_task: Option<tokio::task::JoinHandle<()>>,
    participant_query: Arc<Notify>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = self.livekit_task.take() {
            task.abort();
        }
    }
}
impl Fixture {
    async fn new(native: bool) -> anyhow::Result<Self> {
        let mut ctx = build_test_app(TestAppOptions {
            native_media_enabled: native,
            livekit_available: !native,
            database_connections: 2,
            ..Default::default()
        })
        .await?;
        let participant_query = Arc::new(Notify::new());
        let livekit_task = if native {
            None
        } else {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let endpoint = format!("http://{}", listener.local_addr()?);
            let query = participant_query.clone();
            let mock = Router::new()
                .route(
                    "/twirp/livekit.RoomService/CreateRoom",
                    post(|| async { Json(json!({})) }),
                )
                .route(
                    "/twirp/livekit.RoomService/DeleteRoom",
                    post(|| async { Json(json!({})) }),
                )
                .route(
                    "/twirp/livekit.RoomService/ListParticipants",
                    post(move || {
                        let query = query.clone();
                        async move {
                            query.notify_one();
                            Json(json!({"participants":[]}))
                        }
                    }),
                );
            ctx.state.voice = Arc::new(VoiceManager::new(Arc::new(LiveKitConfig {
                api_key: "lk-test-key".into(),
                api_secret: "lk-test-secret".into(),
                url: endpoint.clone(),
                http_url: endpoint,
            })));
            ctx.app = paracord_api::build_router(&ctx.state).with_state(ctx.state.clone());
            Some(tokio::spawn(async move {
                axum::serve(listener, mock).await.unwrap();
            }))
        };
        let token = create_authenticated_user_token(
            &ctx.db,
            &ctx.jwt_secret,
            "callowner",
            "CallOwnerPass123!",
        )
        .await?;
        let user = paracord_core::auth::validate_token(&token, &ctx.jwt_secret)?.sub;
        let peer = paracord_util::snowflake::generate(1);
        paracord_db::users::create_user(&ctx.db, peer, "callpeer", 1, "peer@example.test", "hash")
            .await?;
        let guild = paracord_util::snowflake::generate(1);
        paracord_core::guild::create_guild_full(&ctx.db, guild, "Call ownership", user, None)
            .await?;
        let voice = paracord_db::channels::get_guild_channels(&ctx.db, guild)
            .await?
            .into_iter()
            .find(|channel| channel.channel_type == 2)
            .unwrap()
            .id;
        let other_voice = paracord_util::snowflake::generate(1);
        paracord_db::channels::create_channel(
            &ctx.db,
            other_voice,
            guild,
            "other",
            2,
            2,
            None,
            None,
        )
        .await?;
        let dm = paracord_util::snowflake::generate(1);
        let other_dm = paracord_util::snowflake::generate(1);
        paracord_db::dms::create_dm_channel(&ctx.db, dm, user, peer).await?;
        paracord_db::dms::create_dm_channel(&ctx.db, other_dm, user, peer).await?;
        Ok(Self {
            ctx,
            token,
            user,
            guild,
            voice,
            other_voice,
            dm,
            other_dm,
            livekit_task,
            participant_query,
        })
    }
    fn join_path(&self, channel: i64) -> String {
        if channel == self.dm || channel == self.other_dm {
            format!("/api/v1/dms/{channel}/voice/join")
        } else {
            format!("/api/v2/voice/{channel}/join")
        }
    }
    fn leave_path(&self, channel: i64, receipt: &str) -> String {
        if channel == self.dm || channel == self.other_dm {
            format!("/api/v1/dms/{channel}/voice/leave?session_id={receipt}")
        } else {
            format!("/api/v2/voice/{channel}/leave?session_id={receipt}")
        }
    }
    async fn post(&self, path: &str) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(
            &self.ctx.app,
            build_json_request(Method::POST, path, None, Some(&self.token))?,
        )
        .await
    }
    async fn join(&self, channel: i64) -> anyhow::Result<Value> {
        let (status, body) = self.post(&self.join_path(channel)).await?;
        assert_eq!(status, StatusCode::OK, "join: {body}");
        Ok(body)
    }
    async fn assert_current(&self, channel: i64, receipt: &str) -> anyhow::Result<()> {
        let rows =
            paracord_db::voice_states::get_all_user_voice_states(&self.ctx.db, self.user).await?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].channel_id, channel);
        assert_eq!(rows[0].session_id, receipt);
        if let Some(native) = &self.ctx.state.native_media {
            let guild = if channel == self.dm || channel == self.other_dm {
                0
            } else {
                self.guild
            };
            let room = native
                .rooms
                .get_room_by_channel(guild, channel)
                .context("active relay room")?;
            assert_eq!(
                room.participants
                    .get(&self.user)
                    .context("active relay participant")?
                    .session_id,
                receipt
            );
        } else {
            let participants = self.ctx.state.voice.get_room_participants(channel).await;
            assert_eq!(
                participants
                    .iter()
                    .find(|participant| participant.user_id == self.user)
                    .context("active LiveKit projection")?
                    .session_id,
                receipt
            );
        }
        Ok(())
    }
}
fn receipt(body: &Value) -> &str {
    body["session_id"].as_str().unwrap()
}

#[tokio::test]
async fn stale_dm_leave_preserves_replacement_receipt_and_native_room() -> anyhow::Result<()> {
    let f = Fixture::new(true).await?;
    let old = f.join(f.dm).await?;
    let current = f.join(f.dm).await?;
    assert_ne!(receipt(&old), receipt(&current));
    assert_eq!(
        f.post(&f.leave_path(f.dm, receipt(&old))).await?.0,
        StatusCode::NO_CONTENT
    );
    f.assert_current(f.dm, receipt(&current)).await?;
    assert_eq!(
        f.post(&f.leave_path(f.dm, receipt(&current))).await?.0,
        StatusCode::NO_CONTENT
    );
    assert!(
        paracord_db::voice_states::get_all_user_voice_states(&f.ctx.db, f.user)
            .await?
            .is_empty()
    );
    assert!(f
        .ctx
        .state
        .native_media
        .as_ref()
        .unwrap()
        .rooms
        .get_room_by_channel(0, f.dm)
        .is_none());
    Ok(())
}

#[tokio::test]
async fn guild_leave_receipt_is_bound_to_its_channel() -> anyhow::Result<()> {
    let f = Fixture::new(true).await?;
    let current = f.join(f.voice).await?;
    assert_eq!(
        f.post(&f.leave_path(f.other_voice, receipt(&current)))
            .await?
            .0,
        StatusCode::NO_CONTENT
    );
    f.assert_current(f.voice, receipt(&current)).await?;
    Ok(())
}

#[tokio::test]
async fn native_room_transitions_remove_only_the_previous_receipt() -> anyhow::Result<()> {
    let f = Fixture::new(true).await?;
    let mut previous: Option<(i64, Value)> = None;
    for channel in [f.dm, f.other_dm, f.voice, f.dm] {
        let current = f.join(channel).await?;
        if let Some((old_channel, old)) = &previous {
            let old_guild = if *old_channel == f.voice { f.guild } else { 0 };
            let old_room = f
                .ctx
                .state
                .native_media
                .as_ref()
                .unwrap()
                .rooms
                .get_room_by_channel(old_guild, *old_channel);
            assert!(
                old_room
                    .as_ref()
                    .is_none_or(|room| !room.participants.contains_key(&f.user)),
                "old relay membership remained after {old_channel} -> {channel}"
            );
            assert_eq!(
                f.post(&f.leave_path(*old_channel, receipt(old))).await?.0,
                StatusCode::NO_CONTENT
            );
        }
        f.assert_current(channel, receipt(&current)).await?;
        previous = Some((channel, current));
    }
    Ok(())
}

#[tokio::test]
async fn livekit_guild_and_dm_tokens_bind_the_same_receipt_as_db_and_local_membership(
) -> anyhow::Result<()> {
    let f = Fixture::new(false).await?;
    for channel in [f.voice, f.dm] {
        let body = f.join(channel).await?;
        let claims = decode::<Value>(
            body["token"].as_str().unwrap(),
            &DecodingKey::from_secret(b"lk-test-secret"),
            &Validation::new(Algorithm::HS256),
        )?
        .claims;
        let metadata: Value = serde_json::from_str(
            claims["metadata"]
                .as_str()
                .context("signed token metadata")?,
        )?;
        assert_eq!(metadata["voice_session_id"], body["session_id"]);
        assert_eq!(metadata["user_id"], f.user);
        assert_eq!(claims["sub"], f.user.to_string());
        assert_eq!(claims["video"]["room"], body["room_name"]);
        f.assert_current(channel, receipt(&body)).await?;
    }
    Ok(())
}

async fn reject_voice_writes(db: &paracord_db::DbPool) -> anyhow::Result<()> {
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query("CREATE TRIGGER reject_voice BEFORE INSERT ON voice_states BEGIN SELECT RAISE(ABORT, 'voice write failed'); END").execute(db).await?;
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query("CREATE FUNCTION reject_voice_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'voice write failed'; END $$").execute(db).await?;
            sqlx::query("CREATE TRIGGER reject_voice BEFORE INSERT ON voice_states FOR EACH ROW EXECUTE FUNCTION reject_voice_write()").execute(db).await?;
        }
    }
    Ok(())
}
async fn assert_failed_livekit_join_unwinds(dm: bool) -> anyhow::Result<()> {
    let f = Fixture::new(false).await?;
    reject_voice_writes(&f.ctx.db).await?;
    let channel = if dm { f.dm } else { f.voice };
    let (status, body) = f.post(&f.join_path(channel)).await?;
    assert!(
        status.is_server_error(),
        "DB failure must not acknowledge joined membership: {body}"
    );
    assert!(
        paracord_db::voice_states::get_all_user_voice_states(&f.ctx.db, f.user)
            .await?
            .is_empty()
    );
    assert!(
        f.ctx
            .state
            .voice
            .get_room_participants(channel)
            .await
            .is_empty(),
        "failed receipt left a local participant"
    );
    Ok(())
}
#[tokio::test]
async fn guild_livekit_db_failure_unwinds_matching_membership() -> anyhow::Result<()> {
    assert_failed_livekit_join_unwinds(false).await
}
#[tokio::test]
async fn dm_livekit_db_failure_unwinds_matching_membership() -> anyhow::Result<()> {
    assert_failed_livekit_join_unwinds(true).await
}

#[tokio::test]
async fn delayed_livekit_left_webhook_cannot_remove_a_replacement_receipt() -> anyhow::Result<()> {
    let f = Fixture::new(false).await?;
    let old = f.join(f.voice).await?;
    let payload = json!({"event":"participant_left","room":{"name":old["room_name"]},"participant":{"identity":f.user.to_string(),"metadata":json!({"voice_session_id":receipt(&old)}).to_string()}}).to_string();
    let digest = Sha256::digest(payload.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(Algorithm::HS256),
        &json!({"iss":"lk-test-key","exp":chrono::Utc::now().timestamp()+60,"sha256":digest}),
        &jsonwebtoken::EncodingKey::from_secret(b"lk-test-secret"),
    )?;
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/voice/livekit/webhook")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(payload))?;
    assert_eq!(
        dispatch_json(&f.ctx.app, request).await?.0,
        StatusCode::NO_CONTENT
    );
    let current = f.join(f.voice).await?;
    tokio::time::timeout(
        std::time::Duration::from_secs(7),
        f.participant_query.notified(),
    )
    .await?;
    // A query proves the delayed worker acquired the gate; acquiring it next
    // waits for its conditional removal to complete before checking the receipt.
    let _membership = f.ctx.state.voice.lock_membership(f.user).await;
    f.assert_current(f.voice, receipt(&current)).await?;
    Ok(())
}

#[tokio::test]
async fn failed_livekit_rejoin_preserves_the_previous_membership_receipt() -> anyhow::Result<()> {
    let f = Fixture::new(false).await?;
    let old = f.join(f.voice).await?;
    reject_voice_writes(&f.ctx.db).await?;
    let (status, body) = f.post(&f.join_path(f.voice)).await?;
    assert!(status.is_server_error(), "failed rejoin: {body}");
    f.assert_current(f.voice, receipt(&old)).await?;
    Ok(())
}

#[tokio::test]
async fn stream_receipts_are_bound_to_the_current_call() -> anyhow::Result<()> {
    let f = Fixture::new(true).await?;
    let old = f.join(f.voice).await?;
    let current = f.join(f.voice).await?;
    assert_ne!(receipt(&old), receipt(&current));

    let stream = |channel: i64, receipt: &str| {
        format!("/api/v1/voice/{channel}/stream?session_id={receipt}")
    };
    let stop = |channel: i64, receipt: &str| {
        format!("/api/v1/voice/{channel}/stream/stop?session_id={receipt}")
    };

    // A stream command from a call that has already been replaced must not act
    // on the call that replaced it, and a receipt is only valid for the channel
    // its call is in.
    for path in [
        stream(f.voice, receipt(&old)),
        stop(f.voice, receipt(&old)),
        stream(f.other_voice, receipt(&current)),
        stop(f.other_voice, receipt(&current)),
    ] {
        let (status, body) = f.post(&path).await?;
        assert_eq!(status, StatusCode::CONFLICT, "{path}: {body}");
    }

    // The receipt that owns the live call still works.
    let (status, body) = f.post(&stream(f.voice, receipt(&current))).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        f.post(&stop(f.voice, receipt(&current))).await?.0,
        StatusCode::NO_CONTENT
    );
    f.assert_current(f.voice, receipt(&current)).await?;
    Ok(())
}

#[tokio::test]
async fn a_rejected_native_join_leaves_the_existing_call_intact() -> anyhow::Result<()> {
    let f = Fixture::new(true).await?;
    let current = f.join(f.voice).await?;

    // Fill the destination room to its participant cap so the next admission is
    // refused *after* the replacement receipt has been staged.
    let rooms = &f.ctx.state.native_media.as_ref().unwrap().rooms;
    for filler in 0..50i64 {
        rooms
            .join_room(
                f.guild,
                f.other_voice,
                MediaParticipant::new(9_000_000 + filler, format!("filler-{filler}")),
            )
            .expect("filler admission");
    }

    let (status, body) = f.post(&f.join_path(f.other_voice)).await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a full room must refuse the join: {body}"
    );

    // The refused join must neither commit its own receipt nor release the one
    // the caller is still using.
    f.assert_current(f.voice, receipt(&current)).await?;
    assert!(
        rooms
            .get_room_by_channel(f.guild, f.other_voice)
            .is_some_and(|room| !room.participants.contains_key(&f.user)),
        "a refused join must not leave a participant in the destination room"
    );
    Ok(())
}

/// Mirrors `leave_voice`: a DM leave from a caller with no membership at all
/// still announces the leave to the DM's recipients, so a client whose local
/// state drifted (it shows a call it is not in) is corrected. A leave that is
/// stale for a *different* call must stay silent — it cannot tear down the
/// call the caller is actually in.
#[tokio::test]
async fn dm_leave_without_membership_still_announces_but_stale_leave_stays_silent(
) -> anyhow::Result<()> {
    let f = Fixture::new(true).await?;
    let leaves = |events: &mut tokio::sync::broadcast::Receiver<
        paracord_core::events::ServerEvent,
    >| {
        let mut count = 0;
        while let Ok(event) = events.try_recv() {
            if event.event_type == "VOICE_STATE_UPDATE" && event.payload["channel_id"].is_null() {
                count += 1;
            }
        }
        count
    };

    // No membership anywhere: the leave has nothing to unwind but is announced.
    let mut events = f.ctx.event_bus.subscribe_system();
    let (status, _) = f.post(&format!("/api/v1/dms/{}/voice/leave", f.dm)).await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        leaves(&mut events),
        1,
        "a membership-less DM leave must clear client desync"
    );

    // In a call in `dm`: a leave naming `other_dm` (with or without the receipt)
    // is stale for a different call and must neither announce nor unwind.
    let current = f.join(f.dm).await?;
    let mut events = f.ctx.event_bus.subscribe_system();
    let (status, _) = f.post(&f.leave_path(f.other_dm, receipt(&current))).await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = f
        .post(&format!("/api/v1/dms/{}/voice/leave", f.other_dm))
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(leaves(&mut events), 0, "a stale DM leave must stay silent");
    f.assert_current(f.dm, receipt(&current)).await?;
    Ok(())
}
