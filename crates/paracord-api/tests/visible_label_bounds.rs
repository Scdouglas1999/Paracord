//! A space or room name has to render as something, and has to read the way it
//! is stored.
//!
//! `contains_dangerous_markup` closes the tag-injection class for these labels.
//! It says nothing about two others, and both were reachable through the front
//! door of a release-candidate server:
//!
//! * **Blank names.** The guild bound is `2 <= name.len() <= 100` in *bytes*,
//!   and the channel bound had no lower end at all. So `"      "` created a
//!   space, `"\u{200B}\u{200B}\u{200B}"` created a space, and `""` created a
//!   room — each of which renders in the sidebar as an unlabelled strip nobody
//!   can name, search for, or tell apart from the next one. Renaming an
//!   existing space or room to any of them worked too.
//! * **Direction spoofing.** `"a\u{202E}gnp.exe"` was accepted and renders to
//!   every member as `aexe.png`: the Trojan Source trick pointed at a label a
//!   person is asked to trust rather than at source code.
//!
//! Control characters travel with them — a newline in a name breaks every
//! single-line surface that renders it, and a NUL truncates the name for any
//! consumer that hands it to a C API.
//!
//! The assertions match on the bound's own error text so a 400 from the length
//! or markup validator beside it cannot be mistaken for this one firing.

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
use serde_json::{json, Value};

/// Every one of these renders as nothing, or as something other than itself.
const UNREADABLE: &[(&str, &str)] = &[
    ("spaces only", "      "),
    ("non-breaking spaces", "\u{00A0}\u{00A0}\u{00A0}"),
    ("zero-width spaces", "\u{200B}\u{200B}\u{200B}"),
    ("byte order mark", "\u{FEFF}\u{FEFF}"),
    ("word joiner", "\u{2060}\u{2060}"),
    ("hangul filler", "\u{3164}\u{3164}"),
    ("newlines", "a\nb"),
    ("carriage return", "a\rb"),
    ("nul byte", "a\u{0000}b"),
    // Renders as "aexe.png".
    ("bidi override", "a\u{202E}gnp.exe"),
    ("bidi isolate", "\u{2066}spoofed\u{2069}"),
];

/// And every one of these is an ordinary name somebody will actually pick.
const READABLE: &[(&str, &str)] = &[
    ("plain", "General"),
    ("emoji only", "\u{1F680}"),
    // Spelled with zero-width joiners, which must not read as blank.
    (
        "family emoji",
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
    ),
    ("heart with variation selector", "\u{2764}\u{FE0F}"),
    ("arabic", "\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}"),
    ("padded but not empty", "  Book Club  "),
];

struct Ctx {
    app: Router,
    token: String,
    _test_app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "labelowner",
            "LabelPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            token,
            _test_app: test_app,
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(&self.token))?;
        dispatch_json(&self.app, request).await
    }

    async fn guild(&self) -> anyhow::Result<String> {
        let (status, payload) = self
            .call(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Readable Labels", "icon": Value::Null })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "guild create failed: {payload}"
        );
        Ok(payload["id"].as_str().context("guild id")?.to_string())
    }

    async fn channel(&self, guild_id: &str) -> anyhow::Result<String> {
        let (status, payload) = self
            .call(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!({ "name": "general", "channel_type": 0 })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "channel create failed: {payload}"
        );
        Ok(payload["id"].as_str().context("channel id")?.to_string())
    }
}

fn message(payload: &Value) -> String {
    payload["message"].as_str().unwrap_or_default().to_string()
}

fn assert_unreadable(label: &str, case: &str, status: StatusCode, payload: &Value) {
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "{label} accepted an unreadable name ({case}): {payload}"
    );
    assert!(
        message(payload).contains("readable text"),
        "{label} rejected {case} for the wrong reason: {payload}"
    );
}

#[tokio::test]
async fn space_name_must_be_readable_on_create() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    for (case, name) in UNREADABLE {
        let (status, payload) = ctx
            .call(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
            )
            .await?;
        assert_unreadable("space create", case, status, &payload);
    }
    Ok(())
}

#[tokio::test]
async fn space_name_must_be_readable_on_rename() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild = ctx.guild().await?;
    for (case, name) in UNREADABLE {
        let (status, payload) = ctx
            .call(
                Method::PATCH,
                &format!("/api/v1/guilds/{guild}"),
                Some(json!({ "name": name })),
            )
            .await?;
        assert_unreadable("space rename", case, status, &payload);
    }
    Ok(())
}

#[tokio::test]
async fn room_name_must_be_readable_on_create() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild = ctx.guild().await?;
    // The empty string had no lower bound at all before this test existed.
    for (case, name) in UNREADABLE.iter().chain([&("empty", "")]) {
        let (status, payload) = ctx
            .call(
                Method::POST,
                &format!("/api/v1/guilds/{guild}/channels"),
                Some(json!({ "name": name, "channel_type": 0 })),
            )
            .await?;
        assert_unreadable("room create", case, status, &payload);
    }
    Ok(())
}

#[tokio::test]
async fn room_name_must_be_readable_on_rename() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild = ctx.guild().await?;
    let channel = ctx.channel(&guild).await?;
    for (case, name) in UNREADABLE.iter().chain([&("empty", "")]) {
        let (status, payload) = ctx
            .call(
                Method::PATCH,
                &format!("/api/v1/channels/{channel}"),
                Some(json!({ "name": name })),
            )
            .await?;
        assert_unreadable("room rename", case, status, &payload);
    }
    Ok(())
}

/// The bound must not cost anybody a name they are entitled to. Emoji-only
/// names in particular are spelled with the very characters the blank check
/// discounts.
#[tokio::test]
async fn ordinary_names_still_pass() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild = ctx.guild().await?;

    for (case, name) in READABLE {
        let (status, payload) = ctx
            .call(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "space create rejected {case}: {payload}"
        );

        let (status, payload) = ctx
            .call(
                Method::POST,
                &format!("/api/v1/guilds/{guild}/channels"),
                Some(json!({ "name": name, "channel_type": 0 })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "room create rejected {case}: {payload}"
        );
    }
    Ok(())
}
