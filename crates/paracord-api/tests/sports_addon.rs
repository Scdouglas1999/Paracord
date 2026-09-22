//! Sports add-on: defaults, permissions, validation, and a fake scoreboard.

mod common;

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use anyhow::Context;
use axum::{
    http::{Method, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_api::routes::audit::ACTION_GUILD_UPDATE;
use paracord_core::sports::{scoreboard, FeedError, ScoreFeed};
use serde_json::{json, Value};
use tower::ServiceExt;

const NFL_BOARD: &str = r#"{
  "leagues": [{ "abbreviation": "NFL" }],
  "events": [
    {
      "id": "100",
      "date": "2026-09-20T17:00:00Z",
      "shortName": "BUF @ KC",
      "status": {
        "clock": 95.0,
        "displayClock": "1:35",
        "period": 4,
        "type": { "state": "in", "shortDetail": "1:35 - 4th" }
      },
      "competitions": [{
        "broadcasts": [{ "names": ["CBS"] }],
        "competitors": [
          {
            "homeAway": "home",
            "score": "24",
            "records": [{ "summary": "1-0" }],
            "team": {
              "id": "12",
              "abbreviation": "KC",
              "displayName": "Kansas City Chiefs",
              "shortDisplayName": "Chiefs",
              "logo": "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png"
            }
          },
          {
            "homeAway": "away",
            "score": "27",
            "team": {
              "id": "2",
              "abbreviation": "BUF",
              "displayName": "Buffalo Bills",
              "shortDisplayName": "Bills",
              "logo": "https://evil.example/buf.png"
            }
          }
        ],
        "situation": {
          "downDistanceText": "2nd & 7 at KC 12",
          "isRedZone": true,
          "possession": "12",
          "lastPlay": {
            "text": " Mahomes pass short right. ",
            "scoreValue": 0,
            "type": { "text": "Pass" },
            "probability": { "homeWinPercentage": 0.31 }
          }
        }
      }]
    },
    {
      "id": "200",
      "date": "2027-01-01T20:00:00Z",
      "shortName": "DAL @ PHI",
      "status": { "type": { "state": "pre", "shortDetail": "Fri 3:00 PM" } },
      "competitions": [{
        "competitors": [
          {
            "homeAway": "home",
            "score": "13",
            "team": {
              "id": "21",
              "abbreviation": "PHI",
              "displayName": "Philadelphia Eagles",
              "shortDisplayName": "Eagles",
              "logo": "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png"
            }
          },
          {
            "homeAway": "away",
            "score": "7",
            "team": {
              "id": "6",
              "abbreviation": "DAL",
              "displayName": "Dallas Cowboys",
              "shortDisplayName": "Cowboys",
              "logo": "https://a.espncdn.com/i/teamlogos/nfl/500/dal.png"
            }
          }
        ]
      }]
    },
    {
      "id": "300",
      "date": "2026-01-01T18:00:00Z",
      "shortName": "GB @ CHI",
      "status": { "type": { "state": "post", "shortDetail": "Final" }, "period": 4 },
      "competitions": [{
        "competitors": [
          {
            "homeAway": "home",
            "score": "17",
            "winner": false,
            "team": {
              "id": "3",
              "abbreviation": "CHI",
              "displayName": "Chicago Bears",
              "shortDisplayName": "Bears"
            }
          },
          {
            "homeAway": "away",
            "score": "20",
            "winner": true,
            "team": {
              "id": "9",
              "abbreviation": "GB",
              "displayName": "Green Bay Packers",
              "shortDisplayName": "Packers"
            }
          }
        ]
      }]
    }
  ]
}"#;

const NFL_TEAMS: &str = r#"{
  "sports": [{
    "leagues": [{
      "teams": [
        { "team": { "id": "12", "abbreviation": "KC", "displayName": "Kansas City Chiefs", "shortDisplayName": "Chiefs", "logos": [{ "href": "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png" }] } },
        { "team": { "id": "2", "abbreviation": "BUF", "displayName": "Buffalo Bills", "shortDisplayName": "Bills", "logos": [{ "href": "https://evil.example/buf.png" }] } }
      ]
    }]
  }]
}"#;

