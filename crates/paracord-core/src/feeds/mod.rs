//! Feeds add-on: RSS/Atom, YouTube, GitHub, Twitch and Jellyfin sources
//! posting new items into a server's channels.
//!
//! This module fetches, parses and plans. The HTTP layer (`paracord-api`'s
//! `routes::feeds`) owns permissions, storage and posting, the same split the
//! sports add-on uses.

pub mod net;
mod parse;
mod plan;
mod sources;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::RwLock;

use chrono::Duration;

pub use net::{
    address_allowed, classify, local_network_allowed, AddressClass, FetchError, FetchRequest,
    FetchResponse, SafeFetcher, LOCAL_NETWORK_REFUSAL, LOCAL_NETWORK_SETTING,
};
pub use parse::{
    clean_title, discover_feed_links, looks_like_html, parse_feed, strip_html, summary_text,
    FeedItem, ParsedFeed, SUMMARY_CHARS,
};
pub use plan::{group_cards, next_check, plan_posts, PostPlan, MAX_BACKOFF, MAX_CARDS_PER_CHECK};
pub use sources::{
    check_source, fetch_poster, forget_twitch_token, resolve_source, Checked, FeedProblem,
    GithubMode, Poster, ResolvedSource, SourceInput, SourceState, TwitchCredentials,
};

/// Where a feed comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FeedKind {
    Rss,
    Youtube,
    Github,
    Twitch,
    Jellyfin,
}

impl FeedKind {
    pub const ALL: [FeedKind; 5] = [
        FeedKind::Rss,
        FeedKind::Youtube,
        FeedKind::Github,
        FeedKind::Twitch,
        FeedKind::Jellyfin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            FeedKind::Rss => "rss",
            FeedKind::Youtube => "youtube",
            FeedKind::Github => "github",
            FeedKind::Twitch => "twitch",
            FeedKind::Jellyfin => "jellyfin",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str().eq_ignore_ascii_case(raw.trim()))
    }

    /// How often a healthy source is checked.
    pub fn interval(self) -> Duration {
        match self {
            FeedKind::Rss | FeedKind::Youtube | FeedKind::Github => Duration::minutes(10),
            FeedKind::Twitch => Duration::minutes(2),
            FeedKind::Jellyfin => Duration::minutes(5),
        }
    }

    /// The source's own name, for "and 7 more from <source>".
    pub fn label(self) -> &'static str {
        match self {
            FeedKind::Rss => "RSS",
            FeedKind::Youtube => "YouTube",
            FeedKind::Github => "GitHub",
            FeedKind::Twitch => "Twitch",
            FeedKind::Jellyfin => "Jellyfin",
        }
    }
}

/// Default number of feeds one server may have.
pub const DEFAULT_MAX_FEEDS_PER_GUILD: u32 = 20;

static MAX_FEEDS_PER_GUILD: AtomicU32 = AtomicU32::new(DEFAULT_MAX_FEEDS_PER_GUILD);

/// Apply the instance config (`[addons] feeds_per_server`). Called at startup.
pub fn configure(max_feeds_per_guild: u32) {
    MAX_FEEDS_PER_GUILD.store(max_feeds_per_guild.max(1), Ordering::Relaxed);
}

pub fn max_feeds_per_guild() -> u32 {
    MAX_FEEDS_PER_GUILD.load(Ordering::Relaxed)
}

/// The public services feeds talk to. Tests point these at a local server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedEndpoints {
    pub youtube: String,
    pub github: String,
    pub twitch_auth: String,
    pub twitch_api: String,
}

impl Default for FeedEndpoints {
    fn default() -> Self {
        Self {
            youtube: "https://www.youtube.com".to_string(),
            github: "https://github.com".to_string(),
            twitch_auth: "https://id.twitch.tv".to_string(),
            twitch_api: "https://api.twitch.tv".to_string(),
        }
    }
}

static ENDPOINTS: RwLock<Option<FeedEndpoints>> = RwLock::new(None);

pub fn endpoints() -> FeedEndpoints {
    ENDPOINTS
        .read()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

/// Point the public services at another host. For tests.
pub fn set_endpoints_for_tests(endpoints: FeedEndpoints) {
    if let Ok(mut guard) = ENDPOINTS.write() {
        *guard = Some(endpoints);
    }
}
