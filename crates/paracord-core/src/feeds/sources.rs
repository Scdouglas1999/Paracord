//! Turning what a server owner pasted into a source, and checking a source.

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use regex::Regex;
use reqwest::header::{HeaderName, AUTHORIZATION, IF_MODIFIED_SINCE, IF_NONE_MATCH};
use reqwest::Url;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::net::{FetchError, FetchRequest, FetchResponse, SafeFetcher};
use super::parse::{
    canonical_link, clean_title, discover_feed_links, is_video_id, looks_like_html, meta_content,
    parse_date, parse_feed, summary_text, FeedItem, ParsedFeed, MAX_ITEMS,
};
use super::{endpoints, FeedKind};

/// A problem with a source, in words for the server owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedProblem(pub String);

impl std::fmt::Display for FeedProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FeedProblem {}

fn problem(text: impl Into<String>) -> FeedProblem {
    FeedProblem(text.into())
}

fn fetch_problem(err: FetchError) -> FeedProblem {
    match err {
        FetchError::Status(code) => problem(format!("The feed address returned {code}.")),
        other => problem(other.to_string()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GithubMode {
    Releases,
    Commits,
    Tags,
}

impl GithubMode {
    pub fn as_str(self) -> &'static str {
        match self {
            GithubMode::Releases => "releases",
            GithubMode::Commits => "commits",
            GithubMode::Tags => "tags",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "releases" => Some(GithubMode::Releases),
            "commits" => Some(GithubMode::Commits),
            "tags" => Some(GithubMode::Tags),
            _ => None,
        }
    }
}

/// What the "Add a feed" sheet sends.
#[derive(Debug, Clone)]
pub struct SourceInput {
    pub kind: FeedKind,
    /// The URL, channel, repository, login or server address, as typed.
    pub input: String,
    pub github_mode: Option<GithubMode>,
    pub branch: Option<String>,
    /// Jellyfin's API key.
    pub api_key: Option<String>,
}

/// The instance's Twitch app, set by the instance admin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwitchCredentials {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedSource {
    pub kind: FeedKind,
    /// One source row per key; every server following it shares the fetch.
    pub source_key: String,
    /// What a check fetches: a feed URL, a Twitch login, a Jellyfin server.
    pub url: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub site_url: Option<String>,
    /// The source's address as the Feeds page shows it.
    pub display: String,
    /// Kind-specific settings kept with the subscription.
    pub options: Value,
    /// What the source holds right now, newest first.
    pub feed: ParsedFeed,
}

/// What a check needs to know about a stored source.
#[derive(Debug, Clone)]
pub struct SourceState<'a> {
    pub kind: FeedKind,
    pub url: &'a str,
    pub etag: Option<&'a str>,
    pub last_modified: Option<&'a str>,
    /// Jellyfin's API key, decrypted.
    pub api_key: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub enum Checked {
    NotModified,
    Fresh {
        feed: ParsedFeed,
        etag: Option<String>,
        last_modified: Option<String>,
    },
}

/// Resolve what the server owner pasted, and read what the source holds now.
pub async fn resolve_source(
    fetcher: &SafeFetcher,
    input: &SourceInput,
    twitch: Option<&TwitchCredentials>,
) -> Result<ResolvedSource, FeedProblem> {
    let raw = input.input.trim();
    if raw.is_empty() {
        return Err(problem(match input.kind {
            FeedKind::Rss => "Paste a feed or web page address.",
            FeedKind::Youtube => "Paste a YouTube channel or video address.",
            FeedKind::Github => "Type a repository as owner/repo, or paste its address.",
            FeedKind::Twitch => "Type a Twitch channel name.",
            FeedKind::Jellyfin => "Type your Jellyfin server's address.",
        }));
    }
    if raw.len() > 2048 {
        return Err(problem("That address is too long."));
    }
    match input.kind {
        FeedKind::Rss => resolve_rss(fetcher, raw).await,
        FeedKind::Youtube => resolve_youtube(fetcher, raw).await,
        FeedKind::Github => {
            let mode = input.github_mode.unwrap_or(GithubMode::Releases);
            resolve_github(fetcher, raw, mode, input.branch.as_deref()).await
        }
        FeedKind::Twitch => {
            let credentials = twitch.ok_or_else(|| {
                problem("Your instance admin needs to add Twitch credentials first.")
            })?;
            resolve_twitch(fetcher, raw, credentials).await
        }
        FeedKind::Jellyfin => {
            let key = input
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .ok_or_else(|| problem("Paste an API key from Jellyfin's dashboard."))?;
            resolve_jellyfin(fetcher, raw, key).await
        }
    }
}

/// Check a stored source for what it holds now.
pub async fn check_source(
    fetcher: &SafeFetcher,
    state: &SourceState<'_>,
    twitch: Option<&TwitchCredentials>,
) -> Result<Checked, FeedProblem> {
    match state.kind {
        FeedKind::Rss | FeedKind::Youtube => {
            fetch_feed(fetcher, state.url, state.etag, state.last_modified, None).await
        }
        FeedKind::Github => Ok(without_avatars(
            fetch_feed(fetcher, state.url, state.etag, state.last_modified, None).await?,
        )),
        FeedKind::Twitch => {
            let credentials = twitch.ok_or_else(|| {
                problem("The instance admin removed the Twitch credentials, so Twitch feeds are paused.")
            })?;
            let (_, stream) = twitch_stream(fetcher, state.url, credentials).await?;
            Ok(Checked::Fresh {
                feed: ParsedFeed {
                    items: stream.into_iter().collect(),
                    ..ParsedFeed::default()
                },
                etag: None,
                last_modified: None,
            })
        }
        FeedKind::Jellyfin => {
            let key = state.api_key.ok_or_else(|| {
                problem("This Jellyfin feed has no API key. Edit it and add one.")
            })?;
            let base = jellyfin_base(state.url)?;
            let items = jellyfin_items(fetcher, &base, key).await?;
            Ok(Checked::Fresh {
                feed: ParsedFeed {
                    items,
                    ..ParsedFeed::default()
                },
                etag: None,
                last_modified: None,
            })
        }
    }
}

// ── RSS and Atom ──────────────────────────────────────────────────────────

fn web_url(raw: &str) -> Result<Url, FeedProblem> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| problem("That isn't a web address."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(problem("Only http and https addresses can be used."));
    }
    if url.host_str().is_none_or(|host| host.is_empty()) {
        return Err(problem("That isn't a web address."));
    }
    Ok(url)
}

