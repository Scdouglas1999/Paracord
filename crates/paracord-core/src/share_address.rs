//! Where people can reach this server, as best the server knows.
//!
//! An owner who set their server up in a browser on the same machine is at
//! `https://localhost:8443`, and an invite link built from their address bar
//! points every friend at the friend's own computer. Only the server knows what
//! it is reachable as — a configured public URL, the public address its router
//! reported (or, when the router will not say, the one a STUN server saw), or
//! just its address on the local network — so it says so, and the invite
//! dialog uses that whenever the address bar is no use. A public address
//! nobody has shown to work yet is still the link, marked unconfirmed with the
//! reason, and the local address rides along as the "On this network" link.
//!
//! The address is a function of the current [`Reachability`] (spec §5.6): it is
//! recomputed on every read from the inputs startup recorded and the state the
//! reachability module keeps, so a renewal that finds a new public address or a
//! failed renewal changes it without anyone remembering to update a copy.
//!
//! Process-wide on purpose: the inputs are facts about the process (what it
//! bound, what it was configured with), learned after startup has begun, and
//! threading them through `AppConfig` would touch every test that builds one.

use crate::reachability::{public_address, PublicSource};
use paracord_contracts::host::{Reachability, ReachabilityState};
use serde::Serialize;
use std::net::IpAddr;
use std::sync::{OnceLock, RwLock};

/// How far an invite made with [`ShareAddress::url`] will carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShareReach {
    /// Anyone on the internet: a public URL is configured, the router opened
    /// the way (or this computer has a public address of its own), or a
    /// connection from outside was seen on this address.
    Internet,
    /// The address is this network's public one, but nothing has shown that
    /// people outside get through: the router refused or did not answer, so
    /// the port may still have to be forwarded by hand. [`ShareAddress::note`]
    /// says what stands in the way.
    InternetUnconfirmed,
    /// Only this computer (a loopback bind).
    ThisComputer,
    /// Startup has not worked it out (yet).
    #[default]
    Unknown,
}

/// Where the address in [`ShareAddress::url`] came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareSource {
    /// `[server] public_url`.
    Configured,
    /// The router reported it.
    Router,
    /// This computer's own address is public.
    ThisComputer,
    /// A STUN server saw this network's traffic come from it
    /// (`[network] external_address_stun_servers`).
    Stun,
}

/// Why people outside may not reach [`ShareAddress::url`] yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareNote {
    /// The router refused or did not answer, so nothing opened the port:
    /// it has to be forwarded on the router by hand.
    PortNotForwarded,
    /// Windows Firewall has no rule for the port.
    FirewallBlocked,
    /// The router's own outside address is a carrier-grade NAT one
    /// (100.64.0.0/10): the provider shares one public address between
    /// customers, and only the provider can let people in.
    CarrierNat,
    /// The router's own outside address is private: another router sits in
    /// front of it, and the port has to be forwarded on that one too.
    OuterRouter,
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
    /// Where the address in `url` came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ShareSource>,
    /// What may stop people outside from reaching `url`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<ShareNote>,
    /// The TCP port people connect to, which is the one that has to be
    /// forwarded. Absent with a configured `public_url`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// What startup knows that does not change while the server runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareInputs {
    /// `[server] public_url`, which wins over everything.
    pub public_url: Option<String>,
    /// The origin on the local network (or loopback) the banner prints; only
    /// used to tell a loopback bind, never handed out as a link.
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

fn is_loopback_origin(url: &str) -> bool {
    url.contains("://localhost") || url.contains("://127.") || url.contains("://[::1]")
}

/// What the router's own outside address says about the network in front of
/// it, when it is not a public one.
fn wan_note(reachability: &Reachability) -> Option<ShareNote> {
    let reported = reachability
        .external_ip
        .as_deref()
        .or(reachability.observed_ip.as_deref())?;
    match reported.trim().parse::<IpAddr>().ok()? {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            if a == 100 && (64..=127).contains(&b) {
                Some(ShareNote::CarrierNat)
            } else if v4.is_private() || v4.is_link_local() {
                Some(ShareNote::OuterRouter)
            } else {
                None
            }
        }
        IpAddr::V6(_) => None,
    }
}

