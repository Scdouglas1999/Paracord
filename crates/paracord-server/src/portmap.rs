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

/// How long to wait, after a refusal, for the router to say its outside
/// address. Short: the refusal is the verdict, the address is extra.
const REFUSED_ADDRESS_BUDGET: Duration = Duration::from_millis(1500);

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

/// The single, always-logged result of the attempt, in the words the startup
/// banner needs. The state machine in [`crate::reachability`] is the richer
/// truth; this is derived from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The router accepted both mappings and reported a public address.
    Mapped {
        external_ip: Option<IpAddr>,
        method: &'static str,
    },
    /// This computer has a public address of its own; there is nothing to map.
    Direct { ip: IpAddr },
    /// Nothing opened the ports. `external_ip` is only ever a public address a
    /// router reported, so the banner can still name where a hand-made
    /// forwarding rule would be reachable.
    NotAvailable {
        external_ip: Option<IpAddr>,
        reason: String,
    },
    /// No attempt was made, on purpose.
    Skipped(SkipReason),
}

impl Outcome {
    /// The public address friends would use, when one is known.
    pub fn external_ip(&self) -> Option<IpAddr> {
        match self {
            Outcome::Mapped { external_ip, .. } | Outcome::NotAvailable { external_ip, .. } => {
                *external_ip
            }
            Outcome::Direct { ip } => Some(*ip),
            Outcome::Skipped(_) => None,
        }
    }

    /// True when a friend on the far side of the router can reach this server.
    pub fn is_mapped(&self) -> bool {
        matches!(self, Outcome::Mapped { .. } | Outcome::Direct { .. })
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
            Outcome::Direct { ip } => format!("Yes — this computer has its own address ({ip})"),
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
            Outcome::Direct { .. } => tracing::info!(
                target: "paracord::portmap",
                tcp_port = request.tcp_port,
                udp_port = request.udp_port,
                external_ip,
                "this computer has a public address of its own; no router is in the way"
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

/// Why a mapping attempt failed, which decides what the owner is told: a
/// gateway that answered and said no is a different problem from silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// A gateway answered and refused: a UPnP fault, a NAT-PMP/PCP result code
    /// other than success, or an answer that left out its public address.
    Refused,
    /// Nothing answered within the budget.
    NoAnswer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapFailure {
    pub kind: FailureKind,
    /// In plain words.
    pub reason: String,
    /// The router that answered, when one did (the UPnP control URL host, or
    /// the NAT-PMP/PCP gateway that sent a result code). `None` when nothing
    /// answered, so the sheet only names an address it knows is the router's.
    pub gateway_ip: Option<IpAddr>,
    /// The router's own outside address, when it refused the mapping but still
    /// answered "what is your external address" (UPnP GetExternalIPAddress,
    /// NAT-PMP opcode 0). A refusal does not make that answer less true.
    pub external_ip: Option<IpAddr>,
}

impl MapFailure {
    pub fn refused(reason: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Refused,
            reason: reason.into(),
            gateway_ip: None,
            external_ip: None,
        }
    }

    pub fn no_answer(reason: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::NoAnswer,
            reason: reason.into(),
            gateway_ip: None,
            external_ip: None,
        }
    }

    /// Record which router this failure came from.
    #[must_use]
    pub fn via_gateway(mut self, gateway: IpAddr) -> Self {
        self.gateway_ip = Some(gateway);
        self
    }

    /// Record the outside address the refusing router still reported.
    #[must_use]
    pub fn with_external_ip(mut self, external_ip: Option<IpAddr>) -> Self {
        self.external_ip = external_ip;
        self
    }
}

/// The gateway conversation, as the orchestrator sees it.
///
/// Everything that talks to a real router is behind this trait, which is what
/// makes the parts worth testing — fallback order, the budget, the state
/// machine on top — testable with a fake that never touches the network.
pub trait Router: Send + Sync {
    /// How this method is named to a human, in the log and the status line.
    fn method(&self) -> &'static str;

    /// Install (or refresh) both mappings. The result carries the router's own
    /// public address: a mapping the router will not describe is a failure,
    /// because nothing else is allowed to say what the address is.
    fn map(
        &self,
        request: PortRequest,
        lease: Duration,
    ) -> BoxFuture<'_, Result<Mapping, MapFailure>>;

