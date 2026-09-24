//! Feeds add-on: every source type against a local fake of the outside world,
//! first-run behavior, dedupe, the five-card cap, errors in plain words, the
//! address checks, permissions, and the Jellyfin key staying on the server.
//!
//! The fake lives on 127.0.0.1, so each test turns on "Add-ons may reach this
//! instance's local network", as an instance admin with a home Jellyfin would.
//! The refusal tests turn it back off.

mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Context;
use axum::{
    body::Bytes,
    extract::Request,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use chrono::{Duration, Utc};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_core::feeds::{FeedEndpoints, LOCAL_NETWORK_REFUSAL};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

// ── The fake outside world ─────────────────────────────────────────────────

#[derive(Clone)]
struct Reply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    etag: Option<String>,
}

impl Reply {
    fn xml(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "application/xml",
            body: body.into().into_bytes(),
            etag: None,
        }
    }

    fn html(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "text/html; charset=utf-8",
            body: body.into().into_bytes(),
            etag: None,
        }
    }

    fn json(body: Value) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            body: body.to_string().into_bytes(),
            etag: None,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain",
            body: Vec::new(),
            etag: None,
        }
    }

    fn with_etag(mut self, etag: &str) -> Self {
        self.etag = Some(etag.to_string());
        self
    }
}

#[derive(Clone, Default)]
struct Fake {
    replies: Arc<Mutex<HashMap<String, Reply>>>,
    hits: Arc<Mutex<Vec<(String, HeaderMap)>>>,
    base: String,
}

impl Fake {
    fn set(&self, path: &str, reply: Reply) {
        self.replies
            .lock()
            .expect("replies")
            .insert(path.to_string(), reply);
    }

    fn hits(&self, path: &str) -> Vec<HeaderMap> {
        self.hits
            .lock()
            .expect("hits")
            .iter()
            .filter(|(hit, _)| hit == path)
            .map(|(_, headers)| headers.clone())
            .collect()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

async fn answer(fake: Fake, request: Request) -> Response {
    let key = match request.uri().query() {
        Some(query) => format!("{}?{query}", request.uri().path()),
        None => request.uri().path().to_string(),
    };
    fake.hits
        .lock()
        .expect("hits")
        .push((key.clone(), request.headers().clone()));
    let reply = fake.replies.lock().expect("replies").get(&key).cloned();
    let Some(reply) = reply else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if let (Some(etag), Some(sent)) = (&reply.etag, request.headers().get("if-none-match")) {
        if sent.to_str().ok() == Some(etag.as_str()) {
            return StatusCode::NOT_MODIFIED.into_response();
        }
    }
    let mut response = Response::builder()
        .status(reply.status)
        .header("content-type", reply.content_type);
    if let Some(etag) = &reply.etag {
        response = response.header("etag", etag);
    }
    response
        .body(axum::body::Body::from(Bytes::from(reply.body)))
        .expect("response")
}

/// One fake for the whole test binary, on its own thread and runtime so it
/// outlives every test's runtime.
fn fake() -> &'static Fake {
    static FAKE: OnceLock<Fake> = OnceLock::new();
    FAKE.get_or_init(|| {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let fake = Fake {
            base: format!("http://127.0.0.1:{port}"),
            ..Fake::default()
        };
        let served = fake.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                let app = Router::new().fallback(move |request: Request| {
                    let fake = served.clone();
                    async move { answer(fake, request).await }
                });
                axum::serve(listener, app).await.expect("serve");
            });
        });
        paracord_core::feeds::set_endpoints_for_tests(FeedEndpoints {
            youtube: fake.url("/yt"),
            github: fake.url("/gh"),
            twitch_auth: fake.url("/twitch-id"),
            twitch_api: fake.url("/twitch-api"),
        });
        fake
    })
}

