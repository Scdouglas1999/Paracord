//! Availability regressions for the resource ceilings a single authenticated
//! user could otherwise walk past: upload buffering, disk growth, the reaction
//! read path, and listings that returned whole tables.
//!
//! Every test here demonstrates a *bound*. None of them allocates gigabytes or
//! fills a disk.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::Context;
use axum::{
    body::{to_bytes, Body, Bytes},
    http::{header, Method, Request, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};
use tower::ServiceExt;

const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB1, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
];

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    token: String,
    test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "avail",
            "AvailPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            token,
            test_app,
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

    async fn request_multipart(
        &self,
        path: &str,
        body: Body,
        boundary: &str,
    ) -> anyhow::Result<(StatusCode, String)> {
        let request = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)?;
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await?;
        Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn user_id(&self) -> anyhow::Result<i64> {
        let claims = paracord_core::auth::validate_token(&self.token, &self.test_app.jwt_secret)?;
        Ok(claims.sub)
    }
}

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<i64> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create guild failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .context("guild id should be a string")?
        .parse()?)
}

async fn create_channel(
    ctx: &TestContext,
    guild_id: i64,
    name: &str,
    channel_type: i16,
) -> anyhow::Result<i64> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": name,
                "channel_type": channel_type,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create channel failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .parse()?)
}

/// One multipart part carrying `bytes` bytes of filler, as a single buffer.
fn multipart_file(boundary: &str, filename: &str, content_type: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// A named image part plus its `name` field, for the emoji/sticker endpoints.
fn multipart_named_image(boundary: &str, name: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"name\"\r\n\r\n");
    body.extend_from_slice(format!("{name}\r\n").as_bytes());
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"image\"; filename=\"overflow.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(PNG_1X1);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// A multipart body that hands out one chunk per wake-up, counting how many the
/// server actually pulled.
///
/// The `Poll::Pending` between chunks is what makes the count meaningful: it is
/// how a real socket behaves, and without it multer drains a synchronously
/// ready stream into its own buffer in a single pass, hiding whether the
/// handler stopped reading. Only one filler buffer is ever allocated -- `Bytes`
/// clones share it -- so the "8 MiB body" below costs 64 KiB of test memory.
struct PacedMultipartBody {
    head: Option<Bytes>,
    filler: Bytes,
    remaining: usize,
    tail: Option<Bytes>,
    polled: Arc<AtomicUsize>,
    ready: bool,
}

impl futures_util::Stream for PacedMultipartBody {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if !self.ready {
            self.ready = true;
            cx.waker().wake_by_ref();
            return std::task::Poll::Pending;
        }
        self.ready = false;

        let next = if let Some(head) = self.head.take() {
            Some(head)
        } else if self.remaining > 0 {
            self.remaining -= 1;
            Some(self.filler.clone())
        } else {
            self.tail.take()
        };

        match next {
            Some(chunk) => {
                self.polled.fetch_add(1, Ordering::Relaxed);
                std::task::Poll::Ready(Some(Ok(chunk)))
            }
            None => std::task::Poll::Ready(None),
        }
    }
}

fn counting_multipart_body(
    boundary: &str,
    chunk_len: usize,
    chunk_count: usize,
) -> (Body, Arc<AtomicUsize>) {
    let polled = Arc::new(AtomicUsize::new(0));
    let stream = PacedMultipartBody {
        head: Some(Bytes::from(format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
             filename=\"flood.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        ))),
        filler: Bytes::from(vec![b'A'; chunk_len]),
        remaining: chunk_count,
        tail: Some(Bytes::from(format!("\r\n--{boundary}--\r\n"))),
        polled: Arc::clone(&polled),
        ready: true,
    };
    (Body::from_stream(stream), polled)
}

/// H3: an over-limit attachment must be refused *while* it is read, not after
/// it is fully resident. The body below is 128 x 64 KiB while the space's
/// policy caps a single upload at 64 KiB, so only a handful of chunks may ever
/// come off the socket.
#[tokio::test]
async fn oversized_attachment_is_refused_before_the_body_is_buffered() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Upload Ceiling").await?;
    let channel_id = create_channel(&ctx, guild_id, "uploads", 0).await?;

    const CHUNK: usize = 64 * 1024;
    const CHUNKS: usize = 128;

    paracord_db::guild_storage_policies::upsert_guild_storage_policy(
        &ctx.db,
        guild_id,
        Some(CHUNK as i64),
        None,
        None,
        None,
        None,
    )
    .await?;

    let boundary = "----paracord-upload-ceiling-boundary";
    let (body, polled) = counting_multipart_body(boundary, CHUNK, CHUNKS);

    let (status, response) = ctx
        .request_multipart(
            &format!("/api/v1/channels/{channel_id}/attachments"),
            body,
            boundary,
        )
        .await?;

    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "over-limit upload should be refused: {response}"
    );

    // A chunk or two past the ceiling is inherent to reading in chunks; the
    // whole body is not. A count near CHUNKS means it was buffered first.
    let pulled = polled.load(Ordering::Relaxed);
    assert!(
        pulled < 8,
        "server pulled {pulled} of {CHUNKS} body chunks; the size ceiling must \
         stop the read instead of checking an already-resident buffer"
    );

    Ok(())
}