struct ScriptedFeed;

impl ScoreFeed for ScriptedFeed {
    fn fetch<'a>(
        &'a self,
        league: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, FeedError>> + Send + 'a>> {
        let league = league.to_ascii_lowercase();
        Box::pin(async move {
            if league == "baseball/mlb" {
                Err(FeedError::TimedOut)
            } else if league == "football/nfl" {
                Ok(NFL_BOARD.to_string())
            } else {
                Err(FeedError::Other(format!("unexpected league {league}")))
            }
        })
    }

    fn fetch_teams<'a>(
        &'a self,
        league: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, FeedError>> + Send + 'a>> {
        let league = league.to_ascii_lowercase();
        Box::pin(async move {
            if league == "football/nfl" {
                Ok(NFL_TEAMS.to_string())
            } else {
                Err(FeedError::TimedOut)
            }
        })
    }

    fn fetch_summary<'a>(
        &'a self,
        league: &'a str,
        event_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String, FeedError>> + Send + 'a>> {
        let league = league.to_ascii_lowercase();
        let event_id = event_id.to_string();
        Box::pin(async move {
            if league == "football/nfl" && event_id == "401872945" {
                Ok(
                    include_str!("../../paracord-core/src/sports/fixtures/nfl_summary.json")
                        .to_string(),
                )
            } else if league == "baseball/mlb" && event_id == "401817017" {
                Ok(
                    include_str!("../../paracord-core/src/sports/fixtures/mlb_summary.json")
                        .to_string(),
                )
            } else {
                Err(FeedError::TimedOut)
            }
        })
    }
}

fn feed_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

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

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "{payload}");
        Ok(payload["id"].as_str().context("user id")?.parse::<i64>()?)
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
}

fn settings_path(guild_id: i64) -> String {
    format!("/api/v1/guilds/{guild_id}/sports")
}

fn board_path(guild_id: i64) -> String {
    format!("/api/v1/guilds/{guild_id}/sports/board")
}

fn game_path(guild_id: i64, sport: &str, league: &str, event_id: &str) -> String {
    format!("/api/v1/guilds/{guild_id}/sports/games/{sport}/{league}/{event_id}")
}

#[tokio::test]
async fn defaults_for_a_server_with_no_row() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Defaults").await?;
    let (status, body) = ctx
        .request(
            Method::GET,
            &settings_path(guild_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["guild_id"], guild_id.to_string());
    assert_eq!(body["enabled"], false);
    assert_eq!(body["leagues"], json!(["football/nfl", "baseball/mlb"]));
    assert_eq!(body["favorite_teams"], json!([]));
    assert_eq!(body["show_on_server_page"], true);
    assert_eq!(body["default_view"], "all");
    assert_eq!(body["layout"], "cards");
    assert_eq!(body["updated_at"], "1970-01-01T00:00:00Z");
    Ok(())
}

#[tokio::test]
async fn non_member_is_refused_and_any_signed_in_user_can_list_leagues() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Closed").await?;
    let outsider =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "outsider", "OutsiderPass123!")
            .await?;

    for (method, path) in [
        (Method::GET, settings_path(guild_id)),
        (Method::PUT, settings_path(guild_id)),
        (Method::GET, board_path(guild_id)),
        (
            Method::GET,
            game_path(guild_id, "football", "nfl", "401872945"),
        ),
    ] {
        let body = (method == Method::PUT).then_some(json!({ "enabled": true }));
        let (status, payload) = ctx.request(method.clone(), &path, body, &outsider).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path} {payload}");
    }

    let (status, catalog) = ctx
        .request(Method::GET, "/api/v1/sports/leagues", None, &outsider)
        .await?;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    let paths: Vec<&str> = catalog["leagues"]
        .as_array()
        .context("leagues")?
        .iter()
        .map(|entry| entry["path"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(paths.len(), 17);
    assert_eq!(paths[0], "football/nfl");
    assert!(paths.contains(&"soccer/eng.1"));
    assert!(paths.contains(&"soccer/usa.nwsl"));
    assert!(paths
        .iter()
        .all(|path| !path.contains("f1") && !path.contains("racing")));
    assert_eq!(catalog["leagues"][9]["label"], "Premier League");

    let request = build_json_request(Method::GET, "/api/v1/sports/leagues", None, None)?;
    let (status, _) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn member_without_manage_guild_cannot_put() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Members").await?;
    let member =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "member", "MemberPass123!")
            .await?;
    let member_id = ctx.user_id(&member).await?;
    paracord_db::members::add_member(&ctx.db, member_id, guild_id).await?;

    let (status, body) = ctx
        .request(Method::GET, &settings_path(guild_id), None, &member)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], false);

    let (status, body) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "enabled": true })),
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    Ok(())
}

