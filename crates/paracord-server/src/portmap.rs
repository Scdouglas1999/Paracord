//! Ask the router to let friends in, so the owner never has to.
//!
//! A first-time owner should not have to log into a router's admin page to run
//! a chat server. Most home routers will open a port on request, over one of two
//! protocols: UPnP IGD (the one nearly every consumer router speaks) and
//! NAT-PMP/PCP (Apple gear, many gaming routers). This module tries them in
//! that order and reports exactly one outcome, which the startup banner turns
//! into a sentence a non-technical person can act on.
//!
//! Exactly two ports are asked for, because exactly two are what a friend
//! outside the house needs: the TCP port the app answers on, and the UDP port
//! voice, video and screen share use. Under the generated defaults both are
//! 8443 and the request collapses to one number per protocol.
//!
//! Nothing here degrades silently. Every path ends in an [`Outcome`] that is
//! logged once with its reason, and the banner says either "friends anywhere can
//! join at ..." or "only your own network can reach this, here is how to change
//! that". A router that does not answer must never delay boot, so the whole
//! attempt runs under one hard budget ([`DISCOVERY_BUDGET`]) and removal on
//! shutdown under a shorter one ([`REMOVAL_BUDGET`]).
//!
//! The gateway conversation sits behind [`Router`] so the orchestration —
//! fallback order, the budget, the renewal arithmetic — is testable without a
//! router in the room.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::num::NonZeroU16;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// Hard ceiling on the whole mapping attempt, across every method.
///
/// A router that ignores discovery packets costs exactly this and not a second
/// more. It runs concurrently with the rest of startup, so on a cooperative
/// network the visible cost is zero and on a hostile one it is bounded.
pub const DISCOVERY_BUDGET: Duration = Duration::from_secs(8);

/// Hard ceiling on tearing the mappings down during a graceful shutdown.
///
/// A restart must not hang on a router that stopped answering; a mapping left
/// behind expires on its own lease.
pub const REMOVAL_BUDGET: Duration = Duration::from_secs(3);

/// Shortest lease worth asking for. Below this the renewals cost more than the
/// mapping is worth, and a router reboot is covered by renewal either way.
const MIN_LEASE: Duration = Duration::from_secs(120);

/// Longest lease worth asking for. Routers commonly cap leases well under this;
/// asking for a week and being given an hour is normal and handled by renewal.
const MAX_LEASE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// How the mapping shows up in a router's table.
const UPNP_TCP_DESCRIPTION: &str = "Paracord (app)";
const UPNP_UDP_DESCRIPTION: &str = "Paracord (voice & video)";

/// The two ports a friend outside this network has to be able to reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortRequest {
    /// TCP: the port a browser or the desktop app connects to (HTTPS when TLS
    /// is on, otherwise the plain bind port).
    pub tcp_port: u16,
    /// UDP: the native media port that carries voice, video and screen share.
    pub udp_port: u16,
}

/// Which transport a single mapping is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Tcp,
    Udp,
}

impl Transport {
    fn label(self) -> &'static str {
        match self {
            Transport::Tcp => "TCP",
            Transport::Udp => "UDP",
        }
    }
}

impl PortRequest {
    /// The distinct (port, transport) pairs to ask for. Deliberately not
    /// deduplicated across transports: the same number on TCP and UDP is two
    /// different mappings to every router, which is the whole reason forwarding
    /// only the web port used to leave outside callers silent.
    pub fn entries(self) -> Vec<(u16, Transport)> {
        vec![
            (self.tcp_port, Transport::Tcp),
            (self.udp_port, Transport::Udp),
        ]
    }
}

/// Why no attempt was made at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The server only listens on this computer, so there is no outside to open
    /// a door to.
    LoopbackBind,
    /// `[network] auto_port_forward = false`.
    Disabled,
    /// Nothing has been asked yet, because nothing is listening yet: this is
    /// `paracord-server init`, which writes a config file and exits. Saying "your
    /// router refused" here would be a guess dressed up as a result.
    NotAskedYet,
}

impl SkipReason {
    fn detail(self) -> &'static str {
        match self {
            SkipReason::LoopbackBind => {
                "the server only listens on this computer (loopback bind), so there is nothing \
                 for a router to forward"
            }
            SkipReason::Disabled => "[network] auto_port_forward is false",
            SkipReason::NotAskedYet => "the server has not started yet",
        }
    }
}

/// The single, always-logged result of the attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The router accepted both mappings. `external_ip` is the address friends
    /// type, when the router (or the public-IP lookup) told us what it is.
    Mapped {
        external_ip: Option<IpAddr>,
        method: &'static str,
    },
    /// Nothing opened the ports. `external_ip` is whatever was learned anyway,
    /// so the banner can still name the address a hand-made forwarding rule
    /// would be reachable at.
    NotAvailable {
        external_ip: Option<IpAddr>,
        reason: String,
    },
    /// No attempt was made, on purpose.
    Skipped(SkipReason),
}

