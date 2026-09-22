//! Pull-through cache for ESPN scoreboards.
//!
//! Nothing is fetched until someone looks. Each league refreshes on its own
//! clock, one flight at a time, and a failed refresh keeps the last good games.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::task::Poll;
use std::time::Duration;

use chrono::{DateTime, Utc};

use super::detail;
use super::espn;
use super::heat;
use super::models::{
    league_label, BoardLeague, FavoriteTeam, Game, GameDetail, LeagueTeams, RosterTeam, SportsBoard,
};
use super::replay::{self, ReplayGame};

pub const DEFAULT_LEAGUE_PATHS: [&str; 2] = ["football/nfl", "baseball/mlb"];

const HOSTS: [&str; 2] = ["site.web.api.espn.com", "site.api.espn.com"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const SUMMARY_MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const LIVE_TTL: Duration = Duration::from_secs(12);
const SOON_TTL: Duration = Duration::from_secs(60);
const IDLE_TTL: Duration = Duration::from_secs(5 * 60);
const ERROR_TTL: Duration = Duration::from_secs(30);
const DETAIL_LIVE_TTL: Duration = Duration::from_secs(8);
const DETAIL_PRE_TTL: Duration = Duration::from_secs(60);
const DETAIL_POST_TTL: Duration = Duration::from_secs(10 * 60);
const CACHE_CAP: usize = 64;
const ROSTER_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const ROSTER_ERROR_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_PARSED_LEAGUES: usize = 16;

pub type FeedFut<'a> = Pin<Box<dyn Future<Output = Result<String, FeedError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedError {
    TimedOut,
    Status { host: String, code: u16 },
    Other(String),
}

impl FeedError {
    pub fn board_message(&self) -> String {
        match self {
            FeedError::TimedOut => "timed out".to_string(),
            FeedError::Status { host, code } => format!("{host} answered HTTP {code}"),
            FeedError::Other(message) => message.clone(),
        }
    }
}

/// One league's scoreboard or team-list JSON, or why this attempt failed.
pub trait ScoreFeed: Send + Sync {
    fn fetch<'a>(&'a self, league: &'a str) -> FeedFut<'a>;

    /// League roster JSON. Feeds that only serve scoreboards leave this as a failure.
    fn fetch_teams<'a>(&'a self, _league: &'a str) -> FeedFut<'a> {
        Box::pin(async { Err(FeedError::Other("this feed has no team list".to_string())) })
    }

    /// One game's summary JSON. Feeds that only serve scoreboards leave this as a failure.
    fn fetch_summary<'a>(&'a self, _league: &'a str, _event_id: &'a str) -> FeedFut<'a> {
        Box::pin(async {
            Err(FeedError::Other(
                "this feed has no game summary".to_string(),
            ))
        })
    }
}

pub struct ScoreboardService {
    feed: RwLock<Arc<dyn ScoreFeed>>,
    cache: Mutex<LruMap<LeagueCache>>,
    refresh: tokio::sync::Mutex<()>,
    rosters: Mutex<HashMap<String, RosterCache>>,
    roster_refresh: tokio::sync::Mutex<()>,
    details: Mutex<LruMap<DetailEntry>>,
    detail_flights: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    #[cfg(test)]
    clock: Mutex<Option<DateTime<Utc>>>,
}

/// Least-recently-used map. The front of `order` is the eviction candidate.
struct LruMap<T> {
    map: HashMap<String, T>,
    order: VecDeque<String>,
    cap: usize,
}

impl<T> LruMap<T> {
    fn new(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap,
        }
    }

    fn peek(&self, key: &str) -> Option<&T> {
        self.map.get(key)
    }

    fn touch(&mut self, key: &str) {
        if self.map.contains_key(key) {
            self.order.retain(|existing| existing != key);
            self.order.push_back(key.to_string());
        }
    }

    /// Inserts `value`. An existing key moves to most-recently used. A new key
    /// past `cap` evicts the least-recently used entries.
    fn insert(&mut self, key: String, value: T) -> Vec<String> {
        if self.map.contains_key(&key) {
            self.map.insert(key.clone(), value);
            self.order.retain(|existing| existing != &key);
            self.order.push_back(key);
            return Vec::new();
        }
        let mut evicted = Vec::new();
        while self.map.len() >= self.cap {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            if self.map.remove(&old).is_some() {
                evicted.push(old);
            }
        }
        self.map.insert(key.clone(), value);
        self.order.push_back(key);
        evicted
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

struct LeagueCache {
    games: Vec<Game>,
    fetched_at: DateTime<Utc>,
    ttl: Duration,
    error: Option<String>,
}

struct RosterCache {
    teams: Vec<RosterTeam>,
    fetched_at: DateTime<Utc>,
    ttl: Duration,
    error: Option<String>,
}

#[derive(Clone)]
struct DetailEntry {
    detail: Option<GameDetail>,
    fetched_at: DateTime<Utc>,
    ttl: Duration,
    error: Option<String>,
}

/// No successful roster is cached for this league.
#[derive(Debug)]
pub struct RosterUnavailable;

/// No successful game detail is cached for this event.
#[derive(Debug)]
pub struct DetailUnavailable;

pub(crate) fn production_feed() -> Result<Arc<dyn ScoreFeed>, FeedError> {
    Ok(Arc::new(EspnFeed::new()?))
}

/// Fetch the listed games once, then serve them time-sliced. Logged by the caller.
pub async fn install_sports_replay(
    games: Vec<ReplayGame>,
    speed: f64,
    start: Option<chrono::DateTime<chrono::Utc>>,
) {
    let inner = match production_feed() {
        Ok(feed) => feed,
        Err(error) => {
            tracing::warn!(
                "Sports replay is off: the scoreboard client did not start ({}).",
                error.board_message()
            );
            return;
        }
    };
    let feed = Arc::new(replay::ReplayFeed::load(inner, games, speed, Utc::now(), start).await);
    feed.spawn_clock();
    let message = feed.announcement();
    scoreboard().use_feed(feed);
    tracing::info!("{message}");
}

/// The process-wide board. One cache serves every guild on this instance.
pub fn scoreboard() -> &'static ScoreboardService {
    static CELL: OnceLock<ScoreboardService> = OnceLock::new();
    CELL.get_or_init(ScoreboardService::production)
}

/// A league board already in the cache, without starting a refresh.
pub struct CachedLeague {
    pub games: Vec<Game>,
    /// False when the only cached result is an error and there are no games.
    pub reliable: bool,
}

impl ScoreboardService {
    fn production() -> Self {
        let feed = match production_feed() {
            Ok(feed) => feed,
            Err(error) => Arc::new(FailingFeed { error }),
        };
        Self::with_feed(feed)
    }

    fn with_feed(feed: Arc<dyn ScoreFeed>) -> Self {
        Self {
            feed: RwLock::new(feed),
            cache: Mutex::new(LruMap::new(CACHE_CAP)),
            refresh: tokio::sync::Mutex::new(()),
            rosters: Mutex::new(HashMap::new()),
            roster_refresh: tokio::sync::Mutex::new(()),
            details: Mutex::new(LruMap::new(CACHE_CAP)),
            detail_flights: Mutex::new(HashMap::new()),
            #[cfg(test)]
            clock: Mutex::new(None),
        }
    }

    /// Test-only. Swaps the process-wide feed and drops cached boards,
    /// rosters, and game details so the next request hits the replacement.
    /// Production code does not call this.
    pub fn set_feed_for_tests(&self, feed: Arc<dyn ScoreFeed>) {
        *write_lock(&self.feed) = feed;
        lock(&self.cache).clear();
        lock(&self.rosters).clear();
        lock(&self.details).clear();
        lock(&self.detail_flights).clear();
    }

    /// Swap the process-wide feed. Startup uses this for the replay feed.
    pub fn use_feed(&self, feed: Arc<dyn ScoreFeed>) {
        *write_lock(&self.feed) = feed;
    }