#[tokio::test]
async fn put_rejects_invalid_settings_and_leaves_the_defaults() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Validate").await?;
    let too_many_leagues: Vec<String> =
        (0..13).map(|index| format!("soccer/l{index:02}")).collect();
    let too_many_favorites: Vec<Value> = (0..25)
        .map(|index| {
            json!({
                "league": "football/nfl",
                "team_id": format!("{index}"),
                "abbr": "KC",
                "name": "Kansas City Chiefs"
            })
        })
        .collect();
    let cases = [
        (json!({ "leagues": [] }), "Choose between 1 and 12 leagues."),
        (
            json!({ "leagues": too_many_leagues }),
            "Choose between 1 and 12 leagues.",
        ),
        (json!({ "leagues": ["../secret"] }), "sport/league"),
        (
            json!({ "leagues": ["football/nfl", "football/nfl"] }),
            "Each league can only be listed once.",
        ),
        (
            json!({ "default_view": "highlights" }),
            "default_view must be all, live, or favorites.",
        ),
        (json!({ "layout": "grid" }), "layout must be cards or list."),
        (json!({ "layout": true }), "layout must be cards or list."),
        (
            json!({ "enabled": "yes" }),
            "enabled must be true or false.",
        ),
        (
            json!({ "favorite_teams": too_many_favorites }),
            "Choose at most 24 favorite teams.",
        ),
        (
            json!({
                "favorite_teams": [{
                    "league": "football/nfl",
                    "team_id": "12",
                    "abbr": "KC",
                    "name": "x".repeat(81)
                }]
            }),
            "A favorite team name must be 1 to 80 characters.",
        ),
    ];

    for (body, needle) in cases {
        let (status, payload) = ctx
            .request(
                Method::PUT,
                &settings_path(guild_id),
                Some(body),
                &ctx.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
        let message = payload["message"].as_str().unwrap_or("");
        assert!(
            message.contains(needle),
            "message {message:?} should contain {needle:?}"
        );
    }

    let (status, body) = ctx
        .request(
            Method::GET,
            &settings_path(guild_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], false);
    assert_eq!(body["leagues"], json!(["football/nfl", "baseball/mlb"]));
    assert_eq!(body["layout"], "cards");
    assert_eq!(body["updated_at"], "1970-01-01T00:00:00Z");
    Ok(())
}

#[tokio::test]
async fn disabling_with_only_the_enabled_field_succeeds() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Disable").await?;
    let (status, saved) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({
                "enabled": true,
                "layout": "list",
                "leagues": ["hockey/nhl"]
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{saved}");

    let (status, body) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "enabled": false })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], false);
    assert_eq!(body["layout"], "list");
    assert_eq!(body["leagues"], json!(["hockey/nhl"]));
    assert_eq!(body["default_view"], "all");
    assert_eq!(body["show_on_server_page"], true);

    let fresh = TestContext::new().await?;
    let fresh_id = fresh.create_guild("Sports Disable Fresh").await?;
    let (status, body) = fresh
        .request(
            Method::PUT,
            &settings_path(fresh_id),
            Some(json!({ "enabled": false })),
            &fresh.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enabled"], false);
    assert_eq!(body["layout"], "cards");
    assert_eq!(body["leagues"], json!(["football/nfl", "baseball/mlb"]));
    Ok(())
}