impl Outcome {
    /// Fill in a public address learned some other way (the HTTP lookup) when
    /// the router did not report one. Never overwrites what the router said:
    /// the gateway's own answer is the authority on its own address.
    pub fn with_fallback_ip(self, fallback: Option<IpAddr>) -> Self {
        match self {
            Outcome::Mapped {
                external_ip: None,
                method,
            } => Outcome::Mapped {
                external_ip: fallback,
                method,
            },
            Outcome::NotAvailable {
                external_ip: None,
                reason,
            } => Outcome::NotAvailable {
                external_ip: fallback,
                reason,
            },
            other => other,
        }
    }

    /// The public address friends would use, when one is known.
    pub fn external_ip(&self) -> Option<IpAddr> {
        match self {
            Outcome::Mapped { external_ip, .. } | Outcome::NotAvailable { external_ip, .. } => {
                *external_ip
            }
            Outcome::Skipped(_) => None,
        }
    }

    /// True when a friend on the far side of the router can reach this server.
    pub fn is_mapped(&self) -> bool {
        matches!(self, Outcome::Mapped { .. })
    }

    /// The value for the banner's "Friends outside your network:" line, in words
    /// that need no glossary.
    pub fn status_line(&self) -> String {
        match self {
            Outcome::Mapped {
                external_ip: Some(ip),
                ..
            } => format!("Yes — set up automatically ({ip})"),
            Outcome::Mapped {
                external_ip: None, ..
            } => "Yes — set up automatically".to_string(),
            Outcome::NotAvailable { .. } => {
                "Not yet — your router needs one setting changed".to_string()
            }
            Outcome::Skipped(SkipReason::LoopbackBind) => "No — this computer only".to_string(),
            Outcome::Skipped(SkipReason::Disabled) => {
                "Not checked (turned off in the config)".to_string()
            }
            Outcome::Skipped(SkipReason::NotAskedYet) => {
                "Checked when the server starts".to_string()
            }
        }
    }

    /// Say it once, in the log, with the reason. The banner is for the person at
    /// the keyboard; this is for the person reading a log file later.
    pub fn log(&self, request: PortRequest) {
        let external_ip = self
            .external_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        match self {
            Outcome::Mapped { method, .. } => tracing::info!(
                target: "paracord::portmap",
                method,
                tcp_port = request.tcp_port,
                udp_port = request.udp_port,
                external_ip,
                "router opened the ports: friends outside this network can reach this server"
            ),
            Outcome::NotAvailable { reason, .. } => tracing::warn!(
                target: "paracord::portmap",
                tcp_port = request.tcp_port,
                udp_port = request.udp_port,
                external_ip,
                reason = %reason,
                "could not open the ports automatically; only this network can reach the server \
                 until someone forwards them by hand (see docs/port-forwarding.md)"
            ),
            Outcome::Skipped(reason) => tracing::info!(
                target: "paracord::portmap",
                "not asking the router to open any ports: {}",
                reason.detail()
            ),
        }
    }
}

/// Boxed future, so [`Router`] stays usable behind `Arc<dyn Router>`.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The gateway conversation, as the orchestrator sees it.
///
/// Everything that talks to a real router is behind this trait, which is what
/// makes the parts worth testing — fallback order, the budget, renewal timing —
/// testable with a fake that never touches the network.
pub trait Router: Send + Sync {
    /// How this method is named to a human, in the log and the status line.
    fn method(&self) -> &'static str;

    /// Install (or refresh) both mappings. `Err` carries a reason in plain words.
    fn map(&self, request: PortRequest, lease: Duration) -> BoxFuture<'_, Result<Mapping, String>>;

    /// Take the mappings back down.
    fn unmap(&self, request: PortRequest) -> BoxFuture<'_, Result<(), String>>;
}

/// What a router reported once it accepted the mappings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Mapping {
    /// The public address of this network, when the gateway knows it. NAT-PMP
    /// (unlike PCP and UPnP) never reports one, hence the `Option`.
    pub external_ip: Option<IpAddr>,
}

/// The result of one attempt, plus the router that answered so renewal and
/// removal keep talking to the same one.
pub struct Attempt {
    pub outcome: Outcome,
    pub router: Option<Arc<dyn Router>>,
}

/// Clamp a configured lease to a range worth asking a router for.
pub fn lease_from_seconds(seconds: u32) -> Duration {
    Duration::from_secs(u64::from(seconds)).clamp(MIN_LEASE, MAX_LEASE)
}

