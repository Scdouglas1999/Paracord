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
}
