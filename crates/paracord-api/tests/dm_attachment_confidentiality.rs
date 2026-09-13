//! What the server may learn from an attachment sent in an end-to-end encrypted
//! conversation.
//!
//! The client encrypts every direct-message attachment under its own key and
//! uploads only the ciphertext, under a generated name, as
//! `application/octet-stream`. These tests hold the server to the other half of
//! that bargain: it stores exactly the bytes it was handed, keeps no name, type
//! or dimensions the sender did not have to give it, derives no preview, and
//! still enforces its own upload ceiling — on the ciphertext, which is what it
//! actually receives.
//!
//! A guild channel is checked alongside each case so the ordinary plaintext
//! upload path is demonstrably unchanged.
//!
//! Run against PostgreSQL as well with `PARACORD_TEST_POSTGRES_URL`.

mod common;

use anyhow::Context;
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
    Router,
};
use common::{build_json_request, build_test_app, dispatch_json, TestApp, TestAppOptions};
use serde_json::{json, Value};
use tower::ServiceExt;

/// A real PNG, so any sniffing or preview derivation the server did would have
/// something to find. Uploaded to a DM it must remain an opaque blob anyway.
const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB1, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// Stands in for a client-encrypted body: high-entropy bytes with no structure.
fn ciphertext(len: usize) -> Vec<u8> {
    (0..len).map(|i| ((i * 37 + 11) % 251) as u8).collect()
}

struct Ctx {
    app: Router,
    test_app: TestApp,
    alice: String,
    alice_id: i64,
    bob_id: i64,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let alice = common::create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "dmalice",
            "DmAlicePass123!",
        )
        .await?;
        let bob = common::create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "dmbob",
            "DmBobPass123!",
        )
        .await?;
        let alice_id = paracord_core::auth::validate_token(&alice, &test_app.jwt_secret)?.sub;
        let bob_id = paracord_core::auth::validate_token(&bob, &test_app.jwt_secret)?.sub;
        Ok(Self {
            app: test_app.app.clone(),
            test_app,
            alice,
            alice_id,
            bob_id,
        })
    }

    async fn dm_channel(&self) -> anyhow::Result<i64> {
        let channel_id = paracord_util::snowflake::generate(1);
        paracord_db::dms::create_dm_channel(
            &self.test_app.db,
            channel_id,
            self.alice_id,
            self.bob_id,
        )
        .await?;
        Ok(channel_id)
    }

    async fn guild_channel(&self) -> anyhow::Result<i64> {
        let (status, guild) = self
            .json(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Plaintext space", "icon": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "create guild: {guild}");
        let guild_id = guild["id"].as_str().context("guild id")?;
        let (status, channel) = self
            .json(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!({
                    "name": "general",
                    "channel_type": 0,
                    "parent_id": Value::Null,
                    "required_role_ids": Value::Null,
                })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "create channel: {channel}");
        Ok(channel["id"].as_str().context("channel id")?.parse()?)
    }

    async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(&self.alice))?;
        dispatch_json(&self.app, request).await
    }

    async fn upload(
        &self,
        channel_id: i64,
        filename: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> anyhow::Result<(StatusCode, Value)> {
        let boundary = "paracord-dm-attachment-boundary";
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

        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/api/v1/channels/{channel_id}/attachments"))
            .header(header::AUTHORIZATION, format!("Bearer {}", self.alice))
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
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        Ok((status, payload))
    }

    /// The bytes actually on disk for an attachment, as the server named it.
    async fn stored(&self, attachment_id: i64) -> anyhow::Result<Vec<u8>> {
        let attachment = paracord_db::attachments::get_attachment(&self.test_app.db, attachment_id)
            .await?
            .context("attachment row")?;
        let ext = std::path::Path::new(&attachment.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let key = format!("attachments/{}.{}", attachment.id, ext);
        Ok(self.test_app.state.storage_backend.retrieve(&key).await?)
    }
}

#[tokio::test]
async fn dm_upload_stores_exactly_the_ciphertext_under_an_opaque_name() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let channel_id = ctx.dm_channel().await?;
    let body = ciphertext(4096);

    let (status, payload) = ctx
        .upload(
            channel_id,
            "0123456789abcdef0123456789abcdef.bin",
            "application/octet-stream",
            &body,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "dm upload: {payload}");

    assert_eq!(
        payload["filename"], "0123456789abcdef0123456789abcdef.bin",
        "the client's opaque name is what the server keeps"
    );
    assert_eq!(payload["content_type"], "application/octet-stream");
    assert_eq!(payload["size"], body.len() as i64);

    let attachment_id: i64 = payload["id"].as_str().context("attachment id")?.parse()?;
    assert_eq!(
        ctx.stored(attachment_id).await?,
        body,
        "the stored object is byte-for-byte what the client uploaded"
    );

    // Nothing derived: no preview, no dimensions, and a name that says nothing.
    let attachment = paracord_db::attachments::get_attachment(&ctx.test_app.db, attachment_id)
        .await?
        .context("attachment row")?;
    assert_eq!(attachment.width, None, "no dimensions are derived");
    assert_eq!(attachment.height, None, "no dimensions are derived");
    assert_eq!(
        attachment.content_type.as_deref(),
        Some("application/octet-stream")
    );
    assert!(
        attachment.filename.ends_with(".bin"),
        "stored name stays opaque: {}",
        attachment.filename
    );
    Ok(())
}

