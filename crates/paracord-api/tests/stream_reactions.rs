//! Glass (WP-G17): reactions on the stream. Who may send them (people in the
//! call or watching it, with VIEW_CHANNEL), the one-a-second limit, and who
//! receives the `STREAM_REACTIONS` event (the channel's voice members and its
//! watch viewers, nobody else in the server).
//!
//! Runs on in-memory SQLite by default and on PostgreSQL when
//! `PARACORD_TEST_POSTGRES_URL` is set (see `common::build_test_app`).

mod common;

use std::time::Duration;

use anyhow::Context;
use axum::body::to_bytes;
use axum::http::{header, Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_contracts::voice as wire;
use paracord_core::events::ServerEvent;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tokio::sync::broadcast::Receiver;
use tower::ServiceExt;

const JWT_SECRET: &str = "stream-reactions-secret";
/// Channel permission overwrite on a single member.
const OVERWRITE_TARGET_MEMBER: i16 = 1;

struct Ctx {
    app: TestApp,
    owner_token: String,
    guild_id: i64,
    voice_id: i64,
}

struct Person {
    token: String,
    id: i64,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let app = build_test_app(TestAppOptions {
            jwt_secret: JWT_SECRET.to_string(),
            native_media_enabled: true,
            ..Default::default()
        })
        .await?;
        let owner_token =
            create_authenticated_user_token(&app.db, JWT_SECRET, "owner", "OwnerPass123!").await?;
        let mut ctx = Self {
            app,
            owner_token,
            guild_id: 0,
            voice_id: 0,
        };
        let (status, guild) = ctx
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Game Night", "icon": Value::Null })),
                &ctx.owner_token.clone(),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{guild}");
        ctx.guild_id = guild["id"].as_str().context("guild id")?.parse()?;
        ctx.voice_id = ctx.channel("Lounge", 2).await?;
        Ok(ctx)
    }

    async fn channel(&self, name: &str, channel_type: i16) -> anyhow::Result<i64> {
        let (status, channel) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{}/channels", self.guild_id),
                Some(json!({
                    "name": name,
                    "channel_type": channel_type,
                    "parent_id": Value::Null,
                    "required_role_ids": Value::Null,
                })),
                &self.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{channel}");
        Ok(channel["id"].as_str().context("channel id")?.parse()?)
    }

    /// A new account; a member of the server when `member` is true.
    async fn person(&self, prefix: &str, member: bool) -> anyhow::Result<Person> {
        let token =
            create_authenticated_user_token(&self.app.db, JWT_SECRET, prefix, "MemberPass123!")
                .await?;
        let id = paracord_core::auth::validate_token(&token, JWT_SECRET)?.sub;
        if member {
            paracord_db::members::add_member(&self.app.db, id, self.guild_id).await?;
            self.app.state.member_index.add_member(self.guild_id, id);
        }
        Ok(Person { token, id })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(
            &self.app.app,
            build_json_request(method, path, body, Some(token))?,
        )
        .await
    }

    async fn join(&self, who: &Person, mode: &str) -> anyhow::Result<String> {
        let (status, body) = self
            .request(
                Method::POST,
                &format!("/api/v2/voice/{}/join?mode={mode}", self.voice_id),
                None,
                &who.token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "join: {body}");
        Ok(body["session_id"].as_str().context("receipt")?.to_string())
    }

    async fn stream(&self, who: &Person) -> anyhow::Result<()> {
        let session = self.join(who, "joined").await?;
        let (status, body) = self
            .request(
                Method::POST,
                &format!(
                    "/api/v1/voice/{}/stream?session_id={session}",
                    self.voice_id
                ),
                None,
                &who.token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "stream: {body}");
        Ok(())
    }

    async fn view(&self, who: &Person, kind: &str, streamer: &Person) -> anyhow::Result<()> {
        let (status, body) = self
            .request(
                Method::POST,
                &format!("/api/v2/voice/{}/view", self.voice_id),
                Some(json!({ "kind": kind, "user_id": streamer.id.to_string() })),
                &who.token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "view: {body}");
        Ok(())
    }

    fn react_body(kind: &str, streamer: &Person) -> Value {
        json!({ "kind": kind, "stream_user_id": streamer.id.to_string() })
    }

    async fn react(&self, who: &Person, body: Value) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            Method::POST,
            &format!("/api/v2/voice/{}/stream-reactions", self.voice_id),
            Some(body),
            &who.token,
        )
        .await
    }
}

