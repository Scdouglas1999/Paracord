//! Banners, sticker tags, and the media gallery.

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
    jwt_secret: String,
    token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "assets",
            "AssetsPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            token,
            _test_app: test_app,
        })
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_json_as(method, path, body, &self.token).await
    }

    async fn request_json_as(
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
            .request_json_as(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"].as_str().context("user id")?.parse::<i64>()?)
    }

    async fn add_member(&self, prefix: &str, guild_id: i64) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
        paracord_db::members::add_member(&self.db, uid, guild_id).await?;
        paracord_db::roles::add_member_role(&self.db, uid, guild_id, guild_id).await?;
        Ok((token, uid))
    }

    async fn post_multipart(
        &self,
        path: &str,
        body: Vec<u8>,
        boundary: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.post_multipart_as(path, body, boundary, &self.token)
            .await
    }

    async fn post_multipart_as(
        &self,
        path: &str,
        body: Vec<u8>,
        boundary: &str,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = Request::builder()
            .method(Method::POST)
            .uri(path)
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
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        Ok((status, payload))
    }
}

fn png_part(boundary: &str, field: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"{field}\"; filename=\"banner.png\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(PNG_1X1);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

fn text_attachment(boundary: &str, filename: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<i64> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{payload}");
    Ok(payload["id"].as_str().context("guild id")?.parse()?)
}

async fn create_channel(ctx: &TestContext, guild_id: i64, name: &str) -> anyhow::Result<i64> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": name,
                "channel_type": 0,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{payload}");
    Ok(payload["id"].as_str().context("channel id")?.parse()?)
}

async fn upload_and_post(
    ctx: &TestContext,
    channel_id: i64,
    filename: &str,
    content_type: &str,
    bytes: &[u8],
    content: &str,
) -> anyhow::Result<String> {
    let boundary = format!("bound-{filename}");
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
    let (status, payload) = ctx
        .post_multipart(
            &format!("/api/v1/channels/{channel_id}/attachments"),
            body,
            &boundary,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "upload {filename}: {payload}");
    let attachment_id = payload["id"].as_str().context("attachment id")?.to_string();
    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": content, "attachment_ids": [attachment_id] })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    Ok(attachment_id)
}

