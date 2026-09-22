//! Defensive parse of ESPN's undocumented scoreboard document.
//!
//! One malformed event is skipped. Invalid JSON is an error for the whole
//! league so the cache can keep the last good board.

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;

use super::models::{Game, RosterTeam, Team};

pub(crate) fn parse(json: &str, league_path: &str) -> Result<Vec<Game>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|_| "invalid scoreboard json".to_string())?;

    let mut segments = league_path.split('/');
    let sport = segments.next().unwrap_or("").to_string();
    let league_segment = league_path.rsplit('/').next().unwrap_or("");
    let mut league = league_segment.to_ascii_uppercase();
    if let Some(leagues) = root.get("leagues").and_then(Value::as_array) {
        if let Some(first) = leagues.first() {
            if let Some(abbreviation) = str_field(first, "abbreviation") {
                league = abbreviation;
            }
        }
    }

    let Some(events) = root.get("events").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    let mut games = Vec::new();
    for event in events {
        if let Some(game) = parse_event(event, &sport, &league, league_path) {
            games.push(game);
        }
    }
    Ok(games)
}

pub(crate) fn game_from_header(root: &Value, league_path: &str) -> Option<Game> {
    let header = root.get("header").filter(|value| value.is_object())?;
    let comp_src = header
        .get("competitions")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .filter(|value| value.is_object())?;
    let mut comp = comp_src.clone();
    normalize_summary_competition(&mut comp);

    let sport = league_path.split('/').next().unwrap_or("");
    let mut league = league_path
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if let Some(abbreviation) = header
        .get("league")
        .and_then(|value| str_field(value, "abbreviation"))
        .filter(|text| !text.is_empty())
    {
        league = abbreviation;
    }

    let mut event = serde_json::Map::new();
    if let Some(id) = header.get("id") {
        event.insert("id".to_string(), id.clone());
    }
    if let Some(date) = comp.get("date") {
        event.insert("date".to_string(), date.clone());
    }
    event.insert("shortName".to_string(), Value::String(matchup_name(&comp)));
    if let Some(status) = comp.get("status") {
        event.insert("status".to_string(), status.clone());
    }
    event.insert("competitions".to_string(), Value::Array(vec![comp]));
    parse_event(&Value::Object(event), sport, &league, league_path)
}

fn normalize_summary_competition(comp: &mut Value) {
    let Some(object) = comp.as_object_mut() else {
        return;
    };
    if let Some(competitors) = object.get_mut("competitors").and_then(Value::as_array_mut) {
        for competitor in competitors {
            let Some(competitor) = competitor.as_object_mut() else {
                continue;
            };
            if competitor.get("records").is_none() {
                if let Some(record) = competitor.get("record").cloned() {
                    competitor.insert("records".to_string(), record);
                }
            }
            let Some(team) = competitor.get_mut("team").and_then(Value::as_object_mut) else {
                continue;
            };
            if team.get("logo").is_none() {
                let href = team
                    .get("logos")
                    .and_then(Value::as_array)
                    .and_then(|logos| logos.first())
                    .and_then(|logo| str_field(logo, "href"));
                if let Some(href) = href {
                    team.insert("logo".to_string(), Value::String(href));
                }
            }
            if team.get("shortDisplayName").is_none() {
                let short = str_field(&Value::Object(team.clone()), "nickname")
                    .or_else(|| str_field(&Value::Object(team.clone()), "name"));
                if let Some(short) = short {
                    team.insert("shortDisplayName".to_string(), Value::String(short));
                }
            }
        }
    }
    if let Some(broadcasts) = object.get_mut("broadcasts").and_then(Value::as_array_mut) {
        for broadcast in broadcasts {
            let Some(broadcast) = broadcast.as_object_mut() else {
                continue;
            };
            if broadcast.get("names").is_some() {
                continue;
            }
            if let Some(short) = broadcast
                .get("media")
                .and_then(|media| str_field(media, "shortName"))
            {
                broadcast.insert(
                    "names".to_string(),
                    Value::Array(vec![Value::String(short)]),
                );
            }
        }
    }
}