/// How often to refresh the mapping: half the lease, so one missed renewal
/// still leaves a working server, floored so a tiny lease cannot turn into a
/// busy loop and capped so a huge one still re-checks within a day.
pub fn renew_interval(lease: Duration) -> Duration {
    (lease / 2).clamp(Duration::from_secs(30), Duration::from_secs(12 * 60 * 60))
}

/// Try each router in order under one shared budget, and stop at the first that
/// accepts both mappings.
///
/// The budget is shared rather than per-method on purpose: the promise is that
/// startup is never delayed by more than `budget`, whatever combination of
/// silent and slow the network offers.
pub async fn establish(
    routers: &[Arc<dyn Router>],
    request: PortRequest,
    lease: Duration,
    budget: Duration,
) -> Attempt {
    let deadline = tokio::time::Instant::now() + budget;
    let mut reasons: Vec<String> = Vec::new();

    for router in routers {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            reasons.push(format!(
                "{}: not tried, the {}s budget was already spent",
                router.method(),
                budget.as_secs()
            ));
            continue;
        }
        match tokio::time::timeout(remaining, router.map(request, lease)).await {
            Ok(Ok(mapping)) => {
                return Attempt {
                    outcome: Outcome::Mapped {
                        external_ip: mapping.external_ip,
                        method: router.method(),
                    },
                    router: Some(Arc::clone(router)),
                };
            }
            Ok(Err(reason)) => reasons.push(format!("{}: {reason}", router.method())),
            Err(_) => reasons.push(format!(
                "{}: no answer within {}s",
                router.method(),
                remaining.as_secs()
            )),
        }
    }

    Attempt {
        outcome: Outcome::NotAvailable {
            external_ip: None,
            reason: if reasons.is_empty() {
                "no port-mapping method was available".to_string()
            } else {
                reasons.join("; ")
            },
        },
        router: None,
    }
}

/// The real routers, in the order they are tried: UPnP IGD first because nearly
/// every consumer router speaks it, then NAT-PMP/PCP.
pub fn default_routers() -> Vec<Arc<dyn Router>> {
    vec![
        Arc::new(UpnpRouter::default()) as Arc<dyn Router>,
        Arc::new(NatPmpRouter::default()) as Arc<dyn Router>,
    ]
}

/// Refresh the mapping for as long as the server runs.
///
/// Re-asking the same router (rather than "renewing" a handle) is deliberate: it
/// is what survives a router reboot, which drops every mapping it held.
pub fn spawn_renewal(
    router: Arc<dyn Router>,
    request: PortRequest,
    lease: Duration,
    shutdown: Arc<tokio::sync::Notify>,
) {
    spawn_renewal_every(router, request, lease, renew_interval(lease), shutdown);
}

/// [`spawn_renewal`] with the interval supplied rather than derived, so the loop
/// itself can be exercised without waiting half a real lease.
fn spawn_renewal_every(
    router: Arc<dyn Router>,
    request: PortRequest,
    lease: Duration,
    interval: Duration,
    shutdown: Arc<tokio::sync::Notify>,
) {
    tracing::info!(
        target: "paracord::portmap",
        method = router.method(),
        lease_seconds = lease.as_secs(),
        renew_every_seconds = interval.as_secs(),
        "keeping the router's port mappings alive"
    );
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tokio::time::sleep(interval) => {
                    match tokio::time::timeout(DISCOVERY_BUDGET, router.map(request, lease)).await {
                        Ok(Ok(_)) => tracing::debug!(
                            target: "paracord::portmap",
                            method = router.method(),
                            "refreshed the router's port mappings"
                        ),
                        Ok(Err(reason)) => tracing::warn!(
                            target: "paracord::portmap",
                            method = router.method(),
                            reason = %reason,
                            "could not refresh the router's port mappings; friends outside this \
                             network may stop being able to join"
                        ),
                        Err(_) => tracing::warn!(
                            target: "paracord::portmap",
                            method = router.method(),
                            "the router stopped answering while refreshing its port mappings"
                        ),
                    }
                }
            }
        }
    });
}

/// Take the mappings down on a graceful shutdown, within [`REMOVAL_BUDGET`].
///
/// Awaited inline on the shutdown path rather than spawned, so it actually
/// happens before the process leaves — but bounded, so a router that stopped
/// answering cannot hold a restart hostage.
pub async fn release(router: Arc<dyn Router>, request: PortRequest) {
    release_within(router, request, REMOVAL_BUDGET).await;
}

/// [`release`] with the budget supplied rather than fixed, so the bound itself
/// can be tested without a three-second wait.
async fn release_within(router: Arc<dyn Router>, request: PortRequest, budget: Duration) {
    match tokio::time::timeout(budget, router.unmap(request)).await {
        Ok(Ok(())) => tracing::info!(
            target: "paracord::portmap",
            method = router.method(),
            "closed the ports this server asked the router to open"
        ),
        Ok(Err(reason)) => tracing::warn!(
            target: "paracord::portmap",
            method = router.method(),
            reason = %reason,
            "could not close the router's port mappings; they expire with their lease"
        ),
        Err(_) => tracing::warn!(
            target: "paracord::portmap",
            method = router.method(),
            "the router did not answer within {:?} while closing its port mappings; they expire \
             with their lease",
            budget
        ),
    }
}