#[tokio::test]
async fn dm_upload_keeps_no_filename_or_type_from_the_client() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let channel_id = ctx.dm_channel().await?;

    // A client that names the file and declares an image type — an older client,
    // or any path other than the encrypted producer — still leaves the server
    // with nothing to read: the name and type are replaced, not recorded.
    let (status, payload) = ctx
        .upload(channel_id, "tax-return-2026.png", "image/png", PNG_1X1)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "dm upload: {payload}");
    let filename = payload["filename"].as_str().context("filename")?;
    assert!(
        !filename.contains("tax-return"),
        "the sender's filename must not survive: {filename}"
    );
    assert!(filename.ends_with(".bin"), "generated name: {filename}");
    assert_eq!(
        payload["content_type"], "application/octet-stream",
        "no type is sniffed or believed for an encrypted conversation"
    );

    let attachment_id: i64 = payload["id"].as_str().context("attachment id")?.parse()?;
    assert_eq!(filename, format!("{attachment_id}.bin"));

    // The same file in a guild channel keeps its plaintext handling untouched.
    let guild_channel = ctx.guild_channel().await?;
    let (status, guild_payload) = ctx
        .upload(guild_channel, "tax-return-2026.png", "image/png", PNG_1X1)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "guild upload: {guild_payload}");
    assert_eq!(guild_payload["filename"], "tax-return-2026.png");
    assert_eq!(guild_payload["content_type"], "image/png");
    Ok(())
}

#[tokio::test]
async fn dm_download_returns_the_ciphertext_as_an_opaque_attachment() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let channel_id = ctx.dm_channel().await?;
    let body = ciphertext(2048);
    let (status, payload) = ctx
        .upload(
            channel_id,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin",
            "application/octet-stream",
            &body,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "dm upload: {payload}");
    let attachment_id = payload["id"].as_str().context("attachment id")?.to_string();

    // Link it to a message so the download route can authorize it.
    let (status, message) = ctx
        .json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({
                "content": "",
                "attachment_ids": [attachment_id],
                "e2ee": {
                    "version": 2,
                    "nonce": "AAAAAAAAAAAAAAAA",
                    "ciphertext": "AAAAAAAAAAAAAAAAAAAAAAAA",
                    "header": "{\"dh\":\"AA\",\"pn\":0,\"n\":0}"
                }
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create message: {message}");
    assert!(
        message["content"].as_str().unwrap_or_default().is_empty(),
        "the server stores no plaintext body for an encrypted message: {message}"
    );

    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/v1/attachments/{attachment_id}"))
        .header(header::AUTHORIZATION, format!("Bearer {}", ctx.alice))
        .body(Body::empty())?;
    let response = ctx.app.clone().oneshot(request).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let disposition = response
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert_eq!(content_type, "application/octet-stream");
    assert!(
        disposition.starts_with("attachment;"),
        "an encrypted conversation's blob is never served inline: {disposition}"
    );
    let downloaded = to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(
        downloaded.to_vec(),
        body,
        "the recipient gets exactly the ciphertext to decrypt"
    );
    Ok(())
}

#[tokio::test]
async fn dm_ciphertext_upload_limit_is_enforced_on_the_bytes_received() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let channel_id = ctx.dm_channel().await?;
    let max = ctx.test_app.state.config.max_upload_size;
    assert!(max > 0, "the harness must configure an upload ceiling");

    let (status, payload) = ctx
        .upload(
            channel_id,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bin",
            "application/octet-stream",
            &ciphertext(usize::try_from(max)? + 1),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "over-limit ciphertext must be refused: {payload}"
    );
    assert!(
        payload.to_string().contains("upload limit"),
        "the refusal names the ceiling: {payload}"
    );

    // The ceiling applies to what the server receives, so a body exactly at the
    // limit is still accepted.
    let (status, payload) = ctx
        .upload(
            channel_id,
            "cccccccccccccccccccccccccccccccc.bin",
            "application/octet-stream",
            &ciphertext(usize::try_from(max)?),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "at-limit upload: {payload}");
    Ok(())
}

#[tokio::test]
async fn a_non_recipient_cannot_upload_into_the_conversation() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let channel_id = ctx.dm_channel().await?;
    let stranger = common::create_authenticated_user_token(
        &ctx.test_app.db,
        &ctx.test_app.jwt_secret,
        "dmstranger",
        "DmStrangerPass123!",
    )
    .await?;

    let boundary = "paracord-dm-attachment-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"dddddddddddddddddddddddddddddddd.bin\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(&ciphertext(64));
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/v1/channels/{channel_id}/attachments"))
        .header(header::AUTHORIZATION, format!("Bearer {stranger}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))?;
    let response = ctx.app.clone().oneshot(request).await?;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    Ok(())
}
