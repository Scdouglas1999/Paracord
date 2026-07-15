use sha2::{Digest, Sha256};

pub const DEFAULT_MAX_SKEW_MS: i64 = 60_000;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

pub fn request_path_from_url(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            let mut out = parsed.path().to_string();
            if let Some(query) = parsed.query() {
                out.push('?');
                out.push_str(query);
            }
            out
        }
        Err(_) => "/".to_string(),
    }
}

/// Extract the destination authority (host, lowercased, without port) that a
/// request URL targets. This is the stable identity the receiving server is
/// expected to recognize as itself (its `server_name`/`domain`), and is folded
/// into the transport signature so a request signed for one server cannot be
/// replayed/forwarded to a different trusting server.
pub fn destination_from_url(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default()
}

pub fn canonical_transport_bytes(
    method: &str,
    path: &str,
    timestamp_ms: i64,
    body_hash_hex: &str,
) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        path,
        timestamp_ms,
        body_hash_hex
    )
    .into_bytes()
}

pub fn canonical_transport_bytes_with_body(
    method: &str,
    path: &str,
    timestamp_ms: i64,
    body: &[u8],
) -> Vec<u8> {
    canonical_transport_bytes(method, path, timestamp_ms, &sha256_hex(body))
}

/// Canonical bytes that additionally bind the intended destination server
/// (`destination`, an authority/host the receiver recognizes as itself). The
/// destination is appended as a trailing line so it is unambiguously part of
/// the signed material; a request signed for one destination fails verification
/// at any other server.
pub fn canonical_transport_bytes_with_destination(
    method: &str,
    path: &str,
    timestamp_ms: i64,
    body_hash_hex: &str,
    destination: &str,
) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        path,
        timestamp_ms,
        body_hash_hex,
        destination.to_ascii_lowercase()
    )
    .into_bytes()
}

pub fn canonical_transport_bytes_with_body_and_destination(
    method: &str,
    path: &str,
    timestamp_ms: i64,
    body: &[u8],
    destination: &str,
) -> Vec<u8> {
    canonical_transport_bytes_with_destination(
        method,
        path,
        timestamp_ms,
        &sha256_hex(body),
        destination,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_bytes_stable() {
        let got = canonical_transport_bytes("POST", "/_paracord/federation/v1/event", 123, "abc");
        assert_eq!(
            String::from_utf8(got).expect("utf8"),
            "POST\n/_paracord/federation/v1/event\n123\nabc"
        );
    }

    #[test]
    fn canonical_bytes_bind_destination() {
        let got = canonical_transport_bytes_with_destination(
            "POST",
            "/_paracord/federation/v1/event",
            123,
            "abc",
            "Example.ORG",
        );
        assert_eq!(
            String::from_utf8(got).expect("utf8"),
            "POST\n/_paracord/federation/v1/event\n123\nabc\nexample.org"
        );
    }

    #[test]
    fn destination_differs_by_receiver() {
        // The same request signed for two different destinations produces
        // different canonical bytes, so a signature valid for one server cannot
        // be replayed/forwarded to another.
        let for_a = canonical_transport_bytes_with_destination(
            "POST",
            "/_paracord/federation/v1/event",
            123,
            "abc",
            "a.example",
        );
        let for_c = canonical_transport_bytes_with_destination(
            "POST",
            "/_paracord/federation/v1/event",
            123,
            "abc",
            "c.example",
        );
        assert_ne!(for_a, for_c);
    }

    #[test]
    fn destination_from_url_extracts_host() {
        assert_eq!(
            destination_from_url("https://Example.ORG:8443/_paracord/federation/v1/event"),
            "example.org"
        );
        assert_eq!(destination_from_url("not a url"), "");
    }
}
