//! Whether friends outside this network can reach the server, as the server
//! knows it (spec §5).
//!
//! Three things live here and nothing else: the current [`Reachability`] (one
//! value, changed only through [`ReachabilityHub::update`]), the table that
//! decides which addresses are public ([`classify`]), and the observation that
//! upgrades "the router says so" to "a friend actually connected from outside"
//! ([`ReachabilityHub::record_inbound_connection`]).
//!
//! The *finding out* (talking to the router, the retry loop) is
//! `paracord-server`'s `reachability` module; it only ever writes here. The
//! readers are the admin and host status routes, the invite address
//! ([`crate::share_address`]) and the gateway: [`spawn_status_broadcaster`]
//! sends `INSTANCE_STATUS_UPDATE` to admins whenever anything in
//! [`InstanceStatusUpdate`] changes.
//!
//! The external address comes from the router first. Only while the router has
//! not named a public address of its own, and only when the owner left
//! `[network] external_address_stun_servers` on, does the server ask a STUN
//! server what address its traffic arrives from ([`Reachability::observed_ip`]).
//! That answer names an address; it never says the way in is open.

use chrono::{DateTime, SecondsFormat, Utc};
use paracord_contracts::host::{
    BackupStatus, InstanceStatusUpdate, Reachability, ReachabilityState, StorageStatus,
};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{watch, Notify};

/// How the router's reported external address reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressClass {
    /// Routable on the public internet.
    Public,
    /// Private, carrier-grade NAT or link-local: another router or the
    /// provider sits between this network and the internet.
    Shared,
    /// Not an address anyone can be reached at (unspecified, loopback,
    /// multicast, reserved). A router reporting one has no working uplink.
    Unusable,
}

/// Classify one address by the table in spec §5.2.
pub fn classify(ip: IpAddr) -> AddressClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => classify_v4(v4),
            None => classify_v6(v6),
        },
    }
}

fn classify_v4(ip: Ipv4Addr) -> AddressClass {
    let [a, b, ..] = ip.octets();
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() || ip.is_broadcast() || a == 0 {
        return AddressClass::Unusable;
    }
    // 240.0.0.0/4 is reserved.
    if a >= 240 {
        return AddressClass::Unusable;
    }
    let private = a == 10                       // 10/8
        || (a == 172 && (16..=31).contains(&b)) // 172.16/12
        || (a == 192 && b == 168)               // 192.168/16
        || (a == 100 && (64..=127).contains(&b)) // 100.64/10, carrier-grade NAT
        || (a == 169 && b == 254); // 169.254/16, link-local
    if private {
        AddressClass::Shared
    } else {
        AddressClass::Public
    }
}

fn classify_v6(ip: Ipv6Addr) -> AddressClass {
    let first = ip.segments()[0];
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        AddressClass::Unusable
    } else if (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 {
        // fc00::/7 unique-local, fe80::/10 link-local.
        AddressClass::Shared
    } else {
        AddressClass::Public
    }
}

/// True for an address a person outside the home network connects from.
pub fn is_public(ip: IpAddr) -> bool {
    classify(ip) == AddressClass::Public
}

/// Where the public address in [`public_address`] came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicSource {
    /// The router reported it.
    Router,
    /// This computer's own interface address is public (`direct`).
    ThisComputer,
    /// A STUN server saw this network's traffic come from it.
    Stun,
}

/// The public address people outside would connect to, as best the server
/// knows: the router's own report when it is public, else what a STUN server
/// observed. `None` when neither is a public address.
pub fn public_address(r: &Reachability) -> Option<(IpAddr, PublicSource)> {
    let parse = |text: Option<&str>| text.and_then(|t| t.trim().parse::<IpAddr>().ok());
    if let Some(ip) = parse(r.external_ip.as_deref()).filter(|ip| is_public(*ip)) {
        let source = if r.state == ReachabilityState::Direct {
            PublicSource::ThisComputer
        } else {
            PublicSource::Router
        };
        return Some((ip, source));
    }
    parse(r.observed_ip.as_deref())
        .filter(|ip| is_public(*ip))
        .map(|ip| (ip, PublicSource::Stun))
}