    /// Games from the last refresh of `league`, if that refresh has happened.
    pub fn cached_league(&self, league: &str) -> Option<CachedLeague> {
        let cache = lock(&self.cache);
        let entry = cache.peek(&cache_key(league))?;
        Some(CachedLeague {
            reliable: entry.error.is_none() || !entry.games.is_empty(),
            games: entry.games.clone(),
        })
    }

    pub async fn board(&self, leagues: &[String], favorites: &[FavoriteTeam]) -> SportsBoard {
        self.refresh_stale(leagues).await;
        let now = self.now();
        let mut cache = lock(&self.cache);
        let mut games = Vec::new();
        let mut statuses = Vec::with_capacity(leagues.len());
        for path in leagues {
            let key = cache_key(path);
            cache.touch(&key);
            let entry = cache.peek(&key);
            statuses.push(BoardLeague {
                path: path.clone(),
                label: league_label(path),
                error: entry.and_then(|cached| cached.error.clone()),
            });
            if let Some(cached) = entry {
                for game in &cached.games {
                    let mut game = game.clone();
                    game.league_path = path.clone();
                    games.push(game);
                }
            }
        }
        drop(cache);

        for game in &mut games {
            mark_favorite(game, favorites);
            heat::apply(game, now);
        }
        sort_games(&mut games);
        SportsBoard {
            fetched_at: now,
            leagues: statuses,
            games,
        }
    }

    /// Sorted roster for one league. A failed refresh keeps the last good list.
    /// `Err` means nothing successful has been cached yet.
    pub async fn teams(&self, league: &str) -> Result<LeagueTeams, RosterUnavailable> {
        let league = league.trim().to_ascii_lowercase();
        if !is_valid_league_path(&league) {
            return Err(RosterUnavailable);
        }
        self.refresh_roster(&league).await;
        let cache = lock(&self.rosters);
        let Some(entry) = cache.get(&cache_key(&league)) else {
            return Err(RosterUnavailable);
        };
        if entry.error.is_some() && entry.teams.is_empty() {
            return Err(RosterUnavailable);
        }
        Ok(LeagueTeams {
            league,
            teams: entry.teams.clone(),
        })
    }

    /// One game's field. A failed refresh keeps the last good detail and marks
    /// it stale. `Err` means nothing successful has been cached yet.
    pub async fn detail(
        &self,
        league: &str,
        event_id: &str,
        favorites: &[FavoriteTeam],
    ) -> Result<GameDetail, DetailUnavailable> {
        let league = league.trim().to_ascii_lowercase();
        if !is_valid_league_path(&league) || !is_valid_event_id(event_id) {
            return Err(DetailUnavailable);
        }
        let key = detail_key(&league, event_id);
        self.refresh_detail(&key, &league, event_id).await;
        let now = self.now();
        let cached = {
            let mut cache = lock(&self.details);
            cache.touch(&key);
            cache.peek(&key).cloned()
        };
        let Some(entry) = cached else {
            return Err(DetailUnavailable);
        };
        let Some(mut detail) = entry.detail else {
            return Err(DetailUnavailable);
        };
        detail.stale = entry.error.is_some();
        detail.fetched_at = entry.fetched_at;
        mark_favorite(&mut detail.game, favorites);
        heat::apply(&mut detail.game, now);
        Ok(detail)
    }

    async fn refresh_detail(&self, key: &str, league: &str, event_id: &str) {
        if !self.detail_is_stale(key) {
            return;
        }
        let flight = self.detail_flight(key);
        let _guard = flight.lock().await;
        if !self.detail_is_stale(key) {
            return;
        }
        let now = self.now();
        let feed = read_lock(&self.feed).clone();
        match feed.fetch_summary(league, event_id).await {
            Ok(body) => match detail::parse(&body, league) {
                Ok(mut parsed) => {
                    let ttl = detail_ttl(&parsed.game.state);
                    parsed.fetched_at = now;
                    parsed.stale = false;
                    self.store_detail(
                        key,
                        DetailEntry {
                            detail: Some(parsed),
                            fetched_at: now,
                            ttl,
                            error: None,
                        },
                    );
                }
                Err(message) => {
                    tracing::warn!(league = %league, event_id, %message, "sports summary parse failed");
                    self.remember_detail_failure(key, now, message);
                }
            },
            Err(error) => {
                let message = error.board_message();
                tracing::warn!(league = %league, event_id, %message, "sports summary refresh failed");
                self.remember_detail_failure(key, now, message);
            }
        }
    }

