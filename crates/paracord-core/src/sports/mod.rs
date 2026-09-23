//! Per-server sports add-on.
//!
//! ESPN's public scoreboard is fetched server-side into one process-wide cache.
//! Guild settings decide which leagues a server shows; heat and favorites are
//! applied when a member asks for the board.

mod alerts;
mod announce;
mod detail;
mod espn;
mod heat;
mod models;
mod replay;
mod service;
mod standings;

pub use alerts::{plan_alerts, AlertCursor, AlertKind, ScoreAlert};
pub use announce::{plan_score_updates, AnnounceCursor, ScoreKind, ScoreSnapshot, ScoreUpdate};
pub use models::{
    format_rfc3339, league_catalog, league_label, AtBat, Athlete, BaseballDetail, Bases,
    BoardLeague, BoxRow, BoxScore, BoxTable, FavoriteTeam, FootballDetail, FootballDrive,
    FootballPlay, Game, GameDetail, Hit, Leader, LeagueCatalogEntry, LeagueTeams, LineScore,
    LineScoreTeam, Pitch, Probable, RosterTeam, ScoringPlay, SportsBoard, StrikeZone, Team,
    WinPoint, LEAGUE_CATALOG,
};
pub use replay::{parse_replay_games, parse_replay_start, ReplayGame};
pub use service::{
    install_sports_replay, is_valid_event_id, is_valid_league_path, parse_leagues, scoreboard,
    scoreboard_url, FeedError, ScoreFeed, ScoreboardService, StandingsUnavailable,
    DEFAULT_LEAGUE_PATHS,
};
pub use standings::{LeagueStandings, StandingsColumn, StandingsGroup, StandingsRow};