#[tokio::test]
async fn teams_requires_a_signed_in_user_and_a_valid_league() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let request = build_json_request(
        Method::GET,
        "/api/v1/sports/leagues/football/nfl/teams",
        None,
        None,
    )?;
    let (status, _) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = ctx
        .request(
            Method::GET,
            "/api/v1/sports/leagues/foo/bar_baz/teams",
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["message"]
        .as_str()
        .unwrap_or("")
        .contains("sport/league"));
    Ok(())
}

#[tokio::test]
async fn teams_come_from_the_fake_feed() -> anyhow::Result<()> {
    let _guard = feed_gate().lock().await;
    scoreboard().set_feed_for_tests(Arc::new(ScriptedFeed));
    let ctx = TestContext::new().await?;
    let request = build_json_request(
        Method::GET,
        "/api/v1/sports/leagues/football/nfl/teams",
        None,
        Some(&ctx.owner_token),
    )?;
    let response = ctx.app.clone().oneshot(request).await?;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let text = String::from_utf8(bytes.to_vec())?;
    assert_eq!(status, StatusCode::OK, "{text}");
    let team = first_object_after(&text, "\"teams\":[");
    println!("TEAM_JSON {team}");
    let body: Value = serde_json::from_str(&text)?;
    assert_eq!(body["league"], "football/nfl");
    assert_eq!(body["teams"][0]["name"], "Buffalo Bills");
    assert_eq!(body["teams"][0]["logo"], "");
    assert_eq!(body["teams"][1]["abbr"], "KC");
    assert_eq!(
        body["teams"][1]["logo"],
        "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png"
    );
    Ok(())
}

#[tokio::test]
async fn teams_without_a_cached_list_are_a_bad_gateway() -> anyhow::Result<()> {
    let _guard = feed_gate().lock().await;
    scoreboard().set_feed_for_tests(Arc::new(ScriptedFeed));
    let ctx = TestContext::new().await?;
    let (status, body) = ctx
        .request(
            Method::GET,
            "/api/v1/sports/leagues/basketball/nba/teams",
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(
        body["message"],
        "The team list for this league is unavailable."
    );
    Ok(())
}

#[tokio::test]
async fn put_round_trips_and_writes_an_audit_entry() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Round Trip").await?;
    let (status, saved) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({
                "enabled": true,
                "leagues": ["Hockey/NHL", "basketball/nba"],
                "favorite_teams": [{
                    "league": "hockey/nhl",
                    "team_id": "1",
                    "abbr": "NJD",
                    "name": "New Jersey Devils"
                }],
                "show_on_server_page": false,
                "default_view": "Favorites",
                "layout": "List"
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["enabled"], true);
    assert_eq!(saved["leagues"], json!(["hockey/nhl", "basketball/nba"]));
    assert_eq!(saved["show_on_server_page"], false);
    assert_eq!(saved["default_view"], "favorites");
    assert_eq!(saved["layout"], "list");
    assert_eq!(saved["favorite_teams"][0]["abbr"], "NJD");
    assert_ne!(saved["updated_at"], "1970-01-01T00:00:00Z");

    let (status, got) = ctx
        .request(
            Method::GET,
            &settings_path(guild_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{got}");
    assert_eq!(got, saved);

    let (status, partial) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "default_view": "live" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{partial}");
    assert_eq!(partial["default_view"], "live");
    assert_eq!(partial["layout"], "list");
    assert_eq!(partial["enabled"], true);
    assert_eq!(partial["show_on_server_page"], false);
    assert_eq!(partial["favorite_teams"][0]["team_id"], "1");

    let entries = paracord_db::audit_log::get_guild_entries(
        &ctx.db,
        guild_id,
        Some(ACTION_GUILD_UPDATE),
        None,
        None,
        10,
    )
    .await?;
    assert!(entries.iter().any(|entry| {
        entry
            .changes
            .as_ref()
            .is_some_and(|changes| changes["sports"]["leagues"][0] == "hockey/nhl")
    }));
    Ok(())
}

#[tokio::test]
async fn board_is_not_found_while_the_add_on_is_off() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Off").await?;
    let (status, body) = ctx
        .request(Method::GET, &board_path(guild_id), None, &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        body["message"],
        "The sports add-on is not turned on for this server."
    );

    let (status, _) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "enabled": true })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "enabled": false })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = ctx
        .request(Method::GET, &board_path(guild_id), None, &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        body["message"],
        "The sports add-on is not turned on for this server."
    );
    Ok(())
}

