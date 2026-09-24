//! Daily word add-on: settings, scoring, the six-guess limit, the hidden
//! answer, board visibility, streaks across days, and rate limiting.

mod common;

use anyhow::Context;
use axum::{
    http::{Method, StatusCode},
    Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_core::daily_word;
use serde_json::{json, Value};

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    owner_token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let owner_token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "owner",
            "OwnerPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            owner_token,
            _test_app: test_app,
        })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    /// The same request, with the daily word's clock at `at`.
    async fn request_at(
        &self,
        at: DateTime<Utc>,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        daily_word::with_now(at, self.request(method, path, body, token)).await
    }

    async fn user(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "PlayerPass123!")
                .await?;
        let (status, payload) = self
            .request(Method::GET, "/api/v1/users/@me", None, &token)
            .await?;
        assert_eq!(status, StatusCode::OK, "{payload}");
        let id = payload["id"].as_str().context("user id")?.parse::<i64>()?;
        Ok((token, id))
    }

    async fn create_guild(&self, name: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
                &self.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{payload}");
        Ok(payload["id"].as_str().context("guild id")?.parse::<i64>()?)
    }

    async fn enable(&self, guild_id: i64) -> anyhow::Result<()> {
        let (status, body) = self
            .request(
                Method::PUT,
                &settings_path(guild_id),
                Some(json!({ "enabled": true })),
                &self.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(())
    }

    /// Fix the answer for the day `at` falls on.
    async fn set_answer(&self, at: DateTime<Utc>, answer: &str) -> anyhow::Result<()> {
        let puzzle = daily_word::puzzle_at(at);
        let stored = paracord_db::daily_word::store_answer(&self.db, puzzle, answer).await?;
        assert_eq!(stored, answer);
        Ok(())
    }

    async fn guess(
        &self,
        at: DateTime<Utc>,
        token: &str,
        word: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_at(
            at,
            Method::POST,
            GUESS,
            Some(json!({ "word": word })),
            token,
        )
        .await
    }
}

const TODAY: &str = "/api/v1/daily-word/today";
const GUESS: &str = "/api/v1/daily-word/today/guess";
const STATS: &str = "/api/v1/daily-word/stats";

fn settings_path(guild_id: i64) -> String {
    format!("/api/v1/guilds/{guild_id}/daily-word")
}

fn board_path(guild_id: i64) -> String {
    format!("/api/v1/guilds/{guild_id}/daily-word/board")
}

fn day(y: i32, m: u32, d: u32) -> DateTime<Utc> {
    NaiveDate::from_ymd_opt(y, m, d)
        .expect("date")
        .and_hms_opt(15, 30, 0)
        .expect("time")
        .and_utc()
}

