//! RSS 2.0, RSS 1.0 (RDF) and Atom 1.0, read into one shape.
//!
//! quick-xml never expands external entities or DTDs, so a hostile feed cannot
//! read files or reach the network through its parser.

use chrono::{DateTime, Utc};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Longest summary on a card, in characters.
pub const SUMMARY_CHARS: usize = 300;
const TITLE_CHARS: usize = 256;
const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 60_000;
/// Items read from one document.
pub const MAX_ITEMS: usize = 100;

/// One entry from a source, in the form every card is built from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct FeedItem {
    /// Dedupe key: guid/id, else link, else a hash of title and date.
    pub key: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<DateTime<Utc>>,
    /// A picture on the open internet (a YouTube thumbnail, a feed's media).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    /// A picture the instance must fetch itself (a Jellyfin poster id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_ref: Option<String>,
    /// Groups items into one card (a Jellyfin series).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_title: Option<String>,
    /// Keys of the items a grouped card stands for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedFeed {
    pub title: Option<String>,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    /// Newest first.
    pub items: Vec<FeedItem>,
}

// ── A small element tree over quick-xml ───────────────────────────────────

#[derive(Debug, Default, Clone)]
pub(crate) struct Node {
    /// Local name, lower case (`media:thumbnail` → `thumbnail`).
    pub name: String,
    /// Namespace prefix, lower case (`media`), empty when none.
    pub prefix: String,
    pub attrs: Vec<(String, String)>,
    pub text: String,
    pub children: Vec<Node>,
}

impl Node {
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|node| node.name == name)
    }

    pub fn child_with_prefix(&self, prefix: &str, name: &str) -> Option<&Node> {
        self.children
            .iter()
            .find(|node| node.name == name && node.prefix == prefix)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |node| node.name == name)
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn trimmed(&self) -> Option<String> {
        let text = self.text.trim();
        (!text.is_empty()).then(|| text.to_string())
    }

    pub fn text_of(&self, name: &str) -> Option<String> {
        self.child(name).and_then(Node::trimmed)
    }
}

fn split_name(raw: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(raw).to_ascii_lowercase();
    match text.split_once(':') {
        Some((prefix, local)) => (prefix.to_string(), local.to_string()),
        None => (String::new(), text),
    }
}

fn element(start: &quick_xml::events::BytesStart<'_>) -> Node {
    let (prefix, name) = split_name(start.name().as_ref());
    let mut attrs = Vec::new();
    for attr in start.attributes().with_checks(false).flatten() {
        let (_, key) = split_name(attr.key.as_ref());
        let value = attr
            .normalized_value(quick_xml::XmlVersion::default())
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&attr.value).into_owned());
        attrs.push((key, value));
    }
    Node {
        name,
        prefix,
        attrs,
        ..Node::default()
    }
}

/// Parse a document into its root element.
pub(crate) fn parse_xml(text: &str) -> Result<Node, String> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().check_end_names = false;
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    let mut nodes = 0usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|err| format!("not valid XML ({err})"))?;
        match event {
            Event::Start(start) => {
                nodes += 1;
                if stack.len() >= MAX_DEPTH || nodes > MAX_NODES {
                    return Err("the document is too deeply nested or too large".to_string());
                }
                stack.push(element(&start));
            }
            Event::Empty(start) => {
                nodes += 1;
                if nodes > MAX_NODES {
                    return Err("the document is too large".to_string());
                }
                let node = element(&start);
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => {
                        if root.is_none() {
                            root = Some(node);
                        }
                    }
                }
            }
            Event::End(_) => {
                if let Some(node) = stack.pop() {
                    match stack.last_mut() {
                        Some(parent) => parent.children.push(node),
                        None => {
                            if root.is_none() {
                                root = Some(node);
                            }
                        }
                    }
                }
            }
            Event::Text(text) => {
                if let Some(node) = stack.last_mut() {
                    let decoded = text
                        .decode()
                        .map(|value| value.into_owned())
                        .unwrap_or_default();
                    node.text.push_str(&decoded);
                }
            }
            Event::CData(data) => {
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&String::from_utf8_lossy(&data));
                }
            }
            Event::GeneralRef(reference) => {
                if let Some(node) = stack.last_mut() {
                    let resolved = match reference.resolve_char_ref() {
                        Ok(Some(ch)) => ch.to_string(),
                        _ => {
                            let name = String::from_utf8_lossy(&reference).into_owned();
                            named_entity(&name)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("&{name};"))
                        }
                    };
                    node.text.push_str(&resolved);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    // An unclosed document still yields what was read.
    while let Some(node) = stack.pop() {
        match stack.last_mut() {
            Some(parent) => parent.children.push(node),
            None => {
                if root.is_none() {
                    root = Some(node);
                }
            }
        }
    }
    root.ok_or_else(|| "the document is empty".to_string())
}

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "middot" => "·",
        "bull" => "•",
        _ => return None,
    })
}

