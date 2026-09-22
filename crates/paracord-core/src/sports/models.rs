//! Wire shapes for the sports board. Field names are the REST contract.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::ser::Serializer;
use serde::Serialize;

/// ESPN `{sport}/{league}` paths offered in the settings picker.
/// F1 is omitted: its scoreboard is a different document shape.
pub const LEAGUE_CATALOG: &[LeagueCatalogEntry] = &[
    LeagueCatalogEntry {
        path: "football/nfl",
        label: "NFL",
        sport: "football",
    },
    LeagueCatalogEntry {
        path: "football/college-football",
        label: "College Football",
        sport: "football",
    },
    LeagueCatalogEntry {
        path: "basketball/nba",
        label: "NBA",
        sport: "basketball",
    },
    LeagueCatalogEntry {
        path: "basketball/wnba",
        label: "WNBA",
        sport: "basketball",
    },
    LeagueCatalogEntry {
        path: "basketball/mens-college-basketball",
        label: "Men's College Basketball",
        sport: "basketball",
    },
    LeagueCatalogEntry {
        path: "basketball/womens-college-basketball",
        label: "Women's College Basketball",
        sport: "basketball",
    },
    LeagueCatalogEntry {
        path: "baseball/mlb",
        label: "MLB",
        sport: "baseball",
    },
    LeagueCatalogEntry {
        path: "hockey/nhl",
        label: "NHL",
        sport: "hockey",
    },
    LeagueCatalogEntry {
        path: "soccer/usa.1",
        label: "MLS",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/eng.1",
        label: "Premier League",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/esp.1",
        label: "La Liga",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/ger.1",
        label: "Bundesliga",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/ita.1",
        label: "Serie A",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/fra.1",
        label: "Ligue 1",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/uefa.champions",
        label: "Champions League",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/usa.nwsl",
        label: "NWSL",
        sport: "soccer",
    },
    LeagueCatalogEntry {
        path: "soccer/mex.1",
        label: "Liga MX",
        sport: "soccer",
    },
];

#[derive(Debug, Clone, Copy, Serialize)]
pub struct LeagueCatalogEntry {
    pub path: &'static str,
    pub label: &'static str,
    pub sport: &'static str,
}

pub fn league_catalog() -> &'static [LeagueCatalogEntry] {
    LEAGUE_CATALOG
}

/// Catalog label, or the league segment in uppercase when the path is custom.
pub fn league_label(path: &str) -> String {
    LEAGUE_CATALOG
        .iter()
        .find(|entry| entry.path.eq_ignore_ascii_case(path))
        .map(|entry| entry.label.to_string())
        .unwrap_or_else(|| {
            path.rsplit_once('/')
                .map(|(_, league)| league)
                .unwrap_or(path)
                .to_ascii_uppercase()
        })
}