    /// Take the mappings back down.
    fn unmap(&self, request: PortRequest) -> BoxFuture<'_, Result<(), String>>;
}

/// What a router reported once it accepted the mappings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mapping {
    /// The public address of this network, as the router reports it. Never
    /// looked up anywhere else.
    pub external_ip: IpAddr,
    /// `"upnp"`, `"nat-pmp"` or `"pcp"`.
    pub protocol: &'static str,
    /// The router that answered, when known.
    pub gateway_ip: Option<IpAddr>,
    /// This computer's address toward the router, when known.
    pub lan_ip: Option<IpAddr>,
    /// The lease the router actually granted; `None` for a permanent entry
    /// that never expires. Routers commonly grant less than was asked.
    pub granted: Option<Duration>,
}

/// The result of one attempt, plus the router that answered so renewal and
/// removal keep talking to the same one.
pub struct Attempt {
    pub result: Result<Mapped, MapFailure>,
}

pub struct Mapped {
    pub mapping: Mapping,
    pub router: Arc<dyn Router>,
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
///
/// The failure is `Refused` when any method got an answer and was told no, and
/// `NoAnswer` only when every method was silent.
pub async fn establish(
    routers: &[Arc<dyn Router>],
    request: PortRequest,
    lease: Duration,
    budget: Duration,
) -> Attempt {
    let deadline = tokio::time::Instant::now() + budget;
    let mut reasons: Vec<String> = Vec::new();
    let mut refused = false;
    let mut gateway_ip: Option<IpAddr> = None;
    let mut external_ip: Option<IpAddr> = None;

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
                    result: Ok(Mapped {
                        mapping,
                        router: Arc::clone(router),
                    }),
                };
            }
            Ok(Err(failure)) => {
                refused |= failure.kind == FailureKind::Refused;
                // The first router that answered names the address; a later
                // method that answered and refused does not replace it.
                gateway_ip = gateway_ip.or(failure.gateway_ip);
                external_ip = external_ip.or(failure.external_ip);
                reasons.push(format!("{}: {}", router.method(), failure.reason));
            }
            Err(_) => reasons.push(format!(
                "{}: no answer within {}s",
                router.method(),
                remaining.as_secs()
            )),
        }
    }

    let reason = if reasons.is_empty() {
        "no port-mapping method was available".to_string()
    } else {
        reasons.join("; ")
    };
    Attempt {
        result: Err(MapFailure {
            kind: if refused {
                FailureKind::Refused
            } else {
                FailureKind::NoAnswer
            },
            reason,
            gateway_ip,
            external_ip,
        }),
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
/// do not pay for another search. The cache is dropped on any failure: a router
/// that rebooted comes back with a new control URL, and the next attempt should
/// find it rather than keep calling the old one.
#[derive(Default)]
struct UpnpRouter {
    gateway: tokio::sync::Mutex<Option<igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>>>,
}

impl UpnpRouter {
    async fn gateway(
        &self,
        search_timeout: Duration,
    ) -> Result<igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, MapFailure> {
        let mut cached = self.gateway.lock().await;
        if let Some(gateway) = cached.as_ref() {
            return Ok(gateway.clone());
        }
        let gateway = igd_next::aio::tokio::search_gateway(igd_next::SearchOptions {
            timeout: Some(search_timeout),
            ..Default::default()
        })
        .await
        .map_err(|err| MapFailure::no_answer(format!("no UPnP router answered ({err})")))?;
        *cached = Some(gateway.clone());
        Ok(gateway)
    }

    async fn forget(&self) {
        *self.gateway.lock().await = None;
    }

    async fn map_inner(
        &self,
        request: PortRequest,
        lease: Duration,
    ) -> Result<Mapping, MapFailure> {
        // Bounded below the overall budget so a silent router still leaves
        // time for NAT-PMP.
        let gateway = self.gateway(Duration::from_secs(4)).await?;
        // The router answered discovery, so every failure from here on names it.
        let router_ip = gateway.addr.ip();
        let local_ip = local_ip_toward(gateway.addr).map_err(|err| {
            MapFailure::refused(format!(
                "could not work out this computer's address ({err})"
            ))
            .via_gateway(router_ip)
        })?;
        let lease_seconds = u32::try_from(lease.as_secs()).unwrap_or(u32::MAX);

        let mut granted = Some(lease);
        for (port, transport) in request.entries() {
            match add_upnp_mapping(&gateway, local_ip, port, transport, lease_seconds).await {
                // The router only keeps permanent entries: nothing expires, so
                // there is no lease to renew against.
                Ok(true) => granted = None,
                Ok(false) => {}
                Err(failure) => {
                    // A router that says no to the mapping may still say what
                    // its outside address is; keep that answer.
                    let external_ip = if failure.kind == FailureKind::Refused {
                        tokio::time::timeout(REFUSED_ADDRESS_BUDGET, gateway.get_external_ip())
                            .await
                            .ok()
                            .and_then(Result::ok)
                    } else {
                        None
                    };
                    return Err(failure.via_gateway(router_ip).with_external_ip(external_ip));
                }
            }
        }

        let external_ip = gateway.get_external_ip().await.map_err(|err| {
            MapFailure::refused(format!(
                "the router opened the ports but would not say its public address ({err})"
            ))
            .via_gateway(router_ip)
        })?;
        Ok(Mapping {
            external_ip,
            protocol: "upnp",
            gateway_ip: Some(gateway.addr.ip()),
            lan_ip: Some(local_ip),
            granted,
        })
    }
}

impl Router for UpnpRouter {
    fn method(&self) -> &'static str {
        "UPnP"
    }

    fn map(
        &self,
        request: PortRequest,
        lease: Duration,
    ) -> BoxFuture<'_, Result<Mapping, MapFailure>> {
        Box::pin(async move {
            let result = self.map_inner(request, lease).await;
            if result.is_err() {
                self.forget().await;
            }
            result
        })
    }

    fn unmap(&self, request: PortRequest) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let gateway = self
                .gateway(Duration::from_secs(2))
                .await
                .map_err(|failure| failure.reason)?;
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