// ── Feeds ─────────────────────────────────────────────────────────────────

/// Whether a body is an HTML page rather than a feed.
pub fn looks_like_html(body: &str) -> bool {
    let head: String = body
        .trim_start_matches('\u{feff}')
        .trim_start()
        .chars()
        .take(512)
        .collect::<String>()
        .to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html") || head.contains("<html")
}

/// Parse a feed document. `base` resolves relative links.
pub fn parse_feed(body: &str, base: &Url) -> Result<ParsedFeed, String> {
    let root = parse_xml(body.trim_start_matches('\u{feff}'))?;
    match root.name.as_str() {
        "rss" => {
            let channel = root
                .child("channel")
                .ok_or_else(|| "an RSS document without a channel".to_string())?;
            Ok(read_rss(channel, channel.children_named("item"), base))
        }
        "rdf" => {
            let channel = root
                .child("channel")
                .ok_or_else(|| "an RSS 1.0 document without a channel".to_string())?;
            Ok(read_rss(channel, root.children_named("item"), base))
        }
        "feed" => Ok(read_atom(&root, base)),
        other => Err(format!("a <{other}> document, not RSS or Atom")),
    }
}

fn read_rss<'a>(channel: &Node, items: impl Iterator<Item = &'a Node>, base: &Url) -> ParsedFeed {
    let site_url = channel
        .children_named("link")
        .find(|node| node.prefix.is_empty())
        .and_then(Node::trimmed)
        .and_then(|link| absolute_url(base, &link));
    let icon_url = channel
        .child("image")
        .and_then(|image| {
            image
                .text_of("url")
                .or_else(|| image.attr("href").map(str::to_string))
        })
        .and_then(|url| absolute_url(base, &url));
    let mut parsed: Vec<FeedItem> = items
        .take(MAX_ITEMS)
        .filter_map(|item| rss_item(item, base))
        .collect();
    sort_newest_first(&mut parsed);
    ParsedFeed {
        title: channel.text_of("title").map(|title| clean_title(&title)),
        site_url,
        icon_url,
        items: parsed,
    }
}