// ── UPnP IGD ────────────────────────────────────────────────────────────────

/// UPnP IGD, cached after the first successful discovery so renewal and removal
/// do not pay for another search.
#[derive(Default)]
struct UpnpRouter {
    gateway: tokio::sync::Mutex<Option<igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>>>,
}

impl UpnpRouter {
    async fn gateway(
        &self,
        search_timeout: Duration,
    ) -> Result<igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, String> {
        let mut cached = self.gateway.lock().await;
        if let Some(gateway) = cached.as_ref() {
            return Ok(gateway.clone());
        }
        let gateway = igd_next::aio::tokio::search_gateway(igd_next::SearchOptions {
            timeout: Some(search_timeout),
            ..Default::default()
        })
        .await
        .map_err(|err| format!("no UPnP router answered ({err})"))?;
        *cached = Some(gateway.clone());
        Ok(gateway)
    }
}

impl Router for UpnpRouter {
    fn method(&self) -> &'static str {
        "UPnP"
    }

    fn map(&self, request: PortRequest, lease: Duration) -> BoxFuture<'_, Result<Mapping, String>> {
        Box::pin(async move {
            // Bounded below the overall budget so a silent router still leaves
            // time for NAT-PMP.
            let gateway = self.gateway(Duration::from_secs(4)).await?;
            let local_ip = local_ip_toward(gateway.addr)
                .map_err(|err| format!("could not work out this computer's address ({err})"))?;
            let lease_seconds = u32::try_from(lease.as_secs()).unwrap_or(u32::MAX);

            for (port, transport) in request.entries() {
                add_upnp_mapping(&gateway, local_ip, port, transport, lease_seconds).await?;
            }

            let external_ip = gateway.get_external_ip().await.ok();
            Ok(Mapping { external_ip })
        })
    }

    fn unmap(&self, request: PortRequest) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let gateway = self.gateway(Duration::from_secs(2)).await?;
            let mut failures: Vec<String> = Vec::new();
            for (port, transport) in request.entries() {
                if let Err(err) = gateway
                    .remove_port(upnp_protocol(transport), port)
                    .await
                    .map_err(|err| format!("{} {port}: {err}", transport.label()))
                {
                    failures.push(err);
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("; "))
            }
        })
    }
}

fn upnp_protocol(transport: Transport) -> igd_next::PortMappingProtocol {
    match transport {
        Transport::Tcp => igd_next::PortMappingProtocol::TCP,
        Transport::Udp => igd_next::PortMappingProtocol::UDP,
    }
}

async fn add_upnp_mapping(
    gateway: &igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>,
    local_ip: IpAddr,
    port: u16,
    transport: Transport,
    lease_seconds: u32,
) -> Result<(), String> {
    let protocol = upnp_protocol(transport);
    let description = match transport {
        Transport::Tcp => UPNP_TCP_DESCRIPTION,
        Transport::Udp => UPNP_UDP_DESCRIPTION,
    };
    let local_addr = SocketAddr::new(local_ip, port);

    match gateway
        .add_port(protocol, port, local_addr, lease_seconds, description)
        .await
    {
        Ok(()) => Ok(()),
        // The mapping already exists. On a restart or a renewal that is our own
        // entry, which is exactly the state we wanted.
        Err(igd_next::AddPortError::PortInUse) => Ok(()),
        // Some routers refuse timed leases outright and only keep permanent
        // entries. Asking again for a permanent one is the honest retry; it is
        // still removed on a graceful shutdown.
        Err(igd_next::AddPortError::OnlyPermanentLeasesSupported) => gateway
            .add_port(protocol, port, local_addr, 0, description)
            .await
            .map_err(|err| {
                format!(
                    "this router only keeps permanent entries and refused one for {} {port} ({err})",
                    transport.label()
                )
            }),
        Err(err) => Err(format!(
            "the router refused {} {port} ({err})",
            transport.label()
        )),
    }
}

// ── NAT-PMP / PCP ───────────────────────────────────────────────────────────

/// NAT-PMP and its successor PCP. The mappings are kept because PCP needs the
/// session nonce it minted to take one back down again.
#[derive(Default)]
struct NatPmpRouter {
    mappings: tokio::sync::Mutex<Vec<crab_nat::PortMapping>>,
}

