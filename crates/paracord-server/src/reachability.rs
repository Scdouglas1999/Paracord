//! Keeping the router's door open, and saying truthfully whether it is.
//!
//! [`crate::portmap`] knows how to ask a router. This module is the state
//! machine on top (spec §5.3): it decides what the answers mean, writes the
//! result into [`paracord_core::reachability`], renews the mapping at half its
//! granted lease, retries every `reachability_retry_seconds` while the way in
//! is shut, and takes the mappings down when the process leaves.
//!
//! ```text
//! asking ─► open            router accepted, external address is public
//!        ├► shared_address  router accepted, external address is private/CGNAT
//!        ├► refused         a gateway answered and said no
//!        ├► no_answer       nothing answered within the budget
//!        └► direct          this computer's own address is public (checked first)
//! ```
//!
//! `firewall_blocked` (Windows host mode) overrides whichever of those applies.
//! The external address is whatever the router said — also when it refused the
//! mapping but still named its address. Only when the router has not named a
//! public address, and the owner left `[network] external_address_stun_servers`
//! on, is a STUN server asked what address this network's traffic comes from
//! ([`crate::stun`]); that lands in `observed_ip`, at most once per
//! [`STUN_REFRESH`] (and on "Try again"), and never changes the state.

use crate::portmap::{
    self, FailureKind, MapFailure, Mapping, PortRequest, Router, DISCOVERY_BUDGET,
};
use crate::stun::PublicAddressProbe;
use chrono::{DateTime, SecondsFormat, Utc};
use paracord_contracts::host::ReachabilityState;
use paracord_core::reachability::{classify, AddressClass, ReachabilityHub};
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How often to look again at a mapping that never expires.
const PERMANENT_RECHECK: Duration = Duration::from_secs(12 * 60 * 60);

/// How often the STUN server is asked again while the router stays silent. A
/// home address changes rarely; asking on every one-minute retry would send a
/// datagram to a third party for nothing.
pub const STUN_REFRESH: Duration = Duration::from_secs(30 * 60);

/// The rule the desktop host installs (spec §2.4).
#[cfg_attr(not(windows), allow(dead_code))]
pub const FIREWALL_RULE_NAME: &str = "Paracord on this computer";

/// Whether the operating system's firewall lets friends in.
pub trait FirewallCheck: Send + Sync {
    /// `Ok(Some(detail))` when the rule is missing, `Ok(None)` when it is in
    /// place, `Err` when the check itself could not run (reported, never taken
    /// as a verdict either way).
    fn blocked(&self, port: u16) -> BoxFuture<'_, Result<Option<String>, String>>;
}

/// What the state machine needs from the machine it runs on.
pub struct Environment {
    /// This computer's IPv4 address on the interface the server listens on.
    pub lan_ip: Box<dyn Fn() -> Option<IpAddr> + Send + Sync>,
    /// Windows host mode only.
    pub firewall: Option<Arc<dyn FirewallCheck>>,
    /// Asks a STUN server for this network's public address when the router
    /// will not say. `None` when `[network] external_address_stun_servers` is
    /// empty.
    pub public_address: Option<Arc<dyn PublicAddressProbe>>,
}

pub struct Settings {
    pub request: PortRequest,
    /// The lease to ask the router for.
    pub lease: Duration,
    /// `[network] reachability_retry_seconds`.
    pub retry: Duration,
    /// Ceiling on one attempt across every method.
    pub budget: Duration,
    /// How long before the lease runs out to renew. Production: half.
    pub renew_interval: fn(Duration) -> Duration,
}

impl Settings {
    pub fn new(request: PortRequest, lease: Duration, retry: Duration) -> Self {
        Self {
            request,
            lease,
            retry,
            budget: DISCOVERY_BUDGET,
            renew_interval: portmap::renew_interval,
        }
    }
}

/// A router wrapped to remember whether it may be holding our mappings, so
/// shutdown closes exactly those and does not make an unrelated UPnP search.
struct Tracked {
    inner: Arc<dyn Router>,
    may_hold: AtomicBool,
}

impl Router for Tracked {
    fn method(&self) -> &'static str {
        self.inner.method()
    }

    fn map(
        &self,
        request: PortRequest,
        lease: Duration,
    ) -> BoxFuture<'_, Result<Mapping, MapFailure>> {
        Box::pin(async move {
            // True from the moment of asking: a task cancelled mid-request
            // may have been granted the mapping without ever hearing so.
            self.may_hold.store(true, Ordering::SeqCst);
            let result = self.inner.map(request, lease).await;
            if result.is_err() {
                self.may_hold.store(false, Ordering::SeqCst);
            }
            result
        })
    }

    fn unmap(&self, request: PortRequest) -> BoxFuture<'_, Result<(), String>> {
        self.inner.unmap(request)
    }
}

