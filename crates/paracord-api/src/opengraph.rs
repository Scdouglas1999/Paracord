//! OpenGraph / link-preview fetching.
//!
//! After a message is created the API spawns a background task that:
//!   1. Extracts HTTP/HTTPS URLs from the message content.
//!   2. Fetches each URL (with a short timeout) and parses `<meta og:*>` tags.
//!   3. Stores the resulting embeds JSON on the message row.
//!   4. Dispatches a `MESSAGE_UPDATE` gateway event so connected clients can
//!      render the preview inline.

use paracord_core::AppState;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::time::Duration;
use url::{Host, Url};

const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_URLS_PER_MESSAGE: usize = 5;
const MAX_RESPONSE_BYTES: usize = 512 * 1024; // 512 KiB
const MAX_REDIRECTS: usize = 3;

/// Extract all `http://` / `https://` URLs from plain text.
pub fn extract_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((i, _)) = chars.next() {
        let rest = &text[i..];
        if rest.starts_with("http://") || rest.starts_with("https://") {
            // Collect until whitespace or end of string
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '>' || c == '<')
                .unwrap_or(rest.len());
            let url =
                rest[..end].trim_end_matches(|c| matches!(c, '.' | ',' | ')' | ']' | '!' | '?'));
            if !url.is_empty() {
                urls.push(url.to_string());
            }
        }
    }
    urls.sort();
    urls.dedup();
    urls.truncate(MAX_URLS_PER_MESSAGE);
    urls
}

/// Fetch a single URL and extract OpenGraph metadata.
/// Returns `None` if fetching fails or no OG tags are found.
async fn fetch_og(client: &reqwest::Client, url: &str) -> Option<Value> {
    let mut current_url = Url::parse(url).ok()?;
    let mut redirects = 0usize;
    let resp = loop {
        validate_ssrf_target(&current_url).await?;

        let resp = client
            .get(current_url.clone())
            .header("User-Agent", "Mozilla/5.0 (compatible; ParacordBot/1.0)")
            .timeout(FETCH_TIMEOUT)
            .send()
            .await
            .ok()?;

        if resp.status().is_redirection() {
            if redirects >= MAX_REDIRECTS {
                return None;
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())?;
            current_url = current_url.join(location).ok()?;
            redirects += 1;
            continue;
        }

        break resp;
    };

    if !resp.status().is_success() {
        return None;
    }

    // Only parse text/html responses
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !content_type.contains("html") {
        return None;
    }

    // Read with a hard cap instead of buffering the entire response first.
    let final_url = resp.url().to_string();
    let mut resp = resp;
    let mut body = Vec::with_capacity(MAX_RESPONSE_BYTES.min(64 * 1024));
    while body.len() < MAX_RESPONSE_BYTES {
        let Some(chunk) = resp.chunk().await.ok()? else {
            break;
        };
        let remaining = MAX_RESPONSE_BYTES - body.len();
        if chunk.len() > remaining {
            body.extend_from_slice(&chunk[..remaining]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    let html = std::str::from_utf8(&body).unwrap_or("");

    parse_og_tags(html, &final_url)
}

fn is_private_or_reserved_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || o[0] == 127
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 192 && o[1] == 0 && o[2] == 2)
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)
                || (224..=239).contains(&o[0])
                || o[0] == 0
                || o[0] >= 240
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_or_reserved_ip(&IpAddr::V4(v4));
            }
            v6.is_loopback()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link local
                || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8)
                || (v6.segments()[0] & 0xff00) == 0xff00
                || v6.is_unspecified()
        }
    }
}

async fn validate_ssrf_target(url: &Url) -> Option<()> {
    match url.scheme() {
        "http" | "https" => {}
        _ => return None,
    }

    let port = url.port_or_known_default()?;
    match url.host()? {
        Host::Ipv4(v4) => {
            if is_private_or_reserved_ip(&IpAddr::V4(v4)) {
                return None;
            }
        }
        Host::Ipv6(v6) => {
            if is_private_or_reserved_ip(&IpAddr::V6(v6)) {
                return None;
            }
        }
        Host::Domain(domain) => {
            let lowered = domain.to_ascii_lowercase();
            let blocked_hosts = [
                "localhost",
                "metadata.google.internal",
                "metadata",
                "local",
                "home.arpa",
            ];
            for blocked in blocked_hosts {
                if lowered == blocked || lowered.ends_with(&format!(".{blocked}")) {
                    return None;
                }
            }

            let lookup = format!("{domain}:{port}");
            let mut has_ip = false;
            let addrs = tokio::net::lookup_host(&lookup).await.ok()?;
            for addr in addrs {
                has_ip = true;
                if is_private_or_reserved_ip(&addr.ip()) {
                    return None;
                }
            }
            if !has_ip {
                return None;
            }
        }
    }

    Some(())
}

