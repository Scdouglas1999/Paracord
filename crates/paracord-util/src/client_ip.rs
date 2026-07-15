//! Shared client-address resolution for HTTP and WebSocket trust boundaries.
//!
//! Forwarded addresses are accepted only from an explicitly trusted socket
//! peer. The chain is then walked from right to left so an attacker-supplied
//! leftmost value cannot bypass per-client controls when a proxy appends to an
//! existing `X-Forwarded-For` header.

use std::net::{IpAddr, Ipv6Addr};

const MAX_FORWARDED_HEADER_LEN: usize = 4096;
const MAX_FORWARDED_HOPS: usize = 32;

pub fn trust_proxy_enabled() -> bool {
    std::env::var("PARACORD_TRUST_PROXY")
        .ok()
        .is_some_and(|value| value.eq_ignore_ascii_case("true") || value == "1")
}

pub fn trusted_proxy_specs() -> Vec<String> {
    std::env::var("PARACORD_TRUSTED_PROXY_IPS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Return whether an IP matches an exact address or CIDR allowlist entry.
pub fn ip_matches_spec(ip: IpAddr, spec: &str) -> bool {
    let spec = spec.trim();
    if let Some((network, prefix)) = spec.split_once('/') {
        let Ok(network) = network.trim().parse::<IpAddr>() else {
            return false;
        };
        let Ok(prefix) = prefix.trim().parse::<u8>() else {
            return false;
        };
        return match (ip, network) {
            (IpAddr::V4(ip), IpAddr::V4(network)) if prefix <= 32 => {
                let mask = if prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - prefix)
                };
                (u32::from(ip) & mask) == (u32::from(network) & mask)
            }
            (IpAddr::V6(ip), IpAddr::V6(network)) if prefix <= 128 => {
                let mask = if prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - prefix)
                };
                (u128::from(ip) & mask) == (u128::from(network) & mask)
            }
            _ => false,
        };
    }

    spec.parse::<IpAddr>().is_ok_and(|trusted| trusted == ip)
}

pub fn peer_is_trusted(peer_ip: Option<&str>, trust_proxy: bool, specs: &[String]) -> bool {
    if !trust_proxy || specs.is_empty() {
        return false;
    }
    let Some(peer) = peer_ip.and_then(|value| value.trim().parse::<IpAddr>().ok()) else {
        return false;
    };
    specs.iter().any(|spec| ip_matches_spec(peer, spec))
}

pub fn peer_is_trusted_from_env(peer_ip: Option<&str>) -> bool {
    let specs = trusted_proxy_specs();
    peer_is_trusted(peer_ip, trust_proxy_enabled(), &specs)
}

/// Resolve the effective client IP from a socket peer and forwarded chain.
///
/// Invalid or unreasonably large forwarded input fails closed to the socket
/// peer. Trusted proxy hops are removed from the right; the first untrusted hop
/// (or the leftmost hop when the whole chain is trusted) is the client.
pub fn resolve_client_ip(
    peer_ip: Option<&str>,
    forwarded_for: Option<&str>,
    trust_proxy: bool,
    specs: &[String],
) -> Option<String> {
    let peer_raw = peer_ip.map(str::trim).filter(|value| !value.is_empty())?;
    let peer = peer_raw.parse::<IpAddr>().ok();
    if !peer_is_trusted(Some(peer_raw), trust_proxy, specs) {
        return Some(peer.map_or_else(|| peer_raw.to_owned(), |ip| ip.to_string()));
    }

    let Some(raw) = forwarded_for else {
        return Some(peer.map_or_else(|| peer_raw.to_owned(), |ip| ip.to_string()));
    };
    if raw.len() > MAX_FORWARDED_HEADER_LEN {
        return Some(peer.map_or_else(|| peer_raw.to_owned(), |ip| ip.to_string()));
    }

    let parts: Vec<&str> = raw.split(',').map(str::trim).collect();
    if parts.is_empty()
        || parts.len() > MAX_FORWARDED_HOPS
        || parts.iter().any(|part| part.is_empty())
    {
        return Some(peer.map_or_else(|| peer_raw.to_owned(), |ip| ip.to_string()));
    }
    let mut hops = Vec::with_capacity(parts.len());
    for part in parts {
        let Ok(ip) = part.parse::<IpAddr>() else {
            return Some(peer.map_or_else(|| peer_raw.to_owned(), |ip| ip.to_string()));
        };
        hops.push(ip);
    }

    for (index, hop) in hops.iter().enumerate().rev() {
        if index == 0 || !specs.iter().any(|spec| ip_matches_spec(*hop, spec)) {
            return Some(hop.to_string());
        }
    }

    Some(peer.map_or_else(|| peer_raw.to_owned(), |ip| ip.to_string()))
}

