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
    token: String,
    test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "searchowner",
            "IntegrationPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
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
}

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "guild create: {payload}");
    Ok(payload["id"].as_str().context("guild id")?.to_string())
}

async fn create_channel(
    ctx: &TestContext,
    guild_id: &str,
    name: &str,
    channel_type: i64,
) -> anyhow::Result<String> {
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
    assert_eq!(status, StatusCode::CREATED, "channel create: {payload}");
    Ok(payload["id"].as_str().context("channel id")?.to_string())
}

async fn post_message(
    ctx: &TestContext,
    token: &str,
    channel_id: &str,
    content: &str,
) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json_as(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": content })),
            token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "post: {payload}");
    Ok(payload["id"].as_str().context("message id")?.to_string())
}

fn search_path(guild_id: &str, query: &str) -> String {
    format!("/api/v1/guilds/{guild_id}/messages/search?{query}")
}

fn hit_ids(payload: &Value) -> Vec<&str> {
    payload["messages"]
        .as_array()
        .map(|hits| {
            hits.iter()
                .filter_map(|hit| hit["message"]["id"].as_str())
                .collect()
        })
        .unwrap_or_default()
}

fn hit_contents(payload: &Value) -> String {
    payload.to_string()
}

#[tokio::test]
async fn guild_search_spans_channels_and_rejects_an_empty_query() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Search Guild").await?;
    let general = create_channel(&ctx, &guild_id, "general", 0).await?;
    let design = create_channel(&ctx, &guild_id, "design", 0).await?;
    let announcements = create_channel(&ctx, &guild_id, "announcements", 5).await?;
    let forum = create_channel(&ctx, &guild_id, "forum", 7).await?;

    let older = post_message(&ctx, &ctx.token, &general, "spanword in general").await?;
    let newer = post_message(&ctx, &ctx.token, &design, "spanword in design").await?;
    let announced = post_message(&ctx, &ctx.token, &announcements, "announceword shipped").await?;
    sqlx::query("UPDATE messages SET created_at = '2020-01-01 00:00:00' WHERE id = $1")
        .bind(older.parse::<i64>()?)
        .execute(&ctx.db)
        .await?;
    sqlx::query("UPDATE messages SET created_at = '2020-06-01 00:00:00' WHERE id = $1")
        .bind(newer.parse::<i64>()?)
        .execute(&ctx.db)
        .await?;

    let (status, thread) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{general}/threads"),
            Some(json!({ "name": "side quest" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "thread: {thread}");
    let thread_id = thread["id"].as_str().context("thread id")?.to_string();
    let threaded = post_message(&ctx, &ctx.token, &thread_id, "threadword lives here").await?;

    let (status, post) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{forum}/forum/posts"),
            Some(json!({ "name": "spec", "content": "forumword in a post" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "forum post: {post}");

    let (status, empty) = ctx
        .request_json(Method::GET, &search_path(&guild_id, ""), None)
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "empty query: {empty}");
    assert!(
        empty["message"]
            .as_str()
            .unwrap_or_default()
            .contains("filter"),
        "empty query should name the missing filter: {empty}"
    );

    let (status, page) = ctx
        .request_json(Method::GET, &search_path(&guild_id, "q=spanword"), None)
        .await?;
    assert_eq!(status, StatusCode::OK, "span search: {page}");
    assert_eq!(page["total"], json!(2), "span total: {page}");
    let ids = hit_ids(&page);
    assert_eq!(
        ids,
        vec![newer.as_str(), older.as_str()],
        "newest first: {page}"
    );
    let names: Vec<&str> = page["messages"]
        .as_array()
        .context("messages")?
        .iter()
        .filter_map(|hit| hit["channel_name"].as_str())
        .collect();
    assert_eq!(names, vec!["design", "general"]);

    let (status, limited) = ctx
        .request_json(
            Method::GET,
            &search_path(&guild_id, "q=spanword&limit=1&offset=1"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "page: {limited}");
    assert_eq!(limited["total"], json!(2));
    assert_eq!(hit_ids(&limited), vec![older.as_str()]);

    let (status, announced_page) = ctx
        .request_json(Method::GET, &search_path(&guild_id, "q=announceword"), None)
        .await?;
    assert_eq!(status, StatusCode::OK, "announcement: {announced_page}");
    assert_eq!(hit_ids(&announced_page), vec![announced.as_str()]);
    assert_eq!(
        announced_page["messages"][0]["channel_name"],
        json!("announcements")
    );

    let (status, thread_page) = ctx
        .request_json(Method::GET, &search_path(&guild_id, "q=threadword"), None)
        .await?;
    assert_eq!(status, StatusCode::OK, "thread: {thread_page}");
    assert_eq!(hit_ids(&thread_page), vec![threaded.as_str()]);
    assert_eq!(
        thread_page["messages"][0]["thread_parent_id"],
        json!(general)
    );

    let (status, forum_page) = ctx
        .request_json(Method::GET, &search_path(&guild_id, "q=forumword"), None)
        .await?;
    assert_eq!(status, StatusCode::OK, "forum: {forum_page}");
    assert_eq!(forum_page["total"], json!(1), "{forum_page}");
    assert_eq!(forum_page["messages"][0]["thread_parent_id"], json!(forum));
    assert_eq!(forum_page["messages"][0]["channel_name"], json!("spec"));

    let (status, bad_limit) = ctx
        .request_json(
            Method::GET,
            &search_path(&guild_id, "q=spanword&limit=51"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "limit: {bad_limit}");

    Ok(())
}

#[tokio::test]
async fn guild_search_filters_and_hides_unreadable_channels() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Filter Guild").await?;
    let guild_num = guild_id.parse::<i64>()?;
    let general = create_channel(&ctx, &guild_id, "general", 0).await?;
    let design = create_channel(&ctx, &guild_id, "design", 0).await?;
    let secret = create_channel(&ctx, &guild_id, "secret", 0).await?;
    let sealed = create_channel(&ctx, &guild_id, "sealed", 0).await?;
    let voice = create_channel(&ctx, &guild_id, "voice", 2).await?;
    let general_num = general.parse::<i64>()?;
    let (member_token, member_id) = ctx.add_member("filtermember", guild_num).await?;

    // `secret` is hidden from the member outright; `sealed` is visible but its
    // history is not. Neither may contribute a result or a count.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        secret.parse::<i64>()?,
        member_id,
        1,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        sealed.parse::<i64>()?,
        member_id,
        1,
        0,
        Permissions::READ_MESSAGE_HISTORY.bits(),
    )
    .await?;
    paracord_core::permissions::invalidate_user(&ctx.test_app.state.permission_cache, member_id)
        .await;

    let secret_message = post_message(&ctx, &ctx.token, &secret, "hiddenword in secret").await?;
    let _ = post_message(&ctx, &ctx.token, &secret, "hiddenword again").await?;
    let _ = post_message(&ctx, &ctx.token, &secret, "hiddenword third").await?;
    let sealed_message = post_message(&ctx, &ctx.token, &sealed, "hiddenword sealed").await?;
    let public_message = post_message(&ctx, &ctx.token, &general, "hiddenword in general").await?;
    let design_message =
        post_message(&ctx, &member_token, &design, "hiddenword from member").await?;

    let (status, member_page) = ctx
        .request_json_as(
            Method::GET,
            &search_path(&guild_id, "q=hiddenword"),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "member search: {member_page}");
    assert_eq!(
        member_page["total"],
        json!(2),
        "unreadable messages must stay out of the count: {member_page}"
    );
    let member_ids = hit_ids(&member_page);
    assert!(member_ids.contains(&public_message.as_str()));
    assert!(member_ids.contains(&design_message.as_str()));
    assert!(
        !hit_contents(&member_page).contains(&secret_message),
        "secret id leaked: {member_page}"
    );
    assert!(
        !hit_contents(&member_page).contains(&sealed_message),
        "sealed id leaked: {member_page}"
    );
    assert!(
        !hit_contents(&member_page).contains("secret")
            && !hit_contents(&member_page).contains("sealed"),
        "hidden channel leaked: {member_page}"
    );

    let (status, owner_page) = ctx
        .request_json(Method::GET, &search_path(&guild_id, "q=hiddenword"), None)
        .await?;
    assert_eq!(status, StatusCode::OK, "owner search: {owner_page}");
    assert_eq!(
        owner_page["total"],
        json!(6),
        "owner sees the secret channel: {owner_page}"
    );

    let (status, hidden_filter) = ctx
        .request_json_as(
            Method::GET,
            &search_path(&guild_id, &format!("channel_id={secret}")),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "hidden channel filter: {hidden_filter}"
    );
    assert_eq!(hidden_filter["total"], json!(0));
    assert!(hidden_filter["messages"].as_array().unwrap().is_empty());

    let (status, sealed_filter) = ctx
        .request_json_as(
            Method::GET,
            &search_path(&guild_id, &format!("q=hiddenword&channel_id={sealed}")),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "sealed filter: {sealed_filter}");
    assert_eq!(sealed_filter["total"], json!(0), "{sealed_filter}");

    let other_guild = create_guild(&ctx, "Other Guild").await?;
    let other_channel = create_channel(&ctx, &other_guild, "other", 0).await?;
    let _ = post_message(&ctx, &ctx.token, &other_channel, "hiddenword elsewhere").await?;
    let (status, foreign) = ctx
        .request_json(
            Method::GET,
            &search_path(
                &guild_id,
                &format!("q=hiddenword&channel_id={other_channel}"),
            ),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "foreign channel: {foreign}");
    assert_eq!(
        foreign,
        json!({ "total": 0, "messages": [] }),
        "a foreign channel answers like a hidden one"
    );

    let (status, voice_search) = ctx
        .request_json(
            Method::GET,
            &search_path(&guild_id, &format!("channel_id={voice}")),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "voice: {voice_search}");

    let outsider =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "outsider", "MemberPass123!")
            .await?;
    let (status, denied) = ctx
        .request_json_as(
            Method::GET,
            &search_path(&guild_id, "q=hiddenword"),
            None,
            &outsider,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "non-member: {denied}");

    let link_id =
        post_message(&ctx, &ctx.token, &general, "notes https://example.com/spec").await?;
    let image_id = post_message(&ctx, &ctx.token, &general, "a picture").await?;
    let video_id = post_message(&ctx, &ctx.token, &general, "a clip").await?;
    let file_id = post_message(&ctx, &ctx.token, &general, "the minutes").await?;
    paracord_db::attachments::create_attachment(
        &ctx.db,
        880_001,
        Some(image_id.parse()?),
        "photo.png",
        Some("image/png"),
        4,
        "/files/photo.png",
        Some(1),
        Some(1),
        None,
        Some(general_num),
        None,
        None,
    )
    .await?;
    paracord_db::attachments::create_attachment(
        &ctx.db,
        880_002,
        Some(video_id.parse()?),
        "clip.mp4",
        Some("video/mp4"),
        4,
        "/files/clip.mp4",
        None,
        None,
        None,
        Some(general_num),
        None,
        None,
    )
    .await?;
    paracord_db::attachments::create_attachment(
        &ctx.db,
        880_003,
        Some(file_id.parse()?),
        "minutes.pdf",
        Some("application/pdf"),
        4,
        "/files/minutes.pdf",
        None,
        None,
        None,
        Some(general_num),
        None,
        None,
    )
    .await?;

    let (status, poll) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{general}/polls"),
            Some(json!({
                "question": "Ship the search?",
                "options": [{ "text": "yes" }, { "text": "no" }]
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "poll: {poll}");
    let poll_id = poll["id"].as_str().context("poll message")?.to_string();

    let embed_id = post_message(&ctx, &ctx.token, &general, "rich card").await?;
    sqlx::query("UPDATE messages SET embeds = $1 WHERE id = $2")
        .bind(r#"[{"title":"preview"}]"#)
        .bind(embed_id.parse::<i64>()?)
        .execute(&ctx.db)
        .await?;

    let pinned_id = post_message(&ctx, &ctx.token, &general, "pin this note").await?;
    let (status, pin_body) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/channels/{general}/pins/{pinned_id}"),
            None,
        )
        .await?;
    assert!(status.is_success(), "pin failed: {status} {pin_body}");

    let mention_id = post_message(
        &ctx,
        &ctx.token,
        &general,
        &format!("<@{member_id}> please look"),
    )
    .await?;
    let other_mention = post_message(&ctx, &member_token, &general, "hey <@1> nope").await?;
    let old_id = post_message(&ctx, &ctx.token, &general, "archived sentence").await?;
    sqlx::query("UPDATE messages SET created_at = '2001-03-01 12:00:00' WHERE id = $1")
        .bind(old_id.parse::<i64>()?)
        .execute(&ctx.db)
        .await?;

    let author_id = post_message(&ctx, &member_token, &general, "member sentence here").await?;

    async fn only(ctx: &TestContext, guild_id: &str, query: &str) -> anyhow::Result<Vec<String>> {
        let (status, page) = ctx
            .request_json(Method::GET, &search_path(guild_id, query), None)
            .await?;
        assert_eq!(status, StatusCode::OK, "{query}: {page}");
        Ok(hit_ids(&page).into_iter().map(str::to_string).collect())
    }

    let links = only(&ctx, &guild_id, "has=link").await?;
    assert!(links.contains(&link_id), "link filter: {links:?}");
    assert!(!links.contains(&image_id));
    let combined = only(&ctx, &guild_id, "has=link&has=image").await?;
    assert!(
        combined.is_empty(),
        "every has filter must match: {combined:?}"
    );

    let images = only(&ctx, &guild_id, "has=image").await?;
    assert_eq!(images, vec![image_id.clone()], "image filter: {images:?}");

    let videos = only(&ctx, &guild_id, "has=video").await?;
    assert_eq!(videos, vec![video_id.clone()], "video filter: {videos:?}");

    let files = only(&ctx, &guild_id, "has=file").await?;
    assert_eq!(files, vec![file_id.clone()], "file filter: {files:?}");

    let polls = only(&ctx, &guild_id, "has=poll").await?;
    assert_eq!(polls, vec![poll_id.clone()], "poll filter: {polls:?}");

    let embeds = only(&ctx, &guild_id, "has=embed").await?;
    assert_eq!(embeds, vec![embed_id.clone()], "embed filter: {embeds:?}");

    let pins = only(&ctx, &guild_id, "pinned=true").await?;
    assert_eq!(pins, vec![pinned_id.clone()], "pinned filter: {pins:?}");

    let mentioned = only(&ctx, &guild_id, &format!("mentions={member_id}")).await?;
    assert_eq!(
        mentioned,
        vec![mention_id.clone()],
        "mentions filter: {mentioned:?}"
    );
    assert!(!mentioned.contains(&other_mention));

    let by_author = only(
        &ctx,
        &guild_id,
        &format!("author_id={member_id}&q=sentence"),
    )
    .await?;
    assert_eq!(by_author, vec![author_id.clone()]);

    let in_design = only(
        &ctx,
        &guild_id,
        &format!("channel_id={design}&q=hiddenword"),
    )
    .await?;
    assert_eq!(in_design, vec![design_message.clone()]);

    let old = only(&ctx, &guild_id, "q=archived&before=2001-06-01").await?;
    assert_eq!(old, vec![old_id.clone()]);
    let not_old = only(&ctx, &guild_id, "q=archived&after=2002-01-01").await?;
    assert!(not_old.is_empty(), "after filter: {not_old:?}");

    let (status, inverted) = ctx
        .request_json(
            Method::GET,
            &search_path(&guild_id, "q=archived&after=2002-01-01&before=2001-01-01"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "inverted range: {inverted}"
    );

    let (status, bad_has) = ctx
        .request_json(Method::GET, &search_path(&guild_id, "has=sticker"), None)
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "bad has: {bad_has}");

    Ok(())
}