/// A path prefix no other test uses.
fn unique(prefix: &str) -> String {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    format!("/{prefix}{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn rss(title: &str, items: &[(&str, &str)]) -> String {
    let entries: String = items
        .iter()
        .enumerate()
        .map(|(index, (key, item_title))| {
            // The first item is the newest.
            let day = 28 - index;
            format!(
                "<item><title>{item_title}</title><link>https://news.example/{key}</link>\
                 <guid>{key}</guid><pubDate>{day} Sep 2026 12:00:00 GMT</pubDate>\
                 <description>&lt;p&gt;About {item_title}&lt;/p&gt;</description></item>"
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>{title}</title>\
         <link>https://news.example/</link>{entries}</channel></rss>"
    )
}

// ── Test context ───────────────────────────────────────────────────────────

struct Ctx {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    token: String,
    test_app: TestApp,
    guild_id: String,
    channel_id: String,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        fake();
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "feedsowner",
            "IntegrationPass123!",
        )
        .await?;
        let mut ctx = Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            token,
            test_app,
            guild_id: String::new(),
            channel_id: String::new(),
        };
        let (status, guild) = ctx
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Feeds Guild", "icon": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild: {guild}");
        ctx.guild_id = guild["id"].as_str().context("guild id")?.to_string();
        ctx.channel_id = ctx.create_channel("news", 0).await?;
        paracord_db::server_settings::set_setting(&ctx.db, "addons_local_network", "true").await?;
        let (status, body) = ctx
            .request(
                Method::PUT,
                &format!("/api/v1/guilds/{}/feeds/settings", ctx.guild_id),
                Some(json!({ "enabled": true })),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "enable: {body}");
        Ok(ctx)
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

    async fn create_channel(&self, name: &str, channel_type: i64) -> anyhow::Result<String> {
        let (status, payload) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{}/channels", self.guild_id),
                Some(json!({
                    "name": name,
                    "channel_type": channel_type,
                    "parent_id": Value::Null,
                    "required_role_ids": Value::Null,
                })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "channel: {payload}");
        Ok(payload["id"].as_str().context("channel id")?.to_string())
    }

    fn feeds_path(&self) -> String {
        format!("/api/v1/guilds/{}/feeds", self.guild_id)
    }

    async fn preview(&self, source: Value) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            Method::POST,
            &format!("{}/preview", self.feeds_path()),
            Some(source),
        )
        .await
    }

    async fn create(&self, source: Value) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            Method::POST,
            &self.feeds_path(),
            Some(json!({ "source": source, "channel_id": self.channel_id })),
        )
        .await
    }

    async fn create_ok(&self, source: Value) -> anyhow::Result<Value> {
        let (status, body) = self.create(source).await?;
        assert_eq!(status, StatusCode::CREATED, "create: {body}");
        Ok(body)
    }

    async fn list(&self) -> anyhow::Result<Value> {
        let (status, body) = self.request(Method::GET, &self.feeds_path(), None).await?;
        assert_eq!(status, StatusCode::OK, "list: {body}");
        Ok(body)
    }

    /// Make every source due and run one poller pass.
    async fn poll(&self) -> anyhow::Result<()> {
        sqlx::query("UPDATE feed_sources SET next_check_at = $1")
            .bind("2000-01-01 00:00:00")
            .execute(&self.db)
            .await?;
        paracord_api::routes::feeds_poll::poll_due_at(&self.test_app.state, Utc::now()).await;
        Ok(())
    }

    async fn messages(&self) -> anyhow::Result<Vec<Value>> {
        let (status, body) = self
            .request(
                Method::GET,
                &format!("/api/v1/channels/{}/messages?limit=50", self.channel_id),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "messages: {body}");
        let mut messages = body.as_array().cloned().unwrap_or_default();
        messages.sort_by_key(|message| {
            message["id"]
                .as_str()
                .and_then(|id| id.parse::<i64>().ok())
                .unwrap_or_default()
        });
        Ok(messages)
    }

    async fn member(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let (_, me) = self
            .request_as(Method::GET, "/api/v1/users/@me", None, &token)
            .await?;
        let uid = me["id"].as_str().context("uid")?.parse::<i64>()?;
        let guild = self.guild_id.parse::<i64>()?;
        paracord_db::members::add_member(&self.db, uid, guild).await?;
        paracord_db::roles::add_member_role(&self.db, uid, guild, guild).await?;
        Ok((token, uid))
    }
}

// ── RSS ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn rss_first_run_posts_nothing_and_new_items_post_once() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let path = unique("rss");
    let feed_path = format!("{path}/feed.xml");
    fake().set(
        &feed_path,
        Reply::xml(rss("Lantern Journal", &[("b", "Second"), ("a", "First")])).with_etag("\"v1\""),
    );

    let (status, preview) = ctx
        .preview(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["title"], "Lantern Journal");
    assert_eq!(preview["item_count"], 2);

    let created = ctx
        .create_ok(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;
    assert_eq!(created["feed"]["name"], "Lantern Journal");
    assert_eq!(created["newest"]["title"], "Second");
    assert!(ctx.messages().await?.is_empty(), "first run posts nothing");

    // Nothing new. The first check stores the ETag; the second sends it and
    // the fake answers 304.
    ctx.poll().await?;
    ctx.poll().await?;
    assert!(ctx.messages().await?.is_empty());
    let conditional = fake().hits(&feed_path);
    assert!(
        conditional
            .last()
            .and_then(|headers| headers.get("if-none-match"))
            .is_some(),
        "a later check sends the ETag"
    );
    let agent = conditional[0]
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        agent.starts_with("Paracord/") && agent.ends_with("(+feeds)"),
        "{agent}"
    );

    fake().set(
        &feed_path,
        Reply::xml(rss(
            "Lantern Journal",
            &[("c", "Third &amp; best"), ("b", "Second"), ("a", "First")],
        ))
        .with_etag("\"v2\""),
    );
    ctx.poll().await?;
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 1, "{messages:?}");
    let card = &messages[0];
    assert_eq!(card["author"]["username"], "Lantern Journal");
    assert_eq!(card["author"]["bot"], true);
    assert_eq!(card["feed"]["kind"], "rss");
    assert_eq!(card["feed"]["name"], "Lantern Journal");
    assert_eq!(card["content"], "Third & best");
    let embed = &card["embeds"][0];
    assert_eq!(embed["title"], "Third & best");
    assert_eq!(embed["url"], "https://news.example/c");
    assert_eq!(embed["description"], "About Third & best");
    assert_eq!(embed["feed"]["kind"], "rss");
    assert!(embed["timestamp"].is_string());

    // The same items again post nothing.
    fake().set(
        &feed_path,
        Reply::xml(rss(
            "Lantern Journal",
            &[("c", "Third &amp; best"), ("b", "Second"), ("a", "First")],
        ))
        .with_etag("\"v3\""),
    );
    ctx.poll().await?;
    assert_eq!(ctx.messages().await?.len(), 1);

    let list = ctx.list().await?;
    let status = &list["feeds"][0]["status"];
    assert!(status["error"].is_null(), "{list}");
    assert!(status["last_checked_at"].is_string());
    assert!(status["last_posted_at"].is_string());
    Ok(())
}

