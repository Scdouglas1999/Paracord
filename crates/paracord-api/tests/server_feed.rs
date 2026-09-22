//! `GET /api/v1/guilds/{guild_id}/feed` (docs/server-home-spec.md): the
//! server home's "Latest" feed, and the `hub_settings.widgets` validation.

mod common;

use std::collections::HashSet;

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
            "feedowner",
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

    async fn request_as(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_as(method, path, body, &self.token).await
    }

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request_as(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"].as_str().context("user id")?.parse::<i64>()?)
    }

    async fn stranger(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
        Ok((token, uid))
    }

    async fn add_member(&self, prefix: &str, guild_id: &str) -> anyhow::Result<(String, i64)> {
        let guild_id = guild_id.parse::<i64>()?;
        let (token, uid) = self.stranger(prefix).await?;
        paracord_db::members::add_member(&self.db, uid, guild_id).await?;
        paracord_db::roles::add_member_role(&self.db, uid, guild_id, guild_id).await?;
        Ok((token, uid))
    }

    async fn create_guild(&self, name: &str) -> anyhow::Result<String> {
        let (status, payload) = self
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild create: {payload}");
        Ok(payload["id"].as_str().context("guild id")?.to_string())
    }

    async fn create_channel(
        &self,
        guild_id: &str,
        name: &str,
        channel_type: i64,
    ) -> anyhow::Result<String> {
        let (status, payload) = self
            .request(
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

    async fn post_as(
        &self,
        token: &str,
        channel_id: &str,
        content: &str,
    ) -> anyhow::Result<String> {
        let (status, payload) = self
            .request_as(
                Method::POST,
                &format!("/api/v1/channels/{channel_id}/messages"),
                Some(json!({ "content": content })),
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "post: {payload}");
        Ok(payload["id"].as_str().context("message id")?.to_string())
    }

    async fn post(&self, channel_id: &str, content: &str) -> anyhow::Result<String> {
        self.post_as(&self.token, channel_id, content).await
    }

    async fn feed_as(&self, token: &str, guild_id: &str, query: &str) -> anyhow::Result<Value> {
        let (status, payload) = self
            .request_as(
                Method::GET,
                &format!("/api/v1/guilds/{guild_id}/feed?{query}"),
                None,
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "feed: {payload}");
        Ok(payload)
    }

    async fn feed(&self, guild_id: &str, query: &str) -> anyhow::Result<Value> {
        self.feed_as(&self.token, guild_id, query).await
    }

    /// Every page of the feed, following `next_cursor` to the end.
    async fn all_pages(
        &self,
        token: &str,
        guild_id: &str,
        limit: i64,
    ) -> anyhow::Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            let query = match &cursor {
                Some(before) => format!("limit={limit}&before={before}"),
                None => format!("limit={limit}"),
            };
            let page = self.feed_as(token, guild_id, &query).await?;
            let page_items = page["items"].as_array().context("items")?.clone();
            assert!(page_items.len() as i64 <= limit, "page too long: {page}");
            items.extend(page_items);
            match page["next_cursor"].as_str() {
                Some(next) => cursor = Some(next.to_string()),
                None => return Ok(items),
            }
        }
        anyhow::bail!("feed never ended")
    }
}

fn items(page: &Value) -> Vec<Value> {
    page["items"].as_array().cloned().unwrap_or_default()
}

fn message_item<'a>(items: &'a [Value], message_id: &str) -> Option<&'a Value> {
    items
        .iter()
        .find(|item| item["type"] == "message" && item["message"]["id"] == message_id)
}