/// The UPnP calls the mapping logic needs, so that logic can be tested against
/// a scripted router instead of the network.
trait UpnpControl: Send + Sync {
    fn add_port(
        &self,
        protocol: igd_next::PortMappingProtocol,
        port: u16,
        local_addr: SocketAddr,
        lease_seconds: u32,
        description: &str,
    ) -> BoxFuture<'_, Result<(), igd_next::AddPortError>>;

    /// The router's current entry for this outside port and protocol, if it
    /// has one and will say so.
    fn existing_mapping(
        &self,
        protocol: igd_next::PortMappingProtocol,
        port: u16,
    ) -> BoxFuture<'_, Result<Option<ExistingMapping>, String>>;
}

/// A mapping already on the router.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ExistingMapping {
    internal_client: String,
    internal_port: u16,
    enabled: bool,
}

/// How many table rows to read looking for our port before giving up.
const UPNP_TABLE_LIMIT: u32 = 512;

impl UpnpControl for igd_next::aio::Gateway<igd_next::aio::tokio::Tokio> {
    fn add_port(
        &self,
        protocol: igd_next::PortMappingProtocol,
        port: u16,
        local_addr: SocketAddr,
        lease_seconds: u32,
        description: &str,
    ) -> BoxFuture<'_, Result<(), igd_next::AddPortError>> {
        let description = description.to_string();
        Box::pin(async move {
            igd_next::aio::Gateway::add_port(
                self,
                protocol,
                port,
                local_addr,
                lease_seconds,
                &description,
            )
            .await
        })
    }

    /// igd-next has no GetSpecificPortMappingEntry, so read the router's
    /// mapping table by index until the entry turns up or the table ends.
    fn existing_mapping(
        &self,
        protocol: igd_next::PortMappingProtocol,
        port: u16,
    ) -> BoxFuture<'_, Result<Option<ExistingMapping>, String>> {
        Box::pin(async move {
            for index in 0..UPNP_TABLE_LIMIT {
                match self.get_generic_port_mapping_entry(index).await {
                    Ok(entry) => {
                        if entry.external_port == port && entry.protocol == protocol {
                            return Ok(Some(ExistingMapping {
                                internal_client: entry.internal_client,
                                internal_port: entry.internal_port,
                                enabled: entry.enabled,
                            }));
                        }
                    }
                    Err(igd_next::GetGenericPortMappingEntryError::SpecifiedArrayIndexInvalid) => {
                        return Ok(None);
                    }
                    Err(err) => return Err(err.to_string()),
                }
            }
            Err(format!(
                "the router's mapping table has more than {UPNP_TABLE_LIMIT} entries"
            ))
        })
    }
}