/// Whether the router (or this computer's own public address) opened the way.
fn opened(state: ReachabilityState) -> bool {
    matches!(state, ReachabilityState::Open | ReachabilityState::Direct)
}

/// Everything the gateway announces to admins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubState {
    pub reachability: Reachability,
    /// Set by the stored-data encryption code at startup; `None` until then.
    pub storage: Option<StorageStatus>,
    /// Set by the backup code at startup; `None` until then.
    pub backups: Option<BackupStatus>,
}

/// A connection counts as "seen from outside" at most this often, so a busy
/// server does not turn every accept into a status broadcast.
const CONFIRMATION_REFRESH: Duration = Duration::from_secs(60);

pub struct ReachabilityHub {
    state: watch::Sender<HubState>,
    retry: Notify,
    /// The last public address ([`public_address`]), kept across failures so a
    /// change is noticed even if nothing could be asked in between.
    addresses: Mutex<Addresses>,
}

#[derive(Default)]
struct Addresses {
    last_known: Option<String>,
    previous: Option<String>,
}

impl Default for ReachabilityHub {
    fn default() -> Self {
        Self::new()
    }
}

impl ReachabilityHub {
    pub fn new() -> Self {
        let (state, _) = watch::channel(HubState {
            reachability: Reachability {
                state: ReachabilityState::Off,
                method: None,
                external_ip: None,
                gateway_ip: None,
                lan_ip: None,
                port: 0,
                lease_expires_at: None,
                next_retry_at: None,
                last_error: None,
                confirmed_at: None,
                observed_ip: None,
            },
            storage: None,
            backups: None,
        });
        Self {
            state,
            retry: Notify::new(),
            addresses: Mutex::new(Addresses::default()),
        }
    }