fn matchup_name(comp: &Value) -> String {
    let mut home = String::new();
    let mut away = String::new();
    if let Some(competitors) = comp.get("competitors").and_then(Value::as_array) {
        for competitor in competitors {
            let abbr = competitor
                .get("team")
                .and_then(|team| str_field(team, "abbreviation"))
                .unwrap_or_default();
            if str_field(competitor, "homeAway")
                .is_some_and(|side| side.eq_ignore_ascii_case("home"))
            {
                home = abbr;
            } else if !abbr.is_empty() {
                away = abbr;
            }
        }
    }
    if home.is_empty() && away.is_empty() {
        String::new()
    } else {
        format!("{away} @ {home}")
    }
}

fn parse_event(event: &Value, sport: &str, league: &str, league_path: &str) -> Option<Game> {
    if !event.is_object() {
        return None;
    }
    let competitions = event.get("competitions")?.as_array()?;
    if competitions.is_empty() {
        return None;
    }
    let comp = competitions.first()?;
    if !comp.is_object() {
        return None;
    }

    let mut game = Game {
        id: str_field(event, "id").unwrap_or_default(),
        sport: sport.to_string(),
        league: league.to_string(),
        league_path: league_path.to_string(),
        name: str_field(event, "shortName")
            .or_else(|| str_field(event, "name"))
            .unwrap_or_default(),
        ..Game::default()
    };

    if let Some(raw) = str_field(event, "date") {
        if let Some(start) = parse_instant(&raw) {
            game.start = start;
        }
    }

    if let Some(status) = event.get("status").filter(|value| value.is_object()) {
        game.period = int_field(status, "period").unwrap_or(0);
        game.clock = str_field(status, "displayClock").unwrap_or_default();
        game.clock_seconds = dbl_field(status, "clock").unwrap_or(0.0);
        if let Some(kind) = status.get("type").filter(|value| value.is_object()) {
            game.state = str_field(kind, "state").unwrap_or_else(|| "pre".to_string());
            game.detail = str_field(kind, "shortDetail")
                .or_else(|| str_field(kind, "detail"))
                .unwrap_or_default();
        }
    }

    let mut possession_id = None;
    if let Some(situation) = comp.get("situation").filter(|value| value.is_object()) {
        possession_id = str_field(situation, "possession");
        game.down_distance =
            str_field(situation, "downDistanceText").filter(|text| !text.is_empty());
        game.red_zone = bool_field(situation, "isRedZone");
        game.balls = int_field(situation, "balls");
        game.strikes = int_field(situation, "strikes");
        game.outs = int_field(situation, "outs");
        game.on_first = bool_field(situation, "onFirst");
        game.on_second = bool_field(situation, "onSecond");
        game.on_third = bool_field(situation, "onThird");

        if let Some(last_play) = situation.get("lastPlay").filter(|value| value.is_object()) {
            game.last_play = str_field(last_play, "text").map(|text| text.trim().to_string());
            if game.last_play.as_deref().is_some_and(str::is_empty) {
                game.last_play = None;
            }
            game.last_play_score = int_field(last_play, "scoreValue").unwrap_or(0);
            if let Some(kind) = last_play.get("type").filter(|value| value.is_object()) {
                game.last_play_type =
                    str_field(kind, "alternativeText").or_else(|| str_field(kind, "text"));
            }
            if let Some(probability) = last_play
                .get("probability")
                .filter(|value| value.is_object())
            {
                game.home_win_pct = dbl_field(probability, "homeWinPercentage");
            }
        }
    }

    // Soccer has no "situation" — the last entry of "details" is the last play.
    if game.last_play.is_none() {
        if let Some(details) = comp.get("details").and_then(Value::as_array) {
            if let Some(detail) = details.last() {
                apply_detail_play(&mut game, detail);
            }
        }
    }

    if let Some(competitors) = comp.get("competitors").and_then(Value::as_array) {
        for competitor in competitors {
            if !competitor.is_object() {
                continue;
            }
            let team = parse_team(competitor, possession_id.as_deref());
            if str_field(competitor, "homeAway")
                .is_some_and(|side| side.eq_ignore_ascii_case("home"))
            {
                game.home = team;
            } else {
                game.away = team;
            }
        }
    }

    game.broadcasts = broadcasts(comp);
    Some(game)
}