struct Shared {
    hub: Arc<ReachabilityHub>,
    settings: Settings,
    env: Environment,
    routers: Vec<Arc<Tracked>>,
    stop: Notify,
    /// The router whose mapping is live, for renewal.
    held: Mutex<Option<Arc<Tracked>>>,
    /// When the STUN server was last asked.
    observed_at: Mutex<Option<tokio::time::Instant>>,
}

/// The running state machine.
pub struct Handle {
    shared: Arc<Shared>,
    task: tokio::task::JoinHandle<()>,
}

/// Start asking. Returns at once; [`Handle::first_attempt`] waits for the
/// first verdict.
pub fn spawn(
    hub: Arc<ReachabilityHub>,
    settings: Settings,
    env: Environment,
    routers: Vec<Arc<dyn Router>>,
) -> Handle {
    let port = settings.request.tcp_port;
    hub.update(|r| {
        r.state = ReachabilityState::Asking;
        r.port = port;
    });
    let shared = Arc::new(Shared {
        hub,
        settings,
        env,
        routers: routers
            .into_iter()
            .map(|inner| {
                Arc::new(Tracked {
                    inner,
                    may_hold: AtomicBool::new(false),
                })
            })
            .collect(),
        stop: Notify::new(),
        held: Mutex::new(None),
        observed_at: Mutex::new(None),
    });
    let task = tokio::spawn(run(Arc::clone(&shared)));
    Handle { shared, task }
}

impl Handle {
    /// Wait until the first attempt has produced a verdict (anything but
    /// `asking`). Bounded by the discovery budget plus a little.
    pub async fn first_attempt(&self) {
        let mut changes = self.shared.hub.subscribe();
        let limit = self.shared.settings.budget + Duration::from_secs(5);
        let waited = tokio::time::timeout(
            limit,
            changes.wait_for(|hub| hub.reachability.state != ReachabilityState::Asking),
        )
        .await;
        if waited.is_err() {
            tracing::warn!(
                target: "paracord::portmap",
                "the first router attempt did not finish within {limit:?}; continuing"
            );
        }
    }

    /// Stop asking and take down whatever this process asked the router to
    /// open, within [`portmap::REMOVAL_BUDGET`] per router. Awaited inline on
    /// the shutdown path so it happens before the process leaves.
    pub async fn release(self) {
        self.shared.stop.notify_one();
        self.task.abort();
        let _ = self.task.await;
        for router in &self.shared.routers {
            if router.may_hold.swap(false, Ordering::SeqCst) {
                portmap::release(
                    Arc::clone(router) as Arc<dyn Router>,
                    self.shared.settings.request,
                )
                .await;
            }
        }
    }
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn after(duration: Duration) -> DateTime<Utc> {
    Utc::now() + chrono::Duration::from_std(duration).unwrap_or_else(|_| chrono::Duration::days(1))
}

/// Why an attempt is running.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Why {
    First,
    /// The retry or renewal timer.
    Timer,
    /// "Try again".
    Asked,
}

async fn run(shared: Arc<Shared>) {
    let mut why = Why::First;
    loop {
        let wait = attempt(&shared, why).await;
        why = tokio::select! {
            _ = shared.stop.notified() => break,
            _ = shared.hub.retry_requested() => Why::Asked,
            _ = tokio::time::sleep(wait) => Why::Timer,
        };
    }
}