#[tokio::test]
async fn at_most_five_cards_and_one_line_for_the_rest() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let feed_path = format!("{}/feed.xml", unique("cap"));
    fake().set(&feed_path, Reply::xml(rss("Busy Blog", &[("old", "Old")])));
    ctx.create_ok(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;

    let keys: Vec<String> = (0..12).map(|n| format!("n{n}")).collect();
    let mut items: Vec<(&str, &str)> = keys
        .iter()
        .rev()
        .map(|key| (key.as_str(), key.as_str()))
        .collect();
    items.push(("old", "Old"));
    fake().set(&feed_path, Reply::xml(rss("Busy Blog", &items)));
    ctx.poll().await?;

    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 6, "five cards and one line");
    let last = &messages[5];
    assert_eq!(last["content"], "and 7 more from Busy Blog");
    assert_eq!(last["embeds"][0]["feed"]["more"], 7);
    assert_eq!(last["embeds"][0]["url"], "https://news.example/");
    // The five newest, oldest first.
    let titles: Vec<&str> = messages[..5]
        .iter()
        .map(|message| message["content"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(titles, vec!["n7", "n8", "n9", "n10", "n11"]);

    // The seven are seen too: nothing more posts on the next check.
    ctx.poll().await?;
    assert_eq!(ctx.messages().await?.len(), 6);
    Ok(())
}

#[tokio::test]
async fn a_web_page_leads_to_its_feed() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let path = unique("page");
    fake().set(
        &format!("{path}/"),
        Reply::html(format!(
            "<!doctype html><html><head><title>Blog</title>\
             <link rel=\"alternate\" type=\"application/atom+xml\" href=\"{path}/atom.xml\"></head></html>"
        )),
    );
    fake().set(
        &format!("{path}/atom.xml"),
        Reply::xml(
            "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><title>Atom Blog</title>\
             <entry><id>tag:x,1</id><title>Hello</title><link href=\"https://blog.example/hello\"/>\
             <updated>2026-09-20T10:00:00Z</updated></entry></feed>",
        ),
    );
    let (status, preview) = ctx
        .preview(json!({ "kind": "rss", "input": fake().url(&format!("{path}/")) }))
        .await?;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["title"], "Atom Blog");
    assert_eq!(preview["item_count"], 1);
    assert_eq!(preview["source"], fake().url(&format!("{path}/atom.xml")));

    fake().set(
        &format!("{path}/plain"),
        Reply::html("<!doctype html><html><head><title>No feed</title></head></html>"),
    );
    let (status, body) = ctx
        .preview(json!({ "kind": "rss", "input": fake().url(&format!("{path}/plain")) }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.to_string().contains("That page doesn't list a feed"),
        "{body}"
    );
    Ok(())
}