async fn get(
    fetcher: &SafeFetcher,
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<FetchResponse, FeedProblem> {
    let mut request = FetchRequest::get(url).header(
        reqwest::header::ACCEPT,
        "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1",
    );
    if let Some(etag) = etag {
        request = request.header(IF_NONE_MATCH, etag);
    }
    if let Some(modified) = last_modified {
        request = request.header(IF_MODIFIED_SINCE, modified);
    }
    fetcher.fetch(request).await.map_err(fetch_problem)
}

/// Fetch and parse a feed document. `not_found` replaces the generic 404 line.
async fn fetch_feed(
    fetcher: &SafeFetcher,
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
    not_found: Option<&str>,
) -> Result<Checked, FeedProblem> {
    let response = get(fetcher, url, etag, last_modified).await?;
    if response.status == 304 {
        return Ok(Checked::NotModified);
    }
    if matches!(response.status, 404 | 410) {
        if let Some(text) = not_found {
            return Err(problem(text));
        }
    }
    if !response.is_success() {
        return Err(problem(format!(
            "The feed address returned {}.",
            response.status
        )));
    }
    let body = response.text();
    if looks_like_html(&body) {
        return Err(problem("That address is a web page, not a feed."));
    }
    let feed = parse_feed(&body, &response.url).map_err(|err| {
        problem(format!(
            "That address didn't return an RSS or Atom feed: {err}."
        ))
    })?;
    Ok(Checked::Fresh {
        feed,
        etag: response.header("etag").map(str::to_string),
        last_modified: response.header("last-modified").map(str::to_string),
    })
}

fn fresh(checked: Checked) -> ParsedFeed {
    match checked {
        Checked::Fresh { feed, .. } => feed,
        Checked::NotModified => ParsedFeed::default(),
    }
}

async fn resolve_rss(fetcher: &SafeFetcher, raw: &str) -> Result<ResolvedSource, FeedProblem> {
    let url = web_url(raw)?;
    let response = get(fetcher, url.as_str(), None, None).await?;
    if !response.is_success() {
        return Err(problem(format!(
            "The feed address returned {}.",
            response.status
        )));
    }
    let body = response.text();
    let (feed_url, feed) = if looks_like_html(&body) {
        let links = discover_feed_links(&body, &response.url);
        if links.is_empty() {
            return Err(problem(
                "That page doesn't list a feed. Paste the feed's own address.",
            ));
        }
        let mut found = None;
        let mut last_error = None;
        for link in links.into_iter().take(3) {
            match fetch_feed(fetcher, &link, None, None, None).await {
                Ok(checked) => {
                    found = Some((link, fresh(checked)));
                    break;
                }
                Err(err) => last_error = Some(err),
            }
        }
        match found {
            Some(found) => found,
            None => {
                return Err(last_error.unwrap_or_else(|| {
                    problem("That page doesn't list a feed. Paste the feed's own address.")
                }))
            }
        }
    } else {
        let feed = parse_feed(&body, &response.url).map_err(|err| {
            problem(format!(
                "That address didn't return an RSS or Atom feed: {err}."
            ))
        })?;
        (url.to_string(), feed)
    };
    let host = Url::parse(&feed_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default();
    let name = feed
        .title
        .clone()
        .filter(|title| !title.is_empty())
        .unwrap_or(host);
    Ok(ResolvedSource {
        kind: FeedKind::Rss,
        source_key: feed_url.clone(),
        url: feed_url.clone(),
        name,
        icon_url: feed.icon_url.clone(),
        site_url: feed.site_url.clone(),
        display: feed_url,
        options: json!({}),
        feed,
    })
}

// ── YouTube ───────────────────────────────────────────────────────────────

enum YoutubeRef {
    Channel(String),
    /// A page on YouTube to read the channel from: a path and query.
    Page(String),
}

fn is_channel_id(text: &str) -> bool {
    text.len() == 24
        && text.starts_with("UC")
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn youtube_ref(raw: &str) -> Result<YoutubeRef, FeedProblem> {
    let not_youtube = || problem("That doesn't look like a YouTube channel or video address.");
    if is_channel_id(raw) {
        return Ok(YoutubeRef::Channel(raw.to_string()));
    }
    if let Some(handle) = raw.strip_prefix('@') {
        if handle.is_empty() || handle.contains(['/', '?', '#', ' ']) {
            return Err(not_youtube());
        }
        return Ok(YoutubeRef::Page(format!("/@{handle}")));
    }
    let url = web_url(raw).map_err(|_| not_youtube())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let host = host.strip_prefix("m.").unwrap_or(host);
    let segments: Vec<&str> = url
        .path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default();
    if host == "youtu.be" {
        let id = segments.first().copied().filter(|id| is_video_id(id));
        return id
            .map(|id| YoutubeRef::Page(format!("/watch?v={id}")))
            .ok_or_else(not_youtube);
    }
    if host != "youtube.com" && host != "music.youtube.com" {
        return Err(not_youtube());
    }
    match segments.as_slice() {
        ["channel", id, ..] if is_channel_id(id) => Ok(YoutubeRef::Channel(id.to_string())),
        [handle, ..] if handle.starts_with('@') && handle.len() > 1 => {
            Ok(YoutubeRef::Page(format!("/{handle}")))
        }
        ["c" | "user", name, ..] => Ok(YoutubeRef::Page(format!("/{}/{name}", segments[0]))),
        ["watch"] => url
            .query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, id)| id.into_owned())
            .filter(|id| is_video_id(id))
            .map(|id| YoutubeRef::Page(format!("/watch?v={id}")))
            .ok_or_else(not_youtube),
        ["shorts" | "live" | "embed", id, ..] if is_video_id(id) => {
            Ok(YoutubeRef::Page(format!("/watch?v={id}")))
        }
        _ => Err(not_youtube()),
    }
}

fn channel_id_in_page(html: &str, base: &Url) -> Option<String> {
    let from_feed = discover_feed_links(html, base)
        .into_iter()
        .find_map(|link| {
            Url::parse(&link).ok().and_then(|url| {
                url.query_pairs()
                    .find(|(key, _)| key == "channel_id")
                    .map(|(_, id)| id.into_owned())
            })
        });
    if let Some(id) = from_feed.filter(|id| is_channel_id(id)) {
        return Some(id);
    }
    if let Some(id) = meta_content(html, "channelId").filter(|id| is_channel_id(id)) {
        return Some(id);
    }
    if let Some(id) = canonical_link(html, base).and_then(|link| {
        let url = Url::parse(&link).ok()?;
        let mut parts = url.path_segments()?;
        (parts.next()? == "channel")
            .then(|| parts.next().map(str::to_string))
            .flatten()
    }) {
        if is_channel_id(&id) {
            return Some(id);
        }
    }
    for pattern in [
        r#""externalChannelId":"(UC[0-9A-Za-z_-]{22})""#,
        r#""channelId":"(UC[0-9A-Za-z_-]{22})""#,
    ] {
        let regex = Regex::new(pattern).ok()?;
        if let Some(found) = regex.captures(html).and_then(|caps| caps.get(1)) {
            return Some(found.as_str().to_string());
        }
    }
    None
}

async fn resolve_youtube(fetcher: &SafeFetcher, raw: &str) -> Result<ResolvedSource, FeedProblem> {
    let base = endpoints().youtube;
    let base_url = Url::parse(&base).map_err(|_| problem("YouTube's address is misconfigured."))?;
    let (channel_id, icon_url) = match youtube_ref(raw)? {
        YoutubeRef::Channel(id) => {
            let page = format!("{base}/channel/{id}");
            let icon = match fetcher.fetch(FetchRequest::get(&page)).await {
                Ok(response) if response.is_success() => meta_content(&response.text(), "og:image"),
                _ => None,
            };
            (id, icon)
        }
        YoutubeRef::Page(path) => {
            let page = format!("{base}{path}");
            let response = fetcher
                .fetch(FetchRequest::get(&page))
                .await
                .map_err(fetch_problem)?;
            if matches!(response.status, 404 | 410) {
                return Err(problem("YouTube has no channel or video at that address."));
            }
            if !response.is_success() {
                return Err(problem(format!("YouTube returned {}.", response.status)));
            }
            let html = response.text();
            let id = channel_id_in_page(&html, &base_url)
                .ok_or_else(|| problem("Couldn't find the YouTube channel on that page."))?;
            // A channel page's picture is the channel's; a video page's is the video's.
            let icon = (!path.starts_with("/watch"))
                .then(|| meta_content(&html, "og:image"))
                .flatten();
            (id, icon)
        }
    };
    let feed_url = format!("{base}/feeds/videos.xml?channel_id={channel_id}");
    let checked = fetch_feed(
        fetcher,
        &feed_url,
        None,
        None,
        Some("YouTube has no channel with that id."),
    )
    .await?;
    let feed = fresh(checked);
    let site_url = format!("https://www.youtube.com/channel/{channel_id}");
    Ok(ResolvedSource {
        kind: FeedKind::Youtube,
        source_key: feed_url.clone(),
        url: feed_url,
        name: feed
            .title
            .clone()
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "YouTube channel".to_string()),
        icon_url: icon_url.filter(|url| url.starts_with("https://")),
        site_url: Some(site_url.clone()),
        display: site_url,
        options: json!({ "channel_id": channel_id }),
        feed,
    })
}