pub fn format_rfc3339(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn serialize_timestamp<S>(value: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&format_rfc3339(*value))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct FavoriteTeam {
    pub league: String,
    pub team_id: String,
    pub abbr: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SportsBoard {
    #[serde(serialize_with = "serialize_timestamp")]
    pub fetched_at: DateTime<Utc>,
    pub leagues: Vec<BoardLeague>,
    pub games: Vec<Game>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoardLeague {
    pub path: String,
    pub label: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Game {
    pub id: String,
    pub sport: String,
    /// Feed abbreviation, e.g. "NFL".
    pub league: String,
    pub league_path: String,
    pub name: String,
    #[serde(serialize_with = "serialize_timestamp")]
    pub start: DateTime<Utc>,
    pub state: String,
    pub detail: String,
    pub period: i32,
    pub clock: String,
    pub clock_seconds: f64,
    pub home: Team,
    pub away: Team,
    pub last_play: Option<String>,
    pub last_play_type: Option<String>,
    pub last_play_score: i32,
    pub down_distance: Option<String>,
    pub red_zone: bool,
    pub balls: Option<i32>,
    pub strikes: Option<i32>,
    pub outs: Option<i32>,
    pub on_first: bool,
    pub on_second: bool,
    pub on_third: bool,
    pub home_win_pct: Option<f64>,
    pub broadcasts: Vec<String>,
    pub heat: i32,
    pub tags: Vec<String>,
    pub favorite: bool,
}

impl Default for Game {
    fn default() -> Self {
        Self {
            id: String::new(),
            sport: String::new(),
            league: String::new(),
            league_path: String::new(),
            name: String::new(),
            start: DateTime::<Utc>::UNIX_EPOCH,
            state: "pre".to_string(),
            detail: String::new(),
            period: 0,
            clock: String::new(),
            clock_seconds: 0.0,
            home: Team::default(),
            away: Team::default(),
            last_play: None,
            last_play_type: None,
            last_play_score: 0,
            down_distance: None,
            red_zone: false,
            balls: None,
            strikes: None,
            outs: None,
            on_first: false,
            on_second: false,
            on_third: false,
            home_win_pct: None,
            broadcasts: Vec::new(),
            heat: 0,
            tags: Vec::new(),
            favorite: false,
        }
    }
}

/// A club on a league roster. Scores and records live on [`Team`] inside a game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RosterTeam {
    pub id: String,
    pub abbr: String,
    pub name: String,
    pub short_name: String,
    pub logo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeagueTeams {
    pub league: String,
    pub teams: Vec<RosterTeam>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Team {
    pub id: String,
    pub abbr: String,
    pub name: String,
    pub short_name: String,
    pub logo: String,
    pub score: Option<i32>,
    pub record: Option<String>,
    pub possession: bool,
    pub winner: bool,
}

/// One game's field detail. `football` or `baseball` is present only for that kind.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GameDetail {
    #[serde(serialize_with = "serialize_timestamp")]
    pub fetched_at: DateTime<Utc>,
    pub stale: bool,
    pub game: Game,
    pub kind: String,
    pub win_probability: Vec<WinPoint>,
    pub scoring_plays: Vec<ScoringPlay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub football: Option<FootballDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseball: Option<BaseballDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WinPoint {
    pub home_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScoringPlay {
    pub text: String,
    pub period: Option<i32>,
    pub clock: Option<String>,
    pub team_id: String,
    pub home_score: Option<i32>,
    pub away_score: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FootballDetail {
    pub possession_team_id: Option<String>,
    pub ball_on: Option<i32>,
    pub down: Option<i32>,
    pub distance: Option<i32>,
    pub yards_to_endzone: Option<i32>,
    pub down_distance_text: Option<String>,
    pub red_zone: Option<bool>,
    pub drives: Vec<FootballDrive>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FootballDrive {
    pub id: String,
    pub team_id: String,
    pub description: String,
    pub result: String,
    pub is_score: bool,
    pub start_yard: Option<i32>,
    pub end_yard: Option<i32>,
    pub live: bool,
    pub plays: Vec<FootballPlay>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FootballPlay {
    pub id: String,
    pub text: String,
    #[serde(rename = "type")]
    pub play_type: String,
    pub period: Option<i32>,
    pub clock: Option<String>,
    pub start_yard: Option<i32>,
    pub end_yard: Option<i32>,
    pub down: Option<i32>,
    pub distance: Option<i32>,
    pub yards: Option<i32>,
    pub scoring: bool,
    pub team_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BaseballDetail {
    pub inning: Option<i32>,
    pub half: Option<String>,
    pub balls: Option<i32>,
    pub strikes: Option<i32>,
    pub outs: Option<i32>,
    pub bases: Bases,
    pub pitcher: Option<Athlete>,
    pub batter: Option<Athlete>,
    pub bats: Option<String>,
    pub strike_zone: Option<StrikeZone>,
    pub at_bats: Vec<AtBat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Bases {
    pub first: Option<Athlete>,
    pub second: Option<Athlete>,
    pub third: Option<Athlete>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StrikeZone {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AtBat {
    pub id: String,
    pub inning: Option<i32>,
    pub half: Option<String>,
    pub batter: Option<Athlete>,
    pub pitcher: Option<Athlete>,
    pub result_text: String,
    pub scoring: bool,
    pub live: bool,
    pub pitches: Vec<Pitch>,
    pub hit: Option<Hit>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pitch {
    pub n: i32,
    pub x: Option<f64>,
    pub y: Option<f64>,
    #[serde(rename = "type")]
    pub pitch_type: String,
    pub type_abbr: String,
    pub velocity: Option<f64>,
    pub result: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    pub x: f64,
    pub y: f64,
    pub trajectory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Athlete {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub headshot: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nullable_fields_are_present_as_null() {
        let value = serde_json::to_value(Game::default()).unwrap();
        for key in [
            "last_play",
            "last_play_type",
            "down_distance",
            "balls",
            "strikes",
            "outs",
            "home_win_pct",
        ] {
            assert!(value[key].is_null(), "{key}");
        }
        assert!(value["home"]["score"].is_null());
        assert!(value["home"]["record"].is_null());
        assert_eq!(value["state"], "pre");
        assert_eq!(value["favorite"], false);
        assert_eq!(value["broadcasts"], serde_json::json!([]));
        assert_eq!(value["tags"], serde_json::json!([]));
        assert_eq!(value["start"], "1970-01-01T00:00:00Z");
    }

    #[test]
    fn catalog_covers_the_picker_and_skips_f1() {
        assert_eq!(LEAGUE_CATALOG.len(), 17);
        assert_eq!(LEAGUE_CATALOG[0].path, "football/nfl");
        assert!(LEAGUE_CATALOG
            .iter()
            .any(|entry| entry.path == "soccer/eng.1" && entry.label == "Premier League"));
        assert!(LEAGUE_CATALOG
            .iter()
            .all(|entry| entry.sport != "racing" && !entry.path.contains("f1")));
        assert_eq!(league_label("soccer/eng.1"), "Premier League");
        assert_eq!(league_label("football/xfl"), "XFL");
    }
}