#[tokio::test]
async fn user_banner_and_accent_round_trip() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let user_id = ctx.user_id(&ctx.token).await?;

    let (status, rejected) = ctx
        .post_multipart(
            "/api/v1/users/@me/banner",
            text_attachment("not-image", "notes.txt", b"hello"),
            "not-image",
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");

    let (status, uploaded) = ctx
        .post_multipart(
            "/api/v1/users/@me/banner",
            png_part("banner", "banner"),
            "banner",
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    let banner_hash = uploaded["banner_hash"].as_str().context("banner_hash")?;
    assert!(
        banner_hash.starts_with(&format!("/api/v1/users/{user_id}/banner?v=")),
        "{banner_hash}"
    );

    let request = build_json_request(
        Method::GET,
        &format!("/api/v1/users/{user_id}/banner"),
        None,
        Some(&ctx.token),
    )?;
    let response = ctx.app.clone().oneshot(request).await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("image/png")
    );

    let (status, _) = ctx
        .request_json(Method::DELETE, "/api/v1/users/@me/banner", None)
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/users/{user_id}/banner"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            "/api/v1/users/@me",
            Some(json!({ "accent_color": 0x336699 })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["accent_color"].as_i64(), Some(0x336699));

    let (status, too_big) = ctx
        .request_json(
            Method::PATCH,
            "/api/v1/users/@me",
            Some(json!({ "accent_color": 0x1000000 })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{too_big}");

    let (status, cleared) = ctx
        .request_json(
            Method::PATCH,
            "/api/v1/users/@me",
            Some(json!({ "accent_color": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert!(cleared["accent_color"].is_null());
    Ok(())
}

#[tokio::test]
async fn guild_banner_requires_manage_guild() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Banner Guild").await?;
    let (member, _) = ctx.add_member("guest", guild_id).await?;

    let (status, denied) = ctx
        .post_multipart_as(
            &format!("/api/v1/guilds/{guild_id}/banner"),
            png_part("gb", "banner"),
            "gb",
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");

    let (status, uploaded) = ctx
        .post_multipart(
            &format!("/api/v1/guilds/{guild_id}/banner"),
            png_part("gb2", "banner"),
            "gb2",
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    let banner_hash = uploaded["banner_hash"].as_str().context("banner_hash")?;
    assert!(
        banner_hash.starts_with(&format!("/api/v1/guilds/{guild_id}/banner?v=")),
        "{banner_hash}"
    );

    let (status, _) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/banner"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn sticker_tags_can_be_set_and_edited() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Sticker Guild").await?;
    let boundary = "sticker-tags";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"name\"\r\n\r\nwave\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"tags\"\r\n\r\nwave, party\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"image\"; filename=\"wave.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(PNG_1X1);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let (status, created) = ctx
        .post_multipart(
            &format!("/api/v1/guilds/{guild_id}/stickers"),
            body,
            boundary,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["tags"], json!(["wave", "party"]));
    let sticker_id = created["id"].as_str().context("sticker id")?;

    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/stickers/{sticker_id}"),
            Some(json!({ "name": "ocean", "tags": ["sea"] })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["name"], "ocean");
    assert_eq!(updated["tags"], json!(["sea"]));
    Ok(())
}

#[tokio::test]
async fn gallery_pages_by_kind_and_hides_unreadable_channels() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Gallery Guild").await?;
    let open_id = create_channel(&ctx, guild_id, "open").await?;
    let secret_id = create_channel(&ctx, guild_id, "secret").await?;
    let (member, _) = ctx.add_member("reader", guild_id).await?;

    let image_id =
        upload_and_post(&ctx, open_id, "pic.png", "image/png", PNG_1X1, "an image").await?;
    let file_id =
        upload_and_post(&ctx, open_id, "notes.txt", "text/plain", b"notes", "a file").await?;
    let secret_file = upload_and_post(
        &ctx,
        secret_id,
        "secret.txt",
        "text/plain",
        b"hidden",
        "https://hidden.example/secret",
    )
    .await?;

    sqlx::query("UPDATE attachments SET width = $2, height = $3 WHERE id = $1")
        .bind(image_id.parse::<i64>()?)
        .bind(1500_i32)
        .bind(500_i32)
        .execute(&ctx.db)
        .await?;

    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{open_id}/messages"),
            Some(json!({ "content": "see https://example.com/docs" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    let link_message_id = message["id"].as_str().context("message id")?;
    sqlx::query("UPDATE messages SET embeds = $2 WHERE id = $1")
        .bind(link_message_id.parse::<i64>()?)
        .bind(
            r#"[{"type":"link","url":"https://example.com/docs","title":"Docs","provider":{"name":"Example"},"thumbnail":{"url":"https://example.com/docs.png"}}]"#,
        )
        .execute(&ctx.db)
        .await?;

    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        secret_id,
        guild_id,
        paracord_core::permissions::OVERWRITE_TARGET_ROLE,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;

    let (status, images) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/channels/{open_id}/attachments?kind=image"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{images}");
    let image_items = images["items"].as_array().context("items")?;
    assert_eq!(image_items.len(), 1);
    assert_eq!(image_items[0]["id"], image_id);
    assert_eq!(image_items[0]["kind"], "image");
    assert_eq!(image_items[0]["width"], 1500);
    assert_eq!(image_items[0]["height"], 500);
    assert!(image_items[0]["author"]["id"].is_string());
    assert!(image_items[0]["message_id"].is_string());
    assert!(image_items[0]["created_at"].is_string());

    let (status, files) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/channels/{open_id}/attachments?kind=file&limit=1"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{files}");
    assert_eq!(files["items"][0]["id"], file_id);
    assert_eq!(files["items"].as_array().map(|items| items.len()), Some(1));

    let (status, bad_kind) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{open_id}/attachments?kind=audio"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad_kind}");
    let (status, bad_limit) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{open_id}/attachments?limit=101"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad_limit}");

    let (status, hidden) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/channels/{secret_id}/attachments"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{hidden}");

    let (status, guild_page) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/attachments"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{guild_page}");
    let guild_ids: Vec<&str> = guild_page["items"]
        .as_array()
        .context("guild items")?
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect();
    assert!(guild_ids.contains(&image_id.as_str()));
    assert!(guild_ids.contains(&file_id.as_str()));
    assert!(
        !guild_ids.contains(&secret_file.as_str()),
        "hidden channel leaked into the server gallery: {guild_page}"
    );

    let (status, filtered) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/attachments?channel_id={secret_id}"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{filtered}");

    let (status, links) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/channels/{open_id}/links"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{links}");
    let link_items = links["items"].as_array().context("links")?;
    assert_eq!(link_items.len(), 1);
    assert_eq!(link_items[0]["url"], "https://example.com/docs");
    assert_eq!(link_items[0]["title"], "Docs");
    assert_eq!(link_items[0]["site"], "Example");
    assert_eq!(link_items[0]["image"], "https://example.com/docs.png");

    let (status, secret_links) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/channels/{secret_id}/links"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{secret_links}");

    let other = ctx.user_id(&ctx.token).await?;
    let dm_id = paracord_util::snowflake::generate(1);
    let member_id = ctx.user_id(&member).await?;
    paracord_db::dms::create_dm_channel(&ctx.db, dm_id, other, member_id).await?;
    let (status, dm_gallery) = ctx
        .request_json_as(
            Method::GET,
            &format!("/api/v1/channels/{dm_id}/attachments"),
            None,
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{dm_gallery}");
    assert!(
        dm_gallery["message"]
            .as_str()
            .unwrap_or("")
            .contains("end-to-end encrypted"),
        "{dm_gallery}"
    );
    Ok(())
}