/// Parse `<meta property="og:*" content="...">` tags from HTML.
fn parse_og_tags(html: &str, page_url: &str) -> Option<Value> {
    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut image: Option<String> = None;
    let mut site_name: Option<String> = None;

    // Walk through <meta ...> tags
    let mut pos = 0;
    while let Some(tag_start) = html[pos..].find("<meta") {
        pos += tag_start;
        let tag_end = html[pos..]
            .find('>')
            .map(|e| pos + e + 1)
            .unwrap_or(html.len());
        let tag = &html[pos..tag_end];
        pos = tag_end;

        // Extract property and content attributes
        let property = extract_attr(tag, "property").or_else(|| extract_attr(tag, "name"));
        let content = extract_attr(tag, "content");

        if let (Some(prop), Some(content)) = (property, content) {
            match prop.as_str() {
                "og:title" | "twitter:title" => {
                    if title.is_none() {
                        title = Some(content);
                    }
                }
                "og:description" | "twitter:description" => {
                    if description.is_none() {
                        description = Some(content);
                    }
                }
                "og:image" | "twitter:image" | "twitter:image:src" => {
                    if image.is_none() {
                        image = Some(content);
                    }
                }
                "og:site_name" => {
                    if site_name.is_none() {
                        site_name = Some(content);
                    }
                }
                _ => {}
            }
        }
    }

    // Fall back to <title> tag if no og:title
    if title.is_none() {
        if let Some(start) = html.find("<title") {
            if let Some(content_start) = html[start..].find('>') {
                let after_tag = &html[start + content_start + 1..];
                if let Some(end) = after_tag.find("</title") {
                    let raw = &after_tag[..end];
                    let trimmed = raw.trim().to_string();
                    if !trimmed.is_empty() {
                        title = Some(trimmed);
                    }
                }
            }
        }
    }

    // Require at least a title or description to emit an embed
    if title.is_none() && description.is_none() {
        return None;
    }

    let embed = json!({
        "type": "link",
        "url": page_url,
        "title": title,
        "description": description,
        "thumbnail": image.map(|url| json!({ "url": url })),
        "provider": site_name.map(|name| json!({ "name": name })),
    });

    Some(embed)
}

/// Extract an HTML attribute value by name from a raw tag string.
/// Handles both double-quoted and single-quoted values.
fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    // Try `attr="..."` or `attr='...'`
    let lower = tag.to_lowercase();
    for quote in ['"', '\''] {
        let needle = format!("{}={}", attr, quote);
        if let Some(start) = lower.find(&needle) {
            let after = &tag[start + needle.len()..];
            if let Some(end) = after.find(quote) {
                let val = html_decode(&after[..end]);
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }
    }
    None
}

/// Minimal HTML entity decode for common entities.
fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&apos;", "'")
}

