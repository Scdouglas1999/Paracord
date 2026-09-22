//! Per-server sports add-on.
//!
//! ESPN's public scoreboard is fetched server-side into one process-wide cache.
//! Guild settings decide which leagues a server shows; heat and favorites are
//! applied when a member asks for the board.

mod detail;
mod espn;
mod heat;
mod models;
mod service;

pub use models::{
    format_rfc3339, league_catalog, league_label, AtBat, Athlete, BaseballDetail, Bases,
    BoardLeague, FavoriteTeam, FootballDetail, FootballDrive, FootballPlay, Game, GameDetail, Hit,
    LeagueCatalogEntry, LeagueTeams, Pitch, RosterTeam, ScoringPlay, SportsBoard, StrikeZone, Team,
    WinPoint, LEAGUE_CATALOG,
};
pub use service::{
    is_valid_event_id, is_valid_league_path, parse_leagues, scoreboard, scoreboard_url, FeedError,
    ScoreFeed, ScoreboardService, DEFAULT_LEAGUE_PATHS,
};
