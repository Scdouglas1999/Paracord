//! ESPN game summary → a field the client can draw.
//!
//! A bad play is skipped. A missing section stays absent. `$ref` links are data,
//! never requests — they point at ESPN's private host.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::espn::{self, bool_field, dbl_field, int_field, loose_id, sanitize_logo, str_field};
use super::models::{
    AtBat, Athlete, BaseballDetail, Bases, FootballDetail, FootballDrive, FootballPlay, GameDetail,
    Hit, Pitch, ScoringPlay, StrikeZone, WinPoint,
};

const MAX_WIN_POINTS: usize = 120;
const MAX_AT_BATS: usize = 12;

pub(crate) fn parse(json: &str, league_path: &str) -> Result<GameDetail, String> {
    let root: Value = serde_json::from_str(json).map_err(|_| "invalid summary json".to_string())?;
    let game = espn::game_from_header(&root, league_path)
        .ok_or_else(|| "summary has no game".to_string())?;
    let kind = kind_of(league_path);
    let athletes = collect_athletes(&root);
    let football = (kind == "football").then(|| football_detail(&root));
    let baseball = (kind == "baseball").then(|| baseball_detail(&root, &athletes, &game.state));
    Ok(GameDetail {
        fetched_at: DateTime::<Utc>::UNIX_EPOCH,
        stale: false,
        game,
        kind,
        win_probability: win_probability(&root),
        scoring_plays: scoring_plays(&root),
        football,
        baseball,
    })
}

fn kind_of(league_path: &str) -> String {
    let sport = league_path.split('/').next().unwrap_or("");
    if sport.eq_ignore_ascii_case("football") {
        "football".to_string()
    } else if sport.eq_ignore_ascii_case("baseball") {
        "baseball".to_string()
    } else {
        "other".to_string()
    }
}

fn football_detail(root: &Value) -> FootballDetail {
    let mut drives = Vec::new();
    if let Some(bucket) = root.get("drives").filter(|value| value.is_object()) {
        if let Some(previous) = bucket.get("previous").and_then(Value::as_array) {
            for drive in previous {
                if let Some(drive) = football_drive(drive, false) {
                    drives.push(drive);
                }
            }
        }
        if let Some(current) = bucket.get("current").filter(|value| value.is_object()) {
            if let Some(drive) = football_drive(current, true) {
                // A live feed lists the drive in progress under `previous` as
                // well; the `current` copy is the fuller one, so it replaces it.
                drives.retain(|earlier| earlier.id != drive.id);
                drives.push(drive);
            }
        }
    }
    let situation = summary_situation(root).unwrap_or(&Value::Null);
    let mut detail = FootballDetail {
        possession_team_id: situation.get("possession").and_then(loose_id),
        ball_on: int_field(situation, "yardLine"),
        down: int_field(situation, "down"),
        distance: int_field(situation, "distance"),
        yards_to_endzone: int_field(situation, "yardsToEndzone"),
        down_distance_text: str_field(situation, "downDistanceText")
            .filter(|text| !text.is_empty()),
        red_zone: opt_bool(situation, "isRedZone"),
        drives,
    };
    fill_football_from_current(&mut detail, root);
    detail
}

/// Fields the situation omitted, taken from the last play of `drives.current`.
fn fill_football_from_current(detail: &mut FootballDetail, root: &Value) {
    let Some(play) = current_drive_last_play(root) else {
        return;
    };
    let end = play.get("end");
    if detail.ball_on.is_none() {
        detail.ball_on = end.and_then(|spot| int_field(spot, "yardLine"));
    }
    if detail.down.is_none() {
        detail.down = end.and_then(|spot| int_field(spot, "down"));
    }
    if detail.distance.is_none() {
        detail.distance = end.and_then(|spot| int_field(spot, "distance"));
    }
    if detail.possession_team_id.is_none() {
        detail.possession_team_id = end.and_then(|spot| spot.get("team")).and_then(loose_id);
    }
    if detail.down_distance_text.is_none() {
        detail.down_distance_text = end
            .and_then(|spot| str_field(spot, "downDistanceText"))
            .filter(|text| !text.is_empty());
    }
    if detail.yards_to_endzone.is_none() {
        detail.yards_to_endzone = end
            .and_then(|spot| int_field(spot, "yardsToEndzone"))
            .or_else(|| int_field(play, "yardsToEndzone"));
    }
    if detail.red_zone.is_none() {
        if let Some(yards) = detail.yards_to_endzone {
            detail.red_zone = Some(yards <= 20);
        }
    }
}

fn current_drive_last_play(root: &Value) -> Option<&Value> {
    root.get("drives")
        .and_then(|drives| drives.get("current"))
        .filter(|drive| drive.is_object())
        .and_then(|drive| drive.get("plays"))
        .and_then(Value::as_array)
        .and_then(|plays| plays.iter().rev().find(|play| play.is_object()))
}