/// The pure rule (spec §5.6, §5.5):
///
/// * a configured `public_url` is the last word;
/// * a loopback bind is "this computer";
/// * otherwise the link is always the network's public address — the
///   router's own report, else what a STUN server saw — `internet` once the
///   router opened the way (or a connection from outside was seen),
///   `internet_unconfirmed` with a [`ShareNote`] before that. Forwarding the
///   port is then the host's to do; the note says so;
/// * with no public address known yet there is no link (`unknown`): a link on
///   the home network reaches nobody it is meant for.
pub fn derive(
    inputs: &ShareInputs,
    reachability: &Reachability,
    previous_external_ip: Option<&str>,
) -> ShareAddress {
    let loopback = is_loopback_origin(&inputs.local_url);
    if let Some(url) = inputs.public_url.as_deref() {
        return ShareAddress {
            url: Some(url.to_string()),
            reach: ShareReach::Internet,
            source: Some(ShareSource::Configured),
            ..ShareAddress::default()
        };
    }
    if loopback {
        return ShareAddress {
            url: None,
            reach: ShareReach::ThisComputer,
            port: Some(inputs.port),
            ..ShareAddress::default()
        };
    }
    let Some((ip, source)) = public_address(reachability) else {
        return ShareAddress {
            url: None,
            reach: ShareReach::Unknown,
            note: wan_note(reachability),
            port: Some(inputs.port),
            ..ShareAddress::default()
        };
    };
    let ip = ip.to_string();
    let url = origin(&inputs.scheme, &ip, inputs.port);
    let previous_url = previous_external_ip
        .filter(|previous| *previous != ip)
        .map(|previous| origin(&inputs.scheme, previous, inputs.port));
    let opened = matches!(
        reachability.state,
        ReachabilityState::Open | ReachabilityState::Direct
    );
    let confirmed = opened || reachability.confirmed_at.is_some();
    let note = (!confirmed).then(|| {
        wan_note(reachability).unwrap_or(
            if reachability.state == ReachabilityState::FirewallBlocked {
                ShareNote::FirewallBlocked
            } else {
                ShareNote::PortNotForwarded
            },
        )
    });
    ShareAddress {
        reach: if confirmed {
            ShareReach::Internet
        } else {
            ShareReach::InternetUnconfirmed
        },
        url: Some(url),
        previous_url,
        source: Some(match source {
            PublicSource::Router => ShareSource::Router,
            PublicSource::ThisComputer => ShareSource::ThisComputer,
            PublicSource::Stun => ShareSource::Stun,
        }),
        note,
        port: Some(inputs.port),
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
            observed_ip: None,
        }
    }

    fn observed(mut r: Reachability, ip: &str) -> Reachability {
        r.observed_ip = Some(ip.to_string());
        r
    }

    const LAN: &str = "https://192.168.1.20:8443";

    #[test]
    fn open_and_direct_share_the_external_address() {
        for kind in [ReachabilityState::Open, ReachabilityState::Direct] {
            let a = derive(&inputs(None, LAN), &state(kind, Some("203.0.113.7")), None);
            assert_eq!(a.url.as_deref(), Some("https://203.0.113.7:8443"));
            assert_eq!(a.reach, ShareReach::Internet);
            assert_eq!(a.note, None);
        }
    }

    /// The owner's case: no UPnP, no NAT-PMP/PCP, and STUN named the address.
    /// The link is the outside one, marked unconfirmed; forwarding is the host's.
    #[test]
    fn no_answer_with_a_stun_address_shares_it_unconfirmed() {
        let r = observed(state(ReachabilityState::NoAnswer, None), "198.51.100.4");
        let a = derive(&inputs(None, LAN), &r, None);
        assert_eq!(a.url.as_deref(), Some("https://198.51.100.4:8443"));
        assert_eq!(a.reach, ShareReach::InternetUnconfirmed);
        assert_eq!(a.note, Some(ShareNote::PortNotForwarded));
        assert_eq!(a.source, Some(ShareSource::Stun));
        assert_eq!(a.port, Some(8443));
    }

    /// A router that refuses the mapping but names its public address: that
    /// address is the link, and it wins over a STUN answer.
    #[test]
    fn a_refusing_router_that_named_its_address_is_the_source() {
        let r = observed(
            state(ReachabilityState::Refused, Some("203.0.113.7")),
            "198.51.100.4",
        );
        let a = derive(&inputs(None, LAN), &r, None);
        assert_eq!(a.url.as_deref(), Some("https://203.0.113.7:8443"));
        assert_eq!(a.reach, ShareReach::InternetUnconfirmed);
        assert_eq!(a.source, Some(ShareSource::Router));
        assert_eq!(a.note, Some(ShareNote::PortNotForwarded));
    }

    #[test]
    fn a_carrier_nat_router_address_says_so() {
        // Router reports 100.64/10, STUN saw the provider's public address.
        for kind in [
            ReachabilityState::SharedAddress,
            ReachabilityState::Refused,
            ReachabilityState::NoAnswer,
        ] {
            let r = observed(state(kind, Some("100.72.1.1")), "198.51.100.4");
            let a = derive(&inputs(None, LAN), &r, None);
            assert_eq!(
                a.url.as_deref(),
                Some("https://198.51.100.4:8443"),
                "{kind:?}"
            );
            assert_eq!(a.reach, ShareReach::InternetUnconfirmed, "{kind:?}");
            assert_eq!(a.note, Some(ShareNote::CarrierNat), "{kind:?}");
        }
    }

    #[test]
    fn a_private_router_address_behind_another_router_says_so() {
        // The router's WAN side is 192.168.0.x: a modem-router sits in front,
        // and its public address (seen by STUN) differs from the router's.
        let r = observed(
            state(ReachabilityState::SharedAddress, Some("192.168.0.10")),
            "198.51.100.4",
        );
        let a = derive(&inputs(None, LAN), &r, None);
        assert_eq!(a.url.as_deref(), Some("https://198.51.100.4:8443"));
        assert_eq!(a.reach, ShareReach::InternetUnconfirmed);
        assert_eq!(a.note, Some(ShareNote::OuterRouter));
    }

    #[test]
    fn with_no_public_address_known_there_is_no_link() {
        // A home-network address reaches nobody an invite is for, so it is
        // never the link.
        for kind in [
            ReachabilityState::Off,
            ReachabilityState::Asking,
            ReachabilityState::Refused,
            ReachabilityState::NoAnswer,
            ReachabilityState::FirewallBlocked,
        ] {
            let a = derive(&inputs(None, LAN), &state(kind, None), None);
            assert_eq!(a.url, None, "{kind:?}");
            assert_eq!(a.reach, ShareReach::Unknown, "{kind:?}");
        }
        // A shared address alone is never the link, but it is named.
        let a = derive(
            &inputs(None, LAN),
            &state(ReachabilityState::SharedAddress, Some("100.64.1.1")),
            None,
        );
        assert_eq!(a.url, None);
        assert_eq!(a.reach, ShareReach::Unknown);
        assert_eq!(a.note, Some(ShareNote::CarrierNat));
    }

    #[test]
    fn a_connection_seen_from_outside_confirms_an_unopened_address() {
        let mut r = observed(state(ReachabilityState::NoAnswer, None), "198.51.100.4");
        r.confirmed_at = Some("2026-10-15T00:00:00Z".into());
        let a = derive(&inputs(None, LAN), &r, None);
        assert_eq!(a.reach, ShareReach::Internet);
        assert_eq!(a.note, None);
    }

    #[test]
    fn a_missing_firewall_rule_is_the_note() {
        let a = derive(
            &inputs(None, LAN),
            &state(ReachabilityState::FirewallBlocked, Some("203.0.113.7")),
            None,
        );
        assert_eq!(a.reach, ShareReach::InternetUnconfirmed);
        assert_eq!(a.note, Some(ShareNote::FirewallBlocked));
    }

    #[test]
    fn a_configured_public_url_wins_and_loopback_is_this_computer() {
        let open = state(ReachabilityState::Open, Some("203.0.113.7"));
        let a = derive(&inputs(Some("https://chat.example.com"), LAN), &open, None);
        assert_eq!(a.url.as_deref(), Some("https://chat.example.com"));
        assert_eq!(a.reach, ShareReach::Internet);
        assert_eq!(a.source, Some(ShareSource::Configured));

        // Even over an unconfirmed STUN address.
        let stun = observed(state(ReachabilityState::NoAnswer, None), "198.51.100.4");
        let a = derive(&inputs(Some("https://chat.example.com"), LAN), &stun, None);
        assert_eq!(a.url.as_deref(), Some("https://chat.example.com"));
        assert_eq!(a.note, None);

        for r in [open, stun] {
            let a = derive(&inputs(None, "https://localhost:8443"), &r, None);
            assert_eq!(a.url, None);
            assert_eq!(a.reach, ShareReach::ThisComputer);
            let a = derive(&inputs(None, "https://127.0.0.1:8443"), &r, None);
            assert_eq!(a.reach, ShareReach::ThisComputer);
        }
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
            &observed(state(ReachabilityState::NoAnswer, None), "198.51.100.5"),
            Some("198.51.100.4"),
        );
        assert_eq!(a.previous_url.as_deref(), Some("https://198.51.100.4:8443"));
        let a = derive(
            &inputs(None, LAN),
            &state(ReachabilityState::Direct, Some("2001:db8::1")),
            None,
        );
        assert_eq!(a.url.as_deref(), Some("https://[2001:db8::1]:8443"));
    }

    #[test]
    fn serializes_in_snake_case_and_leaves_out_what_is_absent() {
        let a = derive(
            &inputs(None, LAN),
            &state(ReachabilityState::Refused, None),
            None,
        );
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::json!({ "url": null, "reach": "unknown", "port": 8443 })
        );
        let a = derive(
            &inputs(None, LAN),
            &observed(state(ReachabilityState::NoAnswer, None), "198.51.100.4"),
            None,
        );
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::json!({
                "url": "https://198.51.100.4:8443",
                "reach": "internet_unconfirmed",
                "source": "stun",
                "note": "port_not_forwarded",
                "port": 8443,
            })
        );
    }
}
