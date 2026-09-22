//! Development replay of a finished game, sliced by play wallclock.
//!
//! Leaders and the box score stay as the final. The feed has no per-play box,
//! so a slice cannot rebuild them.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{Map, Value};

use super::espn::{self, loose_id, str_field};
use super::service::{FeedError, FeedFut, ScoreFeed};

const RETRIES: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayGame {
    pub league: String,
    pub event_id: String,
}

/// `PARACORD_SPORTS_REPLAY_START`. Empty is the first play. Anything that is
/// not RFC3339 is ignored by the caller.
pub fn parse_replay_start(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

/// `spec` is `sport/league/event_id` entries separated by commas.
pub fn parse_replay_games(spec: &str) -> Vec<ReplayGame> {
    let mut games = Vec::new();
    for item in spec.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let mut parts: Vec<&str> = item.split('/').collect();
        if parts.len() < 3 {
            continue;
        }
        let Some(event_id) = parts.pop() else {
            continue;
        };
        let league = parts.join("/");
        if super::service::is_valid_league_path(&league)
            && super::service::is_valid_event_id(event_id)
        {
            games.push(ReplayGame {
                league: league.to_ascii_lowercase(),
                event_id: event_id.to_string(),
            });
        }
    }
    games
}

#[derive(Clone)]
struct LoadedGame {
    league: String,
    event_id: String,
    summary: Value,
}

struct Stamp {
    at: DateTime<Utc>,
    play: Value,
    /// Index into the ordered drive list. Baseball plays use `None`.
    drive: Option<usize>,
}

/// The process-wide feed while replay is on. Scoreboards come from the real
/// feed with replayed events laid over them. A replayed summary is a pure
/// function of how long the process has been up.
pub struct ReplayFeed {
    inner: Arc<dyn ScoreFeed>,
    games: Vec<LoadedGame>,
    missed: Vec<String>,
    started_at: DateTime<Utc>,
    speed: f64,
    /// Wallclock the replay shows at `started_at`. None begins before the first play.
    start_at: Option<DateTime<Utc>>,
}

impl ReplayFeed {
    pub async fn load(
        inner: Arc<dyn ScoreFeed>,
        games: Vec<ReplayGame>,
        speed: f64,
        started_at: DateTime<Utc>,
        start_at: Option<DateTime<Utc>>,
    ) -> Self {
        let mut loaded = Vec::new();
        let mut missed = Vec::new();
        for game in games {
            match fetch_summary(&inner, &game).await {
                Some(summary) => loaded.push(LoadedGame {
                    league: game.league,
                    event_id: game.event_id,
                    summary,
                }),
                None => missed.push(format!("{}/{}", game.league, game.event_id)),
            }
        }
        Self {
            inner,
            games: loaded,
            started_at,
            speed,
            start_at,
            missed,
        }
    }

    /// Debug line for the virtual clock. Called once a minute while replay is on.
    pub fn clock_sentence(&self, now: DateTime<Utc>) -> String {
        let elapsed = self.elapsed_at(now);
        if let Some(start) = self.start_at {
            return format!(
                "Sports replay clock: {}.",
                super::models::format_rfc3339(add_secs(start, elapsed * self.speed))
            );
        }
        if self.games.is_empty() {
            return "Sports replay clock: no games loaded.".to_string();
        }
        let parts: Vec<String> = self
            .games
            .iter()
            .map(|game| {
                let at = match first_wallclock(&game.summary) {
                    Some(origin) if elapsed > 0.0 => {
                        super::models::format_rfc3339(add_secs(origin, elapsed * self.speed))
                    }
                    Some(_) => "before the first play".to_string(),
                    None => "no plays".to_string(),
                };
                format!("{}/{} at {at}", game.league, game.event_id)
            })
            .collect();
        format!("Sports replay clock: {}.", parts.join(", "))
    }

    pub fn spawn_clock(self: &Arc<Self>) {
        let feed = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                tracing::debug!("{}", feed.clock_sentence(Utc::now()));
            }
        });
    }

    /// One plain sentence for the startup log.
    pub fn announcement(&self) -> String {
        let speed = format_speed(self.speed);
        let names: Vec<String> = self
            .games
            .iter()
            .map(|game| format!("{}/{}", game.league, game.event_id))
            .collect();
        let playing = if names.is_empty() {
            "no games loaded".to_string()
        } else {
            names.join(", ")
        };
        let mut sentence =
            format!("Sports replay is on: {playing}, {speed} game-seconds per real second.");
        if !self.missed.is_empty() {
            sentence.push_str(&format!(" {} did not load.", self.missed.join(", ")));
        }
        sentence
    }

    fn elapsed_at(&self, now: DateTime<Utc>) -> f64 {
        let millis = (now - self.started_at).num_milliseconds();
        if millis <= 0 {
            0.0
        } else {
            millis as f64 / 1000.0
        }
    }

    fn slice_game(&self, game: &LoadedGame, now: DateTime<Utc>) -> Value {
        let elapsed = self.elapsed_at(now);
        match self.start_at {
            Some(start) => slice_summary_at(&game.summary, elapsed, self.speed, Some(start)),
            None => slice_summary(&game.summary, elapsed, self.speed),
        }
    }

    fn games_for<'a>(&'a self, league: &str) -> Vec<&'a LoadedGame> {
        let league = league.to_ascii_lowercase();
        self.games
            .iter()
            .filter(|game| game.league == league)
            .collect()
    }
}