/// One pass of the state machine. Returns how long to wait before the next.
async fn attempt(shared: &Shared, why: Why) -> Duration {
    let settings = &shared.settings;
    let hub = &shared.hub;
    let retry = settings.retry;
    let lan_ip = (shared.env.lan_ip)();

    // Direct: this computer's own address is public, so no router is in the
    // way and there is nothing to ask. Checked first (spec §5.3).
    if let Some(ip @ IpAddr::V4(v4)) = lan_ip {
        if classify(IpAddr::V4(v4)) == AddressClass::Public {
            hub.update(|r| {
                r.state = ReachabilityState::Direct;
                r.method = None;
                r.external_ip = Some(ip.to_string());
                r.gateway_ip = None;
                r.lan_ip = Some(ip.to_string());
                r.lease_expires_at = None;
                r.next_retry_at = Some(stamp(after(retry)));
                r.last_error = None;
                r.observed_ip = None;
            });
            log_state(shared);
            apply_firewall(shared).await;
            return retry;
        }
    }

    // Renewing a live mapping is not a new question: stay `open` while the
    // router is still answering.
    let renewing = hub.current().state == ReachabilityState::Open && why == Why::Timer;
    // `asking` shows for the first question and for "Try again". The timer's
    // retries keep the last verdict until a new one replaces it, so a router
    // that stays shut does not flicker the state (and every admin's screen)
    // once a minute.
    if why != Why::Timer {
        hub.update(|r| {
            r.state = ReachabilityState::Asking;
            r.next_retry_at = None;
        });
    }

    let held = shared
        .held
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let routers: Vec<Arc<dyn Router>> = match (&held, renewing) {
        (Some(router), true) => vec![Arc::clone(router) as Arc<dyn Router>],
        _ => shared
            .routers
            .iter()
            .map(|r| Arc::clone(r) as Arc<dyn Router>)
            .collect(),
    };
    let attempt =
        portmap::establish(&routers, settings.request, settings.lease, settings.budget).await;

    let wait = match attempt.result {
        Ok(mapped) => {
            // The Arc<dyn Router> handed back is the Tracked we passed in.
            if let Some(tracked) = shared
                .routers
                .iter()
                .find(|r| std::ptr::addr_eq(Arc::as_ptr(r), Arc::as_ptr(&mapped.router)))
            {
                *shared.held.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(tracked));
            }
            apply_mapping(shared, &mapped.mapping, lan_ip)
        }
        Err(failure) => apply_failure(shared, &failure, lan_ip),
    };
    observe_public_address(shared, why, lan_ip).await;
    log_state(shared);

    // Windows host mode: a missing firewall rule beats whatever the router said.
    if apply_firewall(shared).await {
        return wait.min(retry);
    }
    wait
}

fn apply_mapping(shared: &Shared, mapping: &Mapping, lan_ip: Option<IpAddr>) -> Duration {
    let retry = shared.settings.retry;
    let (state, error) = match classify(mapping.external_ip) {
        AddressClass::Public => (ReachabilityState::Open, None),
        AddressClass::Shared => (ReachabilityState::SharedAddress, None),
        AddressClass::Unusable => (
            ReachabilityState::Refused,
            Some(format!(
                "the router reported {} as its public address, which nobody can connect to",
                mapping.external_ip
            )),
        ),
    };
    let open = state == ReachabilityState::Open;
    // `granted: None` is a permanent entry: nothing expires, nothing to renew,
    // so look again now and then to notice a changed address.
    let renew = mapping
        .granted
        .map_or(PERMANENT_RECHECK, shared.settings.renew_interval);
    let wait = if open { renew } else { retry };
    shared.hub.update(|r| {
        r.state = state;
        r.method = Some(mapping.protocol.to_string());
        // Report what the router said even when it is a shared address, so
        // the sheet can name it; never for an unusable one.
        r.external_ip =
            (state != ReachabilityState::Refused).then(|| mapping.external_ip.to_string());
        r.gateway_ip = mapping.gateway_ip.map(|ip| ip.to_string());
        r.lan_ip = mapping.lan_ip.or(lan_ip).map(|ip| ip.to_string());
        r.lease_expires_at = mapping.granted.map(|lease| stamp(after(lease)));
        r.next_retry_at = (!open).then(|| stamp(after(retry)));
        r.last_error = error;
    });
    wait
}

fn apply_failure(shared: &Shared, failure: &MapFailure, lan_ip: Option<IpAddr>) -> Duration {
    let retry = shared.settings.retry;
    let state = match failure.kind {
        FailureKind::Refused => ReachabilityState::Refused,
        FailureKind::NoAnswer => ReachabilityState::NoAnswer,
    };
    shared.hub.update(|r| {
        r.state = state;
        r.method = None;
        // A router that refused may still have named its outside address; one
        // that did not answer named nothing. Never an unusable one.
        r.external_ip = failure
            .external_ip
            .filter(|ip| classify(*ip) != AddressClass::Unusable)
            .map(|ip| ip.to_string());
        // The router that answered, if any: a refusal still knows its address.
        r.gateway_ip = failure.gateway_ip.map(|ip| ip.to_string());
        r.lan_ip = lan_ip.map(|ip| ip.to_string());
        r.lease_expires_at = None;
        r.next_retry_at = Some(stamp(after(retry)));
        r.last_error = Some(failure.reason.clone());
    });
    retry
}