/// H4: the advertised `max_guild_storage_quota` must apply with no per-space
/// policy row -- which is the default posture on every instance.
#[tokio::test]
async fn server_storage_quota_applies_without_a_space_policy_row() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Quota Default").await?;
    let channel_id = create_channel(&ctx, guild_id, "uploads", 0).await?;

    // Admin-configured server-wide ceiling. No guild_storage_policies row exists.
    paracord_db::server_settings::set_setting(&ctx.db, "max_guild_storage_quota", "1024").await?;

    let boundary = "----paracord-quota-default-boundary";
    let path = format!("/api/v1/channels/{channel_id}/attachments");
    let payload = multipart_file(
        boundary,
        "blob.bin",
        "application/octet-stream",
        &[b'A'; 600],
    );

    let (status, response) = ctx
        .request_multipart(&path, Body::from(payload.clone()), boundary)
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "an upload inside the quota must still be accepted: {response}"
    );

    let (status, response) = ctx
        .request_multipart(&path, Body::from(payload), boundary)
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the second upload crosses the 1 KiB server quota: {response}"
    );
    assert!(
        response.contains("quota"),
        "the rejection should name the quota: {response}"
    );

    Ok(())
}

/// H4: emoji files never reach the storage accounting, so their count is the
/// only thing that bounds them.
#[tokio::test]
async fn emoji_count_per_space_is_capped() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Emoji Cap").await?;
    let user_id = ctx.user_id()?;

    // Fill the space to its cap directly; the API path is what the rejection
    // below exercises.
    for index in 0..250 {
        paracord_db::emojis::create_emoji(
            &ctx.db,
            paracord_util::snowflake::generate(1),
            guild_id,
            &format!("filler{index}"),
            user_id,
            false,
        )
        .await?;
    }

    let boundary = "----paracord-emoji-cap-boundary";
    let (status, response) = ctx
        .request_multipart(
            &format!("/api/v1/guilds/{guild_id}/emojis"),
            Body::from(multipart_named_image(boundary, "overflow")),
            boundary,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "an emoji past the per-space cap must be refused: {response}"
    );

    Ok(())
}

/// H4: stickers are 1 MB each and equally invisible to storage accounting.
#[tokio::test]
async fn sticker_count_per_space_is_capped() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Sticker Cap").await?;
    let user_id = ctx.user_id()?;

    for index in 0..60 {
        paracord_db::stickers::create_sticker(
            &ctx.db,
            paracord_util::snowflake::generate(1),
            guild_id,
            &format!("filler{index}"),
            None,
            1,
            Some("stickers/filler"),
            Some("image/png"),
            Some(user_id),
        )
        .await?;
    }

    let boundary = "----paracord-sticker-cap-boundary";
    let (status, response) = ctx
        .request_multipart(
            &format!("/api/v1/guilds/{guild_id}/stickers"),
            Body::from(multipart_named_image(boundary, "overflow")),
            boundary,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a sticker past the per-space cap must be refused: {response}"
    );

    Ok(())
}

/// Reactions sit on the hottest read path in the product: every `GET /messages`
/// page aggregates them. A message must not be able to carry an unbounded set
/// of distinct emoji.
#[tokio::test]
async fn distinct_reactions_per_message_are_capped() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Reaction Cap").await?;
    let channel_id = create_channel(&ctx, guild_id, "general", 0).await?;

    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "react to me" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create message failed: {message}"
    );
    let message_id = message["id"].as_str().context("message id")?.to_string();

    let cap = paracord_db::reactions::MAX_REACTIONS_PER_MESSAGE as usize;
    for index in 0..cap {
        let (status, payload) = ctx
            .request_json(
                Method::PUT,
                &format!(
                    "/api/v1/channels/{channel_id}/messages/{message_id}/reactions/react{index}/@me"
                ),
                None,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "reaction {index} should be accepted: {payload}"
        );
    }

    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}/reactions/toomany/@me"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "distinct reaction {} must be refused: {payload}",
        cap + 1
    );

    // An emoji the message already carries never widens the aggregate, so it
    // stays reactable at the cap.
    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}/reactions/react0/@me"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "an existing emoji must stay reactable at the cap: {payload}"
    );

    Ok(())
}