#[tokio::test]
async fn errors_are_shown_in_plain_words_and_back_off() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let feed_path = format!("{}/feed.xml", unique("err"));
    fake().set(&feed_path, Reply::xml(rss("Flaky", &[("a", "A")])));
    ctx.create_ok(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;

    fake().set(&feed_path, Reply::status(404));
    ctx.poll().await?;
    let list = ctx.list().await?;
    let status = &list["feeds"][0]["status"];
    assert_eq!(status["error"], "The feed address returned 404.", "{list}");
    let next =
        chrono::DateTime::parse_from_rfc3339(status["next_check_at"].as_str().context("next")?)?;
    let wait = next.with_timezone(&Utc) - Utc::now();
    assert!(
        wait > Duration::minutes(19),
        "one error doubles the wait: {wait}"
    );

    // Recovering clears the error.
    fake().set(&feed_path, Reply::xml(rss("Flaky", &[("a", "A")])));
    ctx.poll().await?;
    let list = ctx.list().await?;
    assert!(list["feeds"][0]["status"]["error"].is_null(), "{list}");

    let (status, body) = ctx
        .preview(json!({ "kind": "rss", "input": fake().url("/nothing-here.xml") }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("returned 404"), "{body}");
    Ok(())
}

#[tokio::test]
async fn post_the_latest_now_and_remove() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let feed_path = format!("{}/feed.xml", unique("now"));
    fake().set(
        &feed_path,
        Reply::xml(rss("Now Blog", &[("b", "Newest"), ("a", "Older")])),
    );
    let created = ctx
        .create_ok(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;
    let feed_id = created["feed"]["id"]
        .as_str()
        .context("feed id")?
        .to_string();

    let (status, body) = ctx
        .request(
            Method::POST,
            &format!("{}/{feed_id}/post-latest", ctx.feeds_path()),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "Newest");

    // Paused feeds are not checked.
    let (status, paused) = ctx
        .request(
            Method::PATCH,
            &format!("{}/{feed_id}", ctx.feeds_path()),
            Some(json!({ "paused": true, "name": "Renamed", "show_on_front_page": false })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{paused}");
    assert_eq!(paused["paused"], true);
    assert_eq!(paused["name"], "Renamed");
    assert_eq!(paused["show_on_front_page"], false);
    fake().set(
        &feed_path,
        Reply::xml(rss("Now Blog", &[("c", "Newer still"), ("b", "Newest")])),
    );
    let before = fake().hits(&feed_path).len();
    ctx.poll().await?;
    assert_eq!(
        fake().hits(&feed_path).len(),
        before,
        "a paused feed is not fetched"
    );

    let (status, _) = ctx
        .request(
            Method::DELETE,
            &format!("{}/{feed_id}", ctx.feeds_path()),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(ctx.list().await?["feeds"].as_array().map(Vec::len), Some(0));
    // Its post stays, still reading as the feed.
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["author"]["username"], "Now Blog");
    let sources: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM feed_sources")
        .fetch_one(&ctx.db)
        .await?;
    assert_eq!(sources, 0, "an orphaned source is removed");
    Ok(())
}

// ── YouTube ────────────────────────────────────────────────────────────────

fn youtube_feed(channel: &str, videos: &[(&str, &str)]) -> String {
    let entries: String = videos
        .iter()
        .map(|(id, title)| {
            format!(
                "<entry><id>yt:video:{id}</id><yt:videoId>{id}</yt:videoId><title>{title}</title>\
                 <link rel=\"alternate\" href=\"https://www.youtube.com/watch?v={id}\"/>\
                 <published>2026-09-2{}T10:00:00+00:00</published>\
                 <media:group><media:thumbnail url=\"https://i1.ytimg.com/vi/{id}/hqdefault.jpg\" width=\"480\" height=\"360\"/>\
                 <media:description>About {title}</media:description></media:group></entry>",
                title.len() % 9
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\"?><feed xmlns:yt=\"http://www.youtube.com/xml/schemas/2015\" \
         xmlns:media=\"http://search.yahoo.com/mrss/\" xmlns=\"http://www.w3.org/2005/Atom\">\
         <title>{channel}</title>{entries}</feed>"
    )
}

#[tokio::test]
async fn a_youtube_handle_resolves_to_its_channel_feed() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let serial = unique("");
    let channel_id = format!("UC{:0>22}", serial.trim_start_matches('/'));
    let handle = format!("lantern{}", serial.trim_start_matches('/'));
    fake().set(
        &format!("/yt/@{handle}"),
        Reply::html(format!(
            "<!doctype html><html><head>\
             <meta property=\"og:image\" content=\"https://yt3.example/avatar.jpg\">\
             <link rel=\"alternate\" type=\"application/rss+xml\" title=\"RSS\" \
             href=\"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}\"></head></html>"
        )),
    );
    let feed_key = format!("/yt/feeds/videos.xml?channel_id={channel_id}");
    fake().set(
        &feed_key,
        Reply::xml(youtube_feed(
            "Lantern Works",
            &[("aaaaaaaaaaa", "First video")],
        )),
    );

    let created = ctx
        .create_ok(json!({ "kind": "youtube", "input": format!("https://www.youtube.com/@{handle}/videos") }))
        .await?;
    assert_eq!(created["feed"]["name"], "Lantern Works");
    assert_eq!(
        created["feed"]["icon_url"],
        "https://yt3.example/avatar.jpg"
    );
    assert_eq!(created["newest"]["title"], "First video");

    fake().set(
        &feed_key,
        Reply::xml(youtube_feed(
            "Lantern Works",
            &[
                ("bbbbbbbbbbb", "Second video"),
                ("aaaaaaaaaaa", "First video"),
            ],
        )),
    );
    ctx.poll().await?;
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 1);
    let embed = &messages[0]["embeds"][0];
    assert_eq!(embed["feed"]["kind"], "youtube");
    assert_eq!(embed["feed"]["video_id"], "bbbbbbbbbbb");
    assert_eq!(
        embed["thumbnail"],
        "https://i1.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg"
    );
    assert_eq!(embed["url"], "https://www.youtube.com/watch?v=bbbbbbbbbbb");
    assert_eq!(
        messages[0]["author"]["avatar_url"],
        "https://yt3.example/avatar.jpg"
    );

    let (status, body) = ctx
        .preview(json!({ "kind": "youtube", "input": "https://vimeo.com/1" }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.to_string().contains("YouTube channel or video"),
        "{body}"
    );
    Ok(())
}

// ── GitHub ─────────────────────────────────────────────────────────────────

fn github_atom(entries: &[(&str, &str)]) -> String {
    let body: String = entries
        .iter()
        .map(|(id, title)| {
            format!(
                "<entry><id>tag:github.com,2008:Repository/1/{id}</id><title>{title}</title>\
                 <link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/o/r/releases/tag/{id}\"/>\
                 <updated>2026-09-20T10:00:00Z</updated><content type=\"html\">&lt;h2&gt;Notes&lt;/h2&gt;</content></entry>"
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><title>Release notes from r</title>{body}</feed>"
    )
}

#[tokio::test]
async fn github_releases_commits_and_a_missing_repository() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let owner = format!("owner{}", unique("").trim_start_matches('/'));
    fake().set(
        &format!("/gh/{owner}/repo/releases.atom"),
        Reply::xml(github_atom(&[("v1.0.0", "v1.0.0")])),
    );
    fake().set(
        &format!("/gh/{owner}/repo/commits/release/3.2.atom"),
        Reply::xml(github_atom(&[("abc", "Fix the thing")])),
    );

    let created = ctx
        .create_ok(json!({ "kind": "github", "input": format!("https://github.com/{owner}/repo") }))
        .await?;
    assert_eq!(created["feed"]["name"], format!("{owner}/repo"));
    assert_eq!(created["feed"]["github_mode"], "releases");
    assert_eq!(
        created["feed"]["icon_url"],
        format!("https://github.com/{owner}.png?size=96")
    );

    let (status, preview) = ctx
        .preview(json!({
            "kind": "github", "input": format!("{owner}/repo"),
            "github_mode": "commits", "branch": "release/3.2"
        }))
        .await?;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["newest"]["title"], "Fix the thing");

    let (status, body) = ctx
        .preview(json!({ "kind": "github", "input": format!("{owner}/missing") }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.to_string().contains(&format!(
            "GitHub has no public repository called {owner}/missing."
        )),
        "{body}"
    );
    let (status, body) = ctx
        .preview(
            json!({ "kind": "github", "input": format!("{owner}/repo"), "github_mode": "commits" }),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("Name the branch"), "{body}");
    Ok(())
}

// ── Twitch ─────────────────────────────────────────────────────────────────

async fn make_admin(ctx: &Ctx) -> anyhow::Result<()> {
    let (_, me) = ctx.request(Method::GET, "/api/v1/users/@me", None).await?;
    let uid = me["id"].as_str().context("uid")?.parse::<i64>()?;
    paracord_db::users::update_user_flags(&ctx.db, uid, paracord_core::USER_FLAG_ADMIN).await?;
    Ok(())
}

#[tokio::test]
async fn twitch_needs_instance_credentials_and_posts_once_per_stream() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let login = format!("lantern{}", unique("").trim_start_matches('/'));

    let list = ctx.list().await?;
    assert_eq!(list["twitch_available"], false);
    let (status, body) = ctx
        .preview(json!({ "kind": "twitch", "input": login }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.to_string()
            .contains("Your instance admin needs to add Twitch credentials first."),
        "{body}"
    );

    // Only an instance admin sets them, and the secret never comes back.
    let (status, _) = ctx
        .request(
            Method::PATCH,
            "/api/v1/admin/addons",
            Some(json!({ "twitch_client_id": "abc123", "twitch_client_secret": "shh-secret" })),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    make_admin(&ctx).await?;
    let (status, admin) = ctx
        .request(
            Method::PATCH,
            "/api/v1/admin/addons",
            Some(json!({ "twitch_client_id": "abc123", "twitch_client_secret": "shh-secret" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{admin}");
    assert_eq!(admin["twitch_client_id"], "abc123");
    assert_eq!(admin["twitch_secret_set"], true);
    assert!(!admin.to_string().contains("shh-secret"));
    let stored: String =
        sqlx::query_scalar("SELECT value FROM server_settings WHERE key = 'twitch_client_secret'")
            .fetch_one(&ctx.db)
            .await?;
    assert!(
        stored.starts_with("enc:v1:") && !stored.contains("shh-secret"),
        "{stored}"
    );
    assert_eq!(ctx.list().await?["twitch_available"], true);

    fake().set(
        "/twitch-id/oauth2/token",
        Reply::json(json!({ "access_token": "app-token", "expires_in": 3600 })),
    );
    fake().set(
        &format!("/twitch-api/helix/users?login={login}"),
        Reply::json(json!({ "data": [{
            "login": login, "display_name": "LanternLive",
            "profile_image_url": "https://static-cdn.example/lantern.png"
        }] })),
    );
    let streams = format!("/twitch-api/helix/streams?user_login={login}");
    fake().set(&streams, Reply::json(json!({ "data": [] })));

    let created = ctx
        .create_ok(json!({ "kind": "twitch", "input": format!("https://www.twitch.tv/{login}") }))
        .await?;
    assert_eq!(created["feed"]["name"], "LanternLive");
    assert!(created["newest"].is_null(), "offline at first");
    let helix = fake().hits(&streams);
    let headers = helix.last().context("helix call")?;
    assert_eq!(
        headers.get("client-id").and_then(|v| v.to_str().ok()),
        Some("abc123")
    );
    assert_eq!(
        headers.get("authorization").and_then(|v| v.to_str().ok()),
        Some("Bearer app-token")
    );

    let live = Reply::json(json!({ "data": [{
        "id": "stream-1", "user_name": "LanternLive", "title": "Building a lamp",
        "game_name": "Just Chatting", "started_at": "2026-09-24T18:00:00Z",
        "thumbnail_url": "https://static-cdn.example/live_{width}x{height}.jpg"
    }] }));
    fake().set(&streams, live);
    ctx.poll().await?;
    ctx.poll().await?;
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 1, "once per stream, not per check");
    assert_eq!(
        messages[0]["content"],
        "LanternLive is live: Building a lamp · Just Chatting"
    );
    assert_eq!(
        messages[0]["embeds"][0]["thumbnail"],
        "https://static-cdn.example/live_640x360.jpg"
    );
    Ok(())
}

// ── Jellyfin ───────────────────────────────────────────────────────────────

const JELLYFIN_ITEMS: &str = "/Items?SortBy=DateCreated&SortOrder=Descending&IncludeItemTypes=Movie,Episode,MusicAlbum&Recursive=true&Limit=40&Fields=DateCreated,Overview,ProductionYear&EnableImageTypes=Primary&ImageTypeLimit=1";

fn episode(id: &str, number: i64) -> Value {
    json!({
        "Id": id, "Name": format!("Episode {number}"), "Type": "Episode",
        "SeriesName": "Severance", "SeriesId": "series1", "SeriesPrimaryImageTag": "tag",
        "ParentIndexNumber": 2, "IndexNumber": number,
        "DateCreated": format!("2026-09-2{number}T10:00:00.0000000Z")
    })
}

#[tokio::test]
async fn jellyfin_groups_episodes_stores_posters_and_keeps_the_key() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let base = unique("jf");
    let key = "jellyfin-secret-key-123";
    fake().set(
        &format!("{base}/System/Info"),
        Reply::json(json!({ "ServerName": "Home Theater", "Version": "10.10.0" })),
    );
    let items_path = format!("{base}{JELLYFIN_ITEMS}");
    fake().set(
        &items_path,
        Reply::json(json!({ "Items": [{
            "Id": "old1", "Name": "Old Movie", "Type": "Movie", "ProductionYear": 1999,
            "DateCreated": "2026-01-01T00:00:00Z", "ImageTags": { "Primary": "t" }
        }] })),
    );
    let jpeg: Vec<u8> = [0xff, 0xd8, 0xff, 0xe0]
        .into_iter()
        .chain(std::iter::repeat_n(7u8, 64))
        .collect();
    fake().set(
        &format!("{base}/Items/series1/Images/Primary?fillHeight=480&quality=85"),
        Reply {
            status: 200,
            content_type: "image/jpeg",
            body: jpeg.clone(),
            etag: None,
        },
    );

    let (status, body) = ctx
        .preview(json!({ "kind": "jellyfin", "input": fake().url(&base) }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("API key"), "{body}");

    let created = ctx
        .create_ok(json!({ "kind": "jellyfin", "input": fake().url(&base), "api_key": key }))
        .await?;
    assert_eq!(created["feed"]["name"], "Home Theater");
    assert_eq!(created["feed"]["api_key_set"], true);
    assert!(
        !created.to_string().contains(key),
        "the key never comes back"
    );
    assert!(!ctx.list().await?.to_string().contains(key));
    let stored: String = sqlx::query_scalar("SELECT secret FROM guild_feeds")
        .fetch_one(&ctx.db)
        .await?;
    assert!(stored.starts_with("enc:v1:"), "stored encrypted: {stored}");
    assert!(!stored.contains(key));
    let auth = fake().hits(&format!("{base}/System/Info"));
    let header = auth
        .last()
        .and_then(|headers| headers.get("authorization"))
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(header.contains(&format!("Token=\"{key}\"")), "{header}");

    fake().set(
        &items_path,
        Reply::json(json!({ "Items": [
            episode("ep3", 3),
            {
                "Id": "mov1", "Name": "Arrival", "Type": "Movie", "ProductionYear": 2016,
                "DateCreated": "2026-09-21T09:00:00Z", "Overview": "A linguist."
            },
            episode("ep2", 2),
            episode("ep1", 1),
            {
                "Id": "old1", "Name": "Old Movie", "Type": "Movie", "ProductionYear": 1999,
                "DateCreated": "2026-01-01T00:00:00Z", "ImageTags": { "Primary": "t" }
            }
        ] })),
    );
    ctx.poll().await?;
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert_eq!(messages[0]["content"], "Arrival (2016)");
    assert_eq!(messages[1]["content"], "3 new episodes of Severance");
    let attachments = messages[1]["attachments"]
        .as_array()
        .context("attachments")?;
    assert_eq!(attachments.len(), 1, "the poster is stored with the card");
    let poster_url = attachments[0]["url"].as_str().context("url")?;
    assert_eq!(messages[1]["embeds"][0]["thumbnail"], poster_url);
    assert!(poster_url.starts_with("/api/v1/attachments/"));
    assert!(
        !messages[1].to_string().contains("series1/Images"),
        "clients never see Jellyfin"
    );

    // The stored copy is what clients download.
    let request = build_json_request(Method::GET, poster_url, None, Some(&ctx.token))?;
    let response = tower::ServiceExt::oneshot(ctx.app.clone(), request).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(bytes.as_ref(), jpeg.as_slice());
    Ok(())
}

// ── Safety ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn private_and_reserved_addresses_are_refused() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    paracord_db::server_settings::set_setting(&ctx.db, "addons_local_network", "false").await?;
    let feed_path = format!("{}/feed.xml", unique("ssrf"));
    fake().set(&feed_path, Reply::xml(rss("Local", &[("a", "A")])));

    for input in [
        fake().url(&feed_path),
        "http://localhost:9/feed".to_string(),
        "http://2130706433/feed".to_string(),
        "http://[::ffff:127.0.0.1]/feed".to_string(),
        "http://10.0.0.8/feed".to_string(),
        "http://100.64.1.1/feed".to_string(),
    ] {
        let (status, body) = ctx
            .preview(json!({ "kind": "rss", "input": input }))
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{input}: {body}");
        assert!(
            body.to_string()
                .contains(LOCAL_NETWORK_REFUSAL.split('"').next().unwrap_or("")),
            "{input}: {body}"
        );
    }
    for input in [
        "http://169.254.169.254/latest/meta-data",
        "http://[fe80::1]/",
        "http://0.0.0.0/",
    ] {
        let (status, body) = ctx
            .preview(json!({ "kind": "rss", "input": input }))
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{input}");
        assert!(body.to_string().contains("never reach"), "{input}: {body}");
    }
    let (status, body) = ctx
        .preview(json!({ "kind": "rss", "input": "file:///etc/passwd" }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("Only http and https"), "{body}");

    // A home Jellyfin is refused with the words that say how to allow it.
    let (status, body) = ctx
        .preview(json!({ "kind": "jellyfin", "input": "http://192.168.1.20:8096", "api_key": "k" }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.to_string()
            .contains("Add-ons may reach this instance's local network"),
        "{body}"
    );

    // With the admin setting on, the same local address works.
    paracord_db::server_settings::set_setting(&ctx.db, "addons_local_network", "true").await?;
    let (status, body) = ctx
        .preview(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(())
}

#[tokio::test]
async fn managing_feeds_needs_manage_server_and_a_channel_you_can_send_in() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let feed_path = format!("{}/feed.xml", unique("perm"));
    fake().set(&feed_path, Reply::xml(rss("Perm", &[("a", "A")])));
    let guild = ctx.guild_id.parse::<i64>()?;

    let (member_token, member_id) = ctx.member("plainmember").await?;
    let (status, _) = ctx
        .request_as(Method::GET, &ctx.feeds_path(), None, &member_token)
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = ctx
        .request_as(
            Method::POST,
            &ctx.feeds_path(),
            Some(json!({ "source": { "kind": "rss", "input": fake().url(&feed_path) }, "channel_id": ctx.channel_id })),
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A manager who can't send in the channel can't point a feed at it.
    let role_id = paracord_util::snowflake::generate(1);
    paracord_db::roles::create_role(
        &ctx.db,
        role_id,
        guild,
        "Managers",
        Permissions::MANAGE_GUILD.bits() | Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;
    paracord_db::roles::add_member_role(&ctx.db, member_id, guild, role_id).await?;
    let quiet = ctx.create_channel("quiet", 0).await?;
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        quiet.parse::<i64>()?,
        guild,
        paracord_core::permissions::OVERWRITE_TARGET_ROLE,
        0,
        Permissions::SEND_MESSAGES.bits(),
    )
    .await?;
    paracord_core::permissions::invalidate_user(&ctx.test_app.state.permission_cache, member_id)
        .await;
    let (status, body) = ctx
        .request_as(
            Method::POST,
            &ctx.feeds_path(),
            Some(json!({ "source": { "kind": "rss", "input": fake().url(&feed_path) }, "channel_id": quiet })),
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body.to_string()
            .contains("channel you can send messages in"),
        "{body}"
    );

    // A voice channel is not a destination.
    let voice = ctx.create_channel("hangout", 2).await?;
    let (status, body) = ctx
        .request(
            Method::POST,
            &ctx.feeds_path(),
            Some(json!({ "source": { "kind": "rss", "input": fake().url(&feed_path) }, "channel_id": voice })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body.to_string().contains("text or announcement channel"),
        "{body}"
    );

    // The add-on has to be on.
    let (status, _) = ctx
        .request(
            Method::PUT,
            &format!("{}/settings", ctx.feeds_path()),
            Some(json!({ "enabled": false })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = ctx
        .create(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("not turned on"), "{body}");
    Ok(())
}

#[tokio::test]
async fn a_server_can_have_at_most_twenty_feeds() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild = ctx.guild_id.parse::<i64>()?;
    let channel = ctx.channel_id.parse::<i64>()?;
    for n in 0..20 {
        let key = format!("https://filler.example/{n}.xml");
        let source_id = paracord_db::feeds::upsert_source(
            &ctx.db,
            paracord_util::snowflake::generate(1),
            &paracord_db::feeds::NewSource {
                kind: "rss",
                source_key: &key,
                url: &key,
                title: None,
                site_url: None,
                icon_url: None,
                next_check_at: Utc::now() + Duration::days(1),
            },
        )
        .await?;
        paracord_db::feeds::create_feed(
            &ctx.db,
            &paracord_db::feeds::NewGuildFeed {
                id: paracord_util::snowflake::generate(1),
                guild_id: guild,
                channel_id: channel,
                source_id,
                creator_id: 1,
                kind: "rss",
                name: "Filler",
                options: "{}",
                secret: None,
                show_on_front_page: true,
            },
        )
        .await?;
    }
    let feed_path = format!("{}/feed.xml", unique("limit"));
    fake().set(&feed_path, Reply::xml(rss("One too many", &[("a", "A")])));
    let (status, body) = ctx
        .create(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("at most 20 feeds"), "{body}");
    assert_eq!(ctx.list().await?["limit"], 20);
    Ok(())
}

#[tokio::test]
async fn one_fetch_serves_every_server_following_an_address() -> anyhow::Result<()> {
    let first = Ctx::new().await?;
    let feed_path = format!("{}/feed.xml", unique("shared"));
    fake().set(&feed_path, Reply::xml(rss("Shared", &[("a", "A")])));
    first
        .create_ok(json!({ "kind": "rss", "input": fake().url(&feed_path) }))
        .await?;
    // A second server on the same instance.
    let other_channel;
    {
        let (status, guild) = first
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Second", "icon": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED);
        let guild_id = guild["id"].as_str().context("guild")?.to_string();
        let (status, channel) = first
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!({ "name": "news", "channel_type": 0, "parent_id": Value::Null, "required_role_ids": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED);
        other_channel = channel["id"].as_str().context("channel")?.to_string();
        first
            .request(
                Method::PUT,
                &format!("/api/v1/guilds/{guild_id}/feeds/settings"),
                Some(json!({ "enabled": true })),
            )
            .await?;
        let (status, body) = first
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/feeds"),
                Some(json!({ "source": { "kind": "rss", "input": fake().url(&feed_path) }, "channel_id": other_channel })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let sources: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM feed_sources")
        .fetch_one(&first.db)
        .await?;
    assert_eq!(sources, 1);

    fake().set(
        &feed_path,
        Reply::xml(rss("Shared", &[("b", "B"), ("a", "A")])),
    );
    let before = fake().hits(&feed_path).len();
    first.poll().await?;
    assert_eq!(fake().hits(&feed_path).len(), before + 1, "fetched once");
    assert_eq!(first.messages().await?.len(), 1);
    let (_, other) = first
        .request(
            Method::GET,
            &format!("/api/v1/channels/{other_channel}/messages"),
            None,
        )
        .await?;
    assert_eq!(other.as_array().map(Vec::len), Some(1));
    Ok(())
}