/// Ask the STUN server for this network's public address when the router has
/// not named one, and forget the answer once the router does.
async fn observe_public_address(shared: &Shared, why: Why, lan_ip: Option<IpAddr>) {
    let current = shared.hub.current();
    let router_public = current
        .external_ip
        .as_deref()
        .and_then(|text| text.parse::<IpAddr>().ok())
        .is_some_and(|ip| classify(ip) == AddressClass::Public);
    let Some(probe) = shared.env.public_address.as_ref() else {
        return;
    };
    if router_public {
        if current.observed_ip.is_some() {
            shared.hub.update(|r| r.observed_ip = None);
        }
        return;
    }
    let due = {
        let asked = shared.observed_at.lock().unwrap_or_else(|e| e.into_inner());
        why != Why::Timer || asked.is_none_or(|at| at.elapsed() >= STUN_REFRESH)
    };
    if !due {
        return;
    }
    *shared.observed_at.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(tokio::time::Instant::now());
    match probe.discover(lan_ip).await {
        Ok(observed) => {
            let class = classify(observed.ip);
            tracing::info!(
                target: "paracord::portmap",
                server = %observed.server,
                observed_ip = %observed.ip,
                public = class == AddressClass::Public,
                "the router did not name a public address; asked a STUN server instead"
            );
            // Kept even when it is not public, so the invite can say what is in
            // the way; only a public one is ever shared.
            let observed_ip = (class != AddressClass::Unusable).then(|| observed.ip.to_string());
            shared.hub.update(|r| r.observed_ip = observed_ip);
        }
        Err(reason) => {
            tracing::warn!(
                target: "paracord::portmap",
                reason = %reason,
                "could not learn this network's public address from a STUN server; invite links \
                 use the address on this network"
            );
            shared.hub.update(|r| r.observed_ip = None);
        }
    }
}

/// Returns true when the firewall is blocking.
async fn apply_firewall(shared: &Shared) -> bool {
    let Some(firewall) = shared.env.firewall.as_ref() else {
        return false;
    };
    match firewall.blocked(shared.settings.request.tcp_port).await {
        Ok(Some(detail)) => {
            shared.hub.update(|r| {
                r.state = ReachabilityState::FirewallBlocked;
                r.next_retry_at = Some(stamp(after(shared.settings.retry)));
                r.last_error = Some(detail);
            });
            log_state(shared);
            true
        }
        Ok(None) => false,
        Err(reason) => {
            tracing::warn!(
                target: "paracord::portmap",
                reason = %reason,
                "could not check the firewall; not reporting it either way"
            );
            false
        }
    }
}

fn log_state(shared: &Shared) {
    let r = shared.hub.current();
    match r.state {
        ReachabilityState::Open | ReachabilityState::Direct => tracing::info!(
            target: "paracord::portmap",
            state = ?r.state,
            external_ip = r.external_ip.as_deref().unwrap_or("-"),
            method = r.method.as_deref().unwrap_or("-"),
            "reachability"
        ),
        _ => tracing::warn!(
            target: "paracord::portmap",
            state = ?r.state,
            external_ip = r.external_ip.as_deref().unwrap_or("-"),
            observed_ip = r.observed_ip.as_deref().unwrap_or("-"),
            reason = r.last_error.as_deref().unwrap_or("-"),
            next_retry_at = r.next_retry_at.as_deref().unwrap_or("-"),
            "reachability"
        ),
    }
}

/// The banner's view of a reachability verdict.
pub fn outcome_for(r: &paracord_contracts::host::Reachability) -> portmap::Outcome {
    use portmap::Outcome;
    let ip = r
        .external_ip
        .as_deref()
        .and_then(|text| text.parse::<IpAddr>().ok());
    match r.state {
        ReachabilityState::Open => Outcome::Mapped {
            external_ip: ip,
            method: match r.method.as_deref() {
                Some("upnp") => "UPnP",
                _ => "NAT-PMP/PCP",
            },
        },
        ReachabilityState::Direct => match ip {
            Some(ip) => Outcome::Direct { ip },
            None => Outcome::NotAvailable {
                external_ip: None,
                reason: "no public address".to_string(),
            },
        },
        ReachabilityState::SharedAddress => Outcome::NotAvailable {
            external_ip: None,
            reason: "the router's own address is shared with others (carrier-grade NAT or \
                     another router in front)"
                .to_string(),
        },
        ReachabilityState::FirewallBlocked => Outcome::NotAvailable {
            external_ip: None,
            reason: r
                .last_error
                .clone()
                .unwrap_or_else(|| "the firewall is blocking friends".to_string()),
        },
        ReachabilityState::Refused | ReachabilityState::NoAnswer | ReachabilityState::Asking => {
            Outcome::NotAvailable {
                // Where friends would join once the port is forwarded, when
                // a public address is known.
                external_ip: paracord_core::reachability::public_address(r).map(|(ip, _)| ip),
                reason: r
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "the router did not open the ports".to_string()),
            }
        }
        ReachabilityState::Off => Outcome::Skipped(portmap::SkipReason::Disabled),
    }
}