pub fn resolve_client_ip_from_env(
    peer_ip: Option<&str>,
    forwarded_for: Option<&str>,
) -> Option<String> {
    let specs = trusted_proxy_specs();
    resolve_client_ip(peer_ip, forwarded_for, trust_proxy_enabled(), &specs)
}

/// Collapse IPv6 sources to their routed `/64` for abuse-control buckets.
pub fn normalize_for_rate_limit(ip: &str) -> String {
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V6(v6)) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4.to_string();
            }
            let seg = v6.segments();
            let prefix = Ipv6Addr::new(seg[0], seg[1], seg[2], seg[3], 0, 0, 0, 0);
            format!("{prefix}/64")
        }
        Ok(IpAddr::V4(v4)) => v4.to_string(),
        Err(_) => ip.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{ip_matches_spec, normalize_for_rate_limit, resolve_client_ip};
    use std::net::IpAddr;

    fn specs(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn exact_and_cidr_specs_match_both_address_families() {
        assert!(ip_matches_spec(
            "172.18.4.9".parse::<IpAddr>().unwrap(),
            "172.18.0.0/16"
        ));
        assert!(!ip_matches_spec(
            "172.19.4.9".parse::<IpAddr>().unwrap(),
            "172.18.0.0/16"
        ));
        assert!(ip_matches_spec(
            "2001:db8:42::9".parse::<IpAddr>().unwrap(),
            "2001:db8:42::/48"
        ));
        assert!(ip_matches_spec(
            "127.0.0.1".parse::<IpAddr>().unwrap(),
            "127.0.0.1"
        ));
    }

    #[test]
    fn untrusted_peer_cannot_supply_forwarded_address() {
        let resolved = resolve_client_ip(
            Some("198.51.100.10"),
            Some("203.0.113.55"),
            true,
            &specs(&["172.18.0.0/16"]),
        );
        assert_eq!(resolved.as_deref(), Some("198.51.100.10"));
    }

    #[test]
    fn forwarded_chain_is_walked_from_the_trusted_edge() {
        let trusted = specs(&["172.18.0.0/16", "10.0.0.2"]);
        let resolved = resolve_client_ip(
            Some("172.18.0.5"),
            Some("198.51.100.99, 10.0.0.2"),
            true,
            &trusted,
        );
        assert_eq!(resolved.as_deref(), Some("198.51.100.99"));
    }

    #[test]
    fn attacker_prefix_is_not_selected_when_proxy_appends() {
        let trusted = specs(&["172.18.0.0/16"]);
        let resolved = resolve_client_ip(
            Some("172.18.0.5"),
            Some("192.0.2.66, 198.51.100.44"),
            true,
            &trusted,
        );
        assert_eq!(resolved.as_deref(), Some("198.51.100.44"));
    }

    #[test]
    fn malformed_forwarded_chain_falls_back_to_peer() {
        let resolved = resolve_client_ip(
            Some("172.18.0.5"),
            Some("198.51.100.1, garbage"),
            true,
            &specs(&["172.18.0.0/16"]),
        );
        assert_eq!(resolved.as_deref(), Some("172.18.0.5"));
    }

    #[test]
    fn ipv6_rate_keys_share_a_64() {
        assert_eq!(
            normalize_for_rate_limit("2001:db8:abcd:1::1"),
            normalize_for_rate_limit("2001:db8:abcd:1:ffff::9")
        );
        assert_eq!(normalize_for_rate_limit("::ffff:192.0.2.1"), "192.0.2.1");
    }
}