fn rss_item(item: &Node, base: &Url) -> Option<FeedItem> {
    let guid = item.text_of("guid");
    let link = item
        .children_named("link")
        .find(|node| node.prefix.is_empty() || node.prefix == "atom")
        .and_then(|node| {
            node.trimmed()
                .or_else(|| node.attr("href").map(str::to_string))
        })
        .or_else(|| {
            let guid_node = item.child("guid")?;
            let permalink = guid_node.attr("ispermalink").unwrap_or("true");
            if permalink.eq_ignore_ascii_case("false") {
                return None;
            }
            guid_node.trimmed()
        })
        .or_else(|| item.attr("about").map(str::to_string))
        .and_then(|link| absolute_url(base, &link));
    let summary_source = item
        .text_of("description")
        .or_else(|| {
            item.child_with_prefix("content", "encoded")
                .and_then(Node::trimmed)
        })
        .or_else(|| item.text_of("summary"));
    let published = item
        .text_of("pubdate")
        .or_else(|| item.text_of("date"))
        .or_else(|| item.text_of("published"))
        .or_else(|| item.text_of("updated"))
        .and_then(|raw| parse_date(&raw));
    let title = item
        .text_of("title")
        .map(|title| clean_title(&title))
        .filter(|title| !title.is_empty())
        .or_else(|| {
            summary_source
                .as_deref()
                .map(clean_title)
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "Untitled".to_string());
    let thumbnail = media_thumbnail(item, base);
    Some(FeedItem {
        key: dedupe_key(guid.as_deref(), link.as_deref(), &title, published),
        title,
        link,
        summary: summary_source.as_deref().and_then(summary_text),
        published_at: published,
        thumbnail_url: thumbnail,
        ..FeedItem::default()
    })
}

fn read_atom(feed: &Node, base: &Url) -> ParsedFeed {
    let site_url = atom_link(feed, base);
    let icon_url = feed
        .text_of("icon")
        .or_else(|| feed.text_of("logo"))
        .and_then(|url| absolute_url(base, &url));
    let mut items: Vec<FeedItem> = feed
        .children_named("entry")
        .take(MAX_ITEMS)
        .map(|entry| atom_entry(entry, base))
        .collect();
    sort_newest_first(&mut items);
    ParsedFeed {
        title: feed.text_of("title").map(|title| clean_title(&title)),
        site_url,
        icon_url,
        items,
    }
}

fn atom_link(node: &Node, base: &Url) -> Option<String> {
    let links: Vec<&Node> = node.children_named("link").collect();
    links
        .iter()
        .find(|link| matches!(link.attr("rel"), None | Some("alternate")))
        .or_else(|| links.first())
        .and_then(|link| link.attr("href"))
        .and_then(|href| absolute_url(base, href))
}

fn atom_entry(entry: &Node, base: &Url) -> FeedItem {
    let id = entry.text_of("id");
    let link = atom_link(entry, base);
    let group = entry.child_with_prefix("media", "group");
    let summary_source = entry
        .text_of("summary")
        .or_else(|| entry.text_of("content"))
        .or_else(|| group.and_then(|group| group.text_of("description")));
    let published = entry
        .text_of("published")
        .or_else(|| entry.text_of("updated"))
        .and_then(|raw| parse_date(&raw));
    let title = entry
        .text_of("title")
        .map(|title| clean_title(&title))
        .filter(|title| !title.is_empty())
        .or_else(|| {
            summary_source
                .as_deref()
                .map(clean_title)
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "Untitled".to_string());
    let video_id = entry
        .child_with_prefix("yt", "videoid")
        .and_then(Node::trimmed)
        .filter(|id| is_video_id(id));
    let thumbnail = group
        .and_then(|group| media_thumbnail(group, base))
        .or_else(|| media_thumbnail(entry, base));
    FeedItem {
        key: dedupe_key(id.as_deref(), link.as_deref(), &title, published),
        title,
        link,
        summary: summary_source.as_deref().and_then(summary_text),
        published_at: published,
        thumbnail_url: thumbnail,
        video_id,
        ..FeedItem::default()
    }
}

fn media_thumbnail(node: &Node, base: &Url) -> Option<String> {
    let candidate = node
        .child_with_prefix("media", "thumbnail")
        .and_then(|thumb| thumb.attr("url"))
        .or_else(|| {
            node.children
                .iter()
                .filter(|child| child.prefix == "media" && child.name == "content")
                .find(|content| {
                    content.attr("medium") == Some("image")
                        || content
                            .attr("type")
                            .is_some_and(|kind| kind.starts_with("image/"))
                })
                .and_then(|content| content.attr("url"))
        })
        .or_else(|| {
            node.children_named("enclosure")
                .find(|enclosure| {
                    enclosure
                        .attr("type")
                        .is_some_and(|kind| kind.starts_with("image/"))
                })
                .and_then(|enclosure| enclosure.attr("url"))
        })
        .or_else(|| {
            node.child_with_prefix("itunes", "image")
                .and_then(|image| image.attr("href"))
        })?;
    absolute_url(base, candidate)
}

fn sort_newest_first(items: &mut [FeedItem]) {
    // Stable: items without a date keep the document's order, which feeds
    // write newest first.
    items.sort_by(|a, b| match (a.published_at, b.published_at) {
        (Some(a), Some(b)) => b.cmp(&a),
        _ => std::cmp::Ordering::Equal,
    });
}

pub fn dedupe_key(
    id: Option<&str>,
    link: Option<&str>,
    title: &str,
    published: Option<DateTime<Utc>>,
) -> String {
    if let Some(id) = id.map(str::trim).filter(|id| !id.is_empty()) {
        return clip(id, 512);
    }
    if let Some(link) = link.map(str::trim).filter(|link| !link.is_empty()) {
        return clip(link, 512);
    }
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0]);
    if let Some(published) = published {
        hasher.update(published.to_rfc3339().as_bytes());
    }
    let digest = hasher.finalize();
    let hex: String = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("hash:{hex}")
}