    fn detail_flight(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut flights = lock(&self.detail_flights);
        flights
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn store_detail(&self, key: &str, entry: DetailEntry) {
        let evicted = lock(&self.details).insert(key.to_string(), entry);
        if evicted.is_empty() {
            return;
        }
        let mut flights = lock(&self.detail_flights);
        for old in evicted {
            flights.remove(&old);
        }
    }

    fn remember_detail_failure(&self, key: &str, now: DateTime<Utc>, message: String) {
        let previous = lock(&self.details)
            .peek(key)
            .and_then(|entry| entry.detail.clone());
        self.store_detail(
            key,
            DetailEntry {
                detail: previous,
                fetched_at: now,
                ttl: ERROR_TTL,
                error: Some(message),
            },
        );
    }

    fn detail_is_stale(&self, key: &str) -> bool {
        let now = self.now();
        match lock(&self.details).peek(key) {
            Some(entry) => expired(entry.fetched_at, entry.ttl, now),
            None => true,
        }
    }

    async fn refresh_roster(&self, league: &str) {
        if !self.roster_is_stale(league) {
            return;
        }
        let _guard = self.roster_refresh.lock().await;
        if !self.roster_is_stale(league) {
            return;
        }
        let now = self.now();
        let feed = read_lock(&self.feed).clone();
        match feed.fetch_teams(league).await {
            Ok(body) => match espn::parse_teams(&body) {
                Ok(teams) => {
                    lock(&self.rosters).insert(
                        cache_key(league),
                        RosterCache {
                            teams,
                            fetched_at: now,
                            ttl: ROSTER_TTL,
                            error: None,
                        },
                    );
                }
                Err(message) => {
                    tracing::warn!(league = %league, %message, "sports roster parse failed");
                    self.remember_roster_failure(league, now, message);
                }
            },
            Err(error) => {
                let message = error.board_message();
                tracing::warn!(league = %league, %message, "sports roster refresh failed");
                self.remember_roster_failure(league, now, message);
            }
        }
    }

    fn remember_roster_failure(&self, league: &str, now: DateTime<Utc>, message: String) {
        let mut cache = lock(&self.rosters);
        let key = cache_key(league);
        let teams = cache
            .get(&key)
            .map(|entry| entry.teams.clone())
            .unwrap_or_default();
        cache.insert(
            key,
            RosterCache {
                teams,
                fetched_at: now,
                ttl: ROSTER_ERROR_TTL,
                error: Some(message),
            },
        );
    }

    fn roster_is_stale(&self, league: &str) -> bool {
        let now = self.now();
        let cache = lock(&self.rosters);
        match cache.get(&cache_key(league)) {
            Some(entry) => expired(entry.fetched_at, entry.ttl, now),
            None => true,
        }
    }

    async fn refresh_stale(&self, leagues: &[String]) {
        if !self.any_stale(leagues) {
            return;
        }
        let _guard = self.refresh.lock().await;
        let now = self.now();
        let stale: Vec<String> = {
            let cache = lock(&self.cache);
            leagues
                .iter()
                .filter(|league| is_stale(cache.peek(&cache_key(league)), now))
                .cloned()
                .collect()
        };
        let mut flights: Vec<Pin<Box<dyn Future<Output = ()> + Send>>> = stale
            .into_iter()
            .map(|league| {
                Box::pin(self.refresh_one(league)) as Pin<Box<dyn Future<Output = ()> + Send>>
            })
            .collect();
        std::future::poll_fn(|cx| {
            let mut pending = false;
            let mut index = 0;
            while index < flights.len() {
                if flights[index].as_mut().poll(cx).is_ready() {
                    drop(flights.swap_remove(index));
                } else {
                    pending = true;
                    index += 1;
                }
            }
            if pending {
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        })
        .await;
    }

    async fn refresh_one(&self, league: String) {
        let now = self.now();
        if !is_valid_league_path(&league) {
            self.remember_failure(&league, now, "invalid league path".to_string());
            return;
        }
        let feed = read_lock(&self.feed).clone();
        let fetched = feed.fetch(&league).await;
        match fetched {
            Ok(body) => match espn::parse(&body, &league) {
                Ok(games) => {
                    let ttl = ttl_for(&games, now);
                    lock(&self.cache).insert(
                        cache_key(&league),
                        LeagueCache {
                            games,
                            fetched_at: now,
                            ttl,
                            error: None,
                        },
                    );
                }
                Err(message) => {
                    tracing::warn!(league = %league, %message, "sports scoreboard parse failed");
                    self.remember_failure(&league, now, message);
                }
            },
            Err(error) => {
                let message = error.board_message();
                tracing::warn!(league = %league, %message, "sports scoreboard refresh failed");
                self.remember_failure(&league, now, message);
            }
        }
    }

    fn remember_failure(&self, league: &str, now: DateTime<Utc>, message: String) {
        let key = cache_key(league);
        let games = lock(&self.cache)
            .peek(&key)
            .map(|entry| entry.games.clone())
            .unwrap_or_default();
        lock(&self.cache).insert(
            key,
            LeagueCache {
                games,
                fetched_at: now,
                ttl: ERROR_TTL,
                error: Some(message),
            },
        );
    }

    fn any_stale(&self, leagues: &[String]) -> bool {
        let now = self.now();
        let cache = lock(&self.cache);
        leagues
            .iter()
            .any(|league| is_stale(cache.peek(&cache_key(league)), now))
    }

    fn now(&self) -> DateTime<Utc> {
        #[cfg(test)]
        if let Some(fixed) = *lock(&self.clock) {
            return fixed;
        }
        Utc::now()
    }

    #[cfg(test)]
    fn set_now(&self, now: DateTime<Utc>) {
        *lock(&self.clock) = Some(now);
    }

    #[cfg(test)]
    fn cached_ttl(&self, league: &str) -> Option<Duration> {
        lock(&self.cache)
            .peek(&cache_key(league))
            .map(|entry| entry.ttl)
    }

    #[cfg(test)]
    fn cached_detail_ttl(&self, league: &str, event_id: &str) -> Option<Duration> {
        lock(&self.details)
            .peek(&detail_key(league, event_id))
            .map(|entry| entry.ttl)
    }

    #[cfg(test)]
    fn cached_roster_ttl(&self, league: &str) -> Option<Duration> {
        lock(&self.rosters)
            .get(&cache_key(league))
            .map(|entry| entry.ttl)
    }
}

fn mark_favorite(game: &mut Game, favorites: &[FavoriteTeam]) {
    game.favorite = favorites.iter().any(|favorite| {
        !favorite.team_id.is_empty()
            && favorite.league.eq_ignore_ascii_case(&game.league_path)
            && (favorite.team_id == game.home.id || favorite.team_id == game.away.id)
    });
}

fn sort_games(games: &mut [Game]) {
    games.sort_by(|left, right| {
        group(&left.state)
            .cmp(&group(&right.state))
            .then_with(|| match left.state.as_str() {
                "in" => right.heat.cmp(&left.heat),
                "pre" => left.start.cmp(&right.start),
                "post" => right.start.cmp(&left.start),
                _ => std::cmp::Ordering::Equal,
            })
    });
}

fn group(state: &str) -> u8 {
    match state {
        "in" => 0,
        "pre" => 1,
        "post" => 2,
        _ => 3,
    }
}

fn ttl_for(games: &[Game], now: DateTime<Utc>) -> Duration {
    if games.iter().any(|game| game.state == "in") {
        LIVE_TTL
    } else if games.iter().any(|game| {
        game.state == "pre" && game.start.signed_duration_since(now) < chrono::Duration::minutes(45)
    }) {
        SOON_TTL
    } else {
        IDLE_TTL
    }
}

fn is_stale(entry: Option<&LeagueCache>, now: DateTime<Utc>) -> bool {
    match entry {
        Some(entry) => expired(entry.fetched_at, entry.ttl, now),
        None => true,
    }
}

fn expired(fetched_at: DateTime<Utc>, ttl: Duration, now: DateTime<Utc>) -> bool {
    let Ok(ttl) = chrono::Duration::from_std(ttl) else {
        return true;
    };
    now.signed_duration_since(fetched_at) >= ttl
}

fn cache_key(league: &str) -> String {
    league.to_ascii_lowercase()
}

fn detail_key(league: &str, event_id: &str) -> String {
    format!("{}\n{event_id}", league.to_ascii_lowercase())
}

fn detail_ttl(state: &str) -> Duration {
    match state {
        "in" => DETAIL_LIVE_TTL,
        "pre" => DETAIL_PRE_TTL,
        _ => DETAIL_POST_TTL,
    }
}

/// An ESPN event id: 1 to 20 ASCII digits.
pub fn is_valid_event_id(event_id: &str) -> bool {
    (1..=20).contains(&event_id.len()) && event_id.bytes().all(|byte| byte.is_ascii_digit())
}

/// A path that is safe to interpolate into the scoreboard URL.
///
/// Exactly one `/`, ASCII letters, digits, `.`, and `-`, at most 48 characters.
/// Segments `.` and `..` are rejected so the path cannot climb out of `/sports/`.
pub fn is_valid_league_path(path: &str) -> bool {
    if path.len() > 48 || !path.is_ascii() {
        return false;
    }
    let Some((sport, league)) = path.split_once('/') else {
        return false;
    };
    if sport.is_empty()
        || league.is_empty()
        || league.contains('/')
        || matches!(sport, "." | "..")
        || matches!(league, "." | "..")
    {
        return false;
    }
    path.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '-'))
}

/// JellyTV `ParseLeagues`: blank config falls back to NFL and MLB, anything that
/// is not a single path segment is dropped, duplicates collapse, and the list
/// stops at 16. Guild settings validate more tightly (1 to 12) before this.
pub fn parse_leagues(configured: Option<&str>) -> Vec<String> {
    let Some(configured) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return DEFAULT_LEAGUE_PATHS
            .iter()
            .map(|path| (*path).to_string())
            .collect();
    };
    let mut leagues = Vec::new();
    for raw in configured.split([',', '\n', ' ']) {
        let league = raw.trim();
        if league.is_empty() || !is_valid_league_path(league) {
            continue;
        }
        if leagues
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(league))
        {
            continue;
        }
        leagues.push(league.to_string());
        if leagues.len() == MAX_PARSED_LEAGUES {
            break;
        }
    }
    leagues
}

pub fn teams_url(host: &str, league: &str) -> String {
    format!("https://{host}/apis/site/v2/sports/{league}/teams?limit=1000")
}

/// Summary URL for one of the two fixed hosts. Any other host, including
/// `$ref` targets on `sports.core.api.espn.pvt`, is `None` and is never requested.
pub fn summary_url(host: &str, league: &str, event_id: &str) -> Option<String> {
    if !HOSTS.contains(&host) || !is_valid_league_path(league) || !is_valid_event_id(event_id) {
        return None;
    }
    Some(format!(
        "https://{host}/apis/site/v2/sports/{league}/summary?event={event_id}"
    ))
}

pub fn scoreboard_url(host: &str, league: &str) -> String {
    let lower = league.to_ascii_lowercase();
    let query = if lower.ends_with("/college-football") {
        "?groups=80&limit=300"
    } else if lower.ends_with("college-basketball") {
        "?groups=50&limit=300"
    } else {
        ""
    };
    format!("https://{host}/apis/site/v2/sports/{league}/scoreboard{query}")
}

pub(crate) fn user_agent() -> String {
    format!("Paracord/{}", env!("CARGO_PKG_VERSION"))
}

struct EspnFeed {
    client: reqwest::Client,
}