/// Is an existing entry this computer's own, pointing at the same port?
fn is_ours(existing: &ExistingMapping, local_ip: IpAddr, port: u16) -> bool {
    existing.enabled
        && existing.internal_port == port
        && existing
            .internal_client
            .trim()
            .parse::<IpAddr>()
            .is_ok_and(|client| client == local_ip)
}

/// `Ok(true)` when the router only keeps permanent entries and one was made.
async fn add_upnp_mapping(
    gateway: &dyn UpnpControl,
    local_ip: IpAddr,
    port: u16,
    transport: Transport,
    lease_seconds: u32,
) -> Result<bool, MapFailure> {
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
        Ok(()) => Ok(false),
        // Error 718 (ConflictInMappingEntry) means either "you already have
        // this entry" or "someone else has it / the router's rules deny it".
        // Only the router's own table can tell the two apart, so ask it; an
        // entry we cannot show is ours is a refusal, never an open port.
        Err(igd_next::AddPortError::PortInUse) => {
            let label = transport.label();
            match gateway.existing_mapping(protocol, port).await {
                Ok(Some(existing)) if is_ours(&existing, local_ip, port) => Ok(false),
                Ok(Some(existing)) => Err(MapFailure::refused(format!(
                    "the router already forwards {label} {port} to {}:{} instead of this \
                     computer ({local_ip}), and it will not replace that entry",
                    existing.internal_client.trim(),
                    existing.internal_port
                ))),
                Ok(None) => Err(MapFailure::refused(format!(
                    "the router refused {label} {port} (conflict in mapping entry) and shows \
                     no existing entry for it, so its rules do not allow this mapping"
                ))),
                Err(why) => Err(MapFailure::refused(format!(
                    "the router refused {label} {port} (conflict in mapping entry) and would \
                     not say whether the entry that is there belongs to this computer ({why})"
                ))),
            }
        }
        // Some routers refuse timed leases outright and only keep permanent
        // entries. Asking again for a permanent one is the honest retry; it is
        // still removed on a graceful shutdown.
        Err(igd_next::AddPortError::OnlyPermanentLeasesSupported) => gateway
            .add_port(protocol, port, local_addr, 0, description)
            .await
            .map(|()| true)
            .map_err(|err| upnp_add_failure(&err, transport, port)),
        Err(err) => Err(upnp_add_failure(&err, transport, port)),
    }
}