fn states(body: &Value, index: usize) -> Vec<String> {
    body["guesses"][index]["states"]
        .as_array()
        .map(|states| {
            states
                .iter()
                .map(|state| state.as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn settings_default_off_and_only_managers_change_them() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Settings").await?;
    let (member, member_id) = ctx.user("member").await?;
    paracord_db::members::add_member(&ctx.db, member_id, guild_id).await?;
    let (outsider, _) = ctx.user("outsider").await?;

    let (status, body) = ctx
        .request(Method::GET, &settings_path(guild_id), None, &member)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], false);
    assert_eq!(body["show_on_front_page"], true);
    assert_eq!(body["share_channel_id"], Value::Null);

    let (status, _) = ctx
        .request(Method::GET, &settings_path(guild_id), None, &outsider)
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "enabled": true })),
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // A share channel must be a text channel on this server.
    let text_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(&ctx.db, text_id, guild_id, "daily", 0, 0, None, None)
        .await?;
    let voice_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(&ctx.db, voice_id, guild_id, "lounge", 2, 1, None, None)
        .await?;
    let other_guild = ctx.create_guild("Elsewhere").await?;
    let foreign_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(
        &ctx.db,
        foreign_id,
        other_guild,
        "general",
        0,
        0,
        None,
        None,
    )
    .await?;
    for (bad, label) in [
        (json!({ "share_channel_id": voice_id.to_string() }), "voice"),
        (
            json!({ "share_channel_id": foreign_id.to_string() }),
            "foreign",
        ),
        (json!({ "share_channel_id": "nope" }), "not an id"),
        (json!({ "enabled": "yes" }), "not a bool"),
        (json!(["enabled"]), "not an object"),
    ] {
        let (status, body) = ctx
            .request(
                Method::PUT,
                &settings_path(guild_id),
                Some(bad),
                &ctx.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {body}");
    }

    let (status, body) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({
                "enabled": true,
                "share_channel_id": text_id.to_string(),
                "show_on_front_page": false,
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], true);
    assert_eq!(body["share_channel_id"], text_id.to_string());
    assert_eq!(body["show_on_front_page"], false);

    // A partial update keeps the other fields; null clears the channel.
    let (status, body) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "share_channel_id": Value::Null })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], true);
    assert_eq!(body["show_on_front_page"], false);
    assert_eq!(body["share_channel_id"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn add_on_off_is_not_found() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Off").await?;
    let now = day(2026, 9, 24);

    let (status, body) = ctx
        .request_at(
            now,
            Method::GET,
            &board_path(guild_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        body["message"],
        "The daily word is not turned on for this server."
    );
    for (method, path) in [(Method::GET, TODAY), (Method::GET, STATS)] {
        let (status, body) = ctx
            .request_at(now, method, path, None, &ctx.owner_token)
            .await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}: {body}");
    }
    let (status, _) = ctx.guess(now, &ctx.owner_token, "crane").await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    ctx.enable(guild_id).await?;
    let (status, body) = ctx
        .request_at(now, Method::GET, TODAY, None, &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["puzzle"], daily_word::puzzle_at(now));
    assert_eq!(body["date"], "2026-09-24");
    assert_eq!(body["next_puzzle_at"], "2026-09-25T00:00:00Z");
    assert_eq!(body["guesses"], json!([]));
    assert_eq!(body["finished"], false);

    // Turning it off again closes that server's board.
    let (status, _) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "enabled": false })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = ctx
        .request_at(
            now,
            Method::GET,
            &board_path(guild_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn guesses_are_scored_with_repeated_letters_and_invalid_words_cost_nothing(
) -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Scoring").await?;
    ctx.enable(guild_id).await?;
    let now = day(2026, 9, 24);
    ctx.set_answer(now, "abide").await?;

    let (status, body) = ctx.guess(now, &ctx.owner_token, "qqqqq").await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "NOT_IN_WORD_LIST");
    assert_eq!(body["message"], "Not in the word list");
    for bad in ["abc", "abcdef", "ab1de", ""] {
        let (status, body) = ctx.guess(now, &ctx.owner_token, bad).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
        assert_eq!(body["code"], "BAD_REQUEST");
    }
    let (status, _) = ctx
        .request_at(now, Method::POST, GUESS, Some(json!({})), &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Two e's against one e: only the first is marked; the d is present.
    let (status, body) = ctx.guess(now, &ctx.owner_token, "SPEED").await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["guesses"][0]["word"], "speed");
    assert_eq!(
        states(&body, 0),
        ["absent", "absent", "present", "absent", "present"]
    );
    // An exact match takes the only copy, so the earlier e is absent.
    let (status, body) = ctx.guess(now, &ctx.owner_token, "eerie").await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        states(&body, 1),
        ["absent", "absent", "absent", "present", "correct"]
    );
    assert_eq!(body["guesses"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["finished"], false);
    assert!(body.get("answer").is_none(), "{body}");
    assert!(!body.to_string().contains("abide"), "{body}");

    let (status, body) = ctx.guess(now, &ctx.owner_token, "abide").await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(states(&body, 2), ["correct"; 5]);
    assert_eq!(body["finished"], true);
    assert_eq!(body["solved"], true);
    assert_eq!(body["answer"], "abide");
    assert_eq!(body["definition"]["part_of_speech"], "verb");
    assert!(body["definition"]["text"]
        .as_str()
        .is_some_and(|text| !text.is_empty()));

    let (status, body) = ctx.guess(now, &ctx.owner_token, "crane").await?;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    Ok(())
}