impl EspnFeed {
    fn new() -> Result<Self, FeedError> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .user_agent(user_agent())
            .build()
            .map_err(|err| FeedError::Other(format!("failed to build scoreboard client: {err}")))?;
        Ok(Self { client })
    }
}

impl ScoreFeed for EspnFeed {
    fn fetch<'a>(&'a self, league: &'a str) -> FeedFut<'a> {
        let league = league.to_string();
        let client = self.client.clone();
        Box::pin(async move { fetch_league(&client, &league).await })
    }

    fn fetch_teams<'a>(&'a self, league: &'a str) -> FeedFut<'a> {
        let league = league.to_string();
        let client = self.client.clone();
        Box::pin(async move { fetch_teams_body(&client, &league).await })
    }

    fn fetch_summary<'a>(&'a self, league: &'a str, event_id: &'a str) -> FeedFut<'a> {
        let league = league.to_string();
        let event_id = event_id.to_string();
        let client = self.client.clone();
        Box::pin(async move { fetch_summary_body(&client, &league, &event_id).await })
    }
}

async fn fetch_league(client: &reqwest::Client, league: &str) -> Result<String, FeedError> {
    if !is_valid_league_path(league) {
        return Err(FeedError::Other("invalid league path".to_string()));
    }
    fetch_on_hosts(
        client,
        |host| Some(scoreboard_url(host, league)),
        MAX_BODY_BYTES,
        "scoreboard response exceeded 4 MiB",
        "no scoreboard host answered",
    )
    .await
}

async fn fetch_teams_body(client: &reqwest::Client, league: &str) -> Result<String, FeedError> {
    if !is_valid_league_path(league) {
        return Err(FeedError::Other("invalid league path".to_string()));
    }
    fetch_on_hosts(
        client,
        |host| Some(teams_url(host, league)),
        MAX_BODY_BYTES,
        "scoreboard response exceeded 4 MiB",
        "no teams host answered",
    )
    .await
}

async fn fetch_summary_body(
    client: &reqwest::Client,
    league: &str,
    event_id: &str,
) -> Result<String, FeedError> {
    if !is_valid_league_path(league) || !is_valid_event_id(event_id) {
        return Err(FeedError::Other("invalid summary path".to_string()));
    }
    fetch_on_hosts(
        client,
        |host| summary_url(host, league, event_id),
        SUMMARY_MAX_BODY_BYTES,
        "summary response exceeded 8 MiB",
        "no summary host answered",
    )
    .await
}

async fn fetch_on_hosts(
    client: &reqwest::Client,
    url_for: impl Fn(&str) -> Option<String>,
    limit: usize,
    too_big: &'static str,
    empty: &str,
) -> Result<String, FeedError> {
    let mut last_error = FeedError::Other(empty.to_string());
    for host in HOSTS {
        let Some(url) = url_for(host) else {
            continue;
        };
        if !request_url_is_allowed(&url) {
            last_error =
                FeedError::Other("refused a request outside the two scoreboard hosts".to_string());
            continue;
        }
        match client
            .get(&url)
            .header(reqwest::header::USER_AGENT, user_agent())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match read_capped(response, limit, too_big).await {
                    Ok(body) => return Ok(body),
                    Err(FeedError::TimedOut) => return Err(FeedError::TimedOut),
                    Err(error) => last_error = error,
                }
            }
            Ok(response) => {
                last_error = FeedError::Status {
                    host: host.to_string(),
                    code: response.status().as_u16(),
                };
            }
            Err(error) if error.is_timeout() => return Err(FeedError::TimedOut),
            Err(error) => last_error = FeedError::Other(error.to_string()),
        }
    }
    Err(last_error)
}

/// True only for https URLs whose host is one of the two fixed ESPN hosts.
fn request_url_is_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let Some((host, _)) = rest.split_once('/') else {
        return false;
    };
    HOSTS.contains(&host)
}

async fn read_capped(
    mut response: reqwest::Response,
    limit: usize,
    too_big: &'static str,
) -> Result<String, FeedError> {
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(FeedError::Other(too_big.to_string()));
    }
    let mut body = Vec::new();
    loop {
        let chunk = match response.chunk().await {
            Ok(chunk) => chunk,
            Err(error) if error.is_timeout() => return Err(FeedError::TimedOut),
            Err(error) => return Err(FeedError::Other(error.to_string())),
        };
        let Some(chunk) = chunk else {
            break;
        };
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(FeedError::Other(too_big.to_string()));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body)
        .map_err(|_| FeedError::Other("scoreboard response was not valid UTF-8".to_string()))
}

struct FailingFeed {
    error: FeedError,
}

impl ScoreFeed for FailingFeed {
    fn fetch<'a>(&'a self, _league: &'a str) -> FeedFut<'a> {
        let error = self.error.clone();
        Box::pin(async move { Err(error) })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use chrono::{DateTime, TimeZone, Utc};
    use tokio::sync::watch;

    use super::super::models::FavoriteTeam;
    use super::{
        is_valid_event_id, is_valid_league_path, parse_leagues, request_url_is_allowed,
        scoreboard_url, summary_url, teams_url, user_agent, FeedError, ScoreFeed,
        ScoreboardService, CACHE_CAP, DEFAULT_LEAGUE_PATHS, DETAIL_LIVE_TTL, DETAIL_POST_TTL,
        DETAIL_PRE_TTL, ERROR_TTL, HOSTS, IDLE_TTL, LIVE_TTL, MAX_BODY_BYTES, REQUEST_TIMEOUT,
        ROSTER_ERROR_TTL, ROSTER_TTL, SOON_TTL, SUMMARY_MAX_BODY_BYTES,
    };

    fn at(hour: u32, minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 20, hour, minute, 0).unwrap()
    }

    fn event(id: &str, state: &str, start: &str) -> String {
        format!(
            r#"{{"id":"{id}","date":"{start}","shortName":"A @ H","status":{{"type":{{"state":"{state}"}}}},"competitions":[{{"competitors":[{{"homeAway":"home","score":"0","team":{{"id":"1","abbreviation":"H","displayName":"Home"}}}},{{"homeAway":"away","score":"0","team":{{"id":"2","abbreviation":"A","displayName":"Away"}}}}]}}]}}"#
        )
    }

    fn board_with(events: &str) -> String {
        format!(r#"{{"events":[{events}]}}"#)
    }

    struct CountingFeed {
        body: Mutex<Result<String, FeedError>>,
        calls: AtomicUsize,
    }

    impl ScoreFeed for CountingFeed {
        fn fetch<'a>(&'a self, _league: &'a str) -> super::FeedFut<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let body = self
                .body
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            Box::pin(async move { body })
        }
    }