#[tokio::test]
async fn enabled_board_uses_the_fake_feed_and_keeps_a_failed_league() -> anyhow::Result<()> {
    let _guard = feed_gate().lock().await;
    scoreboard().set_feed_for_tests(Arc::new(ScriptedFeed));
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Board").await?;
    let (status, saved) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({
                "enabled": true,
                "leagues": ["football/nfl", "baseball/mlb"],
                "favorite_teams": [{
                    "league": "football/nfl",
                    "team_id": "12",
                    "abbr": "KC",
                    "name": "Kansas City Chiefs"
                }]
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{saved}");

    let request = build_json_request(
        Method::GET,
        &board_path(guild_id),
        None,
        Some(&ctx.owner_token),
    )?;
    let response = ctx.app.clone().oneshot(request).await?;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
    let text = String::from_utf8(bytes.to_vec())?;
    assert_eq!(status, StatusCode::OK, "{text}");
    let body: Value = serde_json::from_str(&text)?;
    let live = first_game_object(&text);
    println!("LIVE_GAME_JSON {live}");

    assert!(body["fetched_at"].as_str().unwrap().contains('T'));
    assert_eq!(body["leagues"][0]["path"], "football/nfl");
    assert_eq!(body["leagues"][0]["label"], "NFL");
    assert!(body["leagues"][0]["error"].is_null());
    assert_eq!(body["leagues"][1]["path"], "baseball/mlb");
    assert_eq!(body["leagues"][1]["label"], "MLB");
    assert_eq!(body["leagues"][1]["error"], "timed out");

    let ids: Vec<&str> = body["games"]
        .as_array()
        .unwrap()
        .iter()
        .map(|game| game["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["100", "200", "300"]);
    assert_eq!(body["games"][0]["favorite"], true);
    assert_eq!(body["games"][1]["favorite"], false);
    assert_eq!(body["games"][2]["favorite"], false);
    assert_eq!(body["games"][0]["heat"], 95);
    assert_eq!(
        body["games"][0]["tags"],
        json!(["RED ZONE", "TWO-MINUTE DRILL", "ONE-SCORE GAME"])
    );
    assert_eq!(
        body["games"][0]["home"]["logo"].as_str().unwrap(),
        "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png"
    );
    assert_eq!(body["games"][0]["away"]["logo"], "");
    assert_eq!(body["games"][0]["home"]["possession"], true);
    assert_eq!(body["games"][1]["id"], "200");
    assert_eq!(body["games"][1]["state"], "pre");
    assert_eq!(body["games"][1]["home"]["score"], 13);
    assert_eq!(body["games"][1]["away"]["score"], 7);
    assert!(body["games"]
        .as_array()
        .unwrap()
        .iter()
        .all(|game| game["league_path"] == "football/nfl"));
    Ok(())
}

#[tokio::test]
async fn game_detail_refuses_signed_out_users_and_bad_requests() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Game Gate").await?;
    let request = build_json_request(
        Method::GET,
        &game_path(guild_id, "football", "nfl", "401872945"),
        None,
        None,
    )?;
    let (status, _) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = ctx
        .request(
            Method::GET,
            &game_path(guild_id, "football", "nfl", "401872945"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        body["message"],
        "The sports add-on is not turned on for this server."
    );

    let (status, _) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({
                "enabled": true,
                "leagues": ["football/nfl"]
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = ctx
        .request(
            Method::GET,
            &game_path(guild_id, "baseball", "mlb", "401817017"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["message"],
        "bad request: This server is not following that league."
    );

    let (status, body) = ctx
        .request(
            Method::GET,
            &game_path(guild_id, "foo", "bar_baz", "1"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["message"]
        .as_str()
        .unwrap_or("")
        .contains("sport/league"));

    let (status, body) = ctx
        .request(
            Method::GET,
            &game_path(guild_id, "football", "nfl", "abc"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["message"],
        "bad request: An event id must be 1 to 20 digits."
    );
    Ok(())
}

#[tokio::test]
async fn football_and_baseball_details_come_from_the_fake_feed() -> anyhow::Result<()> {
    let _guard = feed_gate().lock().await;
    scoreboard().set_feed_for_tests(Arc::new(ScriptedFeed));
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Gamecast").await?;
    let (status, _) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({
                "enabled": true,
                "favorite_teams": [{
                    "league": "football/nfl",
                    "team_id": "12",
                    "abbr": "KC",
                    "name": "Kansas City Chiefs"
                }]
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);

    let (status, football) = ctx
        .request(
            Method::GET,
            &game_path(guild_id, "football", "nfl", "401872945"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{football}");
    assert_eq!(football["kind"], "football");
    assert_eq!(football["stale"], false);
    assert_eq!(football["game"]["id"], "401872945");
    assert_eq!(football["game"]["home"]["abbr"], "KC");
    assert_eq!(football["game"]["home"]["score"], 33);
    assert_eq!(football["game"]["away"]["abbr"], "IND");
    assert_eq!(football["game"]["favorite"], true);
    assert!(football["baseball"].is_null());
    assert_eq!(football["football"]["drives"].as_array().unwrap().len(), 2);
    assert_eq!(football["football"]["drives"][0]["end_yard"], 0);
    assert_eq!(
        football["football"]["drives"][0]["plays"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(football["football"]["ball_on"].is_null());
    assert!(!football.to_string().contains("espn.pvt"));
    let play = &football["football"]["drives"][0]["plays"][0];
    println!("NFL_PLAY_JSON {play}");

    let (status, baseball) = ctx
        .request(
            Method::GET,
            &game_path(guild_id, "baseball", "mlb", "401817017"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{baseball}");
    assert_eq!(baseball["kind"], "baseball");
    assert_eq!(baseball["game"]["away"]["abbr"], "PHI");
    assert_eq!(baseball["game"]["home"]["abbr"], "NYM");
    assert!(baseball["football"].is_null());
    assert!(baseball["baseball"]["strike_zone"].is_null());
    let at_bats = baseball["baseball"]["at_bats"].as_array().unwrap();
    assert!(at_bats.len() >= 2);
    assert_eq!(at_bats[0]["batter"]["name"], "Kyle Schwarber");
    assert!(at_bats.iter().any(|at_bat| !at_bat["hit"].is_null()));
    assert!(!baseball.to_string().contains("espn.pvt"));
    println!("MLB_AT_BAT_JSON {}", at_bats[0]);
    Ok(())
}

#[tokio::test]
async fn game_detail_without_a_cached_summary_is_a_bad_gateway() -> anyhow::Result<()> {
    let _guard = feed_gate().lock().await;
    scoreboard().set_feed_for_tests(Arc::new(ScriptedFeed));
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sports Game Down").await?;
    let (status, _) = ctx
        .request(
            Method::PUT,
            &settings_path(guild_id),
            Some(json!({ "enabled": true })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = ctx
        .request(
            Method::GET,
            &game_path(guild_id, "football", "nfl", "999"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(body["message"], "This game's detail is unavailable.");
    Ok(())
}

fn first_game_object(body: &str) -> String {
    first_object_after(body, "\"games\":[")
}

fn first_object_after(body: &str, marker: &str) -> String {
    let at = body.find(marker).expect("array");
    let rest = body[at + marker.len()..].trim_start();
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escape = false;
    for (index, ch) in rest.char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return rest[..=index].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unclosed game object");
}
