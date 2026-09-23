//! Tell a server's members when a favorite team's game has a score.
//!
//! A server opts in with `score_alerts`. The worker watches the leagues those
//! favorites play in, and sends `SPORTS_SCORE` to the server's members for each
//! score in a favorite's game and for its final. Each member's app decides
//! whether that becomes a notification. Nothing is stored: a restart picks up
//! from the current score.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use paracord_core::sports::{
    plan_alerts, scoreboard, AlertCursor, FavoriteTeam, Game, ScoreAlert, ScoreSnapshot,
};
use paracord_core::AppState;
use serde_json::{json, Value};

pub const SPORTS_SCORE_EVENT: &str = "SPORTS_SCORE";
const FORGET_AFTER: Duration = Duration::from_secs(12 * 60 * 60);

struct Watched {
    cursor: AlertCursor,
    seen: Instant,
}

fn cursors() -> &'static Mutex<HashMap<String, Watched>> {
    static CELL: OnceLock<Mutex<HashMap<String, Watched>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One game and the servers that want to hear about it.
struct Target {
    league: String,
    game: Game,
    /// Server id and the favorites of that server playing in this game.
    guilds: Vec<(i64, Vec<String>)>,
}

/// One pass. Safe to call on a timer.
pub async fn alert_due(state: &AppState) {
    let rows = match paracord_db::guild_sports::list_enabled_with_alerts(&state.db).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("sports score alerts could not be listed: {err}");
            return;
        }
    };
    let mut wanted: BTreeMap<String, Vec<(i64, Vec<FavoriteTeam>)>> = BTreeMap::new();
    for row in &rows {
        let followed: Vec<String> = serde_json::from_str(&row.leagues).unwrap_or_default();
        let favorites: Vec<FavoriteTeam> =
            serde_json::from_str(&row.favorite_teams).unwrap_or_default();
        let mut by_league: BTreeMap<String, Vec<FavoriteTeam>> = BTreeMap::new();
        for team in favorites {
            if followed
                .iter()
                .any(|league| league.eq_ignore_ascii_case(&team.league))
            {
                by_league
                    .entry(team.league.to_ascii_lowercase())
                    .or_default()
                    .push(team);
            }
        }
        for (league, teams) in by_league {
            wanted
                .entry(league)
                .or_default()
                .push((row.guild_id, teams));
        }
    }
    if wanted.is_empty() {
        forget_stale();
        return;
    }

    let leagues: Vec<String> = wanted.keys().cloned().collect();
    // Refreshes only the leagues whose cached board has gone past its own TTL.
    scoreboard().board(&leagues, &[]).await;

    let mut targets: BTreeMap<String, Target> = BTreeMap::new();
    for (league, guilds) in &wanted {
        let Some(cached) = scoreboard().cached_league(league) else {
            continue;
        };
        for game in cached.games {
            let mut interested = Vec::new();
            for (guild_id, teams) in guilds {
                let ids: Vec<String> = teams
                    .iter()
                    .filter(|team| team.team_id == game.home.id || team.team_id == game.away.id)
                    .map(|team| team.team_id.clone())
                    .collect();
                if !ids.is_empty() {
                    interested.push((*guild_id, ids));
                }
            }
            if interested.is_empty() {
                continue;
            }
            let key = format!("{league}/{}", game.id);
            targets.insert(
                key,
                Target {
                    league: league.clone(),
                    game,
                    guilds: interested,
                },
            );
        }
    }

    for (key, target) in targets {
        let alerts = step(&key, &target).await;
        for alert in alerts {
            for (guild_id, favorite_ids) in &target.guilds {
                state.event_bus.dispatch(
                    SPORTS_SCORE_EVENT,
                    alert_payload(*guild_id, &key, &target, favorite_ids, &alert),
                    Some(*guild_id),
                );
            }
        }
    }
    forget_stale();
}

/// Advance one game's cursor and return what is new.
async fn step(key: &str, target: &Target) -> Vec<ScoreAlert> {
    let game = &target.game;
    let home = game.home.score.unwrap_or(0);
    let away = game.away.score.unwrap_or(0);
    let known = {
        let mut map = lock();
        match map.get_mut(key) {
            Some(watched) => {
                watched.seen = Instant::now();
                Some(watched.cursor.clone())
            }
            None if game.state.eq_ignore_ascii_case("pre") => {
                map.insert(
                    key.to_string(),
                    Watched {
                        cursor: AlertCursor::pregame(),
                        seen: Instant::now(),
                    },
                );
                return Vec::new();
            }
            None => None,
        }
    };
    if game.state.eq_ignore_ascii_case("pre") {
        return Vec::new();
    }
    if let Some(cursor) = &known {
        if cursor.final_sent || !cursor.board_moved(home, away, &game.state) {
            return Vec::new();
        }
    }
    let detail = match scoreboard().detail(&target.league, &game.id, &[]).await {
        Ok(detail) => detail,
        Err(_) => return Vec::new(),
    };
    let (alerts, next) = plan_alerts(known.as_ref(), &ScoreSnapshot::from_detail(&detail));
    lock().insert(
        key.to_string(),
        Watched {
            cursor: next,
            seen: Instant::now(),
        },
    );
    alerts
}

fn alert_payload(
    guild_id: i64,
    key: &str,
    target: &Target,
    favorite_ids: &[String],
    alert: &ScoreAlert,
) -> Value {
    let game = &target.game;
    let team = |team: &paracord_core::sports::Team| {
        json!({
            "id": team.id,
            "abbr": team.abbr,
            "name": team.short_name,
            "score": team.score,
            "logo": team.logo,
        })
    };
    let favorites: BTreeSet<&String> = favorite_ids.iter().collect();
    json!({
        "guild_id": guild_id.to_string(),
        "game": key,
        "league_path": target.league,
        "event_id": game.id,
        "kind": alert.kind.as_str(),
        "content": alert.content,
        "team_id": alert.team_id,
        "favorite_team_ids": favorites,
        "home": team(&game.home),
        "away": team(&game.away),
    })
}

fn forget_stale() {
    let now = Instant::now();
    lock().retain(|_, watched| now.duration_since(watched.seen) < FORGET_AFTER);
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Watched>> {
    cursors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