    async fn assert_ttl(body: Result<String, FeedError>, expected: std::time::Duration) {
        let calls = AtomicUsize::new(0);
        let feed = Arc::new(CountingFeed {
            body: Mutex::new(body),
            calls,
        });
        // CountingFeed's counter is inside the feed; reach it through a side channel.
        let seen = Arc::new(AtomicUsize::new(0));
        let wrapped = Arc::new(CountWrap {
            inner: feed,
            seen: seen.clone(),
        });
        let service = ScoreboardService::with_feed(wrapped);
        let start = at(20, 0);
        service.set_now(start);
        let leagues = vec!["football/nfl".to_string()];
        service.board(&leagues, &[]).await;
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        assert_eq!(service.cached_ttl("football/nfl"), Some(expected));

        let within = expected.saturating_sub(std::time::Duration::from_secs(1));
        service.set_now(start + chrono::Duration::from_std(within).unwrap());
        service.board(&leagues, &[]).await;
        assert_eq!(seen.load(Ordering::SeqCst), 1);

        service.set_now(start + chrono::Duration::from_std(expected).unwrap());
        service.board(&leagues, &[]).await;
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    struct CountWrap {
        inner: Arc<CountingFeed>,
        seen: Arc<AtomicUsize>,
    }

    impl ScoreFeed for CountWrap {
        fn fetch<'a>(&'a self, league: &'a str) -> super::FeedFut<'a> {
            self.seen.fetch_add(1, Ordering::SeqCst);
            self.inner.fetch(league)
        }
    }

    #[tokio::test]
    async fn live_board_refreshes_every_twelve_seconds() {
        assert_ttl(
            Ok(board_with(&event("1", "in", "2026-09-20T20:00:00Z"))),
            LIVE_TTL,
        )
        .await;
    }

    #[tokio::test]
    async fn imminent_board_refreshes_every_minute() {
        assert_ttl(
            Ok(board_with(&event("1", "pre", "2026-09-20T20:30:00Z"))),
            SOON_TTL,
        )
        .await;
    }

    #[tokio::test]
    async fn idle_board_refreshes_every_five_minutes() {
        assert_ttl(
            Ok(board_with(&event("1", "pre", "2026-09-20T23:30:00Z"))),
            IDLE_TTL,
        )
        .await;
    }

    #[tokio::test]
    async fn error_retries_after_thirty_seconds_and_keeps_last_good_games() {
        let seen = Arc::new(AtomicUsize::new(0));
        let script = Arc::new(Mutex::new(Ok(board_with(&event(
            "7",
            "post",
            "2026-09-20T18:00:00Z",
        )))));
        let service = ScoreboardService::with_feed(Arc::new(ScriptFeed {
            script: script.clone(),
            seen: seen.clone(),
        }));
        let start = at(20, 0);
        service.set_now(start);
        let leagues = vec!["baseball/mlb".to_string()];
        let first = service.board(&leagues, &[]).await;
        assert_eq!(first.games.len(), 1);
        assert!(first.leagues[0].error.is_none());

        *script.lock().unwrap() = Err(FeedError::TimedOut);
        service.set_now(start + chrono::Duration::minutes(10));
        let failed = service.board(&leagues, &[]).await;
        assert_eq!(failed.games.len(), 1);
        assert_eq!(failed.games[0].id, "7");
        assert_eq!(failed.leagues[0].error.as_deref(), Some("timed out"));
        assert_eq!(service.cached_ttl("baseball/mlb"), Some(ERROR_TTL));
        assert_eq!(seen.load(Ordering::SeqCst), 2);

        service.set_now(start + chrono::Duration::minutes(10) + chrono::Duration::seconds(29));
        service.board(&leagues, &[]).await;
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalid_json_keeps_the_previous_games() {
        let script = Arc::new(Mutex::new(Ok(board_with(&event(
            "9",
            "post",
            "2026-09-20T18:00:00Z",
        )))));
        let service = ScoreboardService::with_feed(Arc::new(ScriptFeed {
            script: script.clone(),
            seen: Arc::new(AtomicUsize::new(0)),
        }));
        let start = at(20, 0);
        service.set_now(start);
        let leagues = vec!["hockey/nhl".to_string()];
        service.board(&leagues, &[]).await;
        *script.lock().unwrap() = Ok("not json".to_string());
        service.set_now(start + chrono::Duration::minutes(10));
        let board = service.board(&leagues, &[]).await;
        assert_eq!(board.games.len(), 1);
        assert_eq!(board.games[0].id, "9");
        assert_eq!(
            board.leagues[0].error.as_deref(),
            Some("invalid scoreboard json")
        );
    }

    #[tokio::test]
    async fn one_league_can_fail_without_dropping_the_other() {
        let service = ScoreboardService::with_feed(Arc::new(SplitFeed));
        let leagues = vec!["football/nfl".to_string(), "baseball/mlb".to_string()];
        let board = service.board(&leagues, &[]).await;
        assert_eq!(board.games.len(), 1);
        assert_eq!(board.games[0].league_path, "football/nfl");
        assert_eq!(board.leagues[0].error, None);
        assert_eq!(board.leagues[0].label, "NFL");
        assert_eq!(board.leagues[1].path, "baseball/mlb");
        assert_eq!(
            board.leagues[1].error.as_deref(),
            Some("site.web.api.espn.com answered HTTP 503")
        );
    }

    struct SplitFeed;

    impl ScoreFeed for SplitFeed {
        fn fetch<'a>(&'a self, league: &'a str) -> super::FeedFut<'a> {
            let league = league.to_ascii_lowercase();
            Box::pin(async move {
                if league == "baseball/mlb" {
                    Err(FeedError::Status {
                        host: "site.web.api.espn.com".to_string(),
                        code: 503,
                    })
                } else {
                    Ok(board_with(&event("1", "post", "2026-09-20T18:00:00Z")))
                }
            })
        }
    }

    struct ScriptFeed {
        script: Arc<Mutex<Result<String, FeedError>>>,
        seen: Arc<AtomicUsize>,
    }

    impl ScoreFeed for ScriptFeed {
        fn fetch<'a>(&'a self, _league: &'a str) -> super::FeedFut<'a> {
            self.seen.fetch_add(1, Ordering::SeqCst);
            let body = self
                .script
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            Box::pin(async move { body })
        }
    }

    #[tokio::test]
    async fn concurrent_viewers_share_one_refresh() {
        let (tx, rx) = watch::channel(false);
        let calls = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(ScoreboardService::with_feed(Arc::new(GateFeed {
            calls: calls.clone(),
            release: rx,
            body: board_with(&event("1", "in", "2026-09-20T20:00:00Z")),
        })));
        let leagues = vec!["football/nfl".to_string()];
        let left = {
            let service = service.clone();
            let leagues = leagues.clone();
            tokio::spawn(async move { service.board(&leagues, &[]).await })
        };
        let right = {
            let service = service.clone();
            tokio::spawn(async move { service.board(&leagues, &[]).await })
        };

        let started = std::time::Instant::now();
        while calls.load(Ordering::SeqCst) == 0 {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "fetch did not start"
            );
            tokio::task::yield_now().await;
        }
        let observed = std::time::Instant::now();
        while observed.elapsed() < std::time::Duration::from_millis(300) {
            assert_eq!(calls.load(Ordering::SeqCst), 1, "single-flight was broken");
            tokio::task::yield_now().await;
        }
        tx.send(true).unwrap();
        let (left, right) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(left, right)
        })
        .await
        .expect("board calls finished");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(left.unwrap().games.len(), 1);
        assert_eq!(right.unwrap().games.len(), 1);
    }

    struct GateFeed {
        calls: Arc<AtomicUsize>,
        release: watch::Receiver<bool>,
        body: String,
    }

    impl ScoreFeed for GateFeed {
        fn fetch<'a>(&'a self, _league: &'a str) -> super::FeedFut<'a> {
            let calls = self.calls.clone();
            let mut release = self.release.clone();
            let body = self.body.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                let _ = release.wait_for(|open| *open).await;
                Ok(body)
            })
        }
    }

    #[tokio::test]
    async fn board_sorts_live_then_upcoming_then_finished() {
        let live = event("live", "in", "2026-09-20T20:00:00Z");
        let soon = event("soon", "pre", "2026-09-21T01:00:00Z");
        let later = event("later", "pre", "2026-09-21T05:00:00Z");
        let older = event("older", "post", "2026-09-19T18:00:00Z");
        let newer = event("newer", "post", "2026-09-20T18:00:00Z");
        let body = board_with(&format!("{newer},{soon},{live},{older},{later}"));
        let service = ScoreboardService::with_feed(Arc::new(CountingFeed {
            body: Mutex::new(Ok(body)),
            calls: AtomicUsize::new(0),
        }));
        service.set_now(at(12, 0));
        let board = service.board(&["football/nfl".to_string()], &[]).await;
        let ids: Vec<_> = board.games.iter().map(|game| game.id.as_str()).collect();
        assert_eq!(ids, ["live", "soon", "later", "newer", "older"]);
    }

    #[tokio::test]
    async fn favorites_are_flagged_for_either_side() {
        let service = ScoreboardService::with_feed(Arc::new(CountingFeed {
            body: Mutex::new(Ok(board_with(&event("1", "post", "2026-09-20T18:00:00Z")))),
            calls: AtomicUsize::new(0),
        }));
        let favorites = vec![FavoriteTeam {
            league: "Football/NFL".to_string(),
            team_id: "2".to_string(),
            abbr: "A".to_string(),
            name: "Away".to_string(),
        }];
        let board = service
            .board(&["football/nfl".to_string()], &favorites)
            .await;
        assert!(board.games[0].favorite);
    }

    #[test]
    fn scoreboard_url_is_host_plus_league_path() {
        assert_eq!(
            scoreboard_url("site.web.api.espn.com", "football/nfl"),
            "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
        );
        assert_eq!(
            teams_url("site.web.api.espn.com", "football/nfl"),
            "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=1000"
        );
    }

    #[test]
    fn college_boards_ask_for_every_game_not_just_ranked_teams() {
        assert!(scoreboard_url("h", "football/college-football")
            .ends_with("/football/college-football/scoreboard?groups=80&limit=300"));
        assert!(scoreboard_url("h", "basketball/mens-college-basketball")
            .ends_with("/basketball/mens-college-basketball/scoreboard?groups=50&limit=300"));
        assert!(scoreboard_url("h", "basketball/womens-college-basketball")
            .ends_with("?groups=50&limit=300"));
        let mixed = scoreboard_url("h", "Football/College-Football");
        assert!(mixed.contains("/Football/College-Football/scoreboard?groups=80&limit=300"));
    }

    #[test]
    fn league_config_falls_back_to_defaults_and_rejects_anything_not_a_path() {
        assert_eq!(
            parse_leagues(None),
            DEFAULT_LEAGUE_PATHS
                .iter()
                .map(|path| (*path).to_string())
                .collect::<Vec<_>>()
        );
        assert!(parse_leagues(Some("  ")).contains(&"football/nfl".to_string()));
        assert_eq!(
            parse_leagues(Some(
                "football/nfl, soccer/eng.1\nfootball/nfl, ../../etc/passwd, nfl, a/b?x=1"
            )),
            vec!["football/nfl".to_string(), "soccer/eng.1".to_string()]
        );
    }

    #[test]
    fn league_paths_reject_traversal_and_overlong_segments() {
        assert!(is_valid_league_path("soccer/eng.1"));
        assert!(!is_valid_league_path("foo/.."));
        assert!(!is_valid_league_path("foo/."));
        assert!(!is_valid_league_path("nfl"));
        let ok = format!("soccer/{}", "a".repeat(41));
        assert_eq!(ok.len(), 48);
        assert!(is_valid_league_path(&ok));
        assert!(!is_valid_league_path(&format!("soccer/{}", "a".repeat(42))));
        let many = (0..20)
            .map(|index| format!("soccer/l{index:02}"))
            .collect::<Vec<_>>()
            .join(",");
        let parsed = parse_leagues(Some(&many));
        assert_eq!(parsed.len(), 16);
        assert_eq!(parsed[0], "soccer/l00");
        assert_eq!(parsed[15], "soccer/l15");
    }

    #[test]
    fn hosts_timeout_and_user_agent_match_the_contract() {
        assert_eq!(HOSTS, ["site.web.api.espn.com", "site.api.espn.com"]);
        assert_eq!(REQUEST_TIMEOUT, std::time::Duration::from_secs(15));
        assert_eq!(MAX_BODY_BYTES, 4 * 1024 * 1024);
        assert_eq!(
            user_agent(),
            format!("Paracord/{}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn production_client_builds_without_touching_the_network() {
        super::EspnFeed::new().expect("scoreboard client should build");
    }

    const TWO_TEAMS: &str = r#"{"sports":[{"leagues":[{"teams":[
        {"team":{"id":"12","abbreviation":"KC","displayName":"Kansas City Chiefs","shortDisplayName":"Chiefs"}},
        {"team":{"id":"2","abbreviation":"BUF","displayName":"Buffalo Bills","shortDisplayName":"Bills"}}
    ]}]}]}"#;

    struct RosterScript {
        script: Arc<Mutex<Result<String, FeedError>>>,
        seen: Arc<AtomicUsize>,
    }

    impl ScoreFeed for RosterScript {
        fn fetch<'a>(&'a self, _league: &'a str) -> super::FeedFut<'a> {
            Box::pin(async { Err(FeedError::Other("scoreboard unused".to_string())) })
        }

        fn fetch_teams<'a>(&'a self, _league: &'a str) -> super::FeedFut<'a> {
            self.seen.fetch_add(1, Ordering::SeqCst);
            let body = self
                .script
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            Box::pin(async move { body })
        }
    }

    fn roster_service(
        script: Arc<Mutex<Result<String, FeedError>>>,
        seen: Arc<AtomicUsize>,
    ) -> ScoreboardService {
        ScoreboardService::with_feed(Arc::new(RosterScript { script, seen }))
    }

    #[tokio::test]
    async fn roster_refreshes_once_a_day() {
        let seen = Arc::new(AtomicUsize::new(0));
        let service = roster_service(
            Arc::new(Mutex::new(Ok(TWO_TEAMS.to_string()))),
            seen.clone(),
        );
        let start = at(20, 0);
        service.set_now(start);
        let roster = service.teams("football/nfl").await.unwrap();
        assert_eq!(roster.league, "football/nfl");
        assert_eq!(roster.teams[0].name, "Buffalo Bills");
        assert_eq!(roster.teams[1].name, "Kansas City Chiefs");
        assert_eq!(service.cached_roster_ttl("football/nfl"), Some(ROSTER_TTL));
        assert_eq!(seen.load(Ordering::SeqCst), 1);

        let within = ROSTER_TTL.saturating_sub(std::time::Duration::from_secs(1));
        service.set_now(start + chrono::Duration::from_std(within).unwrap());
        service.teams("Football/NFL").await.unwrap();
        assert_eq!(seen.load(Ordering::SeqCst), 1);

        service.set_now(start + chrono::Duration::from_std(ROSTER_TTL).unwrap());
        service.teams("football/nfl").await.unwrap();
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn roster_failure_keeps_the_last_good_list_for_thirty_minutes() {
        let seen = Arc::new(AtomicUsize::new(0));
        let script = Arc::new(Mutex::new(Ok(TWO_TEAMS.to_string())));
        let service = roster_service(script.clone(), seen.clone());
        let start = at(20, 0);
        service.set_now(start);
        assert_eq!(service.teams("football/nfl").await.unwrap().teams.len(), 2);

        *script.lock().unwrap() = Err(FeedError::TimedOut);
        service.set_now(start + chrono::Duration::from_std(ROSTER_TTL).unwrap());
        let kept = service.teams("football/nfl").await.unwrap();
        assert_eq!(kept.teams[0].abbr, "BUF");
        assert_eq!(
            service.cached_roster_ttl("football/nfl"),
            Some(ROSTER_ERROR_TTL)
        );
        assert_eq!(seen.load(Ordering::SeqCst), 2);

        let failed_at = start + chrono::Duration::from_std(ROSTER_TTL).unwrap();
        service.set_now(failed_at + chrono::Duration::minutes(29));
        service.teams("football/nfl").await.unwrap();
        assert_eq!(seen.load(Ordering::SeqCst), 2);

        *script.lock().unwrap() = Ok("not json".to_string());
        service.set_now(failed_at + chrono::Duration::minutes(30));
        let still = service.teams("football/nfl").await.unwrap();
        assert_eq!(still.teams.len(), 2);
        assert_eq!(still.teams[1].id, "12");
        assert_eq!(seen.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn roster_failure_with_nothing_cached_is_an_error_and_backs_off() {
        let seen = Arc::new(AtomicUsize::new(0));
        let service = roster_service(
            Arc::new(Mutex::new(Err(FeedError::Status {
                host: "site.web.api.espn.com".to_string(),
                code: 503,
            }))),
            seen.clone(),
        );
        let start = at(20, 0);
        service.set_now(start);
        assert!(service.teams("baseball/mlb").await.is_err());
        assert_eq!(
            service.cached_roster_ttl("baseball/mlb"),
            Some(ROSTER_ERROR_TTL)
        );
        service.set_now(start + chrono::Duration::minutes(29));
        assert!(service.teams("baseball/mlb").await.is_err());
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        service.set_now(start + chrono::Duration::minutes(30));
        assert!(service.teams("baseball/mlb").await.is_err());
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    fn tiny_summary(state: &str) -> String {
        format!(
            r#"{{"header":{{"id":"42","league":{{"abbreviation":"NFL"}},"competitions":[{{"date":"2026-09-20T20:00:00Z","competitors":[{{"homeAway":"home","score":"1","team":{{"id":"1","abbreviation":"H","displayName":"Home"}}}},{{"homeAway":"away","score":"0","team":{{"id":"2","abbreviation":"A","displayName":"Away"}}}}],"status":{{"type":{{"state":"{state}","shortDetail":"Q"}}}}}}]}}}}"#
        )
    }

    struct SummaryScript {
        script: Arc<Mutex<Result<String, FeedError>>>,
        seen: Arc<AtomicUsize>,
    }

    impl ScoreFeed for SummaryScript {
        fn fetch<'a>(&'a self, _league: &'a str) -> super::FeedFut<'a> {
            Box::pin(async { Err(FeedError::Other("scoreboard unused".to_string())) })
        }

        fn fetch_summary<'a>(&'a self, _league: &'a str, _event_id: &'a str) -> super::FeedFut<'a> {
            self.seen.fetch_add(1, Ordering::SeqCst);
            let body = self
                .script
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            Box::pin(async move { body })
        }
    }

    #[tokio::test]
    async fn detail_ttl_follows_game_state() {
        for (state, expected) in [
            ("in", DETAIL_LIVE_TTL),
            ("pre", DETAIL_PRE_TTL),
            ("post", DETAIL_POST_TTL),
        ] {
            let seen = Arc::new(AtomicUsize::new(0));
            let service = ScoreboardService::with_feed(Arc::new(SummaryScript {
                script: Arc::new(Mutex::new(Ok(tiny_summary(state)))),
                seen: seen.clone(),
            }));
            let start = at(20, 0);
            service.set_now(start);
            let detail = service.detail("football/nfl", "42", &[]).await.unwrap();
            assert!(!detail.stale);
            assert_eq!(detail.game.state, state);
            assert_eq!(
                service.cached_detail_ttl("football/nfl", "42"),
                Some(expected)
            );
            assert_eq!(seen.load(Ordering::SeqCst), 1);

            let within = expected.saturating_sub(std::time::Duration::from_secs(1));
            service.set_now(start + chrono::Duration::from_std(within).unwrap());
            service.detail("football/nfl", "42", &[]).await.unwrap();
            assert_eq!(seen.load(Ordering::SeqCst), 1);

            service.set_now(start + chrono::Duration::from_std(expected).unwrap());
            service.detail("football/nfl", "42", &[]).await.unwrap();
            assert_eq!(seen.load(Ordering::SeqCst), 2);
        }
    }

    #[tokio::test]
    async fn detail_failure_keeps_the_last_good_summary_and_marks_it_stale() {
        let seen = Arc::new(AtomicUsize::new(0));
        let script = Arc::new(Mutex::new(Ok(tiny_summary("post"))));
        let service = ScoreboardService::with_feed(Arc::new(SummaryScript {
            script: script.clone(),
            seen: seen.clone(),
        }));
        let start = at(20, 0);
        service.set_now(start);
        let first = service.detail("baseball/mlb", "7", &[]).await.unwrap();
        assert!(!first.stale);
        assert_eq!(first.game.id, "42");

        *script.lock().unwrap() = Err(FeedError::TimedOut);
        let failed_at = start + chrono::Duration::from_std(DETAIL_POST_TTL).unwrap();
        service.set_now(failed_at);
        let kept = service.detail("baseball/mlb", "7", &[]).await.unwrap();
        assert!(kept.stale);
        assert_eq!(kept.game.id, "42");
        assert_eq!(
            service.cached_detail_ttl("baseball/mlb", "7"),
            Some(ERROR_TTL)
        );
        assert_eq!(seen.load(Ordering::SeqCst), 2);

        service.set_now(failed_at + chrono::Duration::seconds(29));
        let still = service.detail("baseball/mlb", "7", &[]).await.unwrap();
        assert!(still.stale);
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn detail_failure_with_nothing_cached_is_an_error_and_backs_off() {
        let seen = Arc::new(AtomicUsize::new(0));
        let service = ScoreboardService::with_feed(Arc::new(SummaryScript {
            script: Arc::new(Mutex::new(Err(FeedError::Status {
                host: "site.web.api.espn.com".to_string(),
                code: 503,
            }))),
            seen: seen.clone(),
        }));
        let start = at(20, 0);
        service.set_now(start);
        assert!(service.detail("football/nfl", "9", &[]).await.is_err());
        assert_eq!(
            service.cached_detail_ttl("football/nfl", "9"),
            Some(ERROR_TTL)
        );
        service.set_now(start + chrono::Duration::seconds(29));
        assert!(service.detail("football/nfl", "9", &[]).await.is_err());
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        service.set_now(start + chrono::Duration::seconds(30));
        assert!(service.detail("football/nfl", "9", &[]).await.is_err());
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    struct GateSummary {
        calls: Arc<AtomicUsize>,
        release: watch::Receiver<bool>,
    }

    impl ScoreFeed for GateSummary {
        fn fetch<'a>(&'a self, _league: &'a str) -> super::FeedFut<'a> {
            Box::pin(async { Err(FeedError::Other("scoreboard unused".to_string())) })
        }

        fn fetch_summary<'a>(&'a self, _league: &'a str, _event_id: &'a str) -> super::FeedFut<'a> {
            let calls = self.calls.clone();
            let mut release = self.release.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                let _ = release.wait_for(|open| *open).await;
                Ok(tiny_summary("in"))
            })
        }
    }

    #[tokio::test]
    async fn one_event_shares_a_flight_and_another_event_does_not() {
        let (tx, rx) = watch::channel(false);
        let calls = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(ScoreboardService::with_feed(Arc::new(GateSummary {
            calls: calls.clone(),
            release: rx,
        })));
        let left = {
            let service = service.clone();
            tokio::spawn(async move { service.detail("football/nfl", "1", &[]).await })
        };
        let right = {
            let service = service.clone();
            tokio::spawn(async move { service.detail("football/nfl", "1", &[]).await })
        };
        let started = std::time::Instant::now();
        while calls.load(Ordering::SeqCst) == 0 {
            assert!(started.elapsed() < std::time::Duration::from_secs(2));
            tokio::task::yield_now().await;
        }
        let observed = std::time::Instant::now();
        while observed.elapsed() < std::time::Duration::from_millis(200) {
            assert_eq!(
                calls.load(Ordering::SeqCst),
                1,
                "same event must share one flight"
            );
            tokio::task::yield_now().await;
        }
        tx.send(true).unwrap();
        let (left, right) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(left, right)
        })
        .await
        .expect("detail calls finished");
        assert!(left.unwrap().unwrap().game.id == "42");
        assert!(right.unwrap().unwrap().game.id == "42");

        let (tx, rx) = watch::channel(false);
        let calls = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(ScoreboardService::with_feed(Arc::new(GateSummary {
            calls: calls.clone(),
            release: rx,
        })));
        let first = {
            let service = service.clone();
            tokio::spawn(async move { service.detail("football/nfl", "11", &[]).await })
        };
        let second = {
            let service = service.clone();
            tokio::spawn(async move { service.detail("baseball/mlb", "22", &[]).await })
        };
        let started = std::time::Instant::now();
        while calls.load(Ordering::SeqCst) < 2 {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "different events did not fetch in parallel, calls={}",
                calls.load(Ordering::SeqCst)
            );
            tokio::task::yield_now().await;
        }
        tx.send(true).unwrap();
        let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(first, second)
        })
        .await
        .expect("parallel detail calls finished");
        assert!(first.unwrap().is_ok());
        assert!(second.unwrap().is_ok());
    }

    struct CountedSummary {
        calls: Mutex<std::collections::HashMap<String, usize>>,
    }

    impl ScoreFeed for CountedSummary {
        fn fetch<'a>(&'a self, league: &'a str) -> super::FeedFut<'a> {
            let key = league.to_ascii_lowercase();
            *self
                .calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entry(key)
                .or_default() += 1;
            Box::pin(async { Ok(board_with(&event("1", "post", "2026-09-20T18:00:00Z"))) })
        }

        fn fetch_summary<'a>(&'a self, league: &'a str, event_id: &'a str) -> super::FeedFut<'a> {
            let key = format!("{}\n{event_id}", league.to_ascii_lowercase());
            *self
                .calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entry(key)
                .or_default() += 1;
            Box::pin(async { Ok(tiny_summary("post")) })
        }
    }

    fn calls_for(feed: &CountedSummary, key: &str) -> usize {
        feed.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
            .copied()
            .unwrap_or(0)
    }

    #[tokio::test]
    async fn scoreboard_cache_evicts_the_least_recently_used_league() {
        let feed = Arc::new(CountedSummary {
            calls: Mutex::new(std::collections::HashMap::new()),
        });
        let service = ScoreboardService::with_feed(feed.clone());
        service.set_now(at(20, 0));
        let leagues: Vec<String> = (0..CACHE_CAP)
            .map(|index| format!("soccer/l{index:02}"))
            .collect();
        service.board(&leagues, &[]).await;
        assert_eq!(calls_for(&feed, "soccer/l00"), 1);
        service.board(&["soccer/l00".to_string()], &[]).await;
        assert_eq!(
            calls_for(&feed, "soccer/l00"),
            1,
            "a touch is not a refetch"
        );

        service.board(&["soccer/l64".to_string()], &[]).await;
        assert_eq!(calls_for(&feed, "soccer/l64"), 1);
        service.board(&["soccer/l02".to_string()], &[]).await;
        assert_eq!(
            calls_for(&feed, "soccer/l02"),
            1,
            "a newer league stays cached"
        );
        service.board(&["soccer/l01".to_string()], &[]).await;
        assert_eq!(
            calls_for(&feed, "soccer/l01"),
            2,
            "the oldest league was evicted"
        );
    }

    #[tokio::test]
    async fn detail_cache_evicts_the_least_recently_used_event() {
        let feed = Arc::new(CountedSummary {
            calls: Mutex::new(std::collections::HashMap::new()),
        });
        let service = ScoreboardService::with_feed(feed.clone());
        service.set_now(at(20, 0));
        for index in 1..=CACHE_CAP {
            service
                .detail("football/nfl", &index.to_string(), &[])
                .await
                .unwrap();
        }
        assert_eq!(calls_for(&feed, "football/nfl\n1"), 1);
        service.detail("football/nfl", "1", &[]).await.unwrap();
        assert_eq!(calls_for(&feed, "football/nfl\n1"), 1);

        service.detail("football/nfl", "65", &[]).await.unwrap();
        service.detail("football/nfl", "3", &[]).await.unwrap();
        assert_eq!(
            calls_for(&feed, "football/nfl\n3"),
            1,
            "a newer event stays cached"
        );
        service.detail("football/nfl", "2", &[]).await.unwrap();
        assert_eq!(
            calls_for(&feed, "football/nfl\n2"),
            2,
            "the oldest event was evicted"
        );
    }

    #[test]
    fn summary_urls_exist_only_for_the_two_fixed_hosts() {
        assert!(summary_url("sports.core.api.espn.pvt", "football/nfl", "401872945").is_none());
        assert!(summary_url("evil.example", "football/nfl", "1").is_none());
        assert!(summary_url("site.web.api.espn.com", "../secret", "1").is_none());
        assert!(summary_url("site.web.api.espn.com", "football/nfl", "abc").is_none());
        assert!(summary_url("site.web.api.espn.com", "football/nfl", &"1".repeat(21)).is_none());
        assert_eq!(
            summary_url("site.web.api.espn.com", "football/nfl", "401872945").as_deref(),
            Some(
                "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872945"
            )
        );
        assert!(summary_url("site.api.espn.com", "baseball/mlb", "401817017").is_some());
        assert!(request_url_is_allowed(
            "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=1"
        ));
        assert!(request_url_is_allowed(
            "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"
        ));
        assert!(!request_url_is_allowed(
            "http://sports.core.api.espn.pvt/v2/sports/football/leagues/nfl/events/1"
        ));
        assert!(!request_url_is_allowed(
            "https://sports.core.api.espn.pvt/v2/sports/football/leagues/nfl/events/1"
        ));
        assert!(!request_url_is_allowed("https://evil.example/summary"));
        assert!(!request_url_is_allowed(
            "https://site.web.api.espn.com.evil.example/x"
        ));
        assert!(is_valid_event_id("0"));
        assert!(!is_valid_event_id(""));
        assert_eq!(SUMMARY_MAX_BODY_BYTES, 8 * 1024 * 1024);
        assert_eq!(HOSTS.len(), 2);
    }

    #[tokio::test]
    #[ignore = "fetches the live ESPN scoreboard"]
    async fn live_espn_feed_parses_nfl_and_mlb() {
        let feed = super::EspnFeed::new().expect("client");
        for league in ["football/nfl", "baseball/mlb"] {
            let json = feed.fetch(league).await.expect("fetch");
            let games = super::super::espn::parse(&json, league).expect("parse");
            println!("{league}: {} games", games.len());
            let game = games
                .iter()
                .find(|game| game.state == "in")
                .or_else(|| games.iter().find(|game| game.state == "post"))
                .or_else(|| games.first());
            if let Some(game) = game {
                println!(
                    "  picked: {} ({}) vs {} ({}) state={} detail={}",
                    game.away.name,
                    game.away.abbr,
                    game.home.name,
                    game.home.abbr,
                    game.state,
                    game.detail
                );
                let summary = feed.fetch_summary(league, &game.id).await.expect("summary");
                let detail = super::detail::parse(&summary, league).expect("parse summary");
                let last = match detail.kind.as_str() {
                    "football" => detail
                        .football
                        .as_ref()
                        .and_then(|football| football.drives.last())
                        .and_then(|drive| drive.plays.last())
                        .map(|play| play.text.clone())
                        .unwrap_or_default(),
                    "baseball" => detail
                        .baseball
                        .as_ref()
                        .and_then(|baseball| baseball.at_bats.last())
                        .map(|at_bat| at_bat.result_text.clone())
                        .unwrap_or_default(),
                    _ => String::new(),
                };
                let count = if detail.kind == "football" {
                    detail
                        .football
                        .as_ref()
                        .map(|football| football.drives.len())
                        .unwrap_or(0)
                } else {
                    detail
                        .baseball
                        .as_ref()
                        .map(|baseball| baseball.at_bats.len())
                        .unwrap_or(0)
                };
                println!("  summary kind={} count={count} last={last}", detail.kind);
                if let Some(baseball) = detail.baseball.as_ref() {
                    let batter = baseball
                        .batter
                        .as_ref()
                        .map(|athlete| athlete.name.as_str())
                        .unwrap_or("");
                    let pitcher = baseball
                        .pitcher
                        .as_ref()
                        .map(|athlete| athlete.name.as_str())
                        .unwrap_or("");
                    println!(
                        "  live inning={:?} half={:?} count={:?}-{:?} outs={:?} batter={batter} pitcher={pitcher}",
                        baseball.inning, baseball.half, baseball.balls, baseball.strikes, baseball.outs
                    );
                }
            }
        }
        let json = feed.fetch_teams("football/nfl").await.expect("roster");
        let teams = super::super::espn::parse_teams(&json).expect("parse roster");
        println!("football/nfl roster: {} teams", teams.len());
        for team in teams.iter().take(3) {
            println!("  {}", team.name);
        }
    }
}