// ── GitHub ────────────────────────────────────────────────────────────────

fn github_repo(raw: &str) -> Result<(String, String), FeedProblem> {
    let invalid = || problem("Type a repository as owner/repo, or paste its GitHub address.");
    let path = if raw.contains("github.com") {
        let url = web_url(raw).map_err(|_| invalid())?;
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        if host != "github.com" && host != "www.github.com" {
            return Err(invalid());
        }
        url.path().trim_matches('/').to_string()
    } else {
        raw.trim_matches('/').to_string()
    };
    let mut parts = path.split('/');
    let owner = parts.next().unwrap_or_default().to_string();
    let repo = parts
        .next()
        .unwrap_or_default()
        .trim_end_matches(".git")
        .to_string();
    let owner_ok = (1..=39).contains(&owner.len())
        && owner
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-');
    let repo_ok = (1..=100).contains(&repo.len())
        && repo != "."
        && repo != ".."
        && repo
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if !owner_ok || !repo_ok {
        return Err(invalid());
    }
    Ok((owner, repo))
}

/// GitHub's Atom entries carry the author's avatar as their picture; a card
/// about a release is not a card about a person.
fn without_avatars(checked: Checked) -> Checked {
    match checked {
        Checked::Fresh {
            mut feed,
            etag,
            last_modified,
        } => {
            for item in &mut feed.items {
                item.thumbnail_url = None;
            }
            Checked::Fresh {
                feed,
                etag,
                last_modified,
            }
        }
        Checked::NotModified => Checked::NotModified,
    }
}