    pub fn current(&self) -> Reachability {
        self.state.borrow().reachability.clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<HubState> {
        self.state.subscribe()
    }

    /// Change the reachability. Subscribers are woken only when something in
    /// it actually differs.
    pub fn update(&self, change: impl FnOnce(&mut Reachability)) {
        self.state.send_if_modified(|hub| {
            let before = hub.reachability.clone();
            change(&mut hub.reachability);
            let was = public_address(&before).map(|(ip, _)| ip);
            let now = public_address(&hub.reachability).map(|(ip, _)| ip);
            // A confirmation belongs to the address it was seen on and to the
            // way in it came through: when the address changes, when the router
            // stops (or starts) holding the door, or when nothing is asked any
            // more, it is stale.
            let still_valid = now.is_some()
                && now == was
                && opened(hub.reachability.state) == opened(before.state)
                && hub.reachability.state != ReachabilityState::Off;
            if !still_valid {
                hub.reachability.confirmed_at = None;
            }
            if let Some(now_ip) = now.map(|ip| ip.to_string()) {
                let mut addresses = self.addresses.lock().unwrap_or_else(|e| e.into_inner());
                if addresses.last_known.as_deref() != Some(now_ip.as_str()) {
                    if addresses.last_known.is_some() {
                        addresses.previous = addresses.last_known.take();
                    }
                    addresses.last_known = Some(now_ip);
                }
            }
            hub.reachability != before
        });
    }

    /// The public address links were made with before the current one, when it
    /// changed while this process ran.
    pub fn previous_external_ip(&self) -> Option<String> {
        self.addresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .previous
            .clone()
    }

    pub fn set_storage(&self, storage: StorageStatus) {
        self.state.send_if_modified(|hub| {
            let changed = hub.storage.as_ref() != Some(&storage);
            hub.storage = Some(storage);
            changed
        });
    }

    pub fn set_backups(&self, backups: BackupStatus) {
        self.state.send_if_modified(|hub| {
            let changed = hub.backups.as_ref() != Some(&backups);
            hub.backups = Some(backups);
            changed
        });
    }

    /// The gateway payload, once all three parts are known. Storage and backups
    /// are reported by their own modules; sending a guess for them would be a
    /// claim the server cannot back.
    pub fn status_update(&self) -> Option<InstanceStatusUpdate> {
        let hub = self.state.borrow();
        Some(InstanceStatusUpdate {
            reachability: hub.reachability.clone(),
            storage: hub.storage.clone()?,
            backups: hub.backups.clone()?,
        })
    }

    /// "Try again": ask the retry loop to run an attempt now.
    pub fn request_retry(&self) {
        self.retry.notify_one();
    }

    /// Resolves when someone asked for a retry. A request made while no loop
    /// was waiting is kept for the next wait.
    pub async fn retry_requested(&self) {
        self.retry.notified().await;
    }

    /// A TLS connection was accepted from `peer`. When it comes from a public
    /// address that is not this network's own, it proves the way in works —
    /// also when the router never said it opened it (a port forwarded by hand).
    pub fn record_inbound_connection(&self, peer: IpAddr) {
        self.record_inbound_connection_at(peer, Utc::now());
    }

    pub fn record_inbound_connection_at(&self, peer: IpAddr, now: DateTime<Utc>) {
        // Cheapest test first: nearly every connection is local.
        if !is_public(peer) {
            return;
        }
        {
            let hub = self.state.borrow();
            let r = &hub.reachability;
            if !confirmable(r) {
                return;
            }
            // A connection from this network's own external address is a
            // loop through the router, not a friend.
            let peer_text = peer.to_string();
            if r.external_ip.as_deref() == Some(peer_text.as_str())
                || r.observed_ip.as_deref() == Some(peer_text.as_str())
            {
                return;
            }
            if let Some(last) = r
                .confirmed_at
                .as_deref()
                .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
            {
                if now.signed_duration_since(last).to_std().unwrap_or_default()
                    < CONFIRMATION_REFRESH
                {
                    return;
                }
            }
        }
        let stamp = now.to_rfc3339_opts(SecondsFormat::Secs, true);
        self.state.send_if_modified(|hub| {
            let r = &mut hub.reachability;
            if !confirmable(r) {
                return false;
            }
            r.confirmed_at = Some(stamp);
            true
        });
    }
}

/// An outside connection can confirm the way in only when there is a public
/// address it came in on, and while someone is asking at all.
fn confirmable(r: &Reachability) -> bool {
    !matches!(r.state, ReachabilityState::Off | ReachabilityState::Asking)
        && public_address(r).is_some()
}

/// The process-wide hub. The server learns its reachability once, at startup,
/// and the routes that read it do not have it threaded through `AppState`.
pub fn hub() -> &'static Arc<ReachabilityHub> {
    static HUB: OnceLock<Arc<ReachabilityHub>> = OnceLock::new();
    HUB.get_or_init(|| Arc::new(ReachabilityHub::new()))
}

