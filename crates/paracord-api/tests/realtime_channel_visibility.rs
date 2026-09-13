//! Losing sight of a room over the realtime stream.
//!
//! A moved permission overwrite dispatches `CHANNEL_UPDATE` to the guild, and
//! the stream's per-channel filter drops any channel event the recipient may no
//! longer view. That filter is right for every other event and exactly wrong
//! for this one: the person who just lost `VIEW_CHANNEL` is the one person the
//! change is *about*, and dropping it left them looking at the room's name, its
//! loaded messages and a composer that looked like it would send, until they
//! navigated away or reloaded.
//!
//! So a `CHANNEL_UPDATE` a viewer may no longer see arrives as a
//! `CHANNEL_DELETE` for them — "this room is gone from your world" — and every
//! other filtered channel event stays dropped.

mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request},
    Router,
};
use common::{build_test_app, create_authenticated_user_token, TestAppOptions};
use futures_util::StreamExt;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tower::ServiceExt;

async fn mint_stream_ticket(app: &Router, token: &str) -> String {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/stream/ticket")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("ticket request");
    let (status, body) = common::dispatch_json(app, request)
        .await
        .expect("mint stream ticket");
    assert!(status.is_success(), "mint ticket failed: {status}");
    body["ticket"].as_str().expect("ticket present").to_string()
}

/// The account behind a token, without attaching a stream for it.
async fn member_user_id(_db: &paracord_db::DbPool, _secret: &str, token: &str) -> i64 {
    let claims = token.split('.').nth(1).expect("jwt payload");
    let decoded = base64_decode(claims);
    let value: Value = serde_json::from_slice(&decoded).expect("jwt claims json");
    // `sub` is a number on this server, not the usual string.
    value["sub"].as_i64().expect("numeric sub claim")
}

fn base64_decode(input: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input)
        .expect("base64url jwt payload")
}

async fn create_session(app: &Router, token: &str) -> (String, i64) {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    let (_, body) = common::dispatch_json(app, request)
        .await
        .expect("create session");
    (
        body["session_id"].as_str().unwrap().to_string(),
        body["user_id"].as_str().unwrap().parse().unwrap(),
    )
}

/// Attach the stream and read frames until `stop` says we have what we came for.
fn reader(
    app: Router,
    ticket: String,
    session_id: String,
    stop: fn(&Value) -> bool,
) -> tokio::task::JoinHandle<Vec<Value>> {
    tokio::spawn(async move {
        let uri = format!("/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}");
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .expect("build sse request");
        let response = app.oneshot(request).await.expect("sse response");
        let mut stream = response.into_body().into_data_stream();
        let mut buf = String::new();
        let mut frames: Vec<Value> = Vec::new();
        while frames.len() < 12 {
            let chunk = match tokio::time::timeout(Duration::from_secs(3), stream.next()).await {
                Ok(Some(Ok(bytes))) => bytes,
                _ => break,
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim().to_string();
                buf.drain(..=idx);
                if let Some(payload) = line.strip_prefix("data:") {
                    if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                        let done = stop(&value);
                        frames.push(value);
                        if done {
                            return frames;
                        }
                    }
                }
            }
        }
        frames
    })
}