fn valid_branch(branch: &str) -> bool {
    (1..=200).contains(&branch.len())
        && !branch.starts_with(['/', '-', '.'])
        && !branch.ends_with(['/', '.'])
        && !branch.contains("..")
        && !branch.contains("//")
        && branch
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/'))
}

async fn resolve_github(
    fetcher: &SafeFetcher,
    raw: &str,
    mode: GithubMode,
    branch: Option<&str>,
) -> Result<ResolvedSource, FeedProblem> {
    let (owner, repo) = github_repo(raw)?;
    let base = endpoints().github;
    let branch = match mode {
        GithubMode::Commits => {
            let branch = branch
                .map(str::trim)
                .filter(|branch| !branch.is_empty())
                .ok_or_else(|| problem("Name the branch to follow."))?;
            if !valid_branch(branch) {
                return Err(problem("That isn't a branch name GitHub allows."));
            }
            Some(branch.to_string())
        }
        _ => None,
    };
    let (path, site_tail, missing) = match (mode, branch.as_deref()) {
        (GithubMode::Releases, _) => (
            "releases.atom".to_string(),
            "releases".to_string(),
            format!("GitHub has no public repository called {owner}/{repo}."),
        ),
        (GithubMode::Tags, _) => (
            "tags.atom".to_string(),
            "tags".to_string(),
            format!("GitHub has no public repository called {owner}/{repo}."),
        ),
        (GithubMode::Commits, Some(branch)) => (
            format!("commits/{branch}.atom"),
            format!("commits/{branch}"),
            format!("GitHub has no public repository called {owner}/{repo} with a branch called {branch}."),
        ),
        (GithubMode::Commits, None) => return Err(problem("Name the branch to follow.")),
    };
    let feed_url = format!("{base}/{owner}/{repo}/{path}");
    let feed = fresh(without_avatars(
        fetch_feed(fetcher, &feed_url, None, None, Some(&missing)).await?,
    ));
    let site_url = format!("https://github.com/{owner}/{repo}/{site_tail}");
    Ok(ResolvedSource {
        kind: FeedKind::Github,
        source_key: feed_url.clone(),
        url: feed_url,
        name: format!("{owner}/{repo}"),
        icon_url: Some(format!("https://github.com/{owner}.png?size=96")),
        site_url: Some(site_url),
        display: format!("github.com/{owner}/{repo}"),
        options: json!({
            "repo": format!("{owner}/{repo}"),
            "github_mode": mode.as_str(),
            "branch": branch,
        }),
        feed,
    })
}