fn clip(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

pub fn parse_date(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if let Ok(date) = DateTime::parse_from_rfc3339(raw) {
        return Some(date.with_timezone(&Utc));
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(raw) {
        return Some(date.with_timezone(&Utc));
    }
    // RFC 822 dates with a named zone chrono does not know ("EST" is known,
    // "PDT" and friends too; "UT" and "Z" are not).
    let normalized = raw
        .trim_end_matches(" UT")
        .trim_end_matches(" Z")
        .to_string();
    if normalized != raw {
        if let Ok(date) = DateTime::parse_from_rfc2822(&format!("{normalized} +0000")) {
            return Some(date.with_timezone(&Utc));
        }
    }
    // A bare date or a date-time without a zone reads as UTC.
    if let Ok(date) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
        return Some(date.and_utc());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0).map(|date| date.and_utc());
    }
    None
}

pub fn absolute_url(base: &Url, raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let url = base.join(raw).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

pub fn is_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

/// A title as one plain line.
pub fn clean_title(raw: &str) -> String {
    let text = strip_html(raw);
    truncate_chars(&text, TITLE_CHARS)
}

/// A summary as plain text: HTML removed, whitespace collapsed, at most 300
/// characters.
pub fn summary_text(raw: &str) -> Option<String> {
    let text = strip_html(raw);
    (!text.is_empty()).then(|| truncate_chars(&text, SUMMARY_CHARS))
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// HTML to plain text: tags removed (scripts and styles with their content),
/// entities decoded, whitespace collapsed.
pub fn strip_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let lower: String = after
            .chars()
            .take(8)
            .collect::<String>()
            .to_ascii_lowercase();
        let skip_to = if lower.starts_with("<script") {
            Some("</script")
        } else if lower.starts_with("<style") {
            Some("</style")
        } else if lower.starts_with("<!--") {
            Some("-->")
        } else {
            None
        };
        if let Some(closer) = skip_to {
            match find_ascii_ci(after, closer) {
                Some(end) => {
                    let tail = &after[end..];
                    rest = tail.find('>').map(|gt| &tail[gt + 1..]).unwrap_or("");
                }
                None => rest = "",
            }
            out.push(' ');
            continue;
        }
        match after.find('>') {
            Some(end) => {
                out.push(' ');
                rest = &after[end + 1..];
            }
            None => {
                // A lone "<" in text.
                out.push('<');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    let decoded = decode_entities(&out);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let hay = haystack.as_bytes();
    let ndl = needle.as_bytes();
    if ndl.is_empty() || hay.len() < ndl.len() {
        return None;
    }
    (0..=hay.len() - ndl.len()).find(|&i| hay[i..i + ndl.len()].eq_ignore_ascii_case(ndl))
}

pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp..];
        let Some(semi) = after[..after.len().min(12)].find(';') else {
            out.push('&');
            rest = &after[1..];
            continue;
        };
        let name = &after[1..semi];
        let decoded = if let Some(number) = name.strip_prefix('#') {
            let value = if let Some(hex) = number.strip_prefix(['x', 'X']) {
                u32::from_str_radix(hex, 16).ok()
            } else {
                number.parse::<u32>().ok()
            };
            value.and_then(char::from_u32).map(|ch| ch.to_string())
        } else {
            named_entity(name).map(str::to_string)
        };
        match decoded {
            Some(text) => {
                out.push_str(&text);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ── HTML pages ────────────────────────────────────────────────────────────

/// Every `<link>`/`<meta>` start tag in a page, as lower-case attribute maps.
fn tags_named<'a>(html: &'a str, tag: &'a str) -> impl Iterator<Item = Vec<(String, String)>> + 'a {
    let open = format!("<{tag}");
    let mut position = 0usize;
    std::iter::from_fn(move || loop {
        let start = position + find_ascii_ci(&html[position..], &open)?;
        let end = html[start..].find('>').map(|offset| start + offset + 1)?;
        position = end;
        let next = html.as_bytes().get(start + open.len()).copied();
        if !matches!(next, Some(b' ' | b'\t' | b'\n' | b'\r' | b'/')) {
            continue;
        }
        return Some(parse_attributes(&html[start + open.len()..end - 1]));
    })
}

fn parse_attributes(raw: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'/'
        {
            i += 1;
        }
        if name_start == i {
            break;
        }
        let name = raw[name_start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let value_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value = decode_entities(&raw[value_start..i.min(bytes.len())]);
                i += 1;
            } else {
                let value_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = decode_entities(&raw[value_start..i]);
            }
        }
        attrs.push((name, value));
    }
    attrs
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// The feeds a page announces with `<link rel="alternate">`, RSS or Atom,
/// in page order.
pub fn discover_feed_links(html: &str, base: &Url) -> Vec<String> {
    tags_named(html, "link")
        .filter(|attrs| {
            attr(attrs, "rel").is_some_and(|rel| {
                rel.split_whitespace()
                    .any(|part| part.eq_ignore_ascii_case("alternate"))
            }) && attr(attrs, "type").is_some_and(|kind| {
                let kind = kind.trim().to_ascii_lowercase();
                kind == "application/rss+xml" || kind == "application/atom+xml"
            })
        })
        .filter_map(|attrs| attr(&attrs, "href").and_then(|href| absolute_url(base, href)))
        .collect()
}

/// A page's `<meta property|name|itemprop=... content=...>`.
pub fn meta_content(html: &str, key: &str) -> Option<String> {
    tags_named(html, "meta").find_map(|attrs| {
        let names = ["property", "name", "itemprop"];
        let matches = names
            .iter()
            .any(|name| attr(&attrs, name).is_some_and(|value| value.eq_ignore_ascii_case(key)));
        if matches {
            attr(&attrs, "content")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        } else {
            None
        }
    })
}

/// `<link rel="canonical" href=...>`.
pub fn canonical_link(html: &str, base: &Url) -> Option<String> {
    tags_named(html, "link").find_map(|attrs| {
        let canonical =
            attr(&attrs, "rel").is_some_and(|rel| rel.eq_ignore_ascii_case("canonical"));
        if canonical {
            attr(&attrs, "href").and_then(|href| absolute_url(base, href))
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://example.com/blog/").expect("base")
    }

    const RSS2: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Lantern &amp; Co. Journal</title>
    <link>https://example.com/</link>
    <image><url>/icon.png</url></image>
    <item>
      <title>Older post</title>
      <link>https://example.com/older</link>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Mon, 21 Sep 2026 09:00:00 GMT</pubDate>
      <description>&lt;p&gt;Hello &lt;b&gt;there&lt;/b&gt;&amp;nbsp;friends.&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;</description>
    </item>
    <item>
      <title><![CDATA[Newer <em>post</em>]]></title>
      <link>/newer</link>
      <pubDate>Tue, 22 Sep 2026 10:30:00 +0200</pubDate>
      <content:encoded><![CDATA[<p>Rich &amp; long</p>]]></content:encoded>
      <media:thumbnail url="https://cdn.example.com/n.jpg"/>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn rss_two_is_read_newest_first() {
        let feed = parse_feed(RSS2, &base()).expect("rss");
        assert_eq!(feed.title.as_deref(), Some("Lantern & Co. Journal"));
        assert_eq!(feed.site_url.as_deref(), Some("https://example.com/"));
        assert_eq!(
            feed.icon_url.as_deref(),
            Some("https://example.com/icon.png")
        );
        assert_eq!(feed.items.len(), 2);
        let newer = &feed.items[0];
        assert_eq!(newer.title, "Newer post");
        assert_eq!(newer.link.as_deref(), Some("https://example.com/newer"));
        assert_eq!(newer.key, "https://example.com/newer");
        assert_eq!(newer.summary.as_deref(), Some("Rich & long"));
        assert_eq!(
            newer.thumbnail_url.as_deref(),
            Some("https://cdn.example.com/n.jpg")
        );
        let older = &feed.items[1];
        assert_eq!(older.key, "post-1");
        assert_eq!(older.summary.as_deref(), Some("Hello there friends."));
    }

    #[test]
    fn rss_one_is_read() {
        let doc = r#"<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example.org/">
    <title>Old School</title>
    <link>https://old.example.org/</link>
  </channel>
  <item rdf:about="https://old.example.org/a">
    <title>First</title>
    <link>https://old.example.org/a</link>
    <dc:date>2026-09-20T12:00:00Z</dc:date>
    <description>Plain words</description>
  </item>
</rdf:RDF>"#;
        let feed = parse_feed(doc, &base()).expect("rdf");
        assert_eq!(feed.title.as_deref(), Some("Old School"));
        assert_eq!(feed.items.len(), 1);
        assert_eq!(feed.items[0].key, "https://old.example.org/a");
        assert!(feed.items[0].published_at.is_some());
    }

    #[test]
    fn atom_and_youtube_entries_are_read() {
        let doc = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Lantern Works</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
 <entry>
  <id>yt:video:dQw4w9WgXcQ</id>
  <yt:videoId>dQw4w9WgXcQ</yt:videoId>
  <title>Building the lantern</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
  <published>2026-09-22T15:00:00+00:00</published>
  <media:group>
   <media:thumbnail url="https://i1.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
   <media:description>How we made it.</media:description>
  </media:group>
 </entry>
</feed>"#;
        let feed = parse_feed(doc, &base()).expect("atom");
        assert_eq!(feed.title.as_deref(), Some("Lantern Works"));
        let item = &feed.items[0];
        assert_eq!(item.key, "yt:video:dQw4w9WgXcQ");
        assert_eq!(item.video_id.as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(item.summary.as_deref(), Some("How we made it."));
        assert_eq!(
            item.thumbnail_url.as_deref(),
            Some("https://i1.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
        );
    }

    #[test]
    fn dedupe_falls_back_from_id_to_link_to_a_hash() {
        assert_eq!(dedupe_key(Some("a"), Some("b"), "t", None), "a");
        assert_eq!(dedupe_key(None, Some("b"), "t", None), "b");
        let one = dedupe_key(None, None, "Title", None);
        let two = dedupe_key(None, None, "Title", None);
        assert_eq!(one, two);
        assert!(one.starts_with("hash:"));
        assert_ne!(one, dedupe_key(None, None, "Other", None));
    }

    #[test]
    fn summaries_are_plain_and_clipped() {
        let long = format!("<p>{}</p>", "word ".repeat(200));
        let summary = summary_text(&long).expect("summary");
        assert!(summary.chars().count() <= SUMMARY_CHARS);
        assert!(summary.ends_with('…'));
        assert_eq!(
            summary_text("<style>p{}</style>Hi&#33; &#x263A;").as_deref(),
            Some("Hi! ☺")
        );
        assert_eq!(summary_text("<br/>  "), None);
    }

    #[test]
    fn html_pages_announce_their_feeds() {
        let page = r#"<!doctype html><html><head>
<link rel="stylesheet" href="/s.css">
<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
<link type="application/atom+xml" rel="alternate" href='https://other.example/atom'>
<meta property="og:image" content="https://cdn.example.com/og.png">
</head></html>"#;
        assert!(looks_like_html(page));
        assert_eq!(
            discover_feed_links(page, &base()),
            vec![
                "https://example.com/feed.xml".to_string(),
                "https://other.example/atom".to_string()
            ]
        );
        assert_eq!(
            meta_content(page, "og:image").as_deref(),
            Some("https://cdn.example.com/og.png")
        );
    }

    #[test]
    fn other_xml_is_not_a_feed() {
        assert!(parse_feed("<svg></svg>", &base()).is_err());
        assert!(parse_feed("not xml at all <<<", &base()).is_err());
    }

    #[test]
    fn external_entities_are_never_expanded() {
        let doc = r#"<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss><channel><title>&xxe;</title><item><title>a</title><link>https://e.x/a</link></item></channel></rss>"#;
        let feed = parse_feed(doc, &base()).expect("rss");
        assert_eq!(feed.title.as_deref(), Some("&xxe;"));
    }

    #[test]
    fn dates_in_the_usual_spellings_parse() {
        for raw in [
            "Tue, 22 Sep 2026 10:30:00 +0200",
            "Tue, 22 Sep 2026 10:30:00 GMT",
            "22 Sep 2026 10:30:00 EST",
            "2026-09-22T10:30:00Z",
            "2026-09-22T10:30:00.123+02:00",
            "2026-09-22",
        ] {
            assert!(parse_date(raw).is_some(), "{raw}");
        }
    }
}
