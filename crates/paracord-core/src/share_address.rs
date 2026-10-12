//! Where people can reach this server, as best the server knows.
//!
//! An owner who set their server up in a browser on the same machine is at
//! `https://localhost:8443`, and an invite link built from their address bar
//! points every friend at the friend's own computer. Only the server knows what
//! it is reachable as — a configured public URL, the public address its router
//! reported, or just its address on the local network — so it says so, and the
//! invite dialog uses that whenever the address bar is no use.
//!
//! The address is a function of the current [`Reachability`] (spec §5.6): it is
//! recomputed on every read from the inputs startup recorded and the state the
//! reachability module keeps, so a renewal that finds a new public address or a
//! failed renewal changes it without anyone remembering to update a copy.
//!
//! Process-wide on purpose: the inputs are facts about the process (what it
//! bound, what it was configured with), learned after startup has begun, and
//! threading them through `AppConfig` would touch every test that builds one.

use paracord_contracts::host::{Reachability, ReachabilityState};
use serde::Serialize;
use std::sync::{OnceLock, RwLock};

/// How far an invite made with [`ShareAddress::url`] will carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShareReach {
    /// Anyone on the internet: a public URL is configured, or the router opened
    /// the way (or this computer has a public address of its own).
    Internet,
    /// People on the same network only.
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
    /// The origin links made before the public address changed point at. Only
    /// present when the address changed while the server ran; the Invite screen
    /// says those links no longer work (spec §5.6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_url: Option<String>,
}

/// What startup knows that does not change while the server runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareInputs {
    /// `[server] public_url`, which wins over everything.
    pub public_url: Option<String>,
    /// The origin on the local network (or loopback) the banner prints.
    pub local_url: String,
    /// `http` or `https`.
    pub scheme: String,
    /// The TCP port friends connect to.
    pub port: u16,
}

fn cell() -> &'static RwLock<Option<ShareInputs>> {
    static CELL: OnceLock<RwLock<Option<ShareInputs>>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(None))
}

/// Record the inputs. Called once, after the first reachability attempt.
pub fn set_share_inputs(inputs: ShareInputs) {
    let inputs = ShareInputs {
        public_url: inputs
            .public_url
            .map(|url| url.trim().trim_end_matches('/').to_string())
            .filter(|url| !url.is_empty()),
        local_url: inputs.local_url.trim().trim_end_matches('/').to_string(),
        ..inputs
    };
    match cell().write() {
        Ok(mut guard) => *guard = Some(inputs),
        Err(poisoned) => *poisoned.into_inner() = Some(inputs),
    }
}

/// The address to put in an invite link right now.
pub fn share_address() -> ShareAddress {
    let inputs = match cell().read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    let Some(inputs) = inputs else {
        return ShareAddress::default();
    };
    let hub = crate::reachability::hub();
    derive(
        &inputs,
        &hub.current(),
        hub.previous_external_ip().as_deref(),
    )
}

fn origin(scheme: &str, host: &str, port: u16) -> String {
    // A bare IPv6 literal needs brackets in an origin.
    if host.contains(':') && !host.starts_with('[') {
        format!("{scheme}://[{host}]:{port}")
    } else {
        format!("{scheme}://{host}:{port}")
    }
}