fn football_drive(drive: &Value, live: bool) -> Option<FootballDrive> {
    if !drive.is_object() {
        return None;
    }
    let mut plays = Vec::new();
    if let Some(items) = drive.get("plays").and_then(Value::as_array) {
        for play in items {
            if let Some(play) = football_play(play) {
                plays.push(play);
            }
        }
    }
    Some(FootballDrive {
        id: str_field(drive, "id").unwrap_or_default(),
        team_id: drive.get("team").and_then(loose_id).unwrap_or_default(),
        description: str_field(drive, "description").unwrap_or_default(),
        result: str_field(drive, "result").unwrap_or_default(),
        is_score: bool_field(drive, "isScore"),
        start_yard: drive
            .get("start")
            .and_then(|spot| int_field(spot, "yardLine")),
        end_yard: drive
            .get("end")
            .and_then(|spot| int_field(spot, "yardLine")),
        live,
        plays,
    })
}

fn football_play(play: &Value) -> Option<FootballPlay> {
    if !play.is_object() {
        return None;
    }
    let id = str_field(play, "id").unwrap_or_default();
    let text = str_field(play, "text").unwrap_or_default();
    if id.is_empty() && text.is_empty() {
        return None;
    }
    let start = play.get("start");
    let end = play.get("end");
    Some(FootballPlay {
        id,
        text,
        play_type: play
            .get("type")
            .and_then(|kind| str_field(kind, "text"))
            .unwrap_or_default(),
        period: play
            .get("period")
            .and_then(|period| int_field(period, "number")),
        clock: play
            .get("clock")
            .and_then(|clock| str_field(clock, "displayValue"))
            .filter(|text| !text.is_empty()),
        start_yard: start.and_then(|spot| int_field(spot, "yardLine")),
        end_yard: end.and_then(|spot| int_field(spot, "yardLine")),
        down: start.and_then(|spot| int_field(spot, "down")),
        distance: start.and_then(|spot| int_field(spot, "distance")),
        yards: int_field(play, "statYardage"),
        scoring: bool_field(play, "scoringPlay"),
        team_id: start
            .and_then(|spot| spot.get("team"))
            .and_then(loose_id)
            .unwrap_or_default(),
    })
}

fn baseball_detail(
    root: &Value,
    athletes: &HashMap<String, Athlete>,
    state: &str,
) -> BaseballDetail {
    let situation = summary_situation(root).cloned().unwrap_or(Value::Null);
    let status = competition_status(root);
    let mut at_bats = at_bats(root, athletes);
    if state != "in" {
        for at_bat in &mut at_bats {
            at_bat.live = false;
        }
    }
    let situation_present = summary_situation(root).is_some();
    let live_play = (state == "in")
        .then(|| live_at_bat_last_play(root))
        .flatten();
    if at_bats.len() > MAX_AT_BATS {
        let skip = at_bats.len() - MAX_AT_BATS;
        at_bats.drain(0..skip);
    }
    let half = half_inning(&situation)
        .or_else(|| status.and_then(status_half))
        .or_else(|| {
            live_play
                .and_then(|play| play.get("period"))
                .and_then(period_half)
        });
    BaseballDetail {
        inning: int_field(&situation, "inning")
            .or_else(|| status.and_then(|status| int_field(status, "period")))
            .or_else(|| {
                live_play
                    .and_then(|play| play.get("period"))
                    .and_then(|period| int_field(period, "number"))
            }),
        half,
        balls: int_field(&situation, "balls").or_else(|| count_on(live_play, "balls")),
        strikes: int_field(&situation, "strikes").or_else(|| count_on(live_play, "strikes")),
        outs: int_field(&situation, "outs")
            .or_else(|| competition_outs(root))
            .or_else(|| live_play.and_then(|play| int_field(play, "outs"))),
        bases: Bases {
            first: base_runner(
                &situation,
                live_play,
                "onFirst",
                athletes,
                situation_present,
            ),
            second: base_runner(
                &situation,
                live_play,
                "onSecond",
                athletes,
                situation_present,
            ),
            third: base_runner(
                &situation,
                live_play,
                "onThird",
                athletes,
                situation_present,
            ),
        },
        pitcher: lineup_athlete(&situation, live_play, "pitcher", "pitcher", athletes),
        batter: lineup_athlete(&situation, live_play, "batter", "batter", athletes),
        bats: bats_hand(situation.get("bats"))
            .or_else(|| live_play.and_then(|play| bats_hand(play.get("bats")))),
        strike_zone: strike_zone(&situation),
        at_bats,
    }
}

fn count_on(play: Option<&Value>, name: &str) -> Option<i32> {
    play.and_then(|play| play.get("resultCount"))
        .and_then(|count| int_field(count, name))
}

