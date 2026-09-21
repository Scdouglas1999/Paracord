//! Where people can reach this server, as best the server knows.
//!
//! An owner who set their server up in a browser on the same machine is at
//! `https://localhost:8443`, and an invite link built from their address bar
//! points every friend at the friend's own computer. Only the server knows what
//! it is reachable as — a configured public URL, the public address its router
//! mapped for it, or just its address on the local network — so it says so, and
//! the invite dialog uses that whenever the address bar is no use.
//!
//! Process-wide on purpose: it is a fact about the process (what it bound and
//! what the router agreed to), it is learned after startup has begun, and
//! threading it through `AppConfig` would touch every test that builds one.

use serde::Serialize;
use std::sync::{OnceLock, RwLock};

/// How far an invite made with [`ShareAddress::url`] will carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShareReach {
    /// Anyone on the internet: a public URL is configured, or the router mapped
    /// the ports.
    Internet,
    /// People on the same network only. The router was not opened.
    LocalNetwork,
    /// Only this computer (a loopback bind).
    ThisComputer,
    /// Startup has not worked it out (yet).
    #[default]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ShareAddress {
    /// An origin such as `https://203.0.113.7:8443`, with no trailing slash.
    pub url: Option<String>,
    pub reach: ShareReach,
}

fn cell() -> &'static RwLock<ShareAddress> {
    static CELL: OnceLock<RwLock<ShareAddress>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(ShareAddress::default()))
}

/// Record what startup (or a later router-mapping renewal) learned.
pub fn set_share_address(address: ShareAddress) {
    let normalized = ShareAddress {
        url: address
            .url
            .map(|url| url.trim().trim_end_matches('/').to_string())
            .filter(|url| !url.is_empty()),
        reach: address.reach,
    };
    match cell().write() {
        Ok(mut guard) => *guard = normalized,
        Err(poisoned) => *poisoned.into_inner() = normalized,
    }
}

pub fn share_address() -> ShareAddress {
    match cell().read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_an_origin_without_a_trailing_slash_and_serializes_reach_in_snake_case() {
        set_share_address(ShareAddress {
            url: Some(" https://203.0.113.7:8443/ ".into()),
            reach: ShareReach::LocalNetwork,
        });
        let current = share_address();
        assert_eq!(current.url.as_deref(), Some("https://203.0.113.7:8443"));
        assert_eq!(
            serde_json::to_value(&current).unwrap(),
            serde_json::json!({ "url": "https://203.0.113.7:8443", "reach": "local_network" })
        );
    }
}