#[tokio::test]
async fn six_misses_end_the_game_and_reveal_the_answer() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Limit").await?;
    ctx.enable(guild_id).await?;
    let now = day(2026, 9, 24);
    ctx.set_answer(now, "zebra").await?;

    let words = ["crane", "slate", "pious", "mound", "fight", "lucky"];
    for (index, word) in words.iter().enumerate() {
        let (status, body) = ctx.guess(now, &ctx.owner_token, word).await?;
        assert_eq!(status, StatusCode::OK, "{word}: {body}");
        let last = index == words.len() - 1;
        assert_eq!(body["finished"], last, "{word}: {body}");
        assert_eq!(body["solved"], false);
        if last {
            assert_eq!(body["answer"], "zebra");
        } else {
            assert!(body.get("answer").is_none());
            assert!(!body.to_string().contains("zebra"), "{body}");
        }
    }
    let (status, body) = ctx.guess(now, &ctx.owner_token, "zebra").await?;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    let (status, body) = ctx
        .request_at(now, Method::GET, TODAY, None, &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["guesses"].as_array().map(Vec::len), Some(6));
    assert_eq!(body["answer"], "zebra");

    let (status, stats) = ctx
        .request_at(now, Method::GET, STATS, None, &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK, "{stats}");
    assert_eq!(stats["played"], 1);
    assert_eq!(stats["solved"], 0);
    assert_eq!(stats["missed"], 1);
    assert_eq!(stats["current_streak"], 0);
    Ok(())
}