/// The read side is bounded independently of the write side, so rows written
/// before the cap existed cannot make the aggregate unbounded.
#[tokio::test]
async fn reaction_aggregates_stay_bounded_for_pre_existing_rows() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Reaction Read Bound").await?;
    let channel_id = create_channel(&ctx, guild_id, "general", 0).await?;
    let user_id = ctx.user_id()?;

    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "legacy reactions" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create message failed: {message}"
    );
    let message_id: i64 = message["id"].as_str().context("message id")?.parse()?;

    // Written straight to the table, standing in for rows that predate the
    // insert-side cap.
    let cap = paracord_db::reactions::MAX_REACTIONS_PER_MESSAGE;
    for index in 0..(cap + 15) {
        sqlx::query(
            "INSERT INTO reactions (message_id, user_id, emoji_name, emoji_id)
             VALUES ($1, $2, $3, NULL)",
        )
        .bind(message_id)
        .bind(user_id)
        .bind(format!("legacy{index}"))
        .execute(&ctx.db)
        .await?;
    }

    let aggregated = paracord_db::reactions::get_message_reactions(&ctx.db, message_id).await?;
    assert_eq!(
        aggregated.len() as i64,
        cap,
        "the per-message aggregate must stop at the cap regardless of stored rows"
    );

    let batched =
        paracord_db::reactions::get_reactions_for_message_ids(&ctx.db, &[message_id]).await?;
    assert!(
        batched.len() as i64 <= cap,
        "the batched aggregate every GET /messages runs must be bounded too, got {}",
        batched.len()
    );

    let viewer = paracord_db::reactions::get_viewer_reactions_for_message_ids(
        &ctx.db,
        &[message_id],
        user_id,
    )
    .await?;
    assert!(
        viewer.len() as i64 <= cap,
        "the viewer-reaction lookup must be bounded too, got {}",
        viewer.len()
    );

    Ok(())
}

/// Forum posts are channel rows any member can create, and the listing used to
/// return every one of them.
#[tokio::test]
async fn forum_post_listing_is_paginated() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Forum Paging").await?;
    let forum_id = create_channel(&ctx, guild_id, "forum", 7).await?;
    let user_id = ctx.user_id()?;

    for index in 0..6 {
        paracord_db::channels::create_forum_post(
            &ctx.db,
            paracord_util::snowflake::generate(1),
            guild_id,
            forum_id,
            &format!("post {index}"),
            user_id,
            None,
        )
        .await?;
    }

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{forum_id}/forum/posts?limit=2"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list forum posts failed: {payload}");
    assert_eq!(
        payload["posts"].as_array().context("posts array")?.len(),
        2,
        "forum post listing must honour the requested page size: {payload}"
    );

    // An absurd limit clamps instead of being taken literally.
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{forum_id}/forum/posts?limit=100000"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list forum posts failed: {payload}");
    assert!(
        payload["limit"].as_i64().context("limit echo")? <= 100,
        "an over-large limit must clamp: {payload}"
    );

    Ok(())
}

/// The ban list returned every row and paid one `get_user_by_id` per row.
#[tokio::test]
async fn ban_listing_is_paginated() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Ban Paging").await?;
    let user_id = ctx.user_id()?;

    for index in 0..5 {
        let banned_id = paracord_util::snowflake::generate(1);
        paracord_db::users::create_user(
            &ctx.db,
            banned_id,
            &format!("banned{index}"),
            1,
            &format!("banned{index}@example.com"),
            "hash",
        )
        .await?;
        paracord_db::bans::create_ban(&ctx.db, banned_id, guild_id, Some("bulk"), user_id).await?;
    }

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/bans?limit=2"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list bans failed: {payload}");
    assert_eq!(
        payload.as_array().context("bans array")?.len(),
        2,
        "ban listing must honour the requested page size: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/bans?limit=1&offset=4"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list bans failed: {payload}");
    assert_eq!(
        payload.as_array().context("bans array")?.len(),
        1,
        "ban listing must honour the offset: {payload}"
    );

    Ok(())
}