fn base_runner(
    situation: &Value,
    play: Option<&Value>,
    key: &str,
    athletes: &HashMap<String, Athlete>,
    situation_present: bool,
) -> Option<Athlete> {
    // A live situation lists a base only while it is occupied.
    if situation_present {
        return runner(situation.get(key), athletes);
    }
    play.and_then(|play| runner(play.get(key), athletes))
}

fn lineup_athlete(
    situation: &Value,
    play: Option<&Value>,
    key: &str,
    role: &str,
    athletes: &HashMap<String, Athlete>,
) -> Option<Athlete> {
    if let Some(value) = situation.get(key) {
        if let Some(athlete) = person(Some(value), athletes) {
            return Some(athlete);
        }
    }
    let play = play?;
    let parts = play.get("participants")?.as_array()?;
    parts.iter().find_map(|part| {
        if str_field(part, "type").is_some_and(|kind| kind == role) {
            part.get("athlete")
                .and_then(loose_id)
                .map(|id| resolve(&id, athletes))
        } else {
            None
        }
    })
}

fn live_at_bat_last_play(root: &Value) -> Option<&Value> {
    let plays = root.get("plays")?.as_array()?;
    let mut last_id: Option<String> = None;
    let mut last_play: Option<&Value> = None;
    let mut terminal = false;
    for play in plays {
        let Some(id) = str_field(play, "atBatId").filter(|id| !id.is_empty()) else {
            continue;
        };
        if last_id.as_deref() != Some(id.as_str()) {
            last_id = Some(id);
            terminal = false;
        }
        let slug = play
            .get("type")
            .and_then(|kind| str_field(kind, "type"))
            .unwrap_or_default();
        if matches!(
            slug.as_str(),
            "play-result" | "end-batterpitcher" | "end-inning"
        ) {
            terminal = true;
        }
        last_play = Some(play);
    }
    if terminal {
        None
    } else {
        last_play
    }
}

fn at_bats(root: &Value, athletes: &HashMap<String, Athlete>) -> Vec<AtBat> {
    let Some(plays) = root.get("plays").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for play in plays {
        let Some(id) = str_field(play, "atBatId").filter(|id| !id.is_empty()) else {
            continue;
        };
        if !groups.contains_key(&id) {
            order.push(id.clone());
        }
        groups.entry(id).or_default().push(play);
    }
    let last_id = order.last().cloned();
    order
        .into_iter()
        .map(|id| {
            let plays = groups.remove(&id).unwrap_or_default();
            at_bat(
                &id,
                &plays,
                athletes,
                last_id.as_deref() == Some(id.as_str()),
            )
        })
        .collect()
}

fn at_bat(id: &str, plays: &[&Value], athletes: &HashMap<String, Athlete>, is_last: bool) -> AtBat {
    let mut pitches = Vec::new();
    let mut hit = None;
    let mut result_text = String::new();
    let mut scoring = false;
    let mut batter = None;
    let mut pitcher = None;
    let mut inning = None;
    let mut half = None;
    let mut terminal = false;
    for play in plays {
        let slug = play
            .get("type")
            .and_then(|kind| str_field(kind, "type"))
            .unwrap_or_default();
        if matches!(
            slug.as_str(),
            "play-result" | "end-batterpitcher" | "end-inning"
        ) {
            terminal = true;
        }
        if inning.is_none() {
            inning = play
                .get("period")
                .and_then(|period| int_field(period, "number"));
        }
        if half.is_none() {
            half = play.get("period").and_then(period_half);
        }
        if let Some(parts) = play.get("participants").and_then(Value::as_array) {
            for part in parts {
                let role = str_field(part, "type").unwrap_or_default();
                let person = part.get("athlete").and_then(loose_id);
                if role == "batter" && batter.is_none() {
                    batter = person.map(|id| resolve(&id, athletes));
                } else if role == "pitcher" && pitcher.is_none() {
                    pitcher = person.map(|id| resolve(&id, athletes));
                }
            }
        }
        if bool_field(play, "scoringPlay") {
            scoring = true;
        }
        if slug == "play-result" {
            if let Some(text) = str_field(play, "text").filter(|text| !text.is_empty()) {
                result_text = text;
            }
        }
        if let Some(result) = pitch_result(&slug, play.get("pitchCoordinate").is_some()) {
            let n = int_field(play, "atBatPitchNumber").unwrap_or_else(|| pitches.len() as i32 + 1);
            let coord = play.get("pitchCoordinate");
            let kind = play.get("pitchType");
            pitches.push(Pitch {
                n,
                x: coord.and_then(|coord| dbl_field(coord, "x")),
                y: coord.and_then(|coord| dbl_field(coord, "y")),
                pitch_type: kind
                    .and_then(|kind| str_field(kind, "text"))
                    .unwrap_or_default(),
                type_abbr: kind
                    .and_then(|kind| str_field(kind, "abbreviation"))
                    .unwrap_or_default(),
                velocity: dbl_field(play, "pitchVelocity")
                    .or_else(|| int_field(play, "pitchVelocity").map(f64::from)),
                result: result.to_string(),
                text: str_field(play, "text").unwrap_or_default(),
            });
            if result == "in-play" {
                if result_text.is_empty() {
                    result_text = str_field(play, "text").unwrap_or_default();
                }
                if let Some(coord) = play.get("hitCoordinate").filter(|value| value.is_object()) {
                    if let (Some(x), Some(y)) = (dbl_field(coord, "x"), dbl_field(coord, "y")) {
                        hit = Some(Hit {
                            x,
                            y,
                            trajectory: str_field(play, "trajectory")
                                .filter(|text| !text.is_empty()),
                        });
                    }
                }
            }
        }
    }
    AtBat {
        id: id.to_string(),
        inning,
        half,
        batter,
        pitcher,
        result_text,
        scoring,
        live: is_last && !terminal,
        pitches,
        hit,
    }
}