/// Silence on the control URL is "no answer"; everything the router said back
/// is a refusal.
fn upnp_add_failure(err: &igd_next::AddPortError, transport: Transport, port: u16) -> MapFailure {
    let reason = format!("the router refused {} {port} ({err})", transport.label());
    match err {
        igd_next::AddPortError::RequestError(
            igd_next::RequestError::IoError(_)
            | igd_next::RequestError::HyperError(_)
            | igd_next::RequestError::HyperClientError(_)
            | igd_next::RequestError::AttoHttpError(_),
        ) => MapFailure::no_answer(reason),
        _ => MapFailure::refused(reason),
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

    fn map(
        &self,
        request: PortRequest,
        lease: Duration,
    ) -> BoxFuture<'_, Result<Mapping, MapFailure>> {
        Box::pin(async move {
            let gateway_ip = default_gateway_ipv4().map_err(|err| {
                MapFailure::no_answer(format!("could not find this network's router ({err})"))
            })?;
            let client_ip = local_ip_toward_ipv4(gateway_ip).map_err(|err| {
                MapFailure::no_answer(format!(
                    "could not work out this computer's address ({err})"
                ))
            })?;
            let lifetime = u32::try_from(lease.as_secs()).unwrap_or(u32::MAX);

            let mut fresh: Vec<crab_nat::PortMapping> = Vec::new();
            let mut external_ip: Option<IpAddr> = None;
            let mut protocol = "pcp";
            let mut granted: Option<Duration> = None;

            for (port, transport) in request.entries() {
                let internal_port = NonZeroU16::new(port).ok_or_else(|| {
                    MapFailure::refused(format!("{} port 0 cannot be mapped", transport.label()))
                })?;
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
                .await;
                let mapping = match mapping {
                    Ok(mapping) => mapping,
                    Err(err) => {
                        let failure =
                            tag_if_answered(natpmp_failure(&err, transport, port), gateway_ip);
                        // A gateway that answered with a result code may still
                        // say its outside address (RFC 6886 §3.2).
                        let external_ip = if failure.kind == FailureKind::Refused {
                            natpmp_external_address(gateway_ip)
                                .await
                                .ok()
                                .map(IpAddr::V4)
                        } else {
                            None
                        };
                        return Err(failure.with_external_ip(external_ip));
                    }
                };

                // A different outside port is not usable here: clients derive
                // both the app URL and the media port from this one number, so
                // silently accepting a remapped port would hand the owner an
                // address that does not work.
                if mapping.external_port() != internal_port {
                    let assigned = mapping.external_port();
                    let _ = mapping.try_drop().await;
                    return Err(MapFailure::refused(format!(
                        "this router mapped {} {port} to a different outside port ({assigned}), \
                         which Paracord cannot use",
                        transport.label()
                    ))
                    .via_gateway(IpAddr::V4(gateway_ip)));
                }

                let given = Duration::from_secs(u64::from(mapping.lifetime()));
                granted = Some(granted.map_or(given, |least| least.min(given)));
                match mapping.mapping_type() {
                    crab_nat::PortMappingType::Pcp {
                        external_ip: reported,
                        ..
                    } => {
                        external_ip.get_or_insert(reported);
                    }
                    crab_nat::PortMappingType::NatPmp => protocol = "nat-pmp",
                }
                fresh.push(mapping);
            }

            // PCP answers with the external address. NAT-PMP does not, so ask
            // the router for it (RFC 6886 §3.2): the only source allowed.
            let external_ip = match (protocol, external_ip) {
                ("pcp", Some(ip)) => ip,
                _ => {
                    let ip = natpmp_external_address(gateway_ip)
                        .await
                        .map_err(|err| {
                            let reason = format!(
                                "the router opened the ports but would not say its public \
                                 address ({err})"
                            );
                            match err {
                                crab_nat::natpmp::Failure::Socket(_)
                                | crab_nat::natpmp::Failure::Timeout => {
                                    MapFailure::no_answer(reason)
                                }
                                _ => MapFailure::refused(reason),
                            }
                        })
                        .map_err(|failure| tag_if_answered(failure, gateway_ip))?;
                    IpAddr::V4(ip)
                }
            };

            *self.mappings.lock().await = fresh;
            Ok(Mapping {
                external_ip,
                protocol,
                gateway_ip: Some(IpAddr::V4(gateway_ip)),
                lan_ip: Some(IpAddr::V4(client_ip)),
                granted,
            })
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

/// NAT-PMP opcode 0: the gateway's outside address.
async fn natpmp_external_address(
    gateway_ip: Ipv4Addr,
) -> Result<Ipv4Addr, crab_nat::natpmp::Failure> {
    let timeout = crab_nat::TimeoutConfig {
        initial_timeout: Duration::from_millis(400),
        max_retries: 2,
        max_retry_timeout: Some(Duration::from_secs(2)),
    };
    crab_nat::natpmp::external_address(gateway_ip.into(), Some(timeout)).await
}

/// A gateway that never answered (or whose socket failed) is "no answer"; every
/// result code it sent back is a refusal.
fn natpmp_failure(err: &crab_nat::MappingFailure, transport: Transport, port: u16) -> MapFailure {
    let reason = format!("the router refused {} {port} ({err})", transport.label());
    let silent = matches!(
        err,
        crab_nat::MappingFailure::NatPmp(
            crab_nat::natpmp::Failure::Timeout | crab_nat::natpmp::Failure::Socket(_)
        ) | crab_nat::MappingFailure::Pcp(
            crab_nat::pcp::Failure::Timeout | crab_nat::pcp::Failure::Socket(_)
        )
    );
    if silent {
        MapFailure::no_answer(format!(
            "the router did not answer for {} {port} ({err})",
            transport.label()
        ))
    } else {
        MapFailure::refused(reason)
    }
}

/// Name the gateway on a failure only when it answered (a result code came
/// back); a silent gateway is not known to be a router at all.
fn tag_if_answered(failure: MapFailure, gateway: Ipv4Addr) -> MapFailure {
    if failure.kind == FailureKind::Refused {
        failure.via_gateway(IpAddr::V4(gateway))
    } else {
        failure
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

/// This computer's IPv4 address toward the internet. Nothing is sent.
pub fn local_ipv4_toward_internet() -> Option<Ipv4Addr> {
    match local_ip_toward((Ipv4Addr::new(8, 8, 8, 8), 53).into()) {
        Ok(IpAddr::V4(ip)) => Some(ip),
        _ => None,
    }
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

/// This network's router, for NAT-PMP, which has no discovery step of its own.
///
/// Linux says exactly: the default route's gateway. Elsewhere the protocol's
/// own assumption applies: `.1` on the subnet this machine uses to reach the
/// internet, which is what home routers use.
fn default_gateway_ipv4() -> std::io::Result<Ipv4Addr> {
    #[cfg(target_os = "linux")]
    if let Some(gateway) = std::fs::read_to_string("/proc/net/route")
        .ok()
        .as_deref()
        .and_then(parse_proc_net_route)
    {
        return Ok(gateway);
    }
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

/// The gateway of the default route in `/proc/net/route` (little-endian hex).
#[cfg(any(target_os = "linux", test))]
fn parse_proc_net_route(table: &str) -> Option<Ipv4Addr> {
    const RTF_UP: u32 = 0x1;
    const RTF_GATEWAY: u32 = 0x2;
    table.lines().skip(1).find_map(|line| {
        let columns: Vec<&str> = line.split_whitespace().collect();
        let [_iface, destination, gateway, flags, ..] = columns[..] else {
            return None;
        };
        let flags = u32::from_str_radix(flags, 16).ok()?;
        if destination != "00000000" || flags & RTF_UP == 0 || flags & RTF_GATEWAY == 0 {
            return None;
        }
        let raw = u32::from_str_radix(gateway, 16).ok()?;
        let ip = Ipv4Addr::from(raw.swap_bytes());
        (!ip.is_unspecified()).then_some(ip)
    })
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
        answer: Result<Mapping, MapFailure>,
        map_calls: Arc<AtomicUsize>,
        unmap_calls: Arc<AtomicUsize>,
        /// Appended to in call order, shared across the fakes in one test.
        order: Arc<std::sync::Mutex<Vec<&'static str>>>,
    }

    impl FakeRouter {
        fn new(method: &'static str, answer: Result<Mapping, MapFailure>) -> Self {
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
        ) -> BoxFuture<'_, Result<Mapping, MapFailure>> {
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

    fn mapped(ip: &str) -> Result<Mapping, MapFailure> {
        Ok(Mapping {
            external_ip: ip.parse().expect("test ip"),
            protocol: "upnp",
            gateway_ip: None,
            lan_ip: None,
            granted: Some(Duration::from_secs(3600)),
        })
    }

    fn refused(reason: &str) -> Result<Mapping, MapFailure> {
        Err(MapFailure::refused(reason))
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

        let Ok(won) = attempt.result else {
            panic!("the first router should have mapped");
        };
        assert_eq!(
            won.mapping.external_ip,
            "203.0.113.9".parse::<IpAddr>().unwrap()
        );
        assert_eq!(won.router.method(), "first");
        assert_eq!(*order.lock().unwrap(), vec!["first"]);
        assert_eq!(second_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_refusal_falls_through_to_the_next_method_in_order() {
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let upnp = Arc::new(
            FakeRouter::new(
                "UPnP",
                Err(MapFailure::no_answer("no UPnP router answered")),
            )
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

        let Ok(won) = attempt.result else {
            panic!("the second method should have mapped");
        };
        assert_eq!(won.router.method(), "NAT-PMP/PCP");
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
        let failure = attempt.result.err().expect("nothing answered");
        assert_eq!(failure.kind, FailureKind::NoAnswer);
        assert!(failure.reason.contains("UPnP"), "{}", failure.reason);
        assert!(failure.reason.contains("NAT-PMP/PCP"), "{}", failure.reason);
    }

    /// The second method gets whatever the first one left of the budget, not a
    /// fresh copy of it — otherwise two silent methods cost twice the promise.
    #[tokio::test]
    async fn a_slow_first_method_does_not_hand_the_second_a_new_budget() {
        let budget = Duration::from_millis(300);
        let slow = Arc::new(
            FakeRouter::new("UPnP", refused("refused")).with_delay(Duration::from_millis(150)),
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
        assert!(attempt.result.is_err());
    }

    #[tokio::test]
    async fn no_routers_at_all_is_reported_rather_than_assumed() {
        let attempt = establish(&[], REQUEST, Duration::from_secs(3600), DISCOVERY_BUDGET).await;
        let failure = attempt.result.err().expect("no routers");
        assert!(
            failure.reason.contains("no port-mapping method"),
            "{}",
            failure.reason
        );
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
    fn a_configured_lease_is_clamped_to_something_a_router_will_honor() {
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

    /// A refusal anywhere outweighs silence, because it is the more useful
    /// thing to tell the owner; silence everywhere is "no answer".
    #[tokio::test]
    async fn one_refusal_among_silent_methods_is_a_refusal() {
        let routers: Vec<Arc<dyn Router>> = vec![
            Arc::new(FakeRouter::new(
                "UPnP",
                Err(MapFailure::no_answer("no UPnP router answered")),
            )),
            Arc::new(FakeRouter::new("NAT-PMP/PCP", refused("result code 2"))),
        ];
        let attempt = establish(
            &routers,
            REQUEST,
            Duration::from_secs(3600),
            DISCOVERY_BUDGET,
        )
        .await;
        assert_eq!(attempt.result.err().unwrap().kind, FailureKind::Refused);
    }

    /// The default route's gateway comes out of `/proc/net/route` the way the
    /// kernel writes it: little-endian hex, flags UP|GATEWAY.
    #[test]
    fn the_default_gateway_is_read_from_the_route_table() {
        let table =
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
                     docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n\
                     eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
                     eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n";
        assert_eq!(
            parse_proc_net_route(table),
            Some(Ipv4Addr::new(192, 168, 1, 1))
        );
        // No default route: nothing is invented.
        let none = "Iface\tDestination\tGateway\tFlags\n\
                    eth0\t0001A8C0\t00000000\t0001\n";
        assert_eq!(parse_proc_net_route(none), None);
    }

    #[test]
    fn a_direct_address_reads_as_reachable() {
        let direct = Outcome::Direct {
            ip: "198.51.100.20".parse().unwrap(),
        };
        assert!(direct.is_mapped());
        assert_eq!(direct.external_ip(), Some("198.51.100.20".parse().unwrap()));
        assert!(direct.status_line().contains("198.51.100.20"));
    }

    // ── UPnP conflicts (error 718) against a scripted router ───────────────

    use std::collections::VecDeque;

    /// A UPnP router that answers `AddPortMapping` from a script and shows
    /// whatever mapping table the test gave it.
    struct FakeUpnp {
        adds: std::sync::Mutex<VecDeque<Result<(), igd_next::AddPortError>>>,
        table: Result<Option<ExistingMapping>, String>,
        lookups: AtomicUsize,
    }

    impl FakeUpnp {
        fn new(
            adds: Vec<Result<(), igd_next::AddPortError>>,
            table: Result<Option<ExistingMapping>, String>,
        ) -> Self {
            Self {
                adds: std::sync::Mutex::new(adds.into()),
                table,
                lookups: AtomicUsize::new(0),
            }
        }
    }

    impl UpnpControl for FakeUpnp {
        fn add_port(
            &self,
            _protocol: igd_next::PortMappingProtocol,
            _port: u16,
            _local_addr: SocketAddr,
            _lease_seconds: u32,
            _description: &str,
        ) -> BoxFuture<'_, Result<(), igd_next::AddPortError>> {
            let next = self.adds.lock().unwrap().pop_front().expect("scripted add");
            Box::pin(async move { next })
        }

        fn existing_mapping(
            &self,
            _protocol: igd_next::PortMappingProtocol,
            _port: u16,
        ) -> BoxFuture<'_, Result<Option<ExistingMapping>, String>> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            let answer = self.table.clone();
            Box::pin(async move { answer })
        }
    }

    const ME: &str = "192.168.50.20";

    fn entry(client: &str, port: u16) -> ExistingMapping {
        ExistingMapping {
            internal_client: client.to_string(),
            internal_port: port,
            enabled: true,
        }
    }

    async fn add_one(router: &FakeUpnp) -> Result<bool, MapFailure> {
        add_upnp_mapping(router, ME.parse().unwrap(), 8090, Transport::Tcp, 3600).await
    }

    #[tokio::test]
    async fn a_conflict_that_is_our_own_entry_is_a_success() {
        let router = FakeUpnp::new(
            vec![Err(igd_next::AddPortError::PortInUse)],
            Ok(Some(entry(ME, 8090))),
        );
        assert!(!add_one(&router).await.unwrap());
        assert_eq!(router.lookups.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_conflict_with_another_device_is_a_refusal_that_names_it() {
        let router = FakeUpnp::new(
            vec![Err(igd_next::AddPortError::PortInUse)],
            Ok(Some(entry("192.168.50.99", 8090))),
        );
        let failure = add_one(&router).await.unwrap_err();
        assert_eq!(failure.kind, FailureKind::Refused);
        assert!(
            failure.reason.contains("192.168.50.99"),
            "{}",
            failure.reason
        );
    }

    #[tokio::test]
    async fn our_address_with_a_different_inside_port_is_not_ours() {
        let router = FakeUpnp::new(
            vec![Err(igd_next::AddPortError::PortInUse)],
            Ok(Some(entry(ME, 9999))),
        );
        let failure = add_one(&router).await.unwrap_err();
        assert_eq!(failure.kind, FailureKind::Refused);
    }

    #[tokio::test]
    async fn a_disabled_entry_is_not_an_open_port() {
        let mut disabled = entry(ME, 8090);
        disabled.enabled = false;
        let router = FakeUpnp::new(
            vec![Err(igd_next::AddPortError::PortInUse)],
            Ok(Some(disabled)),
        );
        assert_eq!(
            add_one(&router).await.unwrap_err().kind,
            FailureKind::Refused
        );
    }

    #[tokio::test]
    async fn a_conflict_with_no_entry_to_show_is_a_refusal() {
        // A router whose rules deny the mapping answers 718 with nothing there.
        let router = FakeUpnp::new(vec![Err(igd_next::AddPortError::PortInUse)], Ok(None));
        let failure = add_one(&router).await.unwrap_err();
        assert_eq!(failure.kind, FailureKind::Refused);
        assert!(
            failure.reason.contains("no existing entry"),
            "{}",
            failure.reason
        );
    }

    #[tokio::test]
    async fn a_conflict_that_cannot_be_checked_is_a_refusal_not_a_guess() {
        let router = FakeUpnp::new(
            vec![Err(igd_next::AddPortError::PortInUse)],
            Err("not authorized".to_string()),
        );
        let failure = add_one(&router).await.unwrap_err();
        assert_eq!(failure.kind, FailureKind::Refused);
        assert!(
            failure.reason.contains("not authorized"),
            "{}",
            failure.reason
        );
    }

    #[tokio::test]
    async fn other_upnp_errors_are_refusals_and_never_look_anything_up() {
        for err in [
            igd_next::AddPortError::ActionNotAuthorized,
            igd_next::AddPortError::SamePortValuesRequired,
            igd_next::AddPortError::DescriptionTooLong,
        ] {
            let router = FakeUpnp::new(vec![Err(err)], Ok(Some(entry(ME, 8090))));
            let failure = add_one(&router).await.unwrap_err();
            assert_eq!(failure.kind, FailureKind::Refused);
            assert_eq!(router.lookups.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn a_router_that_only_keeps_permanent_entries_gets_one() {
        let router = FakeUpnp::new(
            vec![
                Err(igd_next::AddPortError::OnlyPermanentLeasesSupported),
                Ok(()),
            ],
            Ok(None),
        );
        assert!(add_one(&router).await.unwrap());
    }

    #[test]
    fn a_failure_remembers_which_router_answered() {
        let failure = MapFailure::refused("no").via_gateway("192.168.50.1".parse().unwrap());
        assert_eq!(failure.gateway_ip, Some("192.168.50.1".parse().unwrap()));
        assert_eq!(MapFailure::no_answer("quiet").gateway_ip, None);
        // A silent NAT-PMP gateway is not named; one that sent a result code is.
        let gw: Ipv4Addr = "192.168.50.1".parse().unwrap();
        assert_eq!(
            tag_if_answered(MapFailure::no_answer("x"), gw).gateway_ip,
            None
        );
        assert_eq!(
            tag_if_answered(MapFailure::refused("x"), gw).gateway_ip,
            Some(IpAddr::V4(gw))
        );
    }

    #[tokio::test]
    async fn establish_carries_the_answering_routers_address_through() {
        let gw: IpAddr = "192.168.50.1".parse().unwrap();
        let routers: Vec<Arc<dyn Router>> = vec![
            Arc::new(FakeRouter::new(
                "UPnP",
                Err(MapFailure::no_answer("none").via_gateway(gw)),
            )),
            Arc::new(FakeRouter::new(
                "NAT-PMP/PCP",
                Err(MapFailure::no_answer("none")),
            )),
        ];
        let request = PortRequest {
            tcp_port: 8090,
            udp_port: 8090,
        };
        let attempt = establish(
            &routers,
            request,
            Duration::from_secs(3600),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(attempt.result.err().unwrap().gateway_ip, Some(gw));
    }
}