// ── Twitch ────────────────────────────────────────────────────────────────

struct CachedToken {
    client_id: String,
    token: String,
    expires_at: DateTime<Utc>,
}

static TWITCH_TOKEN: Mutex<Option<CachedToken>> = Mutex::new(None);

/// Drop the cached app token (the admin changed the credentials).
pub fn forget_twitch_token() {
    if let Ok(mut guard) = TWITCH_TOKEN.lock() {
        *guard = None;
    }
}

fn twitch_login(raw: &str) -> Result<String, FeedProblem> {
    let invalid = || problem("Type a Twitch channel name, or paste its twitch.tv address.");
    let login = if raw.contains("twitch.tv") {
        let url = web_url(raw).map_err(|_| invalid())?;
        url.path_segments()
            .and_then(|mut parts| parts.find(|part| !part.is_empty()).map(str::to_string))
            .ok_or_else(invalid)?
    } else {
        raw.trim_start_matches('@').to_string()
    };
    let login = login.to_ascii_lowercase();
    let valid = (3..=25).contains(&login.len())
        && login
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
    if valid {
        Ok(login)
    } else {
        Err(invalid())
    }
}

async fn twitch_token(
    fetcher: &SafeFetcher,
    credentials: &TwitchCredentials,
) -> Result<String, FeedProblem> {
    if let Ok(guard) = TWITCH_TOKEN.lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.client_id == credentials.client_id
                && cached.expires_at > Utc::now() + chrono::Duration::minutes(5)
            {
                return Ok(cached.token.clone());
            }
        }
    }
    let url = format!("{}/oauth2/token", endpoints().twitch_auth);
    let response = fetcher
        .fetch(FetchRequest::post_form(
            url,
            &[
                ("client_id", credentials.client_id.as_str()),
                ("client_secret", credentials.client_secret.as_str()),
                ("grant_type", "client_credentials"),
            ],
        ))
        .await
        .map_err(|err| problem(format!("Couldn't reach Twitch: {err}")))?;
    if matches!(response.status, 400 | 401 | 403) {
        return Err(problem(
            "Twitch didn't accept this instance's Twitch credentials. Your instance admin needs to check them.",
        ));
    }
    if !response.is_success() {
        return Err(problem(format!("Twitch returned {}.", response.status)));
    }
    let body: Value = serde_json::from_slice(&response.body)
        .map_err(|_| problem("Twitch sent back something that wasn't JSON."))?;
    let token = body["access_token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| problem("Twitch didn't send an access token."))?
        .to_string();
    let lifetime = body["expires_in"].as_i64().unwrap_or(3600).max(60);
    if let Ok(mut guard) = TWITCH_TOKEN.lock() {
        *guard = Some(CachedToken {
            client_id: credentials.client_id.clone(),
            token: token.clone(),
            expires_at: Utc::now() + chrono::Duration::seconds(lifetime),
        });
    }
    Ok(token)
}

async fn helix(
    fetcher: &SafeFetcher,
    credentials: &TwitchCredentials,
    path_and_query: &str,
) -> Result<Value, FeedProblem> {
    let url = format!("{}/helix/{path_and_query}", endpoints().twitch_api);
    for attempt in 0..2 {
        let token = twitch_token(fetcher, credentials).await?;
        let response = fetcher
            .fetch(
                FetchRequest::get(&url)
                    .header(HeaderName::from_static("client-id"), &credentials.client_id)
                    .header(AUTHORIZATION, format!("Bearer {token}")),
            )
            .await
            .map_err(|err| problem(format!("Couldn't reach Twitch: {err}")))?;
        if response.status == 401 && attempt == 0 {
            forget_twitch_token();
            continue;
        }
        if !response.is_success() {
            return Err(problem(format!("Twitch returned {}.", response.status)));
        }
        return serde_json::from_slice(&response.body)
            .map_err(|_| problem("Twitch sent back something that wasn't JSON."));
    }
    Err(problem(
        "Twitch didn't accept this instance's Twitch credentials. Your instance admin needs to check them.",
    ))
}