/// Dispatch `INSTANCE_STATUS_UPDATE` whenever anything in it changes. The
/// gateway delivers it to admins only.
pub fn spawn_status_broadcaster(
    hub: Arc<ReachabilityHub>,
    bus: crate::events::EventBus,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut changes = hub.subscribe();
        // The first value is the current one; announcing it again would only
        // repeat what the admin's page loaded.
        changes.mark_unchanged();
        while changes.changed().await.is_ok() {
            let Some(update) = hub.status_update() else {
                continue;
            };
            match serde_json::to_value(&update) {
                Ok(payload) => bus.dispatch(
                    paracord_models::gateway::EVENT_INSTANCE_STATUS_UPDATE,
                    payload,
                    None,
                ),
                Err(err) => tracing::warn!("could not encode INSTANCE_STATUS_UPDATE: {err}"),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    /// The spec §5.2 table, row by row, with the edges of each range.
    #[test]
    fn classification_table() {
        let shared = [
            "10.0.0.0",
            "10.255.255.255",
            "172.16.0.0",
            "172.31.255.255",
            "192.168.0.1",
            "192.168.255.255",
            "100.64.0.0",
            "100.127.255.255",
            "169.254.1.1",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.1.5",
        ];
        for text in shared {
            assert_eq!(classify(ip(text)), AddressClass::Shared, "{text}");
        }
        let public = [
            "203.0.113.9",
            "8.8.8.8",
            "172.15.255.255",
            "172.32.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "192.167.0.1",
            "169.253.0.1",
            "11.0.0.1",
            "2001:db8::1",
            "2606:4700::1111",
            "::ffff:203.0.113.9",
        ];
        for text in public {
            assert_eq!(classify(ip(text)), AddressClass::Public, "{text}");
        }
        let unusable = [
            "0.0.0.0",
            "127.0.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "::",
            "::1",
            "ff02::1",
        ];
        for text in unusable {
            assert_eq!(classify(ip(text)), AddressClass::Unusable, "{text}");
        }
    }

    fn open(hub: &ReachabilityHub, external: &str) {
        hub.update(|r| {
            r.state = ReachabilityState::Open;
            r.external_ip = Some(external.to_string());
            r.port = 8443;
        });
    }

    #[test]
    fn update_wakes_subscribers_only_on_a_real_change() {
        let hub = ReachabilityHub::new();
        let mut rx = hub.subscribe();
        rx.mark_unchanged();
        hub.update(|r| r.port = 0);
        assert!(!rx.has_changed().unwrap());
        hub.update(|r| r.port = 8443);
        assert!(rx.has_changed().unwrap());
    }

    #[test]
    fn a_public_stranger_confirms_and_local_or_own_address_do_not() {
        let hub = ReachabilityHub::new();
        let now = Utc::now();
        // Nothing to confirm while nothing is open.
        hub.record_inbound_connection_at(ip("198.51.100.7"), now);
        assert!(hub.current().confirmed_at.is_none());

        open(&hub, "203.0.113.9");
        for local in ["192.168.1.20", "127.0.0.1", "100.64.3.3", "::1", "fd00::5"] {
            hub.record_inbound_connection_at(ip(local), now);
        }
        // The network's own external address: a loop through the router.
        hub.record_inbound_connection_at(ip("203.0.113.9"), now);
        assert!(hub.current().confirmed_at.is_none());

        hub.record_inbound_connection_at(ip("198.51.100.7"), now);
        assert_eq!(
            hub.current().confirmed_at,
            Some(now.to_rfc3339_opts(SecondsFormat::Secs, true))
        );
    }

    #[test]
    fn confirmation_refreshes_at_most_once_a_minute() {
        let hub = ReachabilityHub::new();
        open(&hub, "203.0.113.9");
        let t0 = Utc::now();
        hub.record_inbound_connection_at(ip("198.51.100.7"), t0);
        let first = hub.current().confirmed_at;
        hub.record_inbound_connection_at(ip("198.51.100.8"), t0 + chrono::Duration::seconds(30));
        assert_eq!(hub.current().confirmed_at, first);
        hub.record_inbound_connection_at(ip("198.51.100.8"), t0 + chrono::Duration::seconds(61));
        assert_ne!(hub.current().confirmed_at, first);
    }

    #[test]
    fn a_confirmation_does_not_outlive_the_way_in() {
        let hub = ReachabilityHub::new();
        open(&hub, "203.0.113.9");
        hub.record_inbound_connection_at(ip("198.51.100.7"), Utc::now());
        assert!(hub.current().confirmed_at.is_some());
        // Same state, new address: the old observation was about the old one.
        open(&hub, "203.0.113.10");
        assert!(hub.current().confirmed_at.is_none());

        hub.record_inbound_connection_at(ip("198.51.100.7"), Utc::now());
        assert!(hub.current().confirmed_at.is_some());
        hub.update(|r| r.state = ReachabilityState::Refused);
        assert!(hub.current().confirmed_at.is_none());
    }

    #[test]
    fn a_changed_address_is_remembered_even_across_a_failure() {
        let hub = ReachabilityHub::new();
        open(&hub, "203.0.113.9");
        assert_eq!(hub.previous_external_ip(), None);
        hub.update(|r| {
            r.state = ReachabilityState::NoAnswer;
            r.external_ip = None;
        });
        open(&hub, "203.0.113.10");
        assert_eq!(hub.previous_external_ip().as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn the_public_address_is_the_routers_when_public_else_the_stun_answer() {
        let hub = ReachabilityHub::new();
        hub.update(|r| {
            r.state = ReachabilityState::NoAnswer;
            r.observed_ip = Some("198.51.100.4".into());
        });
        assert_eq!(
            public_address(&hub.current()),
            Some((ip("198.51.100.4"), PublicSource::Stun))
        );
        // A router that names a carrier-grade NAT address does not hide the
        // public one STUN saw.
        hub.update(|r| {
            r.state = ReachabilityState::SharedAddress;
            r.external_ip = Some("100.64.0.9".into());
        });
        assert_eq!(
            public_address(&hub.current()),
            Some((ip("198.51.100.4"), PublicSource::Stun))
        );
        // The router's own public answer wins over STUN.
        hub.update(|r| {
            r.state = ReachabilityState::Refused;
            r.external_ip = Some("203.0.113.9".into());
        });
        assert_eq!(
            public_address(&hub.current()),
            Some((ip("203.0.113.9"), PublicSource::Router))
        );
        hub.update(|r| r.state = ReachabilityState::Direct);
        assert_eq!(
            public_address(&hub.current()).map(|(_, source)| source),
            Some(PublicSource::ThisComputer)
        );
        // Nothing public anywhere: nothing to share.
        hub.update(|r| {
            r.state = ReachabilityState::NoAnswer;
            r.external_ip = None;
            r.observed_ip = Some("10.0.0.1".into());
        });
        assert_eq!(public_address(&hub.current()), None);
    }

    #[test]
    fn a_stranger_confirms_a_port_forwarded_by_hand() {
        let hub = ReachabilityHub::new();
        let now = Utc::now();
        // The router did not answer; STUN named the address.
        hub.update(|r| {
            r.state = ReachabilityState::NoAnswer;
            r.observed_ip = Some("203.0.113.9".into());
            r.port = 8443;
        });
        // A loop through the router from the network's own address is not a friend.
        hub.record_inbound_connection_at(ip("203.0.113.9"), now);
        assert!(hub.current().confirmed_at.is_none());
        hub.record_inbound_connection_at(ip("198.51.100.7"), now);
        assert!(hub.current().confirmed_at.is_some());
        // The next unchanged retry keeps it; a new address does not.
        hub.update(|r| r.next_retry_at = Some("later".into()));
        assert!(hub.current().confirmed_at.is_some());
        hub.update(|r| r.observed_ip = Some("203.0.113.10".into()));
        assert!(hub.current().confirmed_at.is_none());
        assert_eq!(hub.previous_external_ip().as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn nothing_confirms_without_a_public_address() {
        let hub = ReachabilityHub::new();
        hub.update(|r| r.state = ReachabilityState::NoAnswer);
        hub.record_inbound_connection_at(ip("198.51.100.7"), Utc::now());
        assert!(hub.current().confirmed_at.is_none());
    }

    fn storage() -> StorageStatus {
        StorageStatus {
            enabled: false,
            sqlite_encrypted: false,
            files_encrypted: false,
            key_source: None,
            protection: None,
            escrowed: false,
        }
    }

    fn backups() -> BackupStatus {
        BackupStatus {
            enabled: true,
            interval_seconds: 86_400,
            keep: 14,
            last_backup_at: None,
            last_error: None,
        }
    }

    #[test]
    fn the_gateway_payload_waits_for_all_three_parts() {
        let hub = ReachabilityHub::new();
        assert!(hub.status_update().is_none());
        hub.set_storage(storage());
        assert!(hub.status_update().is_none());
        hub.set_backups(backups());
        let update = hub.status_update().expect("complete");
        assert_eq!(update.reachability.state, ReachabilityState::Off);
    }

    #[tokio::test]
    async fn the_broadcaster_dispatches_on_a_change_and_not_before() {
        let hub = Arc::new(ReachabilityHub::new());
        hub.set_storage(storage());
        hub.set_backups(backups());
        let bus = crate::events::EventBus::default();
        let mut rx = bus.register_session("s1", 1, &[]).expect("session");
        let task = spawn_status_broadcaster(Arc::clone(&hub), bus);

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(rx.try_recv().is_err(), "announced without a change");

        open(&hub, "203.0.113.9");
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("event in time")
            .expect("bus open");
        assert_eq!(event.event_type, "INSTANCE_STATUS_UPDATE");
        assert_eq!(event.payload["reachability"]["state"], "open");
        assert_eq!(event.payload["reachability"]["external_ip"], "203.0.113.9");
        assert!(event.target_user_ids.is_none());
        task.abort();
    }
}