#[tokio::test]
async fn the_board_hides_results_until_you_finish_and_lists_only_members() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Board").await?;
    let other_guild = ctx.create_guild("Word Elsewhere").await?;
    ctx.enable(guild_id).await?;
    ctx.enable(other_guild).await?;
    let now = day(2026, 9, 24);
    ctx.set_answer(now, "crane").await?;

    let (ada, ada_id) = ctx.user("ada").await?;
    let (bo, bo_id) = ctx.user("bo").await?;
    let (cy, cy_id) = ctx.user("cy").await?;
    for id in [ada_id, bo_id] {
        paracord_db::members::add_member(&ctx.db, id, guild_id).await?;
    }
    // Cy plays from another server: one game for the instance, not on this board.
    paracord_db::members::add_member(&ctx.db, cy_id, other_guild).await?;

    ctx.guess(now, &ada, "slate").await?;
    let (status, body) = ctx.guess(now, &ada, "crane").await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["solved"], true);
    ctx.guess(now, &bo, "moist").await?;
    ctx.guess(now, &cy, "crane").await?;

    // Bo is still playing: counts and who solved, no results.
    let (status, board) = ctx
        .request_at(now, Method::GET, &board_path(guild_id), None, &bo)
        .await?;
    assert_eq!(status, StatusCode::OK, "{board}");
    assert_eq!(board["visible"], false);
    assert_eq!(board["entries"], json!([]));
    assert_eq!(board["played"], 2);
    assert_eq!(board["finished"], 1);
    assert_eq!(board["solved"], 1);
    assert_eq!(board["solvers"][0]["id"], ada_id.to_string());
    assert!(!board.to_string().contains("crane"), "{board}");
    assert!(!board.to_string().contains("correct"), "{board}");

    // Ada finished: she sees everyone's grid, without letters, and no one from elsewhere.
    let (status, board) = ctx
        .request_at(now, Method::GET, &board_path(guild_id), None, &ada)
        .await?;
    assert_eq!(status, StatusCode::OK, "{board}");
    assert_eq!(board["visible"], true);
    let entries = board["entries"].as_array().context("entries")?;
    assert_eq!(entries.len(), 2, "{board}");
    assert_eq!(entries[0]["user"]["id"], ada_id.to_string());
    assert_eq!(entries[0]["guess_count"], 2);
    assert_eq!(
        entries[0]["grid"][1],
        json!(["correct", "correct", "correct", "correct", "correct"])
    );
    assert_eq!(entries[1]["user"]["id"], bo_id.to_string());
    assert_eq!(entries[1]["finished"], false);
    assert_eq!(entries[1]["grid"], json!([]));
    assert!(!board.to_string().contains("slate"), "{board}");
    assert!(!board.to_string().contains(&cy_id.to_string()), "{board}");

    // Cy's one game shows on the other server's board.
    let (status, board) = ctx
        .request_at(now, Method::GET, &board_path(other_guild), None, &cy)
        .await?;
    assert_eq!(status, StatusCode::OK, "{board}");
    assert_eq!(board["solved"], 1);

    // Someone outside the server cannot read its board.
    let (status, _) = ctx
        .request_at(now, Method::GET, &board_path(guild_id), None, &cy)
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
async fn streaks_follow_the_days_on_the_clock() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Streaks").await?;
    ctx.enable(guild_id).await?;
    let (player, player_id) = ctx.user("streaker").await?;
    paracord_db::members::add_member(&ctx.db, player_id, guild_id).await?;

    // Solve 1 and 2 September, skip the 3rd, solve the 4th and 5th in 1 and 4.
    let plan: [(DateTime<Utc>, &str, &[&str]); 4] = [
        (day(2026, 9, 1), "crane", &["slate", "crane"]),
        (day(2026, 9, 2), "moist", &["slate", "pious", "moist"]),
        (day(2026, 9, 4), "abide", &["abide"]),
        (
            day(2026, 9, 5),
            "zebra",
            &["crane", "slate", "pious", "zebra"],
        ),
    ];
    for (at, answer, guesses) in plan {
        ctx.set_answer(at, answer).await?;
        for word in guesses {
            let (status, body) = ctx.guess(at, &player, word).await?;
            assert_eq!(status, StatusCode::OK, "{at} {word}: {body}");
        }
    }

    let (status, stats) = ctx
        .request_at(day(2026, 9, 5), Method::GET, STATS, None, &player)
        .await?;
    assert_eq!(status, StatusCode::OK, "{stats}");
    assert_eq!(stats["played"], 4);
    assert_eq!(stats["solved"], 4);
    assert_eq!(stats["current_streak"], 2);
    assert_eq!(stats["max_streak"], 2);
    assert_eq!(stats["distribution"], json!([1, 1, 1, 1, 0, 0]));

    // The next day, before playing, the streak still stands.
    let (_, stats) = ctx
        .request_at(day(2026, 9, 6), Method::GET, STATS, None, &player)
        .await?;
    assert_eq!(stats["current_streak"], 2);
    assert_eq!(stats["puzzle"], daily_word::puzzle_at(day(2026, 9, 6)));

    // A day with nothing played in between ends it.
    let (_, stats) = ctx
        .request_at(day(2026, 9, 7), Method::GET, STATS, None, &player)
        .await?;
    assert_eq!(stats["current_streak"], 0);
    assert_eq!(stats["max_streak"], 2);

    // A new day brings a new, empty game.
    let (status, today) = ctx
        .request_at(day(2026, 9, 7), Method::GET, TODAY, None, &player)
        .await?;
    assert_eq!(status, StatusCode::OK, "{today}");
    assert_eq!(today["guesses"], json!([]));
    assert_eq!(today["date"], "2026-09-07");
    Ok(())
}

#[tokio::test]
async fn the_day_without_a_stored_answer_draws_one_from_the_keyed_order() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Draw").await?;
    ctx.enable(guild_id).await?;
    let now = day(2026, 10, 3);
    let (status, _) = ctx
        .request_at(now, Method::GET, TODAY, None, &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK);
    let puzzle = daily_word::puzzle_at(now);
    let stored = paracord_db::daily_word::get_answer(&ctx.db, puzzle)
        .await?
        .context("the day's answer is stored on first open")?;
    let expected = daily_word::answer_for(&daily_word::order_key(&ctx.jwt_secret), puzzle);
    assert_eq!(stored, expected);
    assert!(daily_word::is_answer(&stored));
    Ok(())
}

#[tokio::test]
async fn guesses_are_rate_limited() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Word Rate").await?;
    ctx.enable(guild_id).await?;
    let now = day(2026, 9, 24);
    let mut limited = false;
    for _ in 0..25 {
        let (status, body) = ctx.guess(now, &ctx.owner_token, "qqqqq").await?;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert!(limited, "guesses were never rate limited");
    Ok(())
}