#[tokio::test]
async fn server_list_carries_the_banner_and_the_hub_keeps_none() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Listed Banner").await?;
    let (status, uploaded) = ctx
        .post_multipart(
            &format!("/api/v1/guilds/{guild_id}/banner"),
            png_part("lb", "banner"),
            "lb",
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{uploaded}");

    // The server list is what the home reads, so the banner must be on it.
    let (status, list) = ctx
        .request_json(Method::GET, "/api/v1/users/@me/guilds", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed = list
        .as_array()
        .context("guild list")?
        .iter()
        .find(|guild| guild["id"].as_str() == Some(guild_id.to_string().as_str()))
        .context("guild in list")?;
    assert_eq!(listed["banner_hash"], uploaded["banner_hash"]);

    // A client still sending the old data-URL hub banner does not get it stored.
    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({
                "hub_settings": {
                    "welcome_text": "Hello",
                    "banner_hash": "data:image/png;base64,AAAA",
                }
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["hub_settings"]["welcome_text"], "Hello");
    assert!(
        updated["hub_settings"].get("banner_hash").is_none(),
        "{updated}"
    );

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/banner"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, detail) = ctx
        .request_json(Method::GET, &format!("/api/v1/guilds/{guild_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(detail["banner_hash"].is_null(), "{detail}");
    let (status, _) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/banner"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn link_pages_resume_where_the_last_one_stopped() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Links Guild").await?;
    let channel_id = create_channel(&ctx, guild_id, "links").await?;
    for index in 0..5 {
        let (status, message) = ctx
            .request_json(
                Method::POST,
                &format!("/api/v1/channels/{channel_id}/messages"),
                Some(json!({ "content": format!("page https://example.com/{index}") })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{message}");
        let (status, message) = ctx
            .request_json(
                Method::POST,
                &format!("/api/v1/channels/{channel_id}/messages"),
                Some(json!({ "content": "no link here" })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{message}");
    }

    let mut seen = Vec::new();
    let mut before: Option<String> = None;
    for _ in 0..10 {
        let path = match &before {
            Some(cursor) => format!("/api/v1/channels/{channel_id}/links?limit=2&before={cursor}"),
            None => format!("/api/v1/channels/{channel_id}/links?limit=2"),
        };
        let (status, page) = ctx.request_json(Method::GET, &path, None).await?;
        assert_eq!(status, StatusCode::OK, "{page}");
        for item in page["items"].as_array().context("items")? {
            seen.push(item["url"].as_str().context("url")?.to_string());
        }
        match page["next_before"].as_str() {
            Some(cursor) => before = Some(cursor.to_string()),
            None => break,
        }
    }
    assert_eq!(
        seen,
        (0..5)
            .rev()
            .map(|index| format!("https://example.com/{index}"))
            .collect::<Vec<_>>()
    );
    Ok(())
}

#[tokio::test]
async fn old_hub_banners_become_uploaded_banners() -> anyhow::Result<()> {
    use base64::Engine;

    let ctx = TestContext::new().await?;
    let storage = ctx._test_app.state.config.storage_path.clone();
    let with_old = create_guild(&ctx, "Old hub banner").await?;
    let already_uploaded = create_guild(&ctx, "Has an upload").await?;
    let not_an_image = create_guild(&ctx, "Broken hub banner").await?;

    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(PNG_1X1)
    );
    let hub = |banner: &str| json!({ "welcome": "hi", "banner_hash": banner }).to_string();
    paracord_db::guilds::set_hub_settings(&ctx.db, with_old, &hub(&data_url)).await?;
    paracord_db::guilds::set_hub_settings(&ctx.db, already_uploaded, &hub(&data_url)).await?;
    paracord_db::guilds::set_guild_banner_hash(
        &ctx.db,
        already_uploaded,
        Some("/api/v1/guilds/1/banner?v=1"),
    )
    .await?;
    paracord_db::guilds::set_hub_settings(
        &ctx.db,
        not_an_image,
        &hub("data:text/plain;base64,aGk="),
    )
    .await?;

    let converted = paracord_api::convert_legacy_hub_banners(&ctx.db, &storage).await?;
    assert_eq!(converted, 1);

    let row = paracord_db::guilds::get_guild(&ctx.db, with_old)
        .await?
        .context("guild")?;
    let banner = row.banner_hash.context("converted banner")?;
    assert!(banner.starts_with(&format!("/api/v1/guilds/{with_old}/banner?v=")));
    let stored = std::path::Path::new(&storage)
        .join("guild-banners")
        .join(format!("{with_old}.png"));
    assert_eq!(std::fs::read(stored)?, PNG_1X1);
    let hub_after: Value = serde_json::from_str(row.hub_settings.as_deref().context("hub")?)?;
    assert!(hub_after.get("banner_hash").is_none());
    assert_eq!(hub_after["welcome"], "hi");

    let kept = paracord_db::guilds::get_guild(&ctx.db, already_uploaded)
        .await?
        .context("guild")?;
    assert_eq!(
        kept.banner_hash.as_deref(),
        Some("/api/v1/guilds/1/banner?v=1")
    );
    assert!(!kept
        .hub_settings
        .unwrap_or_default()
        .contains("banner_hash"));

    let broken = paracord_db::guilds::get_guild(&ctx.db, not_an_image)
        .await?
        .context("guild")?;
    assert!(broken.banner_hash.is_none());
    assert!(!broken
        .hub_settings
        .unwrap_or_default()
        .contains("banner_hash"));

    // Nothing left to do on the next start.
    assert_eq!(
        paracord_api::convert_legacy_hub_banners(&ctx.db, &storage).await?,
        0
    );
    Ok(())
}