impl Router for NatPmpRouter {
    fn method(&self) -> &'static str {
        "NAT-PMP/PCP"
    }

    fn map(&self, request: PortRequest, lease: Duration) -> BoxFuture<'_, Result<Mapping, String>> {
        Box::pin(async move {
            let gateway_ip = default_gateway_ipv4()
                .map_err(|err| format!("could not find this network's router ({err})"))?;
            let client_ip = local_ip_toward_ipv4(gateway_ip)
                .map_err(|err| format!("could not work out this computer's address ({err})"))?;
            let lifetime = u32::try_from(lease.as_secs()).unwrap_or(u32::MAX);

            let mut fresh: Vec<crab_nat::PortMapping> = Vec::new();
            let mut external_ip: Option<IpAddr> = None;

            for (port, transport) in request.entries() {
                let internal_port = NonZeroU16::new(port)
                    .ok_or_else(|| format!("{} port 0 cannot be mapped", transport.label()))?;
                let options = crab_nat::PortMappingOptions {
                    external_port: Some(internal_port),
                    lifetime_seconds: Some(lifetime),
                    timeout_config: Some(crab_nat::TimeoutConfig {
                        initial_timeout: Duration::from_millis(400),
                        max_retries: 2,
                        max_retry_timeout: Some(Duration::from_secs(2)),
                    }),
                };
                let mapping = crab_nat::PortMapping::new(
                    gateway_ip.into(),
                    IpAddr::V4(client_ip),
                    natpmp_protocol(transport),
                    internal_port,
                    options,
                )
                .await
                .map_err(|err| {
                    format!("the router refused {} {port} ({err})", transport.label())
                })?;

                // A different outside port is not usable here: clients derive
                // both the app URL and the media port from this one number, so
                // silently accepting a remapped port would hand the owner an
                // address that does not work.
                if mapping.external_port() != internal_port {
                    let assigned = mapping.external_port();
                    let _ = mapping.try_drop().await;
                    return Err(format!(
                        "this router mapped {} {port} to a different outside port ({assigned}), \
                         which Paracord cannot use",
                        transport.label()
                    ));
                }

                if external_ip.is_none() {
                    if let crab_nat::PortMappingType::Pcp {
                        external_ip: reported,
                        ..
                    } = mapping.mapping_type()
                    {
                        external_ip = Some(reported);
                    }
                }
                fresh.push(mapping);
            }

            *self.mappings.lock().await = fresh;
            Ok(Mapping { external_ip })
        })
    }

    fn unmap(&self, _request: PortRequest) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let mappings = std::mem::take(&mut *self.mappings.lock().await);
            let mut failures: Vec<String> = Vec::new();
            for mapping in mappings {
                let internal_port = mapping.internal_port();
                if let Err((err, _returned)) = mapping.try_drop().await {
                    failures.push(format!("port {internal_port}: {err}"));
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("; "))
            }
        })
    }
}

fn natpmp_protocol(transport: Transport) -> crab_nat::InternetProtocol {
    match transport {
        Transport::Tcp => crab_nat::InternetProtocol::Tcp,
        Transport::Udp => crab_nat::InternetProtocol::Udp,
    }
}

// ── Local addressing helpers ────────────────────────────────────────────────