/// The channel's display name and its live stream, if it is live.
async fn twitch_stream(
    fetcher: &SafeFetcher,
    login: &str,
    credentials: &TwitchCredentials,
) -> Result<(String, Option<FeedItem>), FeedProblem> {
    let body = helix(fetcher, credentials, &format!("streams?user_login={login}")).await?;
    let Some(stream) = body["data"].as_array().and_then(|data| data.first()) else {
        return Ok((login.to_string(), None));
    };
    let name = stream["user_name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .unwrap_or(login)
        .to_string();
    let id = stream["id"].as_str().unwrap_or_default();
    if id.is_empty() {
        return Ok((name, None));
    }
    let title = stream["title"]
        .as_str()
        .map(clean_title)
        .unwrap_or_default();
    let game = stream["game_name"]
        .as_str()
        .map(clean_title)
        .unwrap_or_default();
    let mut line = format!("{name} is live");
    if !title.is_empty() {
        line.push_str(&format!(": {title}"));
    }
    if !game.is_empty() {
        line.push_str(&format!(" · {game}"));
    }
    let thumbnail = stream["thumbnail_url"]
        .as_str()
        .map(|url| url.replace("{width}", "640").replace("{height}", "360"))
        .filter(|url| url.starts_with("https://"));
    Ok((
        name,
        Some(FeedItem {
            key: format!("stream:{id}"),
            title: clean_title(&line),
            link: Some(format!("https://www.twitch.tv/{login}")),
            summary: None,
            published_at: stream["started_at"].as_str().and_then(parse_date),
            thumbnail_url: thumbnail,
            ..FeedItem::default()
        }),
    ))
}

async fn resolve_twitch(
    fetcher: &SafeFetcher,
    raw: &str,
    credentials: &TwitchCredentials,
) -> Result<ResolvedSource, FeedProblem> {
    let login = twitch_login(raw)?;
    let users = helix(fetcher, credentials, &format!("users?login={login}")).await?;
    let user = users["data"]
        .as_array()
        .and_then(|data| data.first())
        .ok_or_else(|| problem(format!("No Twitch channel is called {login}.")))?;
    let display = user["display_name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .unwrap_or(&login)
        .to_string();
    let icon = user["profile_image_url"]
        .as_str()
        .filter(|url| url.starts_with("https://"))
        .map(str::to_string);
    let (_, stream) = twitch_stream(fetcher, &login, credentials).await?;
    let site_url = format!("https://www.twitch.tv/{login}");
    Ok(ResolvedSource {
        kind: FeedKind::Twitch,
        source_key: format!("twitch:{login}"),
        url: login.clone(),
        name: display,
        icon_url: icon,
        site_url: Some(site_url),
        display: format!("twitch.tv/{login}"),
        options: json!({ "login": login }),
        feed: ParsedFeed {
            items: stream.into_iter().collect(),
            ..ParsedFeed::default()
        },
    })
}

// ── Jellyfin ──────────────────────────────────────────────────────────────

fn jellyfin_base(raw: &str) -> Result<Url, FeedProblem> {
    let mut url = web_url(raw).map_err(|_| {
        problem("Type your Jellyfin server's address, like http://192.168.1.20:8096.")
    })?;
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    // A pasted dashboard link ends in /web/…; the API lives beside it.
    let path = match path.find("/web/") {
        Some(index) => path[..index].to_string(),
        None => path
            .strip_suffix("/web")
            .map(str::to_string)
            .unwrap_or(path),
    };
    url.set_path(&path);
    Ok(url)
}

fn jellyfin_endpoint(base: &Url, tail: &str) -> String {
    format!("{}{tail}", base.as_str().trim_end_matches('/'))
}

fn jellyfin_auth(key: &str) -> String {
    format!(
        "MediaBrowser Client=\"Paracord\", Device=\"Paracord server\", DeviceId=\"paracord-feeds\", Version=\"{}\", Token=\"{}\"",
        env!("CARGO_PKG_VERSION"),
        key.replace('"', "")
    )
}

async fn jellyfin_get(
    fetcher: &SafeFetcher,
    base: &Url,
    tail: &str,
    key: &str,
) -> Result<FetchResponse, FeedProblem> {
    let response = fetcher
        .fetch(
            FetchRequest::get(jellyfin_endpoint(base, tail))
                .header(AUTHORIZATION, jellyfin_auth(key)),
        )
        .await
        .map_err(|err| problem(format!("Couldn't reach Jellyfin: {err}")))?;
    if matches!(response.status, 401 | 403) {
        return Err(problem("Jellyfin didn't accept that API key."));
    }
    if !response.is_success() {
        return Err(problem(format!(
            "Jellyfin returned {}. Check the server address.",
            response.status
        )));
    }
    Ok(response)
}

async fn jellyfin_items(
    fetcher: &SafeFetcher,
    base: &Url,
    key: &str,
) -> Result<Vec<FeedItem>, FeedProblem> {
    let response = jellyfin_get(
        fetcher,
        base,
        "/Items?SortBy=DateCreated&SortOrder=Descending&IncludeItemTypes=Movie,Episode,MusicAlbum&Recursive=true&Limit=40&Fields=DateCreated,Overview,ProductionYear&EnableImageTypes=Primary&ImageTypeLimit=1",
        key,
    )
    .await?;
    let body: Value = serde_json::from_slice(&response.body)
        .map_err(|_| problem("Jellyfin sent back something that wasn't JSON."))?;
    let items = body["Items"]
        .as_array()
        .ok_or_else(|| problem("Jellyfin's answer had no item list."))?;
    Ok(items
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|item| jellyfin_item(base, item))
        .collect())
}

fn jellyfin_item(base: &Url, item: &Value) -> Option<FeedItem> {
    let id = item["Id"].as_str().filter(|id| {
        !id.is_empty() && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })?;
    let name = item["Name"].as_str().map(clean_title).unwrap_or_default();
    let kind = item["Type"].as_str().unwrap_or_default();
    let series_id = item["SeriesId"].as_str().filter(|id| {
        !id.is_empty() && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    });
    let series = item["SeriesName"].as_str().map(clean_title);
    let title = match kind {
        "Movie" => match item["ProductionYear"].as_i64() {
            Some(year) => format!("{name} ({year})"),
            None => name.clone(),
        },
        "Episode" => {
            let mut parts = Vec::new();
            if let Some(series) = series.as_deref().filter(|s| !s.is_empty()) {
                parts.push(series.to_string());
            }
            if let (Some(season), Some(episode)) = (
                item["ParentIndexNumber"].as_i64(),
                item["IndexNumber"].as_i64(),
            ) {
                parts.push(format!("S{season}E{episode}"));
            }
            if !name.is_empty() {
                parts.push(name.clone());
            }
            parts.join(" · ")
        }
        "MusicAlbum" => match item["AlbumArtist"].as_str().map(clean_title) {
            Some(artist) if !artist.is_empty() => format!("{name} — {artist}"),
            _ => name.clone(),
        },
        _ => return None,
    };
    let has_own_poster = item["ImageTags"]["Primary"].as_str().is_some();
    let poster_ref = if kind == "Episode" && item["SeriesPrimaryImageTag"].as_str().is_some() {
        series_id.map(str::to_string)
    } else if has_own_poster {
        Some(id.to_string())
    } else {
        None
    };
    let (group, group_title, link_id) = if kind == "Episode" {
        (
            series_id.map(|id| format!("series:{id}")),
            series.clone(),
            series_id.unwrap_or(id),
        )
    } else {
        (None, None, id)
    };
    Some(FeedItem {
        key: id.to_string(),
        title: if title.is_empty() {
            "Untitled".to_string()
        } else {
            title
        },
        link: Some(jellyfin_endpoint(
            base,
            &format!("/web/#/details?id={link_id}"),
        )),
        summary: item["Overview"].as_str().and_then(summary_text),
        published_at: item["DateCreated"].as_str().and_then(parse_date),
        poster_ref,
        group,
        group_title,
        ..FeedItem::default()
    })
}

fn key_fingerprint(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn resolve_jellyfin(
    fetcher: &SafeFetcher,
    raw: &str,
    key: &str,
) -> Result<ResolvedSource, FeedProblem> {
    let base = jellyfin_base(raw)?;
    let info = jellyfin_get(fetcher, &base, "/System/Info", key).await?;
    let info: Value = serde_json::from_slice(&info.body)
        .map_err(|_| problem("That address answered, but not like a Jellyfin server."))?;
    let server_name = info["ServerName"]
        .as_str()
        .map(clean_title)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Jellyfin".to_string());
    let items = jellyfin_items(fetcher, &base, key).await?;
    let base_text = base.as_str().trim_end_matches('/').to_string();
    Ok(ResolvedSource {
        kind: FeedKind::Jellyfin,
        source_key: format!("jellyfin:{base_text}#{}", key_fingerprint(key)),
        url: base_text.clone(),
        name: server_name.clone(),
        icon_url: None,
        site_url: Some(format!("{base_text}/web/")),
        display: base_text,
        options: json!({ "server_name": server_name }),
        feed: ParsedFeed {
            title: Some(server_name),
            items,
            ..ParsedFeed::default()
        },
    })
}

/// A poster fetched from Jellyfin, ready to store as an attachment.
#[derive(Debug, Clone)]
pub struct Poster {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub extension: &'static str,
}

/// Fetch a Jellyfin poster. The key never leaves the server; clients get the
/// stored copy.
pub async fn fetch_poster(
    fetcher: &SafeFetcher,
    server_url: &str,
    key: &str,
    poster_ref: &str,
) -> Result<Poster, FeedProblem> {
    if !poster_ref
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err(problem("A poster id from Jellyfin was malformed."));
    }
    let base = jellyfin_base(server_url)?;
    let response = jellyfin_get(
        fetcher,
        &base,
        &format!("/Items/{poster_ref}/Images/Primary?fillHeight=480&quality=85"),
        key,
    )
    .await?;
    let (content_type, extension) = sniff_image(&response.body)
        .ok_or_else(|| problem("Jellyfin's poster wasn't a JPEG, PNG or WebP picture."))?;
    Ok(Poster {
        bytes: response.body,
        content_type,
        extension,
    })
}

fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_addresses_are_understood() {
        let id = "UCabcdefghijklmnopqrstuv";
        assert!(matches!(youtube_ref(id), Ok(YoutubeRef::Channel(found)) if found == id));
        assert!(matches!(
            youtube_ref(&format!("https://www.youtube.com/channel/{id}/videos")),
            Ok(YoutubeRef::Channel(found)) if found == id
        ));
        assert!(
            matches!(youtube_ref("@lanternworks"), Ok(YoutubeRef::Page(path)) if path == "/@lanternworks")
        );
        assert!(matches!(
            youtube_ref("youtube.com/@lanternworks/videos"),
            Ok(YoutubeRef::Page(path)) if path == "/@lanternworks"
        ));
        assert!(matches!(
            youtube_ref("https://youtu.be/dQw4w9WgXcQ?t=3"),
            Ok(YoutubeRef::Page(path)) if path == "/watch?v=dQw4w9WgXcQ"
        ));
        assert!(matches!(
            youtube_ref("https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x"),
            Ok(YoutubeRef::Page(path)) if path == "/watch?v=dQw4w9WgXcQ"
        ));
        assert!(matches!(
            youtube_ref("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
            Ok(YoutubeRef::Page(path)) if path == "/watch?v=dQw4w9WgXcQ"
        ));
        assert!(youtube_ref("https://vimeo.com/123").is_err());
        assert!(youtube_ref("https://www.youtube.com/").is_err());
    }

    #[test]
    fn a_channel_id_is_found_on_its_pages() {
        let base = Url::parse("https://www.youtube.com").expect("base");
        let channel_page = r#"<html><head><link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"></head></html>"#;
        assert_eq!(
            channel_id_in_page(channel_page, &base).as_deref(),
            Some("UCabcdefghijklmnopqrstuv")
        );
        let watch_page = r#"<html><head><meta itemprop="channelId" content="UCzyxwvutsrqponmlkjihgfe"></head></html>"#;
        assert_eq!(
            channel_id_in_page(watch_page, &base).as_deref(),
            Some("UCzyxwvutsrqponmlkjihgfe")
        );
        let scripted = r#"<html><script>var x = {"videoDetails":{"channelId":"UC0123456789012345678901"}};</script></html>"#;
        assert_eq!(
            channel_id_in_page(scripted, &base).as_deref(),
            Some("UC0123456789012345678901")
        );
    }

    #[test]
    fn github_repositories_are_understood() {
        assert_eq!(
            github_repo("paracord/paracord").unwrap(),
            ("paracord".to_string(), "paracord".to_string())
        );
        assert_eq!(
            github_repo("https://github.com/tokio-rs/axum/releases").unwrap(),
            ("tokio-rs".to_string(), "axum".to_string())
        );
        assert_eq!(
            github_repo("github.com/a/b.git").unwrap(),
            ("a".to_string(), "b".to_string())
        );
        assert!(github_repo("not a repo").is_err());
        assert!(github_repo("https://gitlab.com/a/b").is_err());
        assert!(github_repo("a/..").is_err());
        assert!(valid_branch("release/3.2"));
        assert!(!valid_branch("../etc"));
        assert!(!valid_branch("main branch"));
    }

    #[test]
    fn twitch_logins_are_understood() {
        assert_eq!(twitch_login("LanternWorks").unwrap(), "lanternworks");
        assert_eq!(
            twitch_login("https://www.twitch.tv/lantern_works/videos").unwrap(),
            "lantern_works"
        );
        assert!(twitch_login("no").is_err());
        assert!(twitch_login("bad name").is_err());
    }

    #[test]
    fn jellyfin_items_read_as_cards() {
        let base = jellyfin_base("http://192.168.1.20:8096/web/index.html#/home").unwrap();
        assert_eq!(base.as_str(), "http://192.168.1.20:8096/");
        let movie = json!({
            "Id": "m1", "Name": "Arrival", "Type": "Movie", "ProductionYear": 2016,
            "Overview": "<p>Linguist.</p>", "DateCreated": "2026-09-22T10:00:00.0000000Z",
            "ImageTags": { "Primary": "tag" }
        });
        let card = jellyfin_item(&base, &movie).unwrap();
        assert_eq!(card.title, "Arrival (2016)");
        assert_eq!(card.poster_ref.as_deref(), Some("m1"));
        assert_eq!(card.summary.as_deref(), Some("Linguist."));
        assert!(card.published_at.is_some());
        let episode = json!({
            "Id": "e1", "Name": "Hello, Ms. Cobel", "Type": "Episode",
            "SeriesName": "Severance", "SeriesId": "s1", "SeriesPrimaryImageTag": "t",
            "ParentIndexNumber": 2, "IndexNumber": 1
        });
        let card = jellyfin_item(&base, &episode).unwrap();
        assert_eq!(card.title, "Severance · S2E1 · Hello, Ms. Cobel");
        assert_eq!(card.poster_ref.as_deref(), Some("s1"));
        assert_eq!(card.group.as_deref(), Some("series:s1"));
        assert_eq!(
            card.link.as_deref(),
            Some("http://192.168.1.20:8096/web/#/details?id=s1")
        );
        assert!(jellyfin_item(&base, &json!({ "Id": "x", "Type": "Folder" })).is_none());
    }

    #[test]
    fn only_real_pictures_are_posters() {
        assert_eq!(
            sniff_image(&[0xff, 0xd8, 0xff, 0xe0]).map(|p| p.0),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image(b"<svg onload=alert(1)>"), None);
    }
}