async fn attach_image(ctx: &TestContext, message_id: &str) -> anyhow::Result<()> {
    paracord_db::attachments::create_attachment(
        &ctx.db,
        paracord_util::snowflake::generate(1),
        Some(message_id.parse::<i64>()?),
        "photo.png",
        Some("image/png"),
        128,
        "/api/v1/attachments/photo",
        Some(640),
        Some(480),
        None,
        None,
        None,
        None,
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn feed_carries_each_notable_reason_and_never_plain_chat() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Feed Guild").await?;
    let general = ctx.create_channel(&guild_id, "general", 0).await?;
    let announcements = ctx.create_channel(&guild_id, "news", 5).await?;

    let plain = ctx.post(&general, "just chatting").await?;
    let announced = ctx.post(&announcements, "we shipped").await?;

    let with_image = ctx.post(&general, "look at this").await?;
    attach_image(&ctx, &with_image).await?;

    let (status, poll) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/channels/{general}/polls"),
            Some(json!({
                "question": "Lunch?",
                "options": [{ "text": "Pizza" }, { "text": "Noodles" }],
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "poll: {poll}");
    let poll_message = poll["id"].as_str().context("poll message id")?.to_string();

    let loved = ctx.post(&general, "a good line").await?;
    let barely = ctx.post(&general, "a fine line").await?;
    for (i, prefix) in ["reactone", "reacttwo", "reactthree"].iter().enumerate() {
        let (_, uid) = ctx.add_member(prefix, &guild_id).await?;
        let emoji = if i == 0 { "🔥" } else { "👍" };
        paracord_db::reactions::add_reaction(&ctx.db, loved.parse()?, uid, emoji, None).await?;
        if i < 2 {
            paracord_db::reactions::add_reaction(&ctx.db, barely.parse()?, uid, emoji, None)
                .await?;
        }
    }

    let pinned = ctx.post(&general, "house rules").await?;
    let (status, pin) = ctx
        .request(
            Method::PUT,
            &format!("/api/v1/channels/{general}/pins/{pinned}"),
            None,
        )
        .await?;
    assert!(status.is_success(), "pin: {pin}");

    // A thread with two replies makes its starter notable; one reply does not.
    let starter = ctx.post(&general, "shall we plan the trip").await?;
    let lonely = ctx.post(&general, "anyone?").await?;
    let mut threads = Vec::new();
    for (message, name) in [(&starter, "trip"), (&lonely, "quiet")] {
        let (status, thread) = ctx
            .request(
                Method::POST,
                &format!("/api/v1/channels/{general}/threads"),
                Some(json!({ "name": name, "message_id": message })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "thread: {thread}");
        threads.push(thread["id"].as_str().context("thread id")?.to_string());
    }
    let reply_one = ctx.post(&threads[0], "yes").await?;
    ctx.post(&threads[0], "count me in").await?;
    ctx.post(&threads[1], "hello?").await?;

    let page = ctx.feed(&guild_id, "limit=50").await?;
    let items = items(&page);
    let reason = |id: &str| {
        message_item(&items, id).map(|item| item["reason"].as_str().unwrap_or_default().to_string())
    };
    assert_eq!(
        reason(&announced).as_deref(),
        Some("announcement"),
        "{page}"
    );
    assert_eq!(reason(&with_image).as_deref(), Some("attachment"), "{page}");
    assert_eq!(reason(&poll_message).as_deref(), Some("poll"), "{page}");
    assert_eq!(reason(&loved).as_deref(), Some("reactions"), "{page}");
    assert_eq!(reason(&pinned).as_deref(), Some("pinned"), "{page}");
    assert_eq!(
        reason(&starter).as_deref(),
        Some("thread_starter"),
        "{page}"
    );
    for quiet in [&plain, &barely, &lonely, &reply_one] {
        assert!(reason(quiet).is_none(), "{quiet} is plain chat: {page}");
    }

    let item = message_item(&items, &announced).context("announcement")?;
    assert_eq!(item["channel_id"], announcements);
    assert_eq!(item["channel_name"], "news");
    assert_eq!(item["channel_type"], 5);
    assert_eq!(item["id"], format!("m:{announced}"));
    assert_eq!(item["key"], announced);
    assert!(item["at"].as_str().is_some());
    let image = message_item(&items, &with_image).context("image")?;
    assert_eq!(image["message"]["attachments"][0]["filename"], "photo.png");
    let voted = message_item(&items, &poll_message).context("poll")?;
    assert_eq!(voted["message"]["poll"]["question"], "Lunch?");
    let reacted = message_item(&items, &loved).context("reactions")?;
    let total: i64 = reacted["message"]["reactions"]
        .as_array()
        .context("reaction list")?
        .iter()
        .filter_map(|r| r["count"].as_i64())
        .sum();
    assert_eq!(total, 3);

    // Newest first, strictly.
    let keys: Vec<i64> = items
        .iter()
        .map(|item| item["key"].as_str().unwrap().parse::<i64>().unwrap())
        .collect();
    assert!(keys.windows(2).all(|w| w[0] > w[1]), "order: {keys:?}");
    assert!(page["next_cursor"].is_null(), "{page}");
    Ok(())
}

#[tokio::test]
async fn feed_hides_channels_the_viewer_cannot_read() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Hidden Guild").await?;
    let guild_num = guild_id.parse::<i64>()?;
    let general = ctx.create_channel(&guild_id, "general", 0).await?;
    let secret = ctx.create_channel(&guild_id, "staff", 0).await?;
    let forum = ctx.create_channel(&guild_id, "staff-forum", 7).await?;
    let (member_token, member_id) = ctx.add_member("hiddenmember", &guild_id).await?;

    for channel in [&secret, &forum] {
        paracord_db::channel_overwrites::upsert_channel_overwrite(
            &ctx.db,
            channel.parse::<i64>()?,
            guild_num,
            paracord_core::permissions::OVERWRITE_TARGET_ROLE,
            0,
            Permissions::VIEW_CHANNEL.bits(),
        )
        .await?;
    }
    paracord_core::permissions::invalidate_user(&ctx.test_app.state.permission_cache, member_id)
        .await;

    let hidden = ctx.post(&secret, "secret photo").await?;
    attach_image(&ctx, &hidden).await?;
    let open = ctx.post(&general, "open photo").await?;
    attach_image(&ctx, &open).await?;
    let (status, post) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/channels/{forum}/forum/posts"),
            Some(json!({ "name": "staff only", "content": "hush" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "forum post: {post}");

    let member_page = ctx.feed_as(&member_token, &guild_id, "limit=50").await?;
    let member_items = items(&member_page);
    assert!(
        message_item(&member_items, &open).is_some(),
        "{member_page}"
    );
    assert!(
        message_item(&member_items, &hidden).is_none(),
        "{member_page}"
    );
    assert!(
        member_items.iter().all(|item| item["type"] != "forum_post"),
        "hidden forum post leaked: {member_page}"
    );

    let owner_page = ctx.feed(&guild_id, "limit=50").await?;
    let owner_items = items(&owner_page);
    assert!(
        message_item(&owner_items, &hidden).is_some(),
        "{owner_page}"
    );
    assert!(owner_items.iter().any(|item| item["type"] == "forum_post"));
    Ok(())
}

#[tokio::test]
async fn forum_posts_carry_title_replies_and_participants() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Forum Guild").await?;
    let forum = ctx.create_channel(&guild_id, "ideas", 7).await?;
    let (ada_token, ada_id) = ctx.add_member("forumada", &guild_id).await?;
    let (ben_token, ben_id) = ctx.add_member("forumben", &guild_id).await?;
    let owner_id = ctx.user_id(&ctx.token).await?;

    let (status, post) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/channels/{forum}/forum/posts"),
            Some(
                json!({ "name": "A darker theme", "content": "What if the sidebar was quieter?" }),
            ),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "forum post: {post}");
    let thread_id = post["id"].as_str().context("post id")?.to_string();
    ctx.post_as(&ada_token, &thread_id, "yes please").await?;
    ctx.post_as(&ben_token, &thread_id, "seconded").await?;

    let (status, bare) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/channels/{forum}/forum/posts"),
            Some(json!({ "name": "Nobody answered", "content": "hello" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "bare post: {bare}");
    let bare_id = bare["id"].as_str().context("bare id")?.to_string();

    let page = ctx.feed(&guild_id, "limit=50").await?;
    let items = items(&page);
    let card = items
        .iter()
        .find(|item| item["type"] == "forum_post" && item["thread_id"] == thread_id)
        .context("forum post item")?;
    assert_eq!(card["id"], format!("f:{thread_id}"));
    assert_eq!(card["key"], thread_id);
    assert_eq!(card["channel_id"], forum);
    assert_eq!(card["channel_name"], "ideas");
    assert_eq!(card["title"], "A darker theme");
    assert_eq!(card["author"]["id"], owner_id.to_string());
    assert_eq!(card["excerpt"], "What if the sidebar was quieter?");
    assert_eq!(card["reply_count"], 2);
    assert_eq!(card["last_reply_author"]["id"], ben_id.to_string());
    assert!(card["last_reply_at"].as_str().is_some());
    let participants: Vec<&str> = card["participants"]
        .as_array()
        .context("participants")?
        .iter()
        .filter_map(|p| p["id"].as_str())
        .collect();
    assert_eq!(
        participants,
        [ben_id.to_string(), ada_id.to_string(), owner_id.to_string()]
    );

    let bare_card = items
        .iter()
        .find(|item| item["type"] == "forum_post" && item["thread_id"] == bare_id)
        .context("bare post item")?;
    assert_eq!(bare_card["reply_count"], 0);
    assert!(bare_card["last_reply_at"].is_null());
    assert!(bare_card["last_reply_author"].is_null());

    // A forum post's replies are the post's, not feed items of their own.
    assert!(items.iter().all(|item| item["type"] != "message"), "{page}");
    Ok(())
}

#[tokio::test]
async fn cursor_pages_without_duplicates_or_gaps() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Cursor Guild").await?;
    let general = ctx.create_channel(&guild_id, "general", 0).await?;
    let news = ctx.create_channel(&guild_id, "news", 5).await?;
    let forum = ctx.create_channel(&guild_id, "ideas", 7).await?;
    let mut expected = Vec::new();
    for i in 0..5 {
        expected.push(format!(
            "m:{}",
            ctx.post(&news, &format!("update {i}")).await?
        ));
        ctx.post(&general, &format!("chat {i}")).await?;
        let (status, post) = ctx
            .request(
                Method::POST,
                &format!("/api/v1/channels/{forum}/forum/posts"),
                Some(json!({ "name": format!("post {i}"), "content": "body" })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "post: {post}");
        expected.push(format!("f:{}", post["id"].as_str().context("post id")?));
    }

    let whole = items(&ctx.feed(&guild_id, "limit=50").await?);
    let paged = ctx.all_pages(&ctx.token, &guild_id, 3).await?;
    let whole_ids: Vec<&str> = whole.iter().filter_map(|i| i["id"].as_str()).collect();
    let paged_ids: Vec<&str> = paged.iter().filter_map(|i| i["id"].as_str()).collect();
    assert_eq!(whole_ids, paged_ids, "paging changed the feed");
    let unique: HashSet<&str> = paged_ids.iter().copied().collect();
    assert_eq!(unique.len(), paged_ids.len(), "duplicates: {paged_ids:?}");
    for id in &expected {
        assert!(unique.contains(id.as_str()), "missing {id}: {paged_ids:?}");
    }
    // Ten notable items plus the owner's join day.
    assert_eq!(paged_ids.len(), 11, "{paged_ids:?}");

    let first = ctx.feed(&guild_id, "limit=3").await?;
    assert_eq!(items(&first).len(), 3);
    assert_eq!(first["next_cursor"], items(&first)[2]["key"]);
    Ok(())
}

#[tokio::test]
async fn new_members_are_grouped_by_day_and_a_day_is_never_split() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Join Guild").await?;
    let guild_num = guild_id.parse::<i64>()?;
    let owner_id = ctx.user_id(&ctx.token).await?;
    let mut people = Vec::new();
    for prefix in ["joinyara", "joinken", "joinlena", "joindiego"] {
        people.push(ctx.add_member(prefix, &guild_id).await?.1);
    }
    let stamps = [
        (owner_id, "2026-02-27 08:00:00"),
        (people[0], "2026-03-02 12:00:00"),
        (people[1], "2026-03-02 10:00:00"),
        (people[2], "2026-03-02 09:30:00"),
        (people[3], "2026-03-01 09:00:00"),
    ];
    for (uid, at) in stamps {
        sqlx::query("UPDATE members SET joined_at = $1 WHERE user_id = $2 AND guild_id = $3")
            .bind(at)
            .bind(uid)
            .bind(guild_num)
            .execute(&ctx.db)
            .await?;
    }

    let page = ctx.feed(&guild_id, "limit=50").await?;
    let groups: Vec<Value> = items(&page)
        .into_iter()
        .filter(|item| item["type"] == "members_joined")
        .collect();
    let days: Vec<&str> = groups.iter().filter_map(|g| g["day"].as_str()).collect();
    assert_eq!(days, ["2026-03-02", "2026-03-01", "2026-02-27"], "{page}");
    let march_second = &groups[0];
    assert_eq!(march_second["id"], "j:2026-03-02");
    assert_eq!(march_second["total"], 3);
    let ids: Vec<&str> = march_second["users"]
        .as_array()
        .context("users")?
        .iter()
        .filter_map(|u| u["id"].as_str())
        .collect();
    assert_eq!(
        ids,
        [
            people[0].to_string(),
            people[1].to_string(),
            people[2].to_string()
        ]
    );
    assert_eq!(
        march_second["users"][0]["username"]
            .as_str()
            .map(|n| n.starts_with("joinyara")),
        Some(true)
    );
    assert!(march_second["at"]
        .as_str()
        .unwrap_or_default()
        .starts_with("2026-03-02T12:00:00"));

    // One item per page: every day still arrives exactly once and whole.
    let paged = ctx.all_pages(&ctx.token, &guild_id, 1).await?;
    let paged_days: Vec<(&str, i64)> = paged
        .iter()
        .filter(|item| item["type"] == "members_joined")
        .map(|item| {
            (
                item["day"].as_str().unwrap(),
                item["total"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        paged_days,
        [("2026-03-02", 3), ("2026-03-01", 1), ("2026-02-27", 1)]
    );
    Ok(())
}

#[tokio::test]
async fn feed_refuses_strangers_and_bad_parameters() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Closed Guild").await?;
    let (stranger_token, _) = ctx.stranger("feedstranger").await?;
    let (status, payload) = ctx
        .request_as(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/feed"),
            None,
            &stranger_token,
        )
        .await?;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "stranger: {status} {payload}"
    );

    for query in ["limit=0", "limit=51", "before=soon"] {
        let (status, payload) = ctx
            .request(
                Method::GET,
                &format!("/api/v1/guilds/{guild_id}/feed?{query}"),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {payload}");
    }
    Ok(())
}

#[tokio::test]
async fn home_widgets_are_validated_on_save() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Widget Guild").await?;
    let path = format!("/api/v1/guilds/{guild_id}");

    let valid = json!([
        { "id": "media", "enabled": true },
        { "id": "coming_up", "enabled": true },
        { "id": "most_active", "enabled": false },
        { "id": "game", "enabled": true },
        { "id": "pinned", "enabled": true },
        { "id": "new_here", "enabled": false },
    ]);
    let (status, saved) = ctx
        .request(
            Method::PATCH,
            &path,
            Some(json!({ "hub_settings": { "welcome_text": "Hi", "widgets": valid } })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "valid widgets: {saved}");
    assert_eq!(saved["hub_settings"]["widgets"], valid);
    assert_eq!(saved["hub_settings"]["welcome_text"], "Hi");

    for (label, widgets) in [
        ("unknown id", json!([{ "id": "weather", "enabled": true }])),
        (
            "duplicate",
            json!([{ "id": "media", "enabled": true }, { "id": "media", "enabled": false }]),
        ),
        (
            "non-bool enabled",
            json!([{ "id": "media", "enabled": "yes" }]),
        ),
        (
            "extra key",
            json!([{ "id": "media", "enabled": true, "size": 2 }]),
        ),
        ("not a list", json!({ "id": "media", "enabled": true })),
    ] {
        let (status, payload) = ctx
            .request(
                Method::PATCH,
                &path,
                Some(json!({ "hub_settings": { "widgets": widgets } })),
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {payload}");
        assert!(
            payload.to_string().contains("hub_settings.widgets"),
            "{label} must name the field: {payload}"
        );
    }

    let (status, kept) = ctx.request(Method::GET, &path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        kept["hub_settings"]["widgets"], valid,
        "a refused save changed nothing"
    );
    Ok(())
}