/// This computer's address on the path toward `target`.
///
/// A connected UDP socket never sends a packet, but the kernel still picks the
/// source address it would use — which is the address the router has to forward
/// to, and the one thing a machine with Docker bridges, VPN tunnels and
/// loopback cannot be asked to guess.
fn local_ip_toward(target: SocketAddr) -> std::io::Result<IpAddr> {
    let bind: SocketAddr = if target.is_ipv4() {
        (Ipv4Addr::UNSPECIFIED, 0).into()
    } else {
        (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
    };
    let socket = std::net::UdpSocket::bind(bind)?;
    socket.connect(target)?;
    Ok(socket.local_addr()?.ip())
}

fn local_ip_toward_ipv4(gateway: Ipv4Addr) -> std::io::Result<Ipv4Addr> {
    match local_ip_toward(SocketAddr::V4(SocketAddrV4::new(
        gateway,
        crab_nat::GATEWAY_PORT,
    )))? {
        IpAddr::V4(ip) => Ok(ip),
        IpAddr::V6(ip) => Err(std::io::Error::other(format!(
            "expected an IPv4 address toward the router, got {ip}"
        ))),
    }
}

/// Best guess at this network's router: `.1` on the subnet this machine uses to
/// reach the internet. NAT-PMP has no discovery step of its own — the protocol
/// assumes the caller knows the gateway — and `.1` is what home routers use.
fn default_gateway_ipv4() -> std::io::Result<Ipv4Addr> {
    match local_ip_toward((Ipv4Addr::new(8, 8, 8, 8), 53).into())? {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            Ok(Ipv4Addr::new(o[0], o[1], o[2], 1))
        }
        IpAddr::V6(_) => Err(std::io::Error::other(
            "this machine reaches the internet over IPv6; NAT-PMP needs an IPv4 router",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A router that never touches the network: it records that it was asked,
    /// and answers however the test told it to.
    struct FakeRouter {
        method: &'static str,
        /// How long the fake "router" takes to answer.
        delay: Duration,
        answer: Result<Mapping, String>,
        map_calls: Arc<AtomicUsize>,
        unmap_calls: Arc<AtomicUsize>,
        /// Appended to in call order, shared across the fakes in one test.
        order: Arc<std::sync::Mutex<Vec<&'static str>>>,
    }

    impl FakeRouter {
        fn new(method: &'static str, answer: Result<Mapping, String>) -> Self {
            Self {
                method,
                delay: Duration::ZERO,
                answer,
                map_calls: Arc::new(AtomicUsize::new(0)),
                unmap_calls: Arc::new(AtomicUsize::new(0)),
                order: Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }

        fn with_delay(mut self, delay: Duration) -> Self {
            self.delay = delay;
            self
        }

        fn sharing_order(mut self, order: Arc<std::sync::Mutex<Vec<&'static str>>>) -> Self {
            self.order = order;
            self
        }
    }

    impl Router for FakeRouter {
        fn method(&self) -> &'static str {
            self.method
        }

        fn map(
            &self,
            _request: PortRequest,
            _lease: Duration,
        ) -> BoxFuture<'_, Result<Mapping, String>> {
            Box::pin(async move {
                self.order.lock().expect("order lock").push(self.method);
                self.map_calls.fetch_add(1, Ordering::SeqCst);
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                self.answer.clone()
            })
        }

        fn unmap(&self, _request: PortRequest) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.unmap_calls.fetch_add(1, Ordering::SeqCst);
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                Ok(())
            })
        }
    }

    const REQUEST: PortRequest = PortRequest {
        tcp_port: 8443,
        udp_port: 8443,
    };

    fn mapped(ip: &str) -> Result<Mapping, String> {
        Ok(Mapping {
            external_ip: Some(ip.parse().expect("test ip")),
        })
    }

    /// Both ports are asked for separately even when they are the same number:
    /// TCP 8443 and UDP 8443 are two mappings, and forwarding only the first is
    /// what used to leave every outside caller silent.
    #[test]
    fn the_same_number_is_two_mappings() {
        assert_eq!(
            REQUEST.entries(),
            vec![(8443, Transport::Tcp), (8443, Transport::Udp)]
        );
        let split = PortRequest {
            tcp_port: 8090,
            udp_port: 8443,
        };
        assert_eq!(
            split.entries(),
            vec![(8090, Transport::Tcp), (8443, Transport::Udp)]
        );
    }

    #[tokio::test]
    async fn the_first_router_that_answers_wins_and_the_second_is_never_asked() {
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let first = Arc::new(
            FakeRouter::new("first", mapped("203.0.113.9")).sharing_order(Arc::clone(&order)),
        );
        let second = Arc::new(
            FakeRouter::new("second", mapped("198.51.100.7")).sharing_order(Arc::clone(&order)),
        );
        let second_calls = Arc::clone(&second.map_calls);
        let routers: Vec<Arc<dyn Router>> = vec![first, second];

        let attempt = establish(
            &routers,
            REQUEST,
            Duration::from_secs(3600),
            DISCOVERY_BUDGET,
        )
        .await;

        assert_eq!(
            attempt.outcome,
            Outcome::Mapped {
                external_ip: Some("203.0.113.9".parse().unwrap()),
                method: "first",
            }
        );
        assert_eq!(*order.lock().unwrap(), vec!["first"]);
        assert_eq!(second_calls.load(Ordering::SeqCst), 0);
        assert!(attempt.router.is_some());
    }

    #[tokio::test]
    async fn a_refusal_falls_through_to_the_next_method_in_order() {
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let upnp = Arc::new(
            FakeRouter::new("UPnP", Err("no UPnP router answered".to_string()))
                .sharing_order(Arc::clone(&order)),
        );
        let pmp = Arc::new(
            FakeRouter::new("NAT-PMP/PCP", mapped("203.0.113.9")).sharing_order(Arc::clone(&order)),
        );
        let routers: Vec<Arc<dyn Router>> = vec![upnp, pmp];

        let attempt = establish(
            &routers,
            REQUEST,
            Duration::from_secs(3600),
            DISCOVERY_BUDGET,
        )
        .await;

        assert!(matches!(
            attempt.outcome,
            Outcome::Mapped {
                method: "NAT-PMP/PCP",
                ..
            }
        ));
        assert_eq!(*order.lock().unwrap(), vec!["UPnP", "NAT-PMP/PCP"]);
    }

    /// The promise the whole feature rests on: a router that never answers costs
    /// the budget and not a second more, and every reason is reported.
    ///
    /// The budget is scaled down rather than mocked out, so the test exercises
    /// the same `tokio::time::timeout` arithmetic the real 8s path uses.
    #[tokio::test]
    async fn a_silent_network_costs_exactly_the_budget() {
        let budget = Duration::from_millis(200);
        let silent_a = Arc::new(
            FakeRouter::new("UPnP", mapped("203.0.113.9")).with_delay(Duration::from_secs(30)),
        );
        let silent_b = Arc::new(
            FakeRouter::new("NAT-PMP/PCP", mapped("203.0.113.9"))
                .with_delay(Duration::from_secs(30)),
        );
        let routers: Vec<Arc<dyn Router>> = vec![silent_a, silent_b];

        let started = std::time::Instant::now();
        let attempt = establish(&routers, REQUEST, Duration::from_secs(3600), budget).await;
        let spent = started.elapsed();

        assert!(spent >= budget, "returned before the budget: {spent:?}");
        assert!(
            spent < budget * 10,
            "budget overrun: {spent:?} for a {budget:?} budget"
        );
        match attempt.outcome {
            Outcome::NotAvailable { reason, .. } => {
                assert!(reason.contains("UPnP"), "{reason}");
                assert!(reason.contains("NAT-PMP/PCP"), "{reason}");
            }
            other => panic!("expected NotAvailable, got {other:?}"),
        }
        assert!(attempt.router.is_none());
    }

    /// The second method gets whatever the first one left of the budget, not a
    /// fresh copy of it — otherwise two silent methods cost twice the promise.
    #[tokio::test]
    async fn a_slow_first_method_does_not_hand_the_second_a_new_budget() {
        let budget = Duration::from_millis(300);
        let slow = Arc::new(
            FakeRouter::new("UPnP", Err("refused".to_string()))
                .with_delay(Duration::from_millis(150)),
        );
        let also_slow = Arc::new(
            FakeRouter::new("NAT-PMP/PCP", mapped("203.0.113.9"))
                .with_delay(Duration::from_secs(30)),
        );
        let routers: Vec<Arc<dyn Router>> = vec![slow, also_slow];

        let started = std::time::Instant::now();
        let attempt = establish(&routers, REQUEST, Duration::from_secs(3600), budget).await;
        let spent = started.elapsed();

        assert!(spent >= budget, "returned before the budget: {spent:?}");
        assert!(
            spent < budget * 10,
            "the second method was handed a new budget: {spent:?}"
        );
        assert!(matches!(attempt.outcome, Outcome::NotAvailable { .. }));
    }

    #[tokio::test]
    async fn no_routers_at_all_is_reported_rather_than_assumed() {
        let attempt = establish(&[], REQUEST, Duration::from_secs(3600), DISCOVERY_BUDGET).await;
        match attempt.outcome {
            Outcome::NotAvailable { reason, .. } => {
                assert!(reason.contains("no port-mapping method"), "{reason}");
            }
            other => panic!("expected NotAvailable, got {other:?}"),
        }
    }

    /// A restart must never hang on a router that stopped answering: removal is
    /// attempted, bounded, and then reported rather than waited on.
    #[tokio::test]
    async fn removal_is_bounded_and_says_so_rather_than_hanging_a_restart() {
        let budget = Duration::from_millis(150);
        let stuck = Arc::new(
            FakeRouter::new("UPnP", mapped("203.0.113.9")).with_delay(Duration::from_secs(600)),
        );
        let calls = Arc::clone(&stuck.unmap_calls);
        let started = std::time::Instant::now();

        release_within(stuck as Arc<dyn Router>, REQUEST, budget).await;
        let spent = started.elapsed();

        assert!(spent >= budget, "gave up before the budget: {spent:?}");
        assert!(spent < budget * 10, "removal hung: {spent:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// The renewal loop refreshes on its interval and stops the moment shutdown
    /// is signalled — a task that outlives the process it maps for would keep a
    /// door open with nothing behind it.
    #[tokio::test]
    async fn renewal_refreshes_on_its_interval_and_stops_at_shutdown() {
        let router = Arc::new(FakeRouter::new("UPnP", mapped("203.0.113.9")));
        let calls = Arc::clone(&router.map_calls);
        let shutdown = Arc::new(tokio::sync::Notify::new());
        let interval = Duration::from_millis(40);

        spawn_renewal_every(
            Arc::clone(&router) as Arc<dyn Router>,
            REQUEST,
            Duration::from_secs(3600),
            interval,
            Arc::clone(&shutdown),
        );

        // Nothing happens before the first interval elapses: `establish` already
        // installed the mapping, so an immediate tick would be a duplicate.
        tokio::time::sleep(interval / 2).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        tokio::time::sleep(interval * 4).await;
        let refreshed = calls.load(Ordering::SeqCst);
        assert!(
            refreshed >= 2,
            "only {refreshed} refresh(es) in four intervals"
        );

        shutdown.notify_waiters();
        tokio::time::sleep(interval * 2).await;
        let after_shutdown = calls.load(Ordering::SeqCst);
        tokio::time::sleep(interval * 4).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            after_shutdown,
            "renewal kept running after shutdown"
        );
    }

    #[test]
    fn renewal_is_half_the_lease_within_sane_bounds() {
        assert_eq!(
            renew_interval(Duration::from_secs(3600)),
            Duration::from_secs(1800)
        );
        // A lease so short that halving it would busy-loop is floored.
        assert_eq!(
            renew_interval(Duration::from_secs(20)),
            Duration::from_secs(30)
        );
        // A lease of a week still re-checks within the day.
        assert_eq!(
            renew_interval(Duration::from_secs(7 * 24 * 3600)),
            Duration::from_secs(12 * 3600)
        );
    }

    #[test]
    fn a_configured_lease_is_clamped_to_something_a_router_will_honour() {
        assert_eq!(lease_from_seconds(3600), Duration::from_secs(3600));
        assert_eq!(lease_from_seconds(0), MIN_LEASE);
        assert_eq!(lease_from_seconds(5), MIN_LEASE);
        assert_eq!(lease_from_seconds(u32::MAX), MAX_LEASE);
    }

    /// The compact status line never says a word the owner would have to look
    /// up, and never claims more than it knows.
    #[test]
    fn the_status_line_is_plain_and_honest() {
        let mapped_with_ip = Outcome::Mapped {
            external_ip: Some("203.0.113.9".parse().unwrap()),
            method: "UPnP",
        };
        assert_eq!(
            mapped_with_ip.status_line(),
            "Yes — set up automatically (203.0.113.9)"
        );
        assert!(mapped_with_ip.is_mapped());

        let mapped_blind = Outcome::Mapped {
            external_ip: None,
            method: "NAT-PMP/PCP",
        };
        assert_eq!(mapped_blind.status_line(), "Yes — set up automatically");

        let failed = Outcome::NotAvailable {
            external_ip: None,
            reason: "no UPnP router answered".to_string(),
        };
        assert_eq!(
            failed.status_line(),
            "Not yet — your router needs one setting changed"
        );
        assert!(!failed.is_mapped());

        assert_eq!(
            Outcome::Skipped(SkipReason::LoopbackBind).status_line(),
            "No — this computer only"
        );
        assert_eq!(
            Outcome::Skipped(SkipReason::Disabled).status_line(),
            "Not checked (turned off in the config)"
        );
        assert_eq!(
            Outcome::Skipped(SkipReason::NotAskedYet).status_line(),
            "Checked when the server starts"
        );

        for outcome in [
            mapped_with_ip.status_line(),
            mapped_blind.status_line(),
            failed.status_line(),
            Outcome::Skipped(SkipReason::LoopbackBind).status_line(),
            Outcome::Skipped(SkipReason::Disabled).status_line(),
            Outcome::Skipped(SkipReason::NotAskedYet).status_line(),
        ] {
            let lowered = outcome.to_lowercase();
            for jargon in ["upnp", "nat-pmp", "pcp", "igd", "quic", "nat "] {
                assert!(
                    !lowered.contains(jargon),
                    "status line leaks {jargon:?}: {outcome}"
                );
            }
        }
    }

    /// The public-address lookup fills the gap a NAT-PMP gateway leaves, and
    /// never overrules a gateway that did report its own address.
    #[test]
    fn a_looked_up_address_only_fills_a_gap() {
        let fallback: IpAddr = "203.0.113.9".parse().unwrap();

        assert_eq!(
            Outcome::Mapped {
                external_ip: None,
                method: "NAT-PMP/PCP",
            }
            .with_fallback_ip(Some(fallback)),
            Outcome::Mapped {
                external_ip: Some(fallback),
                method: "NAT-PMP/PCP",
            }
        );

        let gateway_said: IpAddr = "198.51.100.7".parse().unwrap();
        assert_eq!(
            Outcome::Mapped {
                external_ip: Some(gateway_said),
                method: "UPnP",
            }
            .with_fallback_ip(Some(fallback))
            .external_ip(),
            Some(gateway_said)
        );

        // A failed attempt still learns the address a hand-made rule would be
        // reachable at, so the banner can name it.
        assert_eq!(
            Outcome::NotAvailable {
                external_ip: None,
                reason: "no UPnP router answered".to_string(),
            }
            .with_fallback_ip(Some(fallback))
            .external_ip(),
            Some(fallback)
        );

        // A skip has no address to report and must not invent one.
        assert_eq!(
            Outcome::Skipped(SkipReason::LoopbackBind)
                .with_fallback_ip(Some(fallback))
                .external_ip(),
            None
        );
    }
}