fn apply_detail_play(game: &mut Game, detail: &Value) {
    let what = detail
        .get("type")
        .filter(|value| value.is_object())
        .and_then(|kind| str_field(kind, "text"));
    let when = detail
        .get("clock")
        .filter(|value| value.is_object())
        .and_then(|clock| str_field(clock, "displayValue"));
    let who = detail
        .get("athletesInvolved")
        .and_then(Value::as_array)
        .and_then(|athletes| athletes.first())
        .and_then(|athlete| {
            str_field(athlete, "shortName").or_else(|| str_field(athlete, "displayName"))
        });

    let mut parts = Vec::new();
    if let Some(when) = when.filter(|text| !text.is_empty()) {
        parts.push(when);
    }
    if let Some(what_text) = what.clone().filter(|text| !text.is_empty()) {
        parts.push(what_text);
    }
    if let Some(who) = who.filter(|text| !text.is_empty()) {
        parts.push(format!("\u{2014} {who}"));
    }
    let text = parts.join(" ");
    if !text.is_empty() {
        game.last_play = Some(text);
    }
    game.last_play_type = what.filter(|text| !text.is_empty());
    game.last_play_score = if bool_field(detail, "scoringPlay") {
        int_field(detail, "scoreValue").unwrap_or(1).max(1)
    } else {
        0
    };
}

/// Teams live at `sports[0].leagues[0].teams[].team`. One bad entry is skipped.
/// A missing or oddly shaped document is an empty roster, not an error.
pub(crate) fn parse_teams(json: &str) -> Result<Vec<RosterTeam>, String> {
    let root: Value = serde_json::from_str(json).map_err(|_| "invalid teams json".to_string())?;
    let Some(sports) = root.get("sports").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let Some(sport) = sports.first().filter(|value| value.is_object()) else {
        return Ok(Vec::new());
    };
    let Some(leagues) = sport.get("leagues").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let Some(league) = leagues.first().filter(|value| value.is_object()) else {
        return Ok(Vec::new());
    };
    let Some(entries) = league.get("teams").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut teams = Vec::new();
    for entry in entries {
        if let Some(team) = parse_roster_team(entry) {
            teams.push(team);
        }
    }
    teams.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(teams)
}

fn parse_roster_team(entry: &Value) -> Option<RosterTeam> {
    let info = entry.get("team").filter(|value| value.is_object())?;
    let id = str_field(info, "id").filter(|id| !id.is_empty())?;
    let name = str_field(info, "displayName").unwrap_or_default();
    let short_name = str_field(info, "shortDisplayName")
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| name.clone());
    let abbr = str_field(info, "abbreviation").unwrap_or_default();
    let logo = info
        .get("logos")
        .and_then(Value::as_array)
        .and_then(|logos| logos.first())
        .and_then(|logo| str_field(logo, "href"))
        .map(|href| sanitize_logo(&href))
        .unwrap_or_default();
    Some(RosterTeam {
        id,
        abbr,
        name,
        short_name,
        logo,
    })
}

fn parse_team(competitor: &Value, possession_id: Option<&str>) -> Team {
    let mut team = Team {
        winner: bool_field(competitor, "winner"),
        ..Team::default()
    };
    if let Some(raw) = str_field(competitor, "score") {
        if let Ok(score) = raw.trim().parse::<i32>() {
            team.score = Some(score);
        }
    }
    if let Some(records) = competitor.get("records").and_then(Value::as_array) {
        if let Some(first) = records.first() {
            team.record = str_field(first, "summary").filter(|text| !text.is_empty());
        }
    }
    if let Some(info) = competitor.get("team").filter(|value| value.is_object()) {
        team.id = str_field(info, "id").unwrap_or_default();
        team.abbr = str_field(info, "abbreviation").unwrap_or_default();
        team.name = str_field(info, "displayName").unwrap_or_default();
        team.short_name = str_field(info, "shortDisplayName").unwrap_or_else(|| team.name.clone());
        team.logo = str_field(info, "logo")
            .map(|logo| sanitize_logo(&logo))
            .unwrap_or_default();
    }
    team.possession = possession_id.is_some_and(|id| id == team.id);
    team
}