#[tokio::test]
async fn losing_view_channel_arrives_as_the_room_going_away() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");

    let owner_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "owner", "hunter2hunter2")
            .await
            .expect("owner token");
    // A session snapshots which buildings the account is in, so the owner's
    // (unused) session is only how this test learns their id.
    let (_owner_session, owner_id) = create_session(&ctx.app, &owner_token).await;

    let member_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "member", "hunter2hunter2")
            .await
            .expect("member token");
    let guild_id = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&ctx.db, guild_id, "Kestrel Robotics", owner_id, None)
        .await
        .expect("create guild");
    paracord_db::members::add_member(&ctx.db, owner_id, guild_id)
        .await
        .expect("add owner");
    // Membership first: the realtime session snapshots the buildings it belongs
    // to when it is created.
    let member_id = member_user_id(&ctx.db, &ctx.jwt_secret, &member_token).await;
    paracord_db::members::add_member(&ctx.db, member_id, guild_id)
        .await
        .expect("add member");
    let (member_session, _) = create_session(&ctx.app, &member_token).await;

    let channel_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(
        &ctx.db,
        channel_id,
        guild_id,
        "perm-loss",
        0,
        0,
        None,
        None,
    )
    .await
    .expect("create channel");

    // The member is sitting in the app with the room open.
    let ticket = mint_stream_ticket(&ctx.app, &member_token).await;
    let member_reader = reader(ctx.app.clone(), ticket, member_session.clone(), |frame| {
        frame["t"] == "CHANNEL_DELETE" || frame["t"] == "CHANNEL_UPDATE"
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    // @everyone loses VIEW_CHANNEL on this room, and the route that does it
    // announces the change the only way it can: a bare CHANNEL_UPDATE.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        channel_id,
        guild_id,
        paracord_core::permissions::OVERWRITE_TARGET_ROLE,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .expect("deny VIEW_CHANNEL");
    paracord_core::permissions::invalidate_channel_tree(
        &ctx.db,
        &ctx.state.permission_cache,
        channel_id,
    )
    .await
    .expect("invalidate");
    ctx.state.event_bus.dispatch(
        "CHANNEL_UPDATE",
        json!({ "id": channel_id.to_string() }),
        Some(guild_id),
    );

    let frames = member_reader.await.expect("member reader");
    let delivered = frames
        .iter()
        .find(|frame| frame["t"] == "CHANNEL_DELETE" || frame["t"] == "CHANNEL_UPDATE")
        .unwrap_or_else(|| panic!("no channel event reached the member: {frames:?}"));

    assert_eq!(
        delivered["t"], "CHANNEL_DELETE",
        "a room the member may no longer view must arrive as it going away, not be dropped: \
         {frames:?}",
    );
    assert_eq!(
        delivered["d"]["id"].as_str(),
        Some(channel_id.to_string().as_str()),
        "the delete must name the room that was taken away",
    );
    assert_eq!(
        delivered["d"]["guild_id"].as_str(),
        Some(guild_id.to_string().as_str()),
        "the delete must name the building the room was in",
    );
}

#[tokio::test]
async fn a_room_you_never_saw_is_still_none_of_your_business() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");

    let owner_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "owner2", "hunter2hunter2")
            .await
            .expect("owner token");
    let (_owner_session, owner_id) = create_session(&ctx.app, &owner_token).await;

    let member_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "member2", "hunter2hunter2")
            .await
            .expect("member token");

    let guild_id = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&ctx.db, guild_id, "Harbour Lights", owner_id, None)
        .await
        .expect("create guild");
    paracord_db::members::add_member(&ctx.db, owner_id, guild_id)
        .await
        .expect("add owner");
    let member_id = member_user_id(&ctx.db, &ctx.jwt_secret, &member_token).await;
    paracord_db::members::add_member(&ctx.db, member_id, guild_id)
        .await
        .expect("add member");
    let (member_session, _) = create_session(&ctx.app, &member_token).await;

    let channel_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(
        &ctx.db, channel_id, guild_id, "private", 0, 0, None, None,
    )
    .await
    .expect("create channel");
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        channel_id,
        guild_id,
        paracord_core::permissions::OVERWRITE_TARGET_ROLE,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .expect("deny VIEW_CHANNEL");

    let ticket = mint_stream_ticket(&ctx.app, &member_token).await;
    // The liveness probe is a building-scoped event with no room in it, so it
    // is not subject to the per-room filter this test is about.
    let member_reader = reader(ctx.app.clone(), ticket, member_session.clone(), |frame| {
        frame["t"] == "GUILD_UPDATE"
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A message in a room they cannot see stays invisible…
    ctx.state.event_bus.dispatch(
        "MESSAGE_CREATE",
        json!({ "id": "1", "channel_id": channel_id.to_string() }),
        Some(guild_id),
    );
    // …and so does its creation.
    ctx.state.event_bus.dispatch(
        "CHANNEL_CREATE",
        json!({ "id": channel_id.to_string() }),
        Some(guild_id),
    );
    // The stream itself is alive.
    ctx.state.event_bus.dispatch(
        "GUILD_UPDATE",
        json!({ "id": guild_id.to_string(), "name": "Harbour Lights" }),
        Some(guild_id),
    );

    let frames = member_reader.await.expect("member reader");
    assert!(
        frames.iter().any(|frame| frame["t"] == "GUILD_UPDATE"),
        "the stream must have been delivering at all: {frames:?}",
    );
    assert!(
        frames.iter().all(|frame| {
            frame["d"]["channel_id"].as_str() != Some(channel_id.to_string().as_str())
                && frame["d"]["id"].as_str() != Some(channel_id.to_string().as_str())
        }),
        "only CHANNEL_UPDATE is re-cast; everything else about an invisible room stays \
         invisible: {frames:?}",
    );
}