/// Every event row cost two extra queries (`get_rsvp_count` + `has_rsvp`).
#[tokio::test]
async fn event_listing_is_paginated() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Event Paging").await?;
    let user_id = ctx.user_id()?;

    for index in 0..5 {
        let start = chrono::Utc::now() + chrono::Duration::hours(index + 1);
        paracord_db::scheduled_events::create_event(
            &ctx.db,
            paracord_util::snowflake::generate(1),
            guild_id,
            user_id,
            &format!("event {index}"),
            None,
            &start.to_rfc3339(),
            None,
            2,
            None,
            Some("somewhere"),
            None,
            None,
            None,
            None,
        )
        .await?;
    }

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/events?limit=2"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list events failed: {payload}");
    assert_eq!(
        payload.as_array().context("events array")?.len(),
        2,
        "event listing must honour the requested page size: {payload}"
    );

    Ok(())
}

/// Registration is the cheapest request a client can make, and auto-join used
/// to do two writes for every open public space on the instance.
#[tokio::test]
async fn registration_auto_join_is_capped() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let owner_id = paracord_util::snowflake::generate(1);
    paracord_db::users::create_user(
        &test_app.db,
        owner_id,
        "spaceowner",
        1,
        "spaceowner@example.com",
        "hash",
    )
    .await?;

    // 30 open public spaces: more than the auto-join cap.
    for index in 0..30 {
        let space_id = paracord_util::snowflake::generate(1);
        paracord_db::guilds::create_guild(
            &test_app.db,
            space_id,
            &format!("open space {index}"),
            owner_id,
            None,
        )
        .await?;
        paracord_db::guilds::update_space_visibility(
            &test_app.db,
            paracord_models::id::GuildId::new(space_id),
            "public",
            "[]",
            Some("[]"),
        )
        .await?;
    }

    let (status, registered) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": "capped@example.com",
                "username": "cappedjoiner",
                "password": "CappedPass123!"
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
    let token = registered["token"].as_str().context("register token")?;

    let (status, guilds) = dispatch_json(
        &test_app.app,
        build_json_request(Method::GET, "/api/v1/users/@me/guilds", None, Some(token))?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "list guilds failed: {guilds}");
    let joined = guilds.as_array().context("guild list")?.len();
    assert!(
        joined <= 25,
        "registration auto-join must be capped, joined {joined} spaces"
    );
    assert!(
        joined > 0,
        "auto-join must still happen for the spaces inside the cap"
    );

    Ok(())
}

/// A client-chosen prekey id that collides with another account's must not deny
/// that account's publication -- the collision used to abort the INSERT and
/// surface as a 500, which breaks E2EE DM setup.
#[tokio::test]
async fn colliding_prekey_ids_do_not_deny_publication() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let squatter_token = create_authenticated_user_token(
        &ctx.db,
        &ctx.test_app.jwt_secret,
        "squatter",
        "AvailPass123!",
    )
    .await?;

    // Client ids are derived from wall-clock time, so a squatter can guess them.
    let shared_id = 1_754_000_000_000_i64;
    let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let payload = json!({
        "one_time_prekeys": [
            { "id": shared_id, "public_key": key },
            { "id": shared_id + 1, "public_key": key }
        ]
    });

    let (status, response) = dispatch_json(
        &ctx.app,
        build_json_request(
            Method::PUT,
            "/api/v1/users/@me/keys",
            Some(payload.clone()),
            Some(&squatter_token),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "the squatter's own upload should succeed: {response}"
    );

    let (status, response) = ctx
        .request_json(Method::PUT, "/api/v1/users/@me/keys", Some(payload))
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "a prekey id already claimed by another account must not deny publication: {response}"
    );
    assert_eq!(
        response["one_time_prekeys_total"].as_i64(),
        Some(2),
        "the victim's own prekeys must actually be stored: {response}"
    );

    // Consuming the victim's pool must hand back the victim's key, not the
    // squatter's row that shares the id.
    let victim_id = ctx.user_id()?;
    let consumed = paracord_db::prekeys::consume_one_time_prekey(&ctx.db, victim_id)
        .await?
        .context("victim should have a consumable prekey")?;
    assert_eq!(consumed.user_id, victim_id);
    assert_eq!(
        paracord_db::prekeys::count_one_time_prekeys(&ctx.db, victim_id).await?,
        1,
        "consuming one of the victim's keys must not touch the squatter's"
    );

    Ok(())
}