fn broadcasts(comp: &Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(broadcasts) = comp.get("broadcasts").and_then(Value::as_array) {
        for broadcast in broadcasts {
            if let Some(list) = broadcast.get("names").and_then(Value::as_array) {
                for name in list {
                    if let Some(text) = name.as_str() {
                        push_unique(&mut names, text);
                    }
                }
            }
        }
    }
    if let Some(geo) = comp.get("geoBroadcasts").and_then(Value::as_array) {
        for entry in geo {
            if let Some(media) = entry.get("media") {
                if let Some(name) = str_field(media, "shortName") {
                    push_unique(&mut names, &name);
                }
            }
        }
    }
    names
}

fn push_unique(names: &mut Vec<String>, name: &str) {
    if name.is_empty()
        || names
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(name))
    {
        return;
    }
    names.push(name.to_string());
}

/// Keep https URLs on espncdn.com (or a subdomain). Anything else is blank.
pub(crate) fn sanitize_logo(raw: &str) -> String {
    let raw = raw.trim();
    let Some((scheme, rest)) = raw.split_once("://") else {
        return String::new();
    };
    if !scheme.eq_ignore_ascii_case("https") || rest.is_empty() {
        return String::new();
    }
    let host_and_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_and_port = host_and_port.rsplit('@').next().unwrap_or("");
    let host = host_and_port.split(':').next().unwrap_or("");
    if host.is_empty() {
        return String::new();
    }
    let host = host.to_ascii_lowercase();
    if host == "espncdn.com" || host.ends_with(".espncdn.com") {
        raw.to_string()
    } else {
        String::new()
    }
}

fn parse_instant(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
        return Some(parsed.with_timezone(&Utc));
    }
    // ESPN sometimes omits seconds ("2026-09-20T17:00Z"). A zone-less value is UTC.
    let zone_less = raw.strip_suffix('Z').unwrap_or(raw);
    if let Ok(naive) = NaiveDateTime::parse_from_str(zone_less, "%Y-%m-%dT%H:%M:%S") {
        return Some(Utc.from_utc_datetime(&naive));
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(zone_less, "%Y-%m-%dT%H:%M") {
        return Some(Utc.from_utc_datetime(&naive));
    }
    None
}