/// Spawn a background task that fetches OpenGraph data for URLs in a message
/// and dispatches a `MESSAGE_UPDATE` event when complete.
pub fn spawn_opengraph_task(
    state: AppState,
    msg_id: i64,
    channel_id: i64,
    guild_id: Option<i64>,
    content: String,
) {
    tokio::spawn(async move {
        let urls = extract_urls(&content);
        if urls.is_empty() {
            return;
        }

        let client = match reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        let mut embeds: Vec<Value> = Vec::new();
        for url in &urls {
            if let Some(embed) = fetch_og(&client, url).await {
                embeds.push(embed);
            }
        }

        if embeds.is_empty() {
            return;
        }

        let embeds_json = match serde_json::to_string(&embeds) {
            Ok(j) => j,
            Err(_) => return,
        };

        // Persist embeds to DB
        if paracord_db::messages::update_message_embeds(&state.db, msg_id, &embeds_json)
            .await
            .is_err()
        {
            return;
        }

        // Fetch the updated message to build a full MESSAGE_UPDATE payload
        let msg = match paracord_db::messages::get_message_with_embeds(&state.db, msg_id).await {
            Ok(Some(m)) => m,
            _ => return,
        };

        let embeds_value: Value = serde_json::from_str(&embeds_json).unwrap_or(json!([]));

        let update_payload = json!({
            "id": msg.id.to_string(),
            "channel_id": msg.channel_id.to_string(),
            "embeds": embeds_value,
        });

        if let Some(gid) = guild_id {
            state
                .event_bus
                .dispatch("MESSAGE_UPDATE", update_payload, Some(gid));
        } else {
            // DM channel: deliver to participants
            if let Ok(recipient_ids) =
                paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id).await
            {
                state
                    .event_bus
                    .dispatch_to_users("MESSAGE_UPDATE", update_payload, recipient_ids);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn test_extract_urls_basic() {
        let text = "Check out https://example.com and http://foo.bar/path?q=1";
        let urls = extract_urls(text);
        assert!(urls.contains(&"https://example.com".to_string()));
        assert!(urls.contains(&"http://foo.bar/path?q=1".to_string()));
    }

    #[test]
    fn test_extract_urls_strips_trailing_punctuation() {
        let text = "See https://example.com.";
        let urls = extract_urls(text);
        assert_eq!(urls, vec!["https://example.com".to_string()]);
    }

    #[test]
    fn test_extract_urls_deduplicates() {
        let text = "https://example.com https://example.com";
        let urls = extract_urls(text);
        assert_eq!(urls.len(), 1);
    }

    #[test]
    fn test_extract_urls_no_urls() {
        let urls = extract_urls("no urls here");
        assert!(urls.is_empty());
    }

    #[test]
    fn test_parse_og_tags() {
        let html = r#"<html><head>
            <meta property="og:title" content="Hello World">
            <meta property="og:description" content="A test page">
            <meta property="og:image" content="https://example.com/img.png">
        </head></html>"#;
        let embed = parse_og_tags(html, "https://example.com").unwrap();
        assert_eq!(embed["title"], "Hello World");
        assert_eq!(embed["description"], "A test page");
        assert_eq!(embed["thumbnail"]["url"], "https://example.com/img.png");
    }

    #[test]
    fn test_parse_og_tags_falls_back_to_title_tag() {
        let html = "<html><head><title>Page Title</title></head></html>";
        let embed = parse_og_tags(html, "https://example.com").unwrap();
        assert_eq!(embed["title"], "Page Title");
    }

    #[test]
    fn test_parse_og_tags_no_meta_returns_none() {
        let html = "<html><head></head></html>";
        let embed = parse_og_tags(html, "https://example.com");
        assert!(embed.is_none());
    }

    #[test]
    fn test_private_ip_detection_blocks_local_ranges() {
        assert!(is_private_or_reserved_ip(&IpAddr::V4(Ipv4Addr::new(
            127, 0, 0, 1
        ))));
        assert!(is_private_or_reserved_ip(&IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
        assert!(is_private_or_reserved_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_private_or_reserved_ip(&IpAddr::V6(
            "fc00::1".parse().expect("valid IPv6"),
        )));
    }

    #[test]
    fn test_private_ip_detection_blocks_reserved_documentation_and_multicast_ranges() {
        assert!(is_private_or_reserved_ip(&IpAddr::V4(Ipv4Addr::new(
            192, 0, 2, 1
        ))));
        assert!(is_private_or_reserved_ip(&IpAddr::V4(Ipv4Addr::new(
            198, 51, 100, 1
        ))));
        assert!(is_private_or_reserved_ip(&IpAddr::V4(Ipv4Addr::new(
            203, 0, 113, 1
        ))));
        assert!(is_private_or_reserved_ip(&IpAddr::V4(Ipv4Addr::new(
            224, 0, 0, 1
        ))));
        assert!(is_private_or_reserved_ip(&IpAddr::V6(
            "2001:db8::1".parse().expect("valid IPv6"),
        )));
        assert!(is_private_or_reserved_ip(&IpAddr::V6(
            "ff02::1".parse().expect("valid IPv6"),
        )));
    }

    #[tokio::test]
    async fn test_validate_ssrf_target_blocks_metadata_aliases_and_local_domains() {
        for raw in [
            "https://metadata/latest/meta-data/",
            "https://foo.metadata/computeMetadata/v1/",
            "https://printer.local/status",
            "https://router.home.arpa/status",
        ] {
            let url = Url::parse(raw).expect("valid URL");
            assert!(validate_ssrf_target(&url).await.is_none(), "{raw}");
        }
    }

    #[test]
    fn test_private_ip_detection_allows_public_ips() {
        assert!(!is_private_or_reserved_ip(&IpAddr::V4(Ipv4Addr::new(
            8, 8, 8, 8
        ))));
        assert!(!is_private_or_reserved_ip(&IpAddr::V6(
            "2606:4700:4700::1111".parse().expect("valid IPv6"),
        )));
    }
}