fn pitch_result(slug: &str, has_coordinate: bool) -> Option<&'static str> {
    let slug = slug.to_ascii_lowercase();
    // Bookkeeping rows repeat the last pitch. They are not extra pitches.
    if slug == "play-result" || slug.starts_with("start-") || slug.starts_with("end-") {
        return None;
    }
    if slug.starts_with("ball") {
        Some("ball")
    } else if slug.starts_with("strike-looking") {
        Some("strike-looking")
    } else if slug.starts_with("strike-swinging") || slug == "strikeout" {
        Some("strike-swinging")
    } else if slug.contains("foul") {
        Some("foul")
    } else if matches!(
        slug.as_str(),
        "single"
            | "double"
            | "triple"
            | "home-run"
            | "ground-out"
            | "fly-out"
            | "line-out"
            | "pop-out"
            | "sacrifice-fly"
            | "sacrifice-bunt"
            | "fielders-choice"
            | "batters-fielders-choice---runner-out"
            | "in-play"
    ) || slug.ends_with("-out")
    {
        Some("in-play")
    } else if has_coordinate {
        Some("other")
    } else {
        None
    }
}

fn period_half(period: &Value) -> Option<String> {
    str_field(period, "type").and_then(|raw| half_label(&raw))
}

fn half_inning(situation: &Value) -> Option<String> {
    str_field(situation, "half")
        .or_else(|| {
            situation
                .get("period")
                .and_then(|period| str_field(period, "type"))
        })
        .and_then(|raw| half_label(&raw))
}

fn half_label(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "top" => Some("top".to_string()),
        "bottom" | "bot" => Some("bottom".to_string()),
        _ => None,
    }
}

fn status_half(status: &Value) -> Option<String> {
    str_field(status, "periodPrefix").and_then(|raw| half_label(&raw))
}

fn runner(value: Option<&Value>, athletes: &HashMap<String, Athlete>) -> Option<Athlete> {
    let value = value?;
    if matches!(value, Value::Null | Value::Bool(false)) {
        return None;
    }
    loose_id(value).map(|id| resolve(&id, athletes))
}

fn person(value: Option<&Value>, athletes: &HashMap<String, Athlete>) -> Option<Athlete> {
    runner(value, athletes)
}

fn bats_hand(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let raw = if value.is_object() {
        str_field(value, "abbreviation").or_else(|| str_field(value, "type"))?
    } else {
        str_field_value(value)?
    };
    match raw.to_ascii_uppercase().as_str() {
        "L" | "LEFT" => Some("L".to_string()),
        "R" | "RIGHT" => Some("R".to_string()),
        "S" | "B" | "BOTH" | "SWITCH" => Some("S".to_string()),
        _ => None,
    }
}

fn strike_zone(situation: &Value) -> Option<StrikeZone> {
    let zone = situation
        .get("strikeZone")
        .or_else(|| situation.get("strike_zone"))
        .filter(|value| value.is_object())?;
    Some(StrikeZone {
        left: dbl_field(zone, "left")?,
        right: dbl_field(zone, "right")?,
        top: dbl_field(zone, "top")?,
        bottom: dbl_field(zone, "bottom")?,
    })
}

fn win_probability(root: &Value) -> Vec<WinPoint> {
    let Some(items) = root.get("winprobability").and_then(Value::as_array) else {
        return Vec::new();
    };
    let points = items
        .iter()
        .filter_map(|item| {
            let pct = dbl_field(item, "homeWinPercentage")?;
            Some(WinPoint {
                home_pct: (pct * 100.0).clamp(0.0, 100.0),
            })
        })
        .collect();
    downsample(points, MAX_WIN_POINTS)
}