pub(crate) fn str_field(value: &Value, name: &str) -> Option<String> {
    match value.get(name)? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

pub(crate) fn int_field(value: &Value, name: &str) -> Option<i32> {
    let number = value.get(name)?.as_f64()?;
    if number.is_finite() && (i32::MIN as f64..=i32::MAX as f64).contains(&number) {
        Some(number as i32)
    } else {
        None
    }
}

pub(crate) fn dbl_field(value: &Value, name: &str) -> Option<f64> {
    value
        .get(name)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

pub(crate) fn bool_field(value: &Value, name: &str) -> bool {
    matches!(value.get(name), Some(Value::Bool(true)))
}

#[cfg(test)]
mod tests {
    use super::super::models::format_rfc3339;
    use super::parse;

    const NFL: &str = include_str!("fixtures/nfl_scoreboard.json");
    const SOCCER: &str = include_str!("fixtures/soccer_scoreboard.json");

    #[test]
    fn parses_football_score_situation_and_broadcasts() {
        let games = parse(NFL, "football/nfl").unwrap();
        assert_eq!(games.len(), 1, "the malformed event is skipped, not fatal");
        let game = &games[0];
        assert_eq!(game.sport, "football");
        assert_eq!(game.league, "NFL");
        assert_eq!(game.league_path, "football/nfl");
        assert_eq!(game.state, "in");
        assert_eq!(game.period, 4);
        assert_eq!(game.clock_seconds, 478.0);
        assert_eq!(game.home.score, Some(27));
        assert_eq!(game.away.score, Some(34));
        assert_eq!(game.home.abbr, "ATL");
        assert_eq!(game.home.record.as_deref(), Some("0-1"));
        assert!(game.away.possession);
        assert!(!game.home.possession);
        assert!(game.red_zone);
        assert_eq!(game.down_distance.as_deref(), Some("2nd & 7 at CAR 36"));
        assert_eq!(
            game.last_play.as_deref(),
            Some("(Shotgun) J.Strand pass short left for 3 yards.")
        );
        let pct = game.home_win_pct.expect("home win pct");
        assert!((pct - 0.31).abs() < 1e-9);
        assert_eq!(game.broadcasts, ["FOX", "NFL+"]);
        assert_eq!(game.home.logo, "");
        assert_eq!(format_rfc3339(game.start), "2026-09-20T17:00:00Z");
    }

    #[test]
    fn soccer_last_play_comes_from_details() {
        let games = parse(SOCCER, "soccer/eng.1").unwrap();
        assert_eq!(games.len(), 1);
        let game = &games[0];
        assert_eq!(
            game.last_play.as_deref(),
            Some("80' Goal \u{2014} M. Salah")
        );
        assert_eq!(game.last_play_score, 1);
        assert_eq!(game.away.short_name, "Liverpool");
    }

    #[test]
    fn empty_or_eventless_board_is_not_an_error() {
        assert!(
            parse(include_str!("fixtures/empty_board.json"), "hockey/nhl")
                .unwrap()
                .is_empty()
        );
        assert!(
            parse(include_str!("fixtures/eventless_board.json"), "hockey/nhl")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn keeps_only_espncdn_https_logos() {
        let games = parse(include_str!("fixtures/logos.json"), "football/nfl").unwrap();
        assert_eq!(games.len(), 3);
        assert_eq!(
            games[0].home.logo,
            "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png"
        );
        assert_eq!(games[0].away.logo, "");
        assert_eq!(games[1].home.logo, "https://ESPNCDN.com/logo.png");
        assert_eq!(games[1].away.logo, "");
        assert_eq!(games[2].home.logo, "");
        assert_eq!(games[2].away.logo, "");
    }

    #[test]
    fn parses_a_roster_sorted_by_name_and_filters_logos() {
        let teams = super::parse_teams(include_str!("fixtures/nfl_teams.json")).unwrap();
        assert_eq!(teams.len(), 2);
        assert_eq!(teams[0].name, "Buffalo Bills");
        assert_eq!(teams[0].id, "2");
        assert_eq!(teams[0].abbr, "BUF");
        assert_eq!(teams[0].short_name, "Bills");
        assert_eq!(teams[0].logo, "");
        assert_eq!(teams[1].name, "Kansas City Chiefs");
        assert_eq!(teams[1].short_name, "Chiefs");
        assert_eq!(
            teams[1].logo,
            "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png"
        );
    }

    #[test]
    fn a_malformed_team_does_not_drop_the_rest() {
        let teams = super::parse_teams(include_str!("fixtures/nfl_teams_malformed.json")).unwrap();
        let names: Vec<_> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(names, ["Buffalo Bills", "Kansas City Chiefs"]);
    }

    #[test]
    fn empty_or_odd_roster_is_not_an_error() {
        assert!(super::parse_teams("{}").unwrap().is_empty());
        assert!(super::parse_teams(include_str!("fixtures/odd_teams.json"))
            .unwrap()
            .is_empty());
        assert!(super::parse_teams(r#"{"sports":"football"}"#)
            .unwrap()
            .is_empty());
        assert_eq!(
            super::parse_teams("not json").unwrap_err(),
            "invalid teams json"
        );
    }

    #[test]
    fn pregame_scores_are_serialised_as_the_feed_sent_them() {
        let raw = r#"{
          "events": [{
            "id": "200",
            "date": "2027-01-01T20:00:00Z",
            "shortName": "DAL @ PHI",
            "status": { "type": { "state": "pre", "shortDetail": "Fri 3:00 PM" } },
            "competitions": [{
              "competitors": [
                { "homeAway": "home", "score": "13", "team": { "id": "21", "abbreviation": "PHI", "displayName": "Philadelphia Eagles" } },
                { "homeAway": "away", "score": "7", "team": { "id": "6", "abbreviation": "DAL", "displayName": "Dallas Cowboys" } }
              ]
            }]
          }]
        }"#;
        let game = parse(raw, "football/nfl").unwrap().pop().unwrap();
        assert_eq!(game.state, "pre");
        let value = serde_json::to_value(&game).unwrap();
        assert_eq!(value["state"], "pre");
        assert_eq!(value["home"]["score"], 13);
        assert_eq!(value["away"]["score"], 7);
    }

    #[test]
    fn invalid_json_is_a_league_error() {
        assert_eq!(
            parse("not json", "football/nfl").unwrap_err(),
            "invalid scoreboard json"
        );
    }
}