/// The next `STREAM_REACTIONS` on the bus, with its recipients (bounded wait).
async fn next_reactions(rx: &mut Receiver<ServerEvent>) -> anyhow::Result<(Value, Vec<i64>)> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = rx.recv().await?;
            if event.event_type == "STREAM_REACTIONS" {
                assert!(event.guild_id.is_none(), "never guild-wide");
                let mut targets = event.target_user_ids.clone().context("a targeted event")?;
                targets.sort_unstable();
                return anyhow::Ok(((*event.payload).clone(), targets));
            }
        }
    })
    .await
    .context("a STREAM_REACTIONS event arrives")?
}

/// No `STREAM_REACTIONS` within a coalescing window and a half.
async fn assert_no_reactions(rx: &mut Receiver<ServerEvent>) {
    tokio::time::sleep(Duration::from_millis(400)).await;
    while let Ok(event) = rx.try_recv() {
        assert_ne!(
            event.event_type, "STREAM_REACTIONS",
            "unexpected event: {}",
            event.payload
        );
    }
}

fn sorted(mut ids: Vec<i64>) -> Vec<i64> {
    ids.sort_unstable();
    ids
}

#[tokio::test]
async fn members_and_viewers_react_and_only_they_receive_it() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let vincent = ctx.person("vincent", true).await?;
    let brendan = ctx.person("brendan", true).await?;
    let nick = ctx.person("nick", true).await?;
    let luke = ctx.person("luke", true).await?;
    let sean = ctx.person("sean", true).await?;
    let ambient = ctx.person("ambient", true).await?;
    let elsewhere = ctx.person("elsewhere", true).await?;

    ctx.stream(&vincent).await?;
    ctx.join(&brendan, "joined").await?;
    ctx.join(&nick, "listen").await?;
    ctx.view(&luke, "watch", &vincent).await?;
    ctx.view(&sean, "watch", &vincent).await?;
    ctx.view(&ambient, "ambient", &vincent).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    // Sean, watching without joining, sends a flame.
    let (status, body) = ctx
        .react(
            &sean,
            json!({
                "kind": "flame",
                "stream_user_id": vincent.id.to_string(),
                "nonce": "sean-1",
            }),
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (payload, targets) = next_reactions(&mut events).await?;
    let event: wire::StreamReactions =
        serde_json::from_value(payload.clone()).context("the event matches the contract")?;
    assert_eq!(event.guild_id, ctx.guild_id.to_string());
    assert_eq!(event.channel_id, ctx.voice_id.to_string());
    assert_eq!(event.reactions.len(), 1, "{payload}");
    let reaction = &event.reactions[0];
    assert_eq!(reaction.user_id, sean.id.to_string());
    assert_eq!(reaction.stream_user_id, vincent.id.to_string());
    assert_eq!(reaction.kind, wire::StreamReactionKind::Flame);
    assert_eq!(reaction.count, 1);
    assert_eq!(reaction.nonce.as_deref(), Some("sean-1"));
    assert!(reaction.username.starts_with("sean"), "{payload}");

    // The call (joined and listening), the watchers, and the sender's own echo.
    assert_eq!(
        targets,
        sorted(vec![vincent.id, brendan.id, nick.id, luke.id, sean.id]),
        "the channel's members and watch viewers only"
    );
    assert!(
        !targets.contains(&elsewhere.id),
        "not the rest of the server"
    );
    assert!(
        !targets.contains(&ambient.id),
        "the room light is not watching"
    );

    // A listener in the call may react too, with a heart merging three taps.
    let (status, body) = ctx
        .react(
            &nick,
            json!({ "kind": "heart", "stream_user_id": vincent.id.to_string(), "count": 3 }),
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (payload, _) = next_reactions(&mut events).await?;
    assert_eq!(payload["reactions"][0]["kind"], "heart");
    assert_eq!(payload["reactions"][0]["count"], 3);
    assert_eq!(payload["reactions"][0]["nonce"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn reactions_arriving_together_go_out_as_one_event() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let vincent = ctx.person("vincent", true).await?;
    let brendan = ctx.person("brendan", true).await?;
    let luke = ctx.person("luke", true).await?;
    ctx.stream(&vincent).await?;
    ctx.join(&brendan, "joined").await?;
    ctx.view(&luke, "watch", &vincent).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    for who in [&brendan, &luke] {
        let (status, body) = ctx.react(who, Ctx::react_body("flame", &vincent)).await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }
    let (payload, _) = next_reactions(&mut events).await?;
    let senders: Vec<&str> = payload["reactions"]
        .as_array()
        .context("reactions")?
        .iter()
        .filter_map(|reaction| reaction["user_id"].as_str())
        .collect();
    let brendan_id = brendan.id.to_string();
    let luke_id = luke.id.to_string();
    assert_eq!(
        senders,
        vec![brendan_id.as_str(), luke_id.as_str()],
        "in arrival order"
    );
    assert_no_reactions(&mut events).await;
    Ok(())
}

#[tokio::test]
async fn only_people_in_the_call_or_watching_may_react() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let vincent = ctx.person("vincent", true).await?;
    let elsewhere = ctx.person("elsewhere", true).await?;
    let stranger = ctx.person("stranger", false).await?;
    let ambient = ctx.person("ambient", true).await?;
    let luke = ctx.person("luke", true).await?;
    ctx.stream(&vincent).await?;
    ctx.view(&ambient, "ambient", &vincent).await?;
    ctx.view(&luke, "watch", &vincent).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    // A member of the server who is neither in the call nor watching.
    let (status, body) = ctx
        .react(&elsewhere, Ctx::react_body("flame", &vincent))
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Someone who is not in the server at all.
    let (status, body) = ctx
        .react(&stranger, Ctx::react_body("flame", &vincent))
        .await?;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "{status} {body}"
    );

    // The room light is not watching.
    let (status, body) = ctx
        .react(&ambient, Ctx::react_body("heart", &vincent))
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // A viewer who lost VIEW_CHANNEL (before the sweep ends the view) cannot.
    let (status, body) = ctx
        .request(
            Method::PUT,
            &format!("/api/v1/channels/{}/overwrites/{}", ctx.voice_id, luke.id),
            Some(json!({
                "target_type": OVERWRITE_TARGET_MEMBER,
                "allow_perms": 0,
                "deny_perms": Permissions::VIEW_CHANNEL.bits(),
            })),
            &ctx.owner_token,
        )
        .await?;
    assert!(status.is_success(), "overwrite: {status} {body}");
    let (status, body) = ctx.react(&luke, Ctx::react_body("flame", &vincent)).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Not a voice channel.
    let text = ctx.channel("general", 0).await?;
    let (status, body) = ctx
        .request(
            Method::POST,
            &format!("/api/v2/voice/{text}/stream-reactions"),
            Some(Ctx::react_body("flame", &vincent)),
            &vincent.token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    assert_no_reactions(&mut events).await;
    Ok(())
}

#[tokio::test]
async fn the_request_is_checked_before_it_counts() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let vincent = ctx.person("vincent", true).await?;
    let brendan = ctx.person("brendan", true).await?;
    ctx.join(&brendan, "joined").await?;

    // Nobody is streaming yet.
    let (status, body) = ctx
        .react(&brendan, Ctx::react_body("flame", &vincent))
        .await?;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    ctx.stream(&vincent).await?;
    for bad in [
        json!({ "kind": "flame", "stream_user_id": vincent.id.to_string(), "count": 0 }),
        json!({ "kind": "flame", "stream_user_id": vincent.id.to_string(), "count": 21 }),
        json!({ "kind": "flame", "stream_user_id": vincent.id.to_string(), "nonce": "no spaces" }),
        json!({ "kind": "flame", "stream_user_id": "vincent" }),
    ] {
        let (status, body) = ctx.react(&brendan, bad.clone()).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
    }
    // An unknown kind is refused by the body's own type.
    let (status, _) = ctx
        .react(&brendan, Ctx::react_body("confetti", &vincent))
        .await?;
    assert!(status.is_client_error(), "{status}");

    // None of those used up Brendan's second.
    let (status, body) = ctx
        .react(&brendan, Ctx::react_body("heart", &vincent))
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    Ok(())
}

#[tokio::test]
async fn one_reaction_a_second_per_person() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let vincent = ctx.person("vincent", true).await?;
    let brendan = ctx.person("brendan", true).await?;
    let luke = ctx.person("luke", true).await?;
    ctx.stream(&vincent).await?;
    ctx.join(&brendan, "joined").await?;
    ctx.view(&luke, "watch", &vincent).await?;

    let (status, body) = ctx
        .react(&brendan, Ctx::react_body("flame", &vincent))
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    // The second inside the same second is refused, with when to try again.
    let response = ctx
        .app
        .app
        .clone()
        .oneshot(build_json_request(
            Method::POST,
            &format!("/api/v2/voice/{}/stream-reactions", ctx.voice_id),
            Some(Ctx::react_body("heart", &vincent)),
            Some(&brendan.token),
        )?)
        .await?;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()),
        Some("1")
    );
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    assert_eq!(body["code"], "RATE_LIMITED");
    assert_eq!(body["retry_after"], 1);

    // Someone else is not held back by Brendan.
    let (status, body) = ctx.react(&luke, Ctx::react_body("heart", &vincent)).await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    // A second later Brendan may react again.
    tokio::time::sleep(Duration::from_millis(1050)).await;
    let (status, body) = ctx
        .react(&brendan, Ctx::react_body("heart", &vincent))
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    Ok(())
}