fn scoring_plays(root: &Value) -> Vec<ScoringPlay> {
    if let Some(items) = root.get("scoringPlays").and_then(Value::as_array) {
        return items.iter().filter_map(scoring_play).collect();
    }
    let Some(plays) = root.get("plays").and_then(Value::as_array) else {
        return Vec::new();
    };
    plays
        .iter()
        .filter(|play| bool_field(play, "scoringPlay"))
        .filter_map(scoring_play)
        .collect()
}

fn scoring_play(play: &Value) -> Option<ScoringPlay> {
    if !play.is_object() {
        return None;
    }
    let text = str_field(play, "text").unwrap_or_default();
    let team_id = play.get("team").and_then(loose_id).unwrap_or_default();
    if text.is_empty() && team_id.is_empty() {
        return None;
    }
    Some(ScoringPlay {
        text,
        period: play
            .get("period")
            .and_then(|period| int_field(period, "number")),
        clock: play
            .get("clock")
            .and_then(|clock| str_field(clock, "displayValue"))
            .filter(|text| !text.is_empty()),
        team_id,
        home_score: score_field(play, "homeScore"),
        away_score: score_field(play, "awayScore"),
    })
}

fn score_field(value: &Value, name: &str) -> Option<i32> {
    int_field(value, name)
        .or_else(|| str_field(value, name).and_then(|text| text.trim().parse().ok()))
}

/// Live state lives on the summary root. Older payloads nest it under the header.
fn summary_situation(root: &Value) -> Option<&Value> {
    root.get("situation")
        .filter(|value| value.is_object())
        .or_else(|| header_situation(root))
}