async fn fetch_summary(inner: &Arc<dyn ScoreFeed>, game: &ReplayGame) -> Option<Value> {
    let label = format!("{}/{}", game.league, game.event_id);
    for attempt in 1..=RETRIES {
        match inner.fetch_summary(&game.league, &game.event_id).await {
            Ok(body) => match serde_json::from_str::<Value>(&body) {
                Ok(summary) => return Some(summary),
                Err(_) => tracing::warn!("Sports replay got invalid JSON for {label}."),
            },
            Err(error) => tracing::warn!(
                "Sports replay could not load {label} ({}); attempt {attempt} of {RETRIES}.",
                error.board_message()
            ),
        }
        if attempt < RETRIES {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    None
}

fn format_speed(speed: f64) -> String {
    if speed.fract() == 0.0 && speed.abs() < 1e12 {
        format!("{}", speed as i64)
    } else {
        format!("{speed}")
    }
}

/// `elapsed_secs` is real time since the replay started. With no explicit
/// start, zero is before the first play. Once the last play's wallclock is
/// behind the cutoff, the original final summary is returned unchanged.
pub fn slice_summary(summary: &Value, elapsed_secs: f64, speed: f64) -> Value {
    slice_summary_at(summary, elapsed_secs, speed, None)
}

/// `start` is the virtual wallclock at elapsed zero (`PARACORD_SPORTS_REPLAY_START`).
pub fn slice_summary_at(
    summary: &Value,
    elapsed_secs: f64,
    speed: f64,
    start: Option<DateTime<Utc>>,
) -> Value {
    let Some(stamps) = stamp_summary(summary) else {
        return summary.clone();
    };
    if stamps.is_empty() {
        return pre_game(summary);
    }
    let origin = stamps[0].at;
    let last = stamps.last().expect("stamps is not empty").at;
    let cutoff = match start {
        Some(start) => add_secs(start, elapsed_secs.max(0.0) * speed),
        None => {
            if elapsed_secs <= 0.0 {
                return pre_game(summary);
            }
            add_secs(origin, elapsed_secs * speed)
        }
    };
    if cutoff < origin {
        return pre_game(summary);
    }
    if cutoff > last {
        return summary.clone();
    }
    let included: Vec<&Stamp> = stamps.iter().filter(|stamp| stamp.at <= cutoff).collect();
    if included.is_empty() {
        return pre_game(summary);
    }
    let mut sliced = summary.clone();
    apply_slice(&mut sliced, &included);
    sliced
}

fn first_wallclock(summary: &Value) -> Option<DateTime<Utc>> {
    stamp_summary(summary).and_then(|stamps| stamps.first().map(|stamp| stamp.at))
}

fn stamp_summary(summary: &Value) -> Option<Vec<Stamp>> {
    let drives = football_drives(summary);
    if drives.iter().any(|drive| {
        drive
            .get("plays")
            .and_then(Value::as_array)
            .is_some_and(|plays| !plays.is_empty())
    }) {
        return Some(stamp_drives(&drives));
    }
    let plays = summary.get("plays").and_then(Value::as_array)?;
    Some(stamp_list(plays, None))
}

fn football_drives(summary: &Value) -> Vec<Value> {
    let mut drives = Vec::new();
    let Some(bucket) = summary.get("drives").filter(|value| value.is_object()) else {
        return drives;
    };
    if let Some(previous) = bucket.get("previous").and_then(Value::as_array) {
        for drive in previous {
            if drive.is_object() {
                drives.push(drive.clone());
            }
        }
    }
    if let Some(current) = bucket.get("current").filter(|value| value.is_object()) {
        let id = str_field(current, "id");
        let already = id.as_ref().is_some_and(|id| {
            drives
                .iter()
                .any(|drive| str_field(drive, "id").as_deref() == Some(id))
        });
        if !already {
            drives.push(current.clone());
        }
    }
    drives
}

fn stamp_drives(drives: &[Value]) -> Vec<Stamp> {
    let mut stamps = Vec::new();
    let mut previous = None;
    for (index, drive) in drives.iter().enumerate() {
        let Some(plays) = drive.get("plays").and_then(Value::as_array) else {
            continue;
        };
        stamps.extend(stamp_with(plays, Some(index), &mut previous));
    }
    stamps
}

fn stamp_list(plays: &[Value], drive: Option<usize>) -> Vec<Stamp> {
    let mut previous = None;
    stamp_with(plays, drive, &mut previous)
}

fn stamp_with(
    plays: &[Value],
    drive: Option<usize>,
    previous: &mut Option<DateTime<Utc>>,
) -> Vec<Stamp> {
    let mut stamps = Vec::new();
    for play in plays {
        let own = play.get("wallclock").and_then(parse_wallclock);
        let at = own.or(*previous);
        if let Some(at) = at {
            *previous = Some(at);
            stamps.push(Stamp {
                at,
                play: play.clone(),
                drive,
            });
        }
    }
    stamps
}

fn parse_wallclock(value: &Value) -> Option<DateTime<Utc>> {
    let text = value.as_str()?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn add_secs(origin: DateTime<Utc>, secs: f64) -> DateTime<Utc> {
    if !secs.is_finite() || secs <= 0.0 {
        return origin;
    }
    let millis = (secs * 1000.0).round() as i64;
    origin + ChronoDuration::milliseconds(millis)
}

fn pre_game(summary: &Value) -> Value {
    let mut sliced = summary.clone();
    let status = scheduled_status();
    set_header_status(&mut sliced, status);
    set_header_scores(&mut sliced, 0, 0, &[], &[]);
    if let Some(root) = sliced.as_object_mut() {
        root.remove("situation");
        if let Some(drives) = root.get_mut("drives").and_then(Value::as_object_mut) {
            drives.insert("previous".to_string(), Value::Array(Vec::new()));
            drives.remove("current");
        }
        if root.get("plays").is_some() {
            root.insert("plays".to_string(), Value::Array(Vec::new()));
        }
        if root.get("atBats").is_some() {
            root.insert("atBats".to_string(), Value::Object(Map::new()));
        }
        if root.get("playsMap").is_some() {
            root.insert("playsMap".to_string(), Value::Object(Map::new()));
        }
        if root.get("winprobability").is_some() {
            root.insert("winprobability".to_string(), Value::Array(Vec::new()));
        }
        if root.get("scoringPlays").is_some() {
            root.insert("scoringPlays".to_string(), Value::Array(Vec::new()));
        }
    }
    sliced
}

fn apply_slice(sliced: &mut Value, included: &[&Stamp]) {
    let last = included.last().expect("included plays");
    let (away, home) = running_score(included);
    let (away_periods, home_periods) = period_sums(included);
    let football = last.drive.is_some();
    let status = if football {
        football_status(&last.play)
    } else {
        baseball_status(&last.play)
    };
    set_header_status(sliced, status);
    set_header_scores(sliced, away, home, &away_periods, &home_periods);
    let situation = if football {
        football_situation(sliced, included)
    } else {
        baseball_situation(sliced, included)
    };
    if let Some(root) = sliced.as_object_mut() {
        root.insert("situation".to_string(), situation.clone());
    }
    set_competition_situation(sliced, situation);
    let ids = included_ids(included);
    filter_named_array(sliced, "winprobability", |item| {
        str_field(item, "playId").is_some_and(|id| ids.contains(&id))
    });
    filter_named_array(sliced, "scoringPlays", |item| {
        str_field(item, "id").is_some_and(|id| ids.contains(&id))
    });
    if football {
        rewrite_drives(sliced, included);
    } else {
        rewrite_baseball_lists(sliced, included, &ids);
    }
}

fn included_ids(included: &[&Stamp]) -> HashSet<String> {
    included
        .iter()
        .filter_map(|stamp| play_id(&stamp.play))
        .collect()
}

fn play_id(play: &Value) -> Option<String> {
    str_field(play, "id").filter(|id| !id.is_empty())
}

fn running_score(included: &[&Stamp]) -> (i32, i32) {
    let mut away = 0;
    let mut home = 0;
    for stamp in included {
        if let Some(score) = score_of(&stamp.play, "awayScore") {
            away = score;
        }
        if let Some(score) = score_of(&stamp.play, "homeScore") {
            home = score;
        }
    }
    (away, home)
}

fn period_sums(included: &[&Stamp]) -> (Vec<i32>, Vec<i32>) {
    let mut prev_away = 0;
    let mut prev_home = 0;
    let mut sums: BTreeMap<i32, (i32, i32)> = BTreeMap::new();
    let mut max_period = 0;
    for stamp in included {
        let away = score_of(&stamp.play, "awayScore").unwrap_or(prev_away);
        let home = score_of(&stamp.play, "homeScore").unwrap_or(prev_home);
        let period = play_period(&stamp.play).unwrap_or(max_period.max(1));
        max_period = max_period.max(period);
        let bucket = sums.entry(period).or_insert((0, 0));
        bucket.0 += away - prev_away;
        bucket.1 += home - prev_home;
        prev_away = away;
        prev_home = home;
    }
    if max_period <= 0 {
        return (Vec::new(), Vec::new());
    }
    let mut away_periods = Vec::new();
    let mut home_periods = Vec::new();
    for period in 1..=max_period {
        let (away, home) = sums.get(&period).copied().unwrap_or((0, 0));
        away_periods.push(away);
        home_periods.push(home);
    }
    (away_periods, home_periods)
}

fn score_of(play: &Value, name: &str) -> Option<i32> {
    play.get(name).and_then(whole_number)
}

fn play_period(play: &Value) -> Option<i32> {
    play.get("period")
        .and_then(|period| espn::int_field(period, "number"))
        .filter(|period| *period > 0)
}

fn whole_number(value: &Value) -> Option<i32> {
    match value {
        Value::Number(number) => {
            let number = number.as_f64()?;
            if number.is_finite()
                && number.fract() == 0.0
                && (i32::MIN as f64..=i32::MAX as f64).contains(&number)
            {
                Some(number as i32)
            } else {
                None
            }
        }
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn football_status(play: &Value) -> Value {
    let period = play_period(play).unwrap_or(1);
    let clock = play
        .get("clock")
        .and_then(|clock| str_field(clock, "displayValue"))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "0:00".to_string());
    let label = format!("{clock} - {}", football_ordinal(period));
    progress_status(period, &clock, clock_seconds(&clock), &label, None, None)
}

fn baseball_status(play: &Value) -> Value {
    let period = play_period(play).unwrap_or(1);
    let half = play
        .get("period")
        .and_then(|period| str_field(period, "type"))
        .unwrap_or_default();
    let (prefix, word) = match half.to_ascii_lowercase().as_str() {
        "top" => ("Top", "Top"),
        "bottom" | "bot" => ("Bot", "Bot"),
        _ => ("", ""),
    };
    let ordinal = ordinal(period);
    let label = if word.is_empty() {
        ordinal.clone()
    } else {
        format!("{word} {ordinal}")
    };
    progress_status(period, "", 0.0, &label, Some(prefix), Some(ordinal))
}

fn progress_status(
    period: i32,
    display_clock: &str,
    clock: f64,
    label: &str,
    period_prefix: Option<&str>,
    display_period: Option<String>,
) -> Value {
    let mut status = Map::new();
    let mut kind = Map::new();
    kind.insert("state".to_string(), Value::String("in".to_string()));
    kind.insert("completed".to_string(), Value::Bool(false));
    kind.insert("detail".to_string(), Value::String(label.to_string()));
    kind.insert("shortDetail".to_string(), Value::String(label.to_string()));
    status.insert("type".to_string(), Value::Object(kind));
    status.insert("period".to_string(), Value::from(period));
    status.insert(
        "displayClock".to_string(),
        Value::String(display_clock.to_string()),
    );
    status.insert("clock".to_string(), Value::from(clock));
    if let Some(prefix) = period_prefix.filter(|prefix| !prefix.is_empty()) {
        status.insert(
            "periodPrefix".to_string(),
            Value::String(prefix.to_string()),
        );
    }
    if let Some(display) = display_period {
        status.insert("displayPeriod".to_string(), Value::String(display));
    }
    Value::Object(status)
}

fn scheduled_status() -> Value {
    progress_status(0, "", 0.0, "Scheduled", None, None)
        .as_object()
        .cloned()
        .map(|mut status| {
            if let Some(kind) = status.get_mut("type").and_then(Value::as_object_mut) {
                kind.insert("state".to_string(), Value::String("pre".to_string()));
            }
            Value::Object(status)
        })
        .unwrap_or(Value::Null)
}

fn football_ordinal(period: i32) -> String {
    if period >= 5 {
        if period == 5 {
            "OT".to_string()
        } else {
            format!("{}OT", period - 4)
        }
    } else {
        ordinal(period)
    }
}

fn ordinal(period: i32) -> String {
    let suffix = if (11..=13).contains(&(period % 100)) {
        "th"
    } else {
        match period % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        }
    };
    format!("{period}{suffix}")
}

fn clock_seconds(clock: &str) -> f64 {
    let mut parts = clock.split(':');
    let minutes = parts.next().and_then(|text| text.parse::<f64>().ok());
    let seconds = parts.next().and_then(|text| text.parse::<f64>().ok());
    match (minutes, seconds) {
        (Some(minutes), Some(seconds)) => minutes * 60.0 + seconds,
        _ => 0.0,
    }
}

fn football_situation(summary: &Value, included: &[&Stamp]) -> Value {
    let last = included.last().expect("included plays");
    let mut situation = Map::new();
    if let Some(end) = last.play.get("end").filter(|value| value.is_object()) {
        for key in ["yardLine", "down", "distance", "yardsToEndzone"] {
            if let Some(number) = end.get(key).and_then(whole_number) {
                situation.insert(key.to_string(), Value::from(number));
            }
        }
        if let Some(text) = str_field(end, "downDistanceText").filter(|text| !text.is_empty()) {
            situation.insert("downDistanceText".to_string(), Value::String(text));
        }
        if let Some(yards) = end.get("yardsToEndzone").and_then(whole_number) {
            situation.insert("isRedZone".to_string(), Value::Bool(yards <= 20));
        }
    }
    if let Some(team) = last
        .drive
        .and_then(|index| football_drives(summary).get(index).cloned())
        .and_then(|drive| drive.get("team").and_then(loose_id))
    {
        situation.insert("possession".to_string(), Value::String(team));
    }
    let previous = included
        .len()
        .checked_sub(2)
        .and_then(|index| included.get(index));
    situation.insert(
        "lastPlay".to_string(),
        last_play_value(
            &last.play,
            previous.map(|stamp| &stamp.play),
            summary,
            included,
            None,
        ),
    );
    Value::Object(situation)
}

fn baseball_situation(summary: &Value, included: &[&Stamp]) -> Value {
    let last = included.last().expect("included plays");
    let ended = at_bat_ended(&last.play);
    // A later included play is the next at-bat. The slice usually ends on the
    // out itself, and then the next batter is not known yet.
    let follow = if ended {
        following_at_bat(included, included.len() - 1)
    } else {
        None
    };
    let source = follow.unwrap_or(&last.play);
    let mut situation = Map::new();
    if ended {
        situation.insert("balls".to_string(), Value::from(0));
        situation.insert("strikes".to_string(), Value::from(0));
    } else if let Some(count) = last
        .play
        .get("resultCount")
        .filter(|value| value.is_object())
    {
        if let Some(balls) = count.get("balls").and_then(whole_number) {
            situation.insert("balls".to_string(), Value::from(balls));
        }
        if let Some(strikes) = count.get("strikes").and_then(whole_number) {
            situation.insert("strikes".to_string(), Value::from(strikes));
        }
    }
    if let Some(outs) = source.get("outs").and_then(whole_number) {
        situation.insert("outs".to_string(), Value::from(outs));
    }
    for (feed, wire) in [
        ("onFirst", "onFirst"),
        ("onSecond", "onSecond"),
        ("onThird", "onThird"),
    ] {
        if let Some(id) = runner_id(source.get(feed)) {
            situation.insert(wire.to_string(), player_id_value(&id));
        }
    }
    if let Some(id) = participant_id(source, "pitcher") {
        situation.insert("pitcher".to_string(), player_id_value(&id));
    }
    let batter = if ended {
        follow.and_then(|play| participant_id(play, "batter"))
    } else {
        participant_id(&last.play, "batter")
    };
    match &batter {
        Some(id) => {
            situation.insert("batter".to_string(), player_id_value(id));
        }
        None if ended => {
            situation.insert("batter".to_string(), Value::Null);
        }
        None => {}
    }
    let described = if follow.is_some() {
        source
    } else {
        included
            .iter()
            .rev()
            .find_map(|stamp| {
                str_field(&stamp.play, "text")
                    .filter(|text| !text.is_empty())
                    .map(|_| &stamp.play)
            })
            .unwrap_or(source)
    };
    let previous = included
        .len()
        .checked_sub(2)
        .and_then(|index| included.get(index));
    situation.insert(
        "lastPlay".to_string(),
        last_play_value(
            described,
            previous.map(|stamp| &stamp.play),
            summary,
            included,
            Some((participant_id(source, "pitcher"), batter)),
        ),
    );
    Value::Object(situation)
}

/// A strikeout, walk, out, or hit closes the count. The live board then shows
/// 0-0 until the next pitch, not the 2-3 the last pitch recorded.
fn at_bat_ended(play: &Value) -> bool {
    let slug = play
        .get("type")
        .and_then(|kind| str_field(kind, "type"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        slug.as_str(),
        "play-result" | "end-batterpitcher" | "end-inning" | "strikeout"
    ) || slug.ends_with("-out")
        || matches!(
            slug.as_str(),
            "single"
                | "double"
                | "triple"
                | "home-run"
                | "fielders-choice"
                | "sacrifice-fly"
                | "sacrifice-bunt"
        )
    {
        return true;
    }
    let Some(count) = play.get("resultCount").filter(|value| value.is_object()) else {
        return false;
    };
    let balls = count.get("balls").and_then(whole_number).unwrap_or(0);
    let strikes = count.get("strikes").and_then(whole_number).unwrap_or(0);
    balls >= 4 || strikes >= 3
}

fn following_at_bat<'a>(included: &'a [&Stamp], ended_at: usize) -> Option<&'a Value> {
    let ended_id = str_field(&included.get(ended_at)?.play, "atBatId");
    for stamp in included.iter().skip(ended_at + 1) {
        let next_id = str_field(&stamp.play, "atBatId");
        if next_id.is_some() && next_id != ended_id {
            return Some(&stamp.play);
        }
    }
    None
}

fn participant_id(play: &Value, role: &str) -> Option<String> {
    let parts = play.get("participants")?.as_array()?;
    parts.iter().find_map(|part| {
        if str_field(part, "type").is_some_and(|kind| kind.eq_ignore_ascii_case(role)) {
            part.get("athlete").and_then(loose_id)
        } else {
            None
        }
    })
}

fn last_play_value(
    play: &Value,
    previous: Option<&Value>,
    summary: &Value,
    included: &[&Stamp],
    matchup: Option<(Option<String>, Option<String>)>,
) -> Value {
    let mut last = Map::new();
    let matchup_text = matchup
        .and_then(|(pitcher, batter)| pitches_to(summary, pitcher.as_deref(), batter.as_deref()));
    let text = matchup_text
        .clone()
        .or_else(|| str_field(play, "text").filter(|text| !text.is_empty()));
    if let Some(text) = text {
        last.insert("text".to_string(), Value::String(text));
    }
    last.insert(
        "scoreValue".to_string(),
        Value::from(play_score_value(play, previous)),
    );
    if matchup_text.is_some() {
        let mut kind = Map::new();
        kind.insert("text".to_string(), Value::String("Now at bat".to_string()));
        kind.insert(
            "alternativeText".to_string(),
            Value::String("Now at bat".to_string()),
        );
        last.insert("type".to_string(), Value::Object(kind));
    } else if let Some(kind) = play.get("type").filter(|value| value.is_object()) {
        last.insert("type".to_string(), kind.clone());
    }
    if let Some(pct) = last_win_pct(summary, included) {
        let mut probability = Map::new();
        probability.insert("homeWinPercentage".to_string(), Value::from(pct));
        last.insert("probability".to_string(), Value::Object(probability));
    }
    Value::Object(last)
}

fn pitches_to(summary: &Value, pitcher: Option<&str>, batter: Option<&str>) -> Option<String> {
    let pitcher = roster_name(summary, pitcher?)?;
    let batter = roster_name(summary, batter?)?;
    Some(format!("{pitcher} pitches to {batter}"))
}

fn roster_name(summary: &Value, id: &str) -> Option<String> {
    let groups = summary.get("rosters")?.as_array()?;
    for group in groups {
        let roster = group.get("roster").and_then(Value::as_array)?;
        for entry in roster {
            let athlete = entry.get("athlete").filter(|value| value.is_object())?;
            let athlete_id = loose_id(athlete)?;
            if athlete_id == id {
                return str_field(athlete, "displayName")
                    .filter(|name| !name.is_empty())
                    .or_else(|| str_field(athlete, "shortName").filter(|name| !name.is_empty()))
                    .or_else(|| str_field(athlete, "fullName").filter(|name| !name.is_empty()));
            }
        }
    }
    None
}

fn last_win_pct(summary: &Value, included: &[&Stamp]) -> Option<f64> {
    let ids = included_ids(included);
    let items = summary.get("winprobability")?.as_array()?;
    items.iter().rev().find_map(|item| {
        let id = str_field(item, "playId")?;
        if !ids.contains(&id) {
            return None;
        }
        espn::dbl_field(item, "homeWinPercentage")
    })
}

fn play_score_value(play: &Value, previous: Option<&Value>) -> i32 {
    if let Some(points) = play.get("scoreValue").and_then(whole_number) {
        return points;
    }
    if !espn::bool_field(play, "scoringPlay") {
        return 0;
    }
    let away = score_of(play, "awayScore").unwrap_or(0);
    let home = score_of(play, "homeScore").unwrap_or(0);
    let (prev_away, prev_home) = previous
        .map(|play| {
            (
                score_of(play, "awayScore").unwrap_or(0),
                score_of(play, "homeScore").unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    (away - prev_away).max(0) + (home - prev_home).max(0)
}

fn runner_id(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if matches!(value, Value::Null | Value::Bool(false)) {
        return None;
    }
    loose_id(value).or_else(|| value.get("athlete").and_then(loose_id))
}

fn player_id_value(id: &str) -> Value {
    let mut object = Map::new();
    let id_value = id
        .parse::<i64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(id.to_string()));
    object.insert("playerId".to_string(), id_value);
    Value::Object(object)
}

fn set_header_status(summary: &mut Value, status: Value) {
    if let Some(competition) = competition_mut(summary) {
        competition.insert("status".to_string(), status);
    }
}

fn set_competition_situation(summary: &mut Value, situation: Value) {
    if let Some(competition) = competition_mut(summary) {
        competition.insert("situation".to_string(), situation);
    }
}

fn set_header_scores(
    summary: &mut Value,
    away: i32,
    home: i32,
    away_periods: &[i32],
    home_periods: &[i32],
) {
    let Some(competitors) = competition_mut(summary)
        .and_then(|competition| competition.get_mut("competitors"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for competitor in competitors {
        let Some(side) = str_field(competitor, "homeAway") else {
            continue;
        };
        let (score, periods) = if side.eq_ignore_ascii_case("home") {
            (home, home_periods)
        } else if side.eq_ignore_ascii_case("away") {
            (away, away_periods)
        } else {
            continue;
        };
        let Some(object) = competitor.as_object_mut() else {
            continue;
        };
        object.insert("score".to_string(), Value::String(score.to_string()));
        object.insert("hits".to_string(), Value::Null);
        object.insert("errors".to_string(), Value::Null);
        let lines: Vec<Value> = periods
            .iter()
            .map(|points| {
                let mut line = Map::new();
                line.insert(
                    "displayValue".to_string(),
                    Value::String(points.to_string()),
                );
                Value::Object(line)
            })
            .collect();
        object.insert("linescores".to_string(), Value::Array(lines));
    }
}

fn competition_mut(summary: &mut Value) -> Option<&mut Map<String, Value>> {
    summary
        .get_mut("header")
        .and_then(|header| header.get_mut("competitions"))
        .and_then(Value::as_array_mut)
        .and_then(|items| items.first_mut())
        .and_then(Value::as_object_mut)
}

fn filter_named_array(summary: &mut Value, name: &str, keep: impl Fn(&Value) -> bool) {
    let Some(root) = summary.as_object_mut() else {
        return;
    };
    let Some(items) = root.get_mut(name).and_then(Value::as_array_mut) else {
        return;
    };
    items.retain(keep);
}

fn rewrite_drives(summary: &mut Value, included: &[&Stamp]) {
    let drives = football_drives(summary);
    let Some(last_drive) = included.last().and_then(|stamp| stamp.drive) else {
        return;
    };
    let mut previous = Vec::new();
    for (index, drive) in drives.iter().enumerate() {
        let total = drive
            .get("plays")
            .and_then(Value::as_array)
            .map(|plays| plays.len())
            .unwrap_or(0);
        // A drive is previous only when every one of its plays is included.
        let included_here = included
            .iter()
            .filter(|stamp| stamp.drive == Some(index))
            .count();
        if total > 0 && included_here == total {
            previous.push(drive_with_plays(drive, included, index));
        }
    }
    let current = drives
        .get(last_drive)
        .map(|drive| drive_with_plays(drive, included, last_drive));
    if let Some(bucket) = summary.get_mut("drives").and_then(Value::as_object_mut) {
        bucket.insert("previous".to_string(), Value::Array(previous));
        if let Some(current) = current {
            bucket.insert("current".to_string(), current);
        } else {
            bucket.remove("current");
        }
    }
}

fn drive_with_plays(drive: &Value, included: &[&Stamp], index: usize) -> Value {
    let mut clone = drive.clone();
    let plays: Vec<Value> = included
        .iter()
        .filter(|stamp| stamp.drive == Some(index))
        .map(|stamp| stamp.play.clone())
        .collect();
    if let Some(object) = clone.as_object_mut() {
        object.insert("plays".to_string(), Value::Array(plays));
    }
    clone
}

fn rewrite_baseball_lists(summary: &mut Value, included: &[&Stamp], ids: &HashSet<String>) {
    let plays: Vec<Value> = included.iter().map(|stamp| stamp.play.clone()).collect();
    let at_bat_ids: HashSet<String> = included
        .iter()
        .filter_map(|stamp| str_field(&stamp.play, "atBatId"))
        .collect();
    if let Some(root) = summary.as_object_mut() {
        root.insert("plays".to_string(), Value::Array(plays));
        if let Some(at_bats) = root.get_mut("atBats").and_then(Value::as_object_mut) {
            at_bats.retain(|id, _| at_bat_ids.contains(id));
        }
        if let Some(map) = root.get_mut("playsMap").and_then(Value::as_object_mut) {
            map.retain(|id, _| ids.contains(id));
        }
    }
}

/// Rewrite one scoreboard event so the board agrees with a sliced summary.
/// The event is appended when today's board does not already list it.
pub fn overlay_scoreboard(board: &mut Value, event_id: &str, sliced: &Value) {
    let Some(events) = board.get_mut("events").and_then(Value::as_array_mut) else {
        return;
    };
    let replacement = scoreboard_event(event_id, sliced);
    if let Some(event) = events.iter_mut().find(|event| event_id_is(event, event_id)) {
        merge_event(event, &replacement);
    } else if let Some(replacement) = replacement {
        events.push(replacement);
    }
}

fn event_id_is(event: &Value, event_id: &str) -> bool {
    match event.get("id") {
        Some(Value::String(id)) => id == event_id,
        Some(Value::Number(id)) => id.to_string() == event_id,
        _ => false,
    }
}

fn scoreboard_event(event_id: &str, sliced: &Value) -> Option<Value> {
    let competition = sliced.pointer("/header/competitions/0")?.clone();
    let mut event = Map::new();
    event.insert("id".to_string(), Value::String(event_id.to_string()));
    if let Some(date) = competition.get("date") {
        event.insert("date".to_string(), date.clone());
    }
    if let Some(status) = competition.get("status") {
        event.insert("status".to_string(), status.clone());
    }
    event.insert("competitions".to_string(), Value::Array(vec![competition]));
    Some(Value::Object(event))
}

fn merge_event(event: &mut Value, replacement: &Option<Value>) {
    let Some(replacement) = replacement else {
        return;
    };
    let Some(event) = event.as_object_mut() else {
        return;
    };
    if let Some(status) = replacement.get("status") {
        event.insert("status".to_string(), status.clone());
    }
    let Some(fresh) = replacement
        .pointer("/competitions/0")
        .and_then(Value::as_object)
    else {
        return;
    };
    let competitions = event
        .entry("competitions")
        .or_insert_with(|| Value::Array(vec![Value::Object(Map::new())]));
    let Some(competition) = competitions
        .as_array_mut()
        .and_then(|items| {
            if items.is_empty() {
                items.push(Value::Object(Map::new()));
            }
            items.first_mut()
        })
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    if let Some(status) = fresh.get("status") {
        competition.insert("status".to_string(), status.clone());
    }
    if let Some(situation) = fresh.get("situation") {
        competition.insert("situation".to_string(), situation.clone());
    } else {
        competition.remove("situation");
    }
    merge_competitors(competition, fresh.get("competitors"));
}

fn merge_competitors(competition: &mut Map<String, Value>, fresh: Option<&Value>) {
    let Some(fresh) = fresh.and_then(Value::as_array) else {
        return;
    };
    let Some(competitors) = competition
        .get_mut("competitors")
        .and_then(Value::as_array_mut)
    else {
        competition.insert("competitors".to_string(), Value::Array(fresh.clone()));
        return;
    };
    for incoming in fresh {
        let Some(side) = str_field(incoming, "homeAway") else {
            continue;
        };
        let Some(existing) = competitors.iter_mut().find(|competitor| {
            str_field(competitor, "homeAway")
                .is_some_and(|existing| existing.eq_ignore_ascii_case(&side))
        }) else {
            competitors.push(incoming.clone());
            continue;
        };
        let Some(existing) = existing.as_object_mut() else {
            continue;
        };
        if let Some(score) = incoming.get("score") {
            existing.insert("score".to_string(), score.clone());
        }
        if let Some(lines) = incoming.get("linescores") {
            existing.insert("linescores".to_string(), lines.clone());
        }
    }
}

impl ScoreFeed for ReplayFeed {
    fn fetch<'a>(&'a self, league: &'a str) -> FeedFut<'a> {
        let league_owned = league.to_string();
        let inner = Arc::clone(&self.inner);
        let overlays: Vec<(String, Value)> = self
            .games_for(league)
            .into_iter()
            .map(|game| (game.event_id.clone(), self.slice_game(game, Utc::now())))
            .collect();
        Box::pin(async move {
            let body = inner.fetch(&league_owned).await?;
            if overlays.is_empty() {
                return Ok(body);
            }
            let mut board: Value = serde_json::from_str(&body)
                .map_err(|_| FeedError::Other("scoreboard was not valid json".to_string()))?;
            for (event_id, sliced) in &overlays {
                overlay_scoreboard(&mut board, event_id, sliced);
            }
            serde_json::to_string(&board).map_err(|_| {
                FeedError::Other("could not write the replayed scoreboard".to_string())
            })
        })
    }

    fn fetch_teams<'a>(&'a self, league: &'a str) -> FeedFut<'a> {
        self.inner.fetch_teams(league)
    }

    fn fetch_summary<'a>(&'a self, league: &'a str, event_id: &'a str) -> FeedFut<'a> {
        let league_key = league.to_ascii_lowercase();
        if let Some(game) = self
            .games
            .iter()
            .find(|game| game.league == league_key && game.event_id == event_id)
        {
            let sliced = self.slice_game(game, Utc::now());
            return Box::pin(async move {
                serde_json::to_string(&sliced).map_err(|_| {
                    FeedError::Other("could not write the replayed summary".to_string())
                })
            });
        }
        self.inner.fetch_summary(league, event_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sports::detail;
    use crate::sports::espn;

    fn nfl() -> Value {
        serde_json::from_str(include_str!("fixtures/nfl_summary.json")).expect("nfl fixture")
    }

    fn mlb() -> Value {
        serde_json::from_str(include_str!("fixtures/mlb_summary.json")).expect("mlb fixture")
    }

    fn status<'a>(summary: &'a Value) -> &'a Value {
        &summary["header"]["competitions"][0]["status"]
    }

    #[test]
    fn football_slice_is_scheduled_then_live_then_the_final() {
        let original = nfl();
        let scheduled = slice_summary(&original, 0.0, 1.0);
        assert_eq!(status(&scheduled)["type"]["state"], "pre");
        assert_eq!(status(&scheduled)["type"]["detail"], "Scheduled");
        assert!(scheduled.get("situation").is_none());
        assert_eq!(scheduled["drives"]["previous"].as_array().unwrap().len(), 0);
        assert!(scheduled["drives"].get("current").is_none());
        assert_eq!(scheduled["scoringPlays"].as_array().unwrap().len(), 0);
        assert_eq!(scheduled["winprobability"].as_array().unwrap().len(), 0);
        assert_eq!(scheduled["leaders"], original["leaders"]);
        assert_eq!(scheduled["boxscore"], original["boxscore"]);
        let pre = detail::parse(&scheduled.to_string(), "football/nfl").unwrap();
        assert_eq!(pre.game.state, "pre");
        assert_eq!(pre.game.detail, "Scheduled");
        assert_eq!(pre.game.home.score, Some(0));
        assert_eq!(pre.game.away.score, Some(0));
        assert!(pre.football.unwrap().drives.is_empty());
        assert!(pre.line_score.is_none());

        // 150s includes the kickoff, the play that inherited its clock, the
        // rush, and the overtime kickoff. The final play is still ahead.
        let mid = slice_summary(&original, 150.0, 1.0);
        assert_eq!(slice_summary(&original, 150.0, 1.0), mid);
        assert_eq!(status(&mid)["type"]["state"], "in");
        assert_eq!(status(&mid)["type"]["detail"], "3:11 - OT");
        assert_eq!(status(&mid)["type"]["shortDetail"], "3:11 - OT");
        assert_eq!(status(&mid)["period"], 5);
        assert_eq!(status(&mid)["displayClock"], "3:11");
        let previous = mid["drives"]["previous"].as_array().unwrap();
        assert_eq!(previous.len(), 1);
        assert_eq!(previous[0]["plays"].as_array().unwrap().len(), 3);
        assert_eq!(previous[0]["plays"][1], "not-a-play");
        assert_eq!(
            mid["drives"]["current"]["plays"].as_array().unwrap().len(),
            1
        );
        assert_eq!(mid["drives"]["current"]["id"], "40187294521");
        assert_eq!(mid["situation"]["yardLine"], 32);
        assert_eq!(mid["situation"]["down"], 1);
        assert_eq!(mid["situation"]["distance"], 10);
        assert_eq!(mid["situation"]["yardsToEndzone"], 68);
        assert_eq!(mid["situation"]["downDistanceText"], "1st & 10 at KC 32");
        assert_eq!(mid["situation"]["possession"], "12");
        assert_eq!(mid["situation"]["isRedZone"], false);
        assert!(mid["scoringPlays"].as_array().unwrap().is_empty());
        assert!(mid["winprobability"].as_array().unwrap().is_empty());
        assert_eq!(mid["leaders"], original["leaders"]);
        assert_eq!(mid["boxscore"], original["boxscore"]);
        let parsed = detail::parse(&mid.to_string(), "football/nfl").unwrap();
        assert_eq!(parsed.game.state, "in");
        assert_eq!(parsed.game.detail, "3:11 - OT");
        assert_eq!(parsed.game.period, 5);
        assert_eq!(parsed.game.home.score, Some(30));
        assert_eq!(parsed.game.away.score, Some(30));
        let football = parsed.football.unwrap();
        assert_eq!(football.possession_team_id.as_deref(), Some("12"));
        assert_eq!(football.ball_on, Some(32));
        assert_eq!(football.down, Some(1));
        assert_eq!(football.distance, Some(10));
        assert_eq!(football.yards_to_endzone, Some(68));
        assert_eq!(
            football.down_distance_text.as_deref(),
            Some("1st & 10 at KC 32")
        );
        assert_eq!(football.red_zone, Some(false));
        assert_eq!(football.drives.len(), 2);
        assert!(!football.drives[0].live);
        assert_eq!(football.drives[0].plays.len(), 2);
        assert!(football.drives[1].live);
        assert_eq!(football.drives[1].plays.len(), 1);
        let lines = parsed.line_score.unwrap();
        assert_eq!(
            lines.periods,
            ["1", "2", "3", "4", "OT"].map(String::from).to_vec()
        );
        assert_eq!(
            lines.away.periods,
            [Some(0), Some(0), Some(0), Some(0), Some(30)].to_vec()
        );
        assert_eq!(
            lines.home.periods,
            [Some(0), Some(0), Some(0), Some(0), Some(30)].to_vec()
        );
        assert_eq!(lines.home.total, Some(30));
        assert_eq!(lines.away.hits, None);
        assert_eq!(lines.home.errors, None);
        assert_eq!(
            parsed.leaders,
            detail::parse(&original.to_string(), "football/nfl")
                .unwrap()
                .leaders
        );
        assert_eq!(
            parsed.box_score,
            detail::parse(&original.to_string(), "football/nfl")
                .unwrap()
                .box_score
        );

        let done = slice_summary(&original, 181.0, 1.0);
        assert_eq!(done, original);
    }

    #[test]
    fn baseball_slice_is_scheduled_then_live_then_the_final() {
        let original = mlb();
        let scheduled = slice_summary(&original, 0.0, 1.0);
        assert_eq!(status(&scheduled)["type"]["state"], "pre");
        assert_eq!(scheduled["plays"].as_array().unwrap().len(), 0);
        assert!(scheduled.get("situation").is_none());
        assert_eq!(scheduled["boxscore"], original["boxscore"]);

        let mid = slice_summary(&original, 480.0, 1.0);
        assert_eq!(mid["plays"].as_array().unwrap().len(), 17);
        assert_eq!(status(&mid)["type"]["state"], "in");
        assert_eq!(status(&mid)["type"]["detail"], "Top 1st");
        assert_eq!(status(&mid)["periodPrefix"], "Top");
        assert_eq!(status(&mid)["displayPeriod"], "1st");
        assert_eq!(status(&mid)["period"], 1);
        // The last included play is a single, so the live count resets.
        assert_eq!(mid["situation"]["balls"], 0);
        assert_eq!(mid["situation"]["strikes"], 0);
        assert_eq!(mid["situation"]["outs"], 1);
        assert_eq!(mid["situation"]["onFirst"]["playerId"], 30951);
        assert!(mid["situation"].get("onSecond").is_none());
        assert_eq!(mid["situation"]["onThird"]["playerId"], 33712);
        assert_eq!(mid["situation"]["pitcher"]["playerId"], 5214984);
        assert!(mid["situation"]["batter"].is_null());
        assert_eq!(
            mid["situation"]["lastPlay"]["text"],
            "Harper singled to right, Schwarber to third."
        );
        assert_eq!(mid["winprobability"].as_array().unwrap().len(), 1);
        assert_eq!(mid["boxscore"], original["boxscore"]);
        let parsed = detail::parse(&mid.to_string(), "baseball/mlb").unwrap();
        assert_eq!(parsed.game.state, "in");
        assert_eq!(parsed.game.detail, "Top 1st");
        assert_eq!(parsed.game.balls, Some(0));
        assert_eq!(parsed.game.strikes, Some(0));
        assert_eq!(parsed.game.outs, Some(1));
        assert!(parsed.game.on_first);
        assert!(!parsed.game.on_second);
        assert!(parsed.game.on_third);
        let baseball = parsed.baseball.unwrap();
        assert_eq!(baseball.inning, Some(1));
        assert_eq!(baseball.half.as_deref(), Some("top"));
        assert_eq!(baseball.bases.first.unwrap().id, "30951");
        assert!(baseball.bases.second.is_none());
        assert_eq!(baseball.bases.third.unwrap().id, "33712");
        assert_eq!(baseball.pitcher.unwrap().id, "5214984");
        assert!(baseball.batter.is_none());
        assert_eq!(baseball.balls, Some(0));
        assert_eq!(baseball.strikes, Some(0));
        assert_eq!(baseball.at_bats.len(), 2);
        let lines = parsed.line_score.unwrap();
        assert_eq!(lines.periods, ["1".to_string()].to_vec());
        assert_eq!(lines.away.periods, vec![Some(0)]);
        assert_eq!(lines.home.periods, vec![Some(0)]);
        assert_eq!(lines.away.hits, None);
        assert_eq!(lines.home.errors, None);

        assert_eq!(slice_summary(&original, 511.0, 1.0), original);
    }

    #[test]
    fn a_play_without_a_wallclock_inherits_the_previous_one() {
        let summary = serde_json::json!({
            "header": {
                "id": "9",
                "competitions": [{
                    "competitors": [
                        {"homeAway": "away", "score": "0", "team": {"id": "1", "abbreviation": "A", "displayName": "Away"}},
                        {"homeAway": "home", "score": "0", "team": {"id": "2", "abbreviation": "H", "displayName": "Home"}}
                    ]
                }]
            },
            "plays": [
                {
                    "id": "1",
                    "wallclock": "2026-09-20T17:00:00Z",
                    "awayScore": 0,
                    "homeScore": 0,
                    "period": {"type": "Top", "number": 1},
                    "atBatId": "10",
                    "resultCount": {"balls": 0, "strikes": 0},
                    "outs": 0
                },
                {
                    "id": "2",
                    "awayScore": 1,
                    "homeScore": 0,
                    "period": {"type": "Top", "number": 1},
                    "atBatId": "10",
                    "resultCount": {"balls": 1, "strikes": 1},
                    "outs": 0,
                    "participants": [
                        {"type": "pitcher", "athlete": {"id": "7"}},
                        {"type": "batter", "athlete": {"id": "8"}}
                    ]
                },
                {
                    "id": "3",
                    "wallclock": "2026-09-20T17:10:00Z",
                    "awayScore": 1,
                    "homeScore": 2,
                    "period": {"type": "Bot", "number": 2},
                    "atBatId": "11"
                }
            ],
            "atBats": {"10": {"id": "10"}, "11": {"id": "11"}},
            "playsMap": {"1": {}, "2": {}, "3": {}},
            "scoringPlays": [{"id": "2", "text": "run"}, {"id": "9", "text": "later"}],
            "winprobability": [{"playId": "2", "homeWinPercentage": 0.4}, {"playId": "3", "homeWinPercentage": 0.2}],
            "leaders": [{"category": "batting"}],
            "boxscore": {"players": []}
        });
        let sliced = slice_summary(&summary, 1.0, 1.0);
        assert_eq!(sliced["plays"].as_array().unwrap().len(), 2);
        assert_eq!(sliced["plays"][1]["id"], "2");
        assert_eq!(sliced["situation"]["balls"], 1);
        assert_eq!(sliced["situation"]["strikes"], 1);
        assert_eq!(sliced["situation"]["pitcher"]["playerId"], 7);
        assert_eq!(
            sliced["header"]["competitions"][0]["competitors"][0]["score"],
            "1"
        );
        assert_eq!(
            sliced["header"]["competitions"][0]["competitors"][0]["linescores"][0]["displayValue"],
            "1"
        );
        assert_eq!(sliced["atBats"].as_object().unwrap().len(), 1);
        assert!(sliced["atBats"].get("10").is_some());
        assert_eq!(sliced["playsMap"].as_object().unwrap().len(), 2);
        assert!(sliced["playsMap"].get("3").is_none());
        assert_eq!(sliced["scoringPlays"].as_array().unwrap().len(), 1);
        assert_eq!(sliced["scoringPlays"][0]["id"], "2");
        assert_eq!(sliced["winprobability"].as_array().unwrap().len(), 1);
        assert_eq!(sliced["leaders"], summary["leaders"]);
        assert_eq!(sliced["boxscore"], summary["boxscore"]);
        assert_eq!(slice_summary(&summary, 601.0, 1.0), summary);
    }

    #[test]
    fn scoreboard_overlay_matches_the_sliced_summary() {
        let sliced = slice_summary(&nfl(), 150.0, 1.0);
        let mut board = serde_json::json!({
            "events": [{
                "id": 401872945,
                "date": "2026-09-21T00:20:00Z",
                "shortName": "IND @ KC",
                "status": {"type": {"state": "post", "shortDetail": "Final/OT"}, "period": 5},
                "competitions": [{
                    "competitors": [
                        {"homeAway": "home", "score": "33", "team": {"id": "12", "abbreviation": "KC", "displayName": "Kansas City Chiefs"}},
                        {"homeAway": "away", "score": "30", "team": {"id": "11", "abbreviation": "IND", "displayName": "Indianapolis Colts"}}
                    ]
                }]
            }]
        });
        overlay_scoreboard(&mut board, "401872945", &sliced);
        let games = espn::parse(&board.to_string(), "football/nfl").unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].state, "in");
        assert_eq!(games[0].detail, "3:11 - OT");
        assert_eq!(games[0].period, 5);
        assert_eq!(games[0].clock, "3:11");
        assert_eq!(games[0].home.score, Some(30));
        assert_eq!(games[0].away.score, Some(30));
        assert_eq!(games[0].ball_on, Some(32));
        assert_eq!(games[0].possession_team_id.as_deref(), Some("12"));
        assert_eq!(games[0].yards_to_endzone, Some(68));
        assert!(!games[0].red_zone);
        assert_eq!(games[0].down_distance.as_deref(), Some("1st & 10 at KC 32"));

        let mut missing = serde_json::json!({"events": []});
        overlay_scoreboard(&mut missing, "401872945", &sliced);
        let appended = espn::parse(&missing.to_string(), "football/nfl").unwrap();
        assert_eq!(appended.len(), 1);
        assert_eq!(appended[0].id, "401872945");
        assert_eq!(appended[0].state, "in");
        assert_eq!(appended[0].home.score, Some(30));
    }

    fn teams() -> Value {
        serde_json::json!([{
            "homeAway": "home",
            "score": "0",
            "team": {"id": "2", "abbreviation": "H", "displayName": "Home"}
        }, {
            "homeAway": "away",
            "score": "0",
            "team": {"id": "1", "abbreviation": "A", "displayName": "Away"}
        }])
    }

    #[test]
    fn board_overlay_carries_the_last_play_and_win_probability() {
        let summary = serde_json::json!({
            "header": {"id": "7", "competitions": [{"competitors": teams()}]},
            "drives": {"previous": [{
                "id": "d1",
                "team": {"id": "12"},
                "plays": [
                    {
                        "id": "1",
                        "wallclock": "2026-09-21T00:22:42Z",
                        "text": "Kickoff",
                        "type": {"text": "Kickoff"},
                        "awayScore": 0,
                        "homeScore": 0,
                        "scoringPlay": false,
                        "period": {"number": 1},
                        "clock": {"displayValue": "15:00"},
                        "end": {"down": 1, "distance": 10, "yardLine": 25, "yardsToEndzone": 75, "downDistanceText": "1st & 10"}
                    },
                    {
                        "id": "2",
                        "wallclock": "2026-09-21T00:23:42Z",
                        "text": "Pass complete for 7 yards",
                        "type": {"text": "Pass Reception", "alternativeText": "Catch"},
                        "awayScore": 0,
                        "homeScore": 7,
                        "scoringPlay": true,
                        "scoreValue": 7,
                        "period": {"number": 1},
                        "clock": {"displayValue": "10:00"},
                        "end": {"down": 1, "distance": 10, "yardLine": 18, "yardsToEndzone": 18, "downDistanceText": "1st & 10 at IND 18"}
                    }
                ]
            }]},
            "winprobability": [
                {"playId": "1", "homeWinPercentage": 0.5},
                {"playId": "2", "homeWinPercentage": 0.62},
                {"playId": "9", "homeWinPercentage": 0.9}
            ]
        });
        let sliced = slice_summary(&summary, 60.0, 1.0);
        assert_eq!(
            sliced["situation"]["lastPlay"]["text"],
            "Pass complete for 7 yards"
        );
        assert_eq!(sliced["situation"]["lastPlay"]["scoreValue"], 7);
        assert_eq!(
            sliced["situation"]["lastPlay"]["type"]["text"],
            "Pass Reception"
        );
        assert!(
            (sliced["situation"]["lastPlay"]["probability"]["homeWinPercentage"]
                .as_f64()
                .unwrap()
                - 0.62)
                .abs()
                < 1e-9
        );
        assert_eq!(sliced["situation"]["possession"], "12");
        assert_eq!(sliced["situation"]["isRedZone"], true);
        assert_eq!(sliced["situation"]["yardLine"], 18);
        assert_eq!(sliced["situation"]["yardsToEndzone"], 18);

        let mut board = serde_json::json!({
            "events": [{
                "id": "7",
                "date": "2026-09-21T00:20:00Z",
                "shortName": "A @ H",
                "status": {"type": {"state": "post", "shortDetail": "Final"}},
                "competitions": [{"competitors": teams()}]
            }]
        });
        overlay_scoreboard(&mut board, "7", &sliced);
        let games = espn::parse(&board.to_string(), "football/nfl").unwrap();
        assert_eq!(
            games[0].last_play.as_deref(),
            Some("Pass complete for 7 yards")
        );
        assert_eq!(games[0].last_play_type.as_deref(), Some("Catch"));
        assert_eq!(games[0].last_play_score, 7);
        let pct = games[0].home_win_pct.expect("home win pct");
        assert!((pct - 0.62).abs() < 1e-9);
        assert!(games[0].red_zone);
        assert_eq!(games[0].ball_on, Some(18));
        assert_eq!(games[0].yards_to_endzone, Some(18));
        assert_eq!(games[0].possession_team_id.as_deref(), Some("12"));
        assert_eq!(
            games[0].down_distance.as_deref(),
            Some("1st & 10 at IND 18")
        );
    }

    fn baseball_summary(plays: Value) -> Value {
        serde_json::json!({
            "header": {"id": "8", "competitions": [{"competitors": teams()}]},
            "plays": plays,
            "rosters": [{
                "homeAway": "home",
                "roster": [
                    {"athlete": {"id": "7", "displayName": "DJ Herz"}},
                    {"athlete": {"id": "8", "displayName": "Gleyber Torres"}},
                    {"athlete": {"id": "9", "displayName": "Hao-Yu Lee"}}
                ]
            }],
            "winprobability": [
                {"playId": "p1", "homeWinPercentage": 0.4},
                {"playId": "p2", "homeWinPercentage": 0.22}
            ]
        })
    }

    #[test]
    fn a_finished_at_bat_resets_the_count_and_the_batter() {
        let strikeout = baseball_summary(serde_json::json!([
            {
                "id": "p1",
                "wallclock": "2026-09-20T17:11:47Z",
                "text": "Pitch 4 : Strike 3 Swinging",
                "type": {"type": "strike-swinging", "text": "Strike Swinging"},
                "atBatId": "ab1",
                "awayScore": 0,
                "homeScore": 0,
                "resultCount": {"balls": 2, "strikes": 3},
                "outs": 0,
                "period": {"type": "Top", "number": 1},
                "participants": [
                    {"type": "pitcher", "athlete": {"id": "7"}},
                    {"type": "batter", "athlete": {"id": "8"}}
                ]
            }
        ]));
        let sliced = slice_summary_at(
            &strikeout,
            0.0,
            1.0,
            parse_replay_start("2026-09-20T17:11:47Z"),
        );
        assert_eq!(sliced["situation"]["balls"], 0);
        assert_eq!(sliced["situation"]["strikes"], 0);
        assert!(sliced["situation"]["batter"].is_null());
        assert_eq!(sliced["situation"]["pitcher"]["playerId"], 7);
        assert_eq!(
            sliced["situation"]["lastPlay"]["text"],
            "Pitch 4 : Strike 3 Swinging"
        );
        let parsed = detail::parse(&sliced.to_string(), "baseball/mlb").unwrap();
        assert_eq!(parsed.game.balls, Some(0));
        assert_eq!(parsed.game.strikes, Some(0));
        assert!(parsed.baseball.unwrap().batter.is_none());

        let with_next = baseball_summary(serde_json::json!([
            {
                "id": "p1",
                "wallclock": "2026-09-20T17:11:47Z",
                "text": "Torres struck out swinging.",
                "type": {"type": "play-result", "text": "Play Result"},
                "atBatId": "ab1",
                "awayScore": 0,
                "homeScore": 0,
                "resultCount": {"balls": 2, "strikes": 3},
                "outs": 1,
                "period": {"type": "Top", "number": 1},
                "participants": [
                    {"type": "pitcher", "athlete": {"id": "7"}},
                    {"type": "batter", "athlete": {"id": "8"}}
                ]
            },
            {
                "id": "p2",
                "wallclock": "2026-09-20T17:12:00Z",
                "text": "ignored",
                "type": {"type": "start-batterpitcher", "text": "Start Batter/Pitcher", "alternativeText": "Now at bat"},
                "atBatId": "ab2",
                "awayScore": 0,
                "homeScore": 0,
                "resultCount": {"balls": 0, "strikes": 0},
                "outs": 1,
                "period": {"type": "Top", "number": 1},
                "participants": [
                    {"type": "pitcher", "athlete": {"id": "7"}},
                    {"type": "batter", "athlete": {"id": "9"}}
                ]
            }
        ]));
        let live = slice_summary(&with_next, 13.0, 1.0);
        assert_eq!(live["situation"]["balls"], 0);
        assert_eq!(live["situation"]["strikes"], 0);
        assert_eq!(live["situation"]["outs"], 1);
        assert_eq!(live["situation"]["batter"]["playerId"], 9);
        assert_eq!(
            live["situation"]["lastPlay"]["text"],
            "DJ Herz pitches to Hao-Yu Lee"
        );
        assert_eq!(
            live["situation"]["lastPlay"]["type"]["alternativeText"],
            "Now at bat"
        );
        assert!(
            (live["situation"]["lastPlay"]["probability"]["homeWinPercentage"]
                .as_f64()
                .unwrap()
                - 0.22)
                .abs()
                < 1e-9
        );

        let mut board = serde_json::json!({
            "events": [{
                "id": "8",
                "date": "2026-09-20T17:00:00Z",
                "shortName": "A @ H",
                "status": {"type": {"state": "in", "shortDetail": "Top 1st"}},
                "competitions": [{"competitors": teams()}]
            }]
        });
        overlay_scoreboard(&mut board, "8", &live);
        let games = espn::parse(&board.to_string(), "baseball/mlb").unwrap();
        assert_eq!(games[0].balls, Some(0));
        assert_eq!(games[0].strikes, Some(0));
        assert_eq!(games[0].outs, Some(1));
        assert_eq!(
            games[0].last_play.as_deref(),
            Some("DJ Herz pitches to Hao-Yu Lee")
        );
        assert_eq!(games[0].last_play_type.as_deref(), Some("Now at bat"));
        let pct = games[0].home_win_pct.expect("home win pct");
        assert!((pct - 0.22).abs() < 1e-9);
    }

    #[test]
    fn replay_start_begins_at_that_wallclock() {
        let summary = serde_json::json!({
            "header": {"id": "7", "competitions": [{"competitors": teams()}]},
            "plays": [
                {
                    "id": "1",
                    "wallclock": "2026-09-20T17:00:00Z",
                    "text": "first",
                    "awayScore": 0,
                    "homeScore": 0,
                    "period": {"type": "Top", "number": 1},
                    "resultCount": {"balls": 0, "strikes": 1},
                    "outs": 0,
                    "participants": [
                        {"type": "pitcher", "athlete": {"id": "7"}},
                        {"type": "batter", "athlete": {"id": "8"}}
                    ]
                },
                {
                    "id": "2",
                    "wallclock": "2026-09-20T17:10:00Z",
                    "text": "second",
                    "awayScore": 1,
                    "homeScore": 0,
                    "period": {"type": "Top", "number": 2},
                    "resultCount": {"balls": 1, "strikes": 1},
                    "outs": 1,
                    "participants": [
                        {"type": "pitcher", "athlete": {"id": "7"}},
                        {"type": "batter", "athlete": {"id": "9"}}
                    ]
                }
            ],
            "rosters": [{
                "roster": [
                    {"athlete": {"id": "7", "displayName": "DJ Herz"}},
                    {"athlete": {"id": "8", "displayName": "Gleyber Torres"}},
                    {"athlete": {"id": "9", "displayName": "Hao-Yu Lee"}}
                ]
            }]
        });
        let start = parse_replay_start("2026-09-20T17:10:00Z").unwrap();
        let sliced = slice_summary_at(&summary, 0.0, 30.0, Some(start));
        assert_eq!(sliced["plays"].as_array().unwrap().len(), 2);
        assert_eq!(
            sliced["situation"]["lastPlay"]["text"],
            "DJ Herz pitches to Hao-Yu Lee"
        );
        let early = parse_replay_start("2026-09-20T16:00:00Z").unwrap();
        assert_eq!(
            slice_summary_at(&summary, 0.0, 1.0, Some(early))["header"]["competitions"][0]
                ["status"]["type"]["state"],
            "pre"
        );
        assert!(parse_replay_start("noon").is_none());
        assert!(parse_replay_start("  ").is_none());

        let started = parse_replay_start("2026-09-22T14:00:00Z").unwrap();
        let feed = ReplayFeed {
            inner: Arc::new(IdleFeed),
            games: vec![LoadedGame {
                league: "baseball/mlb".to_string(),
                event_id: "8".to_string(),
                summary,
            }],
            missed: Vec::new(),
            started_at: started,
            speed: 8.0,
            start_at: Some(start),
        };
        assert_eq!(
            feed.clock_sentence(started),
            format!(
                "Sports replay clock: {}.",
                crate::sports::format_rfc3339(start)
            )
        );
        let later = started + chrono::Duration::seconds(60);
        assert_eq!(
            feed.clock_sentence(later),
            format!(
                "Sports replay clock: {}.",
                crate::sports::format_rfc3339(start + chrono::Duration::seconds(480))
            )
        );
    }

    struct IdleFeed;

    impl ScoreFeed for IdleFeed {
        fn fetch<'a>(&'a self, _league: &'a str) -> FeedFut<'a> {
            Box::pin(async { Err(FeedError::Other("idle".to_string())) })
        }
    }
}