/// This computer's IPv4 address on the interface the server listens on: the
/// bind address when it names one, else the address used toward the internet.
pub fn bind_lan_ip(bind_address: &str) -> Option<IpAddr> {
    let host = bind_address
        .rsplit_once(':')
        .map_or(bind_address, |(h, _)| h);
    match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(ip) if !ip.is_unspecified() => Some(ip),
        _ => portmap::local_ipv4_toward_internet().map(IpAddr::V4),
    }
}

// ── Observed connections ────────────────────────────────────────────────────

/// Wraps the TLS acceptor so every connection that completes its handshake is
/// shown to the hub, which decides whether it came from outside this network.
/// The handshake is the point: a scanner that opens a socket and leaves is not
/// a friend knocking.
#[derive(Clone)]
pub struct ObservingAcceptor<A> {
    inner: A,
    hub: Arc<ReachabilityHub>,
}

impl<A> ObservingAcceptor<A> {
    pub fn new(inner: A, hub: Arc<ReachabilityHub>) -> Self {
        Self { inner, hub }
    }
}

impl<A, S> axum_server::accept::Accept<tokio::net::TcpStream, S> for ObservingAcceptor<A>
where
    A: axum_server::accept::Accept<tokio::net::TcpStream, S>,
    A::Future: Send + 'static,
    A::Stream: Send + 'static,
    A::Service: Send + 'static,
{
    type Stream = A::Stream;
    type Service = A::Service;
    type Future = Pin<Box<dyn Future<Output = std::io::Result<(A::Stream, A::Service)>> + Send>>;

    fn accept(&self, stream: tokio::net::TcpStream, service: S) -> Self::Future {
        let peer = stream.peer_addr().ok().map(|addr| addr.ip());
        let hub = Arc::clone(&self.hub);
        let handshake = self.inner.accept(stream, service);
        Box::pin(async move {
            let accepted = handshake.await?;
            if let Some(peer) = peer {
                hub.record_inbound_connection(peer);
            }
            Ok(accepted)
        })
    }
}

// ── Windows Firewall ────────────────────────────────────────────────────────

/// Whether `netsh advfirewall firewall show rule` output describes an inbound
/// allow rule that names `port`. The labels are localized on non-English
/// Windows, so only the exit status and the port number are relied on.
#[cfg(any(windows, test))]
pub fn netsh_rule_covers_port(succeeded: bool, stdout: &str, port: u16) -> bool {
    if !succeeded {
        return false;
    }
    let wanted = port.to_string();
    stdout.lines().any(|line| {
        line.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|token| token == wanted)
    })
}

#[cfg(windows)]
pub struct WindowsFirewall;

#[cfg(windows)]
impl FirewallCheck for WindowsFirewall {
    fn blocked(&self, port: u16) -> BoxFuture<'_, Result<Option<String>, String>> {
        Box::pin(async move {
            let output = tokio::process::Command::new("netsh")
                .args([
                    "advfirewall",
                    "firewall",
                    "show",
                    "rule",
                    &format!("name={FIREWALL_RULE_NAME}"),
                ])
                .output()
                .await
                .map_err(|err| format!("could not run netsh ({err})"))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            if netsh_rule_covers_port(output.status.success(), &stdout, port) {
                Ok(None)
            } else {
                Ok(Some(format!(
                    "Windows Firewall has no rule \"{FIREWALL_RULE_NAME}\" for port {port}"
                )))
            }
        })
    }
}

/// The firewall check for this platform and mode: Windows host mode only.
pub fn platform_firewall(host_mode: bool) -> Option<Arc<dyn FirewallCheck>> {
    #[cfg(windows)]
    if host_mode {
        return Some(Arc::new(WindowsFirewall));
    }
    let _ = host_mode;
    None
}

#[cfg(test)]
mod tests;