fn competition(root: &Value) -> Option<&Value> {
    root.get("header")
        .and_then(|header| header.get("competitions"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
}

fn competition_status(root: &Value) -> Option<&Value> {
    competition(root)
        .and_then(|comp| comp.get("status"))
        .filter(|value| value.is_object())
}

fn competition_outs(root: &Value) -> Option<i32> {
    competition(root).and_then(|comp| int_field(comp, "outs"))
}

fn header_situation(root: &Value) -> Option<&Value> {
    let comp = competition(root)?;
    comp.get("situation")
        .filter(|value| value.is_object())
        .or_else(|| {
            root.get("header")
                .and_then(|header| header.get("situation"))
                .filter(|value| value.is_object())
        })
}

fn collect_athletes(root: &Value) -> HashMap<String, Athlete> {
    let mut index = HashMap::new();
    if let Some(rosters) = root.get("rosters").and_then(Value::as_array) {
        for side in rosters {
            if let Some(entries) = side.get("roster").and_then(Value::as_array) {
                for entry in entries {
                    if let Some(raw) = entry.get("athlete") {
                        remember(&mut index, raw);
                    }
                }
            }
        }
    }
    if let Some(players) = root
        .get("boxscore")
        .and_then(|boxscore| boxscore.get("players"))
        .and_then(Value::as_array)
    {
        for team in players {
            let Some(groups) = team.get("statistics").and_then(Value::as_array) else {
                continue;
            };
            for group in groups {
                let Some(athletes) = group.get("athletes").and_then(Value::as_array) else {
                    continue;
                };
                for row in athletes {
                    if let Some(raw) = row.get("athlete") {
                        remember(&mut index, raw);
                    }
                }
            }
        }
    }
    index
}

fn remember(index: &mut HashMap<String, Athlete>, raw: &Value) {
    let Some(athlete) = athlete_from(raw) else {
        return;
    };
    match index.get(&athlete.id) {
        Some(existing) if !existing.name.is_empty() => {}
        _ => {
            index.insert(athlete.id.clone(), athlete);
        }
    }
}

fn athlete_from(raw: &Value) -> Option<Athlete> {
    let id = str_field(raw, "id").filter(|id| !id.is_empty())?;
    let name = str_field(raw, "displayName")
        .or_else(|| str_field(raw, "fullName"))
        .unwrap_or_default();
    let short_name = str_field(raw, "shortName")
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| name.clone());
    let headshot = raw
        .get("headshot")
        .and_then(|headshot| str_field(headshot, "href"))
        .map(|href| sanitize_logo(&href))
        .unwrap_or_default();
    Some(Athlete {
        id,
        name,
        short_name,
        headshot,
    })
}

fn resolve(id: &str, index: &HashMap<String, Athlete>) -> Athlete {
    index.get(id).cloned().unwrap_or(Athlete {
        id: id.to_string(),
        name: String::new(),
        short_name: String::new(),
        headshot: String::new(),
    })
}

fn str_field_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn opt_bool(value: &Value, name: &str) -> Option<bool> {
    match value.get(name) {
        Some(Value::Bool(flag)) => Some(*flag),
        _ => None,
    }
}

fn downsample<T: Clone>(items: Vec<T>, max: usize) -> Vec<T> {
    if max == 0 || items.len() <= max {
        return items;
    }
    if max == 1 {
        return vec![items.into_iter().next().unwrap()];
    }
    let last = items.len() - 1;
    (0..max)
        .map(|index| items[(index * last) / (max - 1)].clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfl_summary_keeps_the_drive_when_a_play_is_malformed() {
        let detail = parse(include_str!("fixtures/nfl_summary.json"), "football/nfl").unwrap();
        assert_eq!(detail.kind, "football");
        assert!(detail.baseball.is_none());
        let game = &detail.game;
        assert_eq!(game.id, "401872945");
        assert_eq!(game.state, "post");
        assert_eq!(game.league, "NFL");
        assert_eq!(game.home.abbr, "KC");
        assert_eq!(game.home.score, Some(33));
        assert_eq!(game.away.abbr, "IND");
        assert_eq!(game.away.score, Some(30));
        assert_eq!(game.home.color.as_deref(), Some("e31837"));
        assert_eq!(game.home.alt_color.as_deref(), Some("ffb612"));
        assert_eq!(game.away.color.as_deref(), Some("003b75"));
        assert_eq!(game.away.alt_color.as_deref(), Some("ffffff"));
        assert_eq!(game.broadcasts, ["NBC"]);
        assert_eq!(game.detail, "Final/OT");
        let football = detail.football.as_ref().unwrap();
        assert!(football.ball_on.is_none());
        assert!(football.red_zone.is_none());
        assert_eq!(football.drives.len(), 2);
        assert!(!football.drives[0].live);
        assert_eq!(football.drives[0].plays.len(), 2, "the bad play is skipped");
        assert_eq!(football.drives[0].start_yard, Some(65));
        assert_eq!(football.drives[0].end_yard, Some(0));
        assert_eq!(football.drives[0].plays[0].start_yard, Some(35));
        assert_eq!(football.drives[1].result, "FG");
        assert_eq!(detail.scoring_plays.len(), 2);
        assert!(detail.scoring_plays[0].text.contains("Tyler Warren"));
        assert_eq!(detail.win_probability.len(), 3);
        assert!((detail.win_probability[0].home_pct - 76.93).abs() < 0.01);
        let wire = serde_json::to_string(&detail).unwrap();
        assert!(!wire.contains("espn.pvt"));
        assert!(!wire.contains("$ref"));
    }

    #[test]
    fn a_drive_listed_as_both_previous_and_current_appears_once_as_live() {
        // Seen on a real live game (Giants at Rams, 2026-09-21): drives.previous
        // already held the drive in progress, and drives.current was the same id.
        let detail = parse(
            r#"{"header":{"id":"3","competitions":[{"date":"2026-09-22T00:15:00Z","competitors":[{"homeAway":"home","team":{"id":"14","abbreviation":"LAR","displayName":"Rams"}},{"homeAway":"away","team":{"id":"19","abbreviation":"NYG","displayName":"Giants"}}],"status":{"type":{"state":"in","shortDetail":"11:28 - 1st"},"period":1,"displayClock":"11:28"}}]},"drives":{"current":{"id":"4018729471","team":{"id":"19"},"description":"6 plays, 27 yards, 2:55","plays":[{"id":"a","text":"Kickoff","type":{"text":"Kickoff"},"end":{"yardLine":30,"team":{"id":"19"}}},{"id":"b","text":"Jones pass","type":{"text":"Pass"},"end":{"down":3,"distance":8,"yardLine":43,"yardsToEndzone":43,"team":{"id":"19"},"downDistanceText":"3rd & 8 at LAR 43"}}]},"previous":[{"id":"4018729471","team":{"id":"19"},"description":"5 plays, 25 yards, 2:30","plays":[{"id":"a","text":"Kickoff","type":{"text":"Kickoff"},"end":{"yardLine":30,"team":{"id":"19"}}}]}]}}"#,
            "football/nfl",
        )
        .unwrap();
        let football = detail.football.as_ref().unwrap();
        assert_eq!(football.drives.len(), 1);
        assert!(football.drives[0].live);
        assert_eq!(football.drives[0].plays.len(), 2);
        assert_eq!(football.down, Some(3));
        assert_eq!(football.ball_on, Some(43));
    }

    #[test]
    fn nfl_live_fixture_puts_the_current_drive_last() {
        // Derived and reshaped: no NFL, college, CFL, or UFL game was live.
        // The situation sits on the summary root, where a real live feed puts it.
        let detail = parse(
            include_str!("fixtures/nfl_summary_live.json"),
            "football/nfl",
        )
        .unwrap();
        let football = detail.football.as_ref().unwrap();
        assert_eq!(football.ball_on, Some(72));
        assert_eq!(football.down, Some(2));
        assert_eq!(football.distance, Some(7));
        assert_eq!(football.yards_to_endzone, Some(28));
        assert_eq!(football.possession_team_id.as_deref(), Some("12"));
        assert_eq!(football.red_zone, Some(true));
        assert!(football.drives.last().unwrap().live);
        assert!(!football.drives[0].live);
        assert_eq!(detail.game.state, "in");
        assert_eq!(detail.game.detail, "2:05 - 4th");
    }

    #[test]
    fn mlb_summary_groups_pitches_and_resolves_names() {
        let detail = parse(include_str!("fixtures/mlb_summary.json"), "baseball/mlb").unwrap();
        assert_eq!(detail.kind, "baseball");
        assert!(detail.football.is_none());
        assert_eq!(detail.game.away.abbr, "PHI");
        assert_eq!(detail.game.home.abbr, "NYM");
        assert_eq!(detail.game.detail, "Final");
        assert_eq!(detail.game.home.color.as_deref(), Some("002d72"));
        assert_eq!(detail.game.home.alt_color.as_deref(), Some("ff5910"));
        assert_eq!(detail.game.away.color.as_deref(), Some("e81828"));
        assert_eq!(detail.game.away.alt_color.as_deref(), Some("003278"));
        let baseball = detail.baseball.as_ref().unwrap();
        assert!(baseball.balls.is_none());
        assert!(baseball.inning.is_none());
        assert!(baseball.half.is_none());
        assert!(baseball.strike_zone.is_none());
        assert!(baseball.at_bats.len() >= 2);
        let walk = &baseball.at_bats[0];
        assert!(!walk.live);
        assert!(walk.pitches.iter().any(|pitch| pitch.result == "foul"));
        assert!(walk.pitches.iter().any(|pitch| pitch.result == "ball"));
        assert_eq!(walk.batter.as_ref().unwrap().name, "Kyle Schwarber");
        assert_eq!(
            walk.pitcher.as_ref().unwrap().headshot,
            "https://a.espncdn.com/i/headshots/mlb/players/full/5214984.png"
        );
        let hit = baseball
            .at_bats
            .iter()
            .find(|at_bat| at_bat.hit.is_some())
            .unwrap();
        assert_eq!(hit.hit.as_ref().unwrap().x, 173.0);
        assert_eq!(hit.hit.as_ref().unwrap().trajectory.as_deref(), Some("G"));
        assert!(hit.pitches.iter().any(|pitch| pitch.result == "in-play"));
        assert_eq!(hit.batter.as_ref().unwrap().short_name, "B. Harper");
        let wire = serde_json::to_string(&detail).unwrap();
        assert!(!wire.contains("espn.pvt"));
    }

    #[test]
    fn mlb_live_capture_fills_the_count_from_the_root_situation() {
        // Captured from the live Nationals at Tigers summary (event 401817028).
        // situation is a top-level object; inning and half come from header status.
        let detail = parse(
            include_str!("fixtures/mlb_summary_live.json"),
            "baseball/mlb",
        )
        .unwrap();
        assert_eq!(detail.game.detail, "Bot 1st");
        assert_eq!(detail.game.state, "in");
        let baseball = detail.baseball.as_ref().unwrap();
        assert_eq!(baseball.inning, Some(1));
        assert_eq!(baseball.half.as_deref(), Some("bottom"));
        assert_eq!(baseball.balls, Some(0));
        assert_eq!(baseball.strikes, Some(0));
        assert_eq!(baseball.outs, Some(0));
        assert_eq!(baseball.bats.as_deref(), Some("R"));
        assert!(baseball.bases.first.is_none());
        assert_eq!(
            baseball.bases.second.as_ref().unwrap().name,
            "Gleyber Torres"
        );
        assert!(baseball.bases.third.is_none());
        assert_eq!(baseball.pitcher.as_ref().unwrap().name, "DJ Herz");
        assert_eq!(baseball.pitcher.as_ref().unwrap().id, "4917686");
        assert_eq!(baseball.batter.as_ref().unwrap().name, "Hao-Yu Lee");
        assert_eq!(baseball.batter.as_ref().unwrap().id, "5124113");
        let live = baseball.at_bats.last().unwrap();
        assert!(live.live);
        assert!(live
            .pitches
            .iter()
            .any(|pitch| pitch.result == "strike-looking"));
        let wire = serde_json::to_string(&detail).unwrap();
        assert!(!wire.contains("espn.pvt"));
    }

    #[test]
    fn missing_live_situation_is_taken_from_the_current_play() {
        let detail = parse(
            r#"{"header":{"id":"1","competitions":[{"date":"2026-09-21T23:00:00Z","outs":2,"competitors":[{"homeAway":"home","team":{"id":"6","abbreviation":"DET","displayName":"Tigers"}},{"homeAway":"away","team":{"id":"20","abbreviation":"WSH","displayName":"Nationals"}}],"status":{"type":{"state":"in","shortDetail":"Top 1st"},"period":1,"periodPrefix":"Bot"}}]},"plays":[{"id":"p1","atBatId":"ab","type":{"type":"strike-looking"},"text":"Pitch 1","period":{"type":"Top","number":1},"resultCount":{"balls":1,"strikes":2},"outs":1,"bats":{"abbreviation":"L"},"participants":[{"type":"pitcher","athlete":{"id":"9"}},{"type":"batter","athlete":{"id":"8"}}],"onFirst":{"athlete":{"id":"7"}}}]}"#,
            "baseball/mlb",
        )
        .unwrap();
        // periodPrefix wins over the play's "Top" because the header said Bot.
        let baseball = detail.baseball.as_ref().unwrap();
        assert_eq!(baseball.inning, Some(1));
        assert_eq!(baseball.half.as_deref(), Some("bottom"));
        assert_eq!(baseball.balls, Some(1));
        assert_eq!(baseball.strikes, Some(2));
        assert_eq!(baseball.outs, Some(2));
        assert_eq!(baseball.bats.as_deref(), Some("L"));
        assert_eq!(baseball.bases.first.as_ref().unwrap().id, "7");
        assert_eq!(baseball.pitcher.as_ref().unwrap().id, "9");
        assert_eq!(baseball.batter.as_ref().unwrap().id, "8");
        assert_eq!(detail.game.detail, "Top 1st");

        let detail = parse(
            r#"{"header":{"id":"2","competitions":[{"date":"2026-09-21T23:00:00Z","competitors":[{"homeAway":"home","team":{"id":"12","abbreviation":"KC","displayName":"Chiefs"}},{"homeAway":"away","team":{"id":"11","abbreviation":"IND","displayName":"Colts"}}],"status":{"type":{"state":"in","shortDetail":"2:05 - 4th"},"period":4,"displayClock":"2:05"}}]},"drives":{"current":{"id":"d","team":{"id":"12"},"plays":[{"id":"p","text":"Mahomes pass","type":{"text":"Pass"},"end":{"down":2,"distance":7,"yardLine":72,"yardsToEndzone":18,"team":{"id":"12"},"downDistanceText":"2nd & 7"}}]}}}"#,
            "football/nfl",
        )
        .unwrap();
        let football = detail.football.as_ref().unwrap();
        assert_eq!(football.ball_on, Some(72));
        assert_eq!(football.down, Some(2));
        assert_eq!(football.distance, Some(7));
        assert_eq!(football.possession_team_id.as_deref(), Some("12"));
        assert_eq!(football.down_distance_text.as_deref(), Some("2nd & 7"));
        assert_eq!(football.yards_to_endzone, Some(18));
        assert_eq!(football.red_zone, Some(true));
        assert_eq!(detail.game.detail, "2:05 - 4th");
    }

    #[test]
    fn missing_sections_are_absent_and_win_probability_is_capped() {
        let detail = parse(
            r#"{"header":{"id":"9","league":{"abbreviation":"NHL"},"competitions":[{"date":"2026-09-21T00:00:00Z","competitors":[{"homeAway":"home","team":{"id":"1","abbreviation":"H","displayName":"Home"}},{"homeAway":"away","team":{"id":"2","abbreviation":"A","displayName":"Away"}}],"status":{"type":{"state":"pre","shortDetail":"Wed"}}}]}}"#,
            "hockey/nhl",
        )
        .unwrap();
        assert_eq!(detail.kind, "other");
        assert!(detail.football.is_none());
        assert!(detail.baseball.is_none());
        assert!(detail.win_probability.is_empty());
        assert!(detail.scoring_plays.is_empty());

        let mut points = Vec::new();
        for index in 0..121 {
            points.push(format!(
                r#"{{"homeWinPercentage":{}}}"#,
                index as f64 / 120.0
            ));
        }
        let raw = format!(
            r#"{{"header":{{"id":"1","competitions":[{{"date":"2026-09-21T00:00:00Z","competitors":[{{"homeAway":"home","team":{{"id":"1","abbreviation":"H","displayName":"Home"}}}},{{"homeAway":"away","team":{{"id":"2","abbreviation":"A","displayName":"Away"}}}}],"status":{{"type":{{"state":"post"}}}}}}]}},"winprobability":[{}]}}"#,
            points.join(",")
        );
        let detail = parse(&raw, "football/nfl").unwrap();
        assert_eq!(detail.win_probability.len(), 120);
        assert!((detail.win_probability[0].home_pct).abs() < 0.001);
        assert!((detail.win_probability[119].home_pct - 100.0).abs() < 0.001);
        assert!(detail.football.as_ref().unwrap().drives.is_empty());
    }

    #[test]
    fn invalid_summary_json_is_an_error() {
        assert_eq!(
            parse("nope", "football/nfl").unwrap_err(),
            "invalid summary json"
        );
    }
}