/// The pure rule (spec §5.6, §5.5):
///
/// * a configured `public_url` is the last word;
/// * `open` and `direct` use the external address;
/// * everything else uses the address on the local network, and a loopback
///   address is "this computer".
pub fn derive(
    inputs: &ShareInputs,
    reachability: &Reachability,
    previous_external_ip: Option<&str>,
) -> ShareAddress {
    if let Some(url) = inputs.public_url.as_deref() {
        return ShareAddress {
            url: Some(url.to_string()),
            reach: ShareReach::Internet,
            previous_url: None,
        };
    }
    let loopback = inputs.local_url.contains("://localhost")
        || inputs.local_url.contains("://127.")
        || inputs.local_url.contains("://[::1]");
    if loopback {
        return ShareAddress {
            url: None,
            reach: ShareReach::ThisComputer,
            previous_url: None,
        };
    }
    match (reachability.state, reachability.external_ip.as_deref()) {
        (ReachabilityState::Open | ReachabilityState::Direct, Some(ip)) => {
            let url = origin(&inputs.scheme, ip, inputs.port);
            let previous_url = previous_external_ip
                .filter(|previous| *previous != ip)
                .map(|previous| origin(&inputs.scheme, previous, inputs.port));
            ShareAddress {
                url: Some(url),
                reach: ShareReach::Internet,
                previous_url,
            }
        }
        _ => ShareAddress {
            url: Some(inputs.local_url.clone()),
            reach: ShareReach::LocalNetwork,
            previous_url: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(public_url: Option<&str>, local: &str) -> ShareInputs {
        ShareInputs {
            public_url: public_url.map(str::to_string),
            local_url: local.to_string(),
            scheme: "https".into(),
            port: 8443,
        }
    }

    fn state(state: ReachabilityState, external: Option<&str>) -> Reachability {
        Reachability {
            state,
            method: None,
            external_ip: external.map(str::to_string),
            gateway_ip: None,
            lan_ip: None,
            port: 8443,
            lease_expires_at: None,
            next_retry_at: None,
            last_error: None,
            confirmed_at: None,
        }
    }

    const LAN: &str = "https://192.168.1.20:8443";

    #[test]
    fn open_and_direct_share_the_external_address() {
        for kind in [ReachabilityState::Open, ReachabilityState::Direct] {
            let a = derive(&inputs(None, LAN), &state(kind, Some("203.0.113.7")), None);
            assert_eq!(a.url.as_deref(), Some("https://203.0.113.7:8443"));
            assert_eq!(a.reach, ShareReach::Internet);
        }
    }

    #[test]
    fn every_other_state_falls_back_to_the_local_address() {
        for kind in [
            ReachabilityState::Off,
            ReachabilityState::Asking,
            ReachabilityState::SharedAddress,
            ReachabilityState::Refused,
            ReachabilityState::NoAnswer,
            ReachabilityState::FirewallBlocked,
        ] {
            // Even when an address is known, it is not claimed.
            let a = derive(&inputs(None, LAN), &state(kind, Some("100.64.1.1")), None);
            assert_eq!(a.url.as_deref(), Some(LAN), "{kind:?}");
            assert_eq!(a.reach, ShareReach::LocalNetwork, "{kind:?}");
        }
    }

    #[test]
    fn a_configured_public_url_wins_and_loopback_is_this_computer() {
        let open = state(ReachabilityState::Open, Some("203.0.113.7"));
        let a = derive(&inputs(Some("https://chat.example.com"), LAN), &open, None);
        assert_eq!(a.url.as_deref(), Some("https://chat.example.com"));
        assert_eq!(a.reach, ShareReach::Internet);

        let a = derive(&inputs(None, "https://localhost:8443"), &open, None);
        assert_eq!(a.url, None);
        assert_eq!(a.reach, ShareReach::ThisComputer);
    }

    #[test]
    fn a_changed_address_names_the_old_link_and_ipv6_is_bracketed() {
        let a = derive(
            &inputs(None, LAN),
            &state(ReachabilityState::Open, Some("203.0.113.10")),
            Some("203.0.113.9"),
        );
        assert_eq!(a.previous_url.as_deref(), Some("https://203.0.113.9:8443"));
        let a = derive(
            &inputs(None, LAN),
            &state(ReachabilityState::Direct, Some("2001:db8::1")),
            None,
        );
        assert_eq!(a.url.as_deref(), Some("https://[2001:db8::1]:8443"));
    }

    #[test]
    fn serializes_reach_in_snake_case_and_leaves_out_an_absent_previous() {
        let a = derive(
            &inputs(None, LAN),
            &state(ReachabilityState::Refused, None),
            None,
        );
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::json!({ "url": LAN, "reach": "local_network" })
        );
    }
}
