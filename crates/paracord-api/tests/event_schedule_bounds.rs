//! A scheduled event has to have a schedule.
//!
//! `scheduled_start` and `scheduled_end` are stored as text and every consumer
//! parses them back. `POST /guilds/{id}/events` wrote whichever string arrived
//! straight into the column, so `"not-a-date"` and `""` both created a
//! scheduled event with no scheduled time — and nothing failed loudly
//! afterwards. `GET /events` hands the unparseable string back as the start
//! time, and the guild-wide `.ics` feed simply omits the row, so the event is
//! in the list and absent from the calendar with nothing said. That is the
//! silent degradation the project's rule forbids, and the single-event
//! `/events/{id}/ical` route has always carried a defensive 400 for exactly
//! this state ("event has an invalid scheduled_start value") — a branch
//! describing a row the front door should never have created.
//!
//! The unordered pair went in unchecked too: an end a year before the start
//! stored fine and renders as a negative-length event wherever a duration is
//! shown.
//!
//! A patch is held to the same bound for the values it supplies, and
//! deliberately *not* for the values it leaves alone: a row written before this
//! bound existed may hold an unparseable start, and refusing to patch it would
//! make the only broken events on an instance permanently unfixable — including
//! by the edit that would repair them.

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
use tower::ServiceExt;

const START: &str = "2027-06-01T00:00:00Z";
const LATER: &str = "2027-06-01T02:00:00Z";
const EARLIER: &str = "2027-01-01T00:00:00Z";

struct Ctx {
    app: Router,
    token: String,
    guild: String,
    _test_app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "eventowner",
            "EventPass123!",
        )
        .await?;
        let request = build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Event Bounds", "icon": Value::Null })),
            Some(&token),
        )?;
        let (status, payload) = dispatch_json(&test_app.app, request).await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "guild create failed: {payload}"
        );
        let guild = payload["id"].as_str().context("guild id")?.to_string();
        Ok(Self {
            app: test_app.app.clone(),
            token,
            guild,
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

    async fn create(&self, mut body: Value) -> anyhow::Result<(StatusCode, Value)> {
        body["entity_type"] = json!(2);
        body["location"] = json!("Somewhere");
        self.call(
            Method::POST,
            &format!("/api/v1/guilds/{}/events", self.guild),
            Some(body),
        )
        .await
    }
}

fn message(payload: &Value) -> String {
    payload["message"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn a_start_that_is_not_a_timestamp_is_rejected() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    for raw in ["not-a-date", "", "   ", "2027-06-01", "tomorrow", "0"] {
        let (status, payload) = ctx
            .create(json!({ "name": "Bad Start", "scheduled_start": raw }))
            .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "accepted {raw:?} as a start: {payload}"
        );
        assert!(
            message(&payload).contains("scheduled_start must be an RFC3339 timestamp"),
            "rejected {raw:?} for the wrong reason: {payload}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn an_end_that_is_not_a_timestamp_is_rejected() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (status, payload) = ctx
        .create(json!({
            "name": "Bad End",
            "scheduled_start": START,
            "scheduled_end": "not-a-date",
        }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert!(
        message(&payload).contains("scheduled_end must be an RFC3339 timestamp"),
        "rejected for the wrong reason: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn an_event_may_not_finish_before_it_starts() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (status, payload) = ctx
        .create(json!({
            "name": "Backwards",
            "scheduled_start": START,
            "scheduled_end": EARLIER,
        }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert!(
        message(&payload).contains("scheduled_end must not be before scheduled_start"),
        "rejected for the wrong reason: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn an_ordinary_schedule_is_accepted_and_reaches_the_calendar() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (status, payload) = ctx
        .create(json!({
            "name": "Book Club",
            "scheduled_start": START,
            "scheduled_end": LATER,
        }))
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "valid event rejected: {payload}"
    );

    // The point of the bound: what the list shows is what the calendar carries.
    let request = build_json_request(
        Method::GET,
        &format!("/api/v1/guilds/{}/events.ics", ctx.guild),
        None,
        Some(&ctx.token),
    )?;
    let response = ctx.app.clone().oneshot(request).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let ics = String::from_utf8_lossy(&bytes);
    assert!(
        ics.contains("SUMMARY:Book Club"),
        "the accepted event should appear in the calendar feed: {ics}"
    );
    assert!(
        ics.contains("DTSTART:20270601T000000Z"),
        "the calendar should carry the start it was given: {ics}"
    );
    Ok(())
}

#[tokio::test]
async fn a_patch_is_held_to_the_same_bound() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (status, created) = ctx
        .create(json!({ "name": "Movable", "scheduled_start": START }))
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let event_id = created["id"].as_str().context("event id")?.to_string();
    let path = format!("/api/v1/guilds/{}/events/{event_id}", ctx.guild);

    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &path,
            Some(json!({ "scheduled_start": "not-a-date" })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert!(
        message(&payload).contains("scheduled_start must be an RFC3339 timestamp"),
        "{payload}"
    );

    // Moving only the end still has to clear the start already stored.
    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &path,
            Some(json!({ "scheduled_end": EARLIER })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert!(
        message(&payload).contains("scheduled_end must not be before scheduled_start"),
        "{payload}"
    );

    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &path,
            Some(json!({ "scheduled_end": LATER })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "valid patch rejected: {payload}");
    Ok(())
}
