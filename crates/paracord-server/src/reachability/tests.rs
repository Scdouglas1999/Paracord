use super::*;
use crate::stun::{Observed, PublicAddressProbe};
use paracord_core::share_address::{derive, ShareInputs, ShareNote, ShareReach, ShareSource};
use std::sync::atomic::AtomicUsize;

const REQUEST: PortRequest = PortRequest {
    tcp_port: 8443,
    udp_port: 8443,
};

/// A router that never touches the network. It answers from a script: each
/// call to `map` pops the next answer, and the last one repeats.
struct Scripted {
    method: &'static str,
    answers: Mutex<Vec<Result<Mapping, MapFailure>>>,
    delay: Duration,
    maps: AtomicUsize,
    unmaps: AtomicUsize,
}

impl Scripted {
    fn new(answers: Vec<Result<Mapping, MapFailure>>) -> Arc<Self> {
        Arc::new(Self {
            method: "scripted",
            answers: Mutex::new(answers),
            delay: Duration::ZERO,
            maps: AtomicUsize::new(0),
            unmaps: AtomicUsize::new(0),
        })
    }

    fn silent() -> Arc<Self> {
        Arc::new(Self {
            method: "silent",
            answers: Mutex::new(vec![Err(MapFailure::no_answer("never"))]),
            delay: Duration::from_secs(60),
            maps: AtomicUsize::new(0),
            unmaps: AtomicUsize::new(0),
        })
    }
}

impl Router for Scripted {
    fn method(&self) -> &'static str {
        self.method
    }

    fn map(
        &self,
        _request: PortRequest,
        _lease: Duration,
    ) -> BoxFuture<'_, Result<Mapping, MapFailure>> {
        Box::pin(async move {
            self.maps.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            let mut answers = self.answers.lock().unwrap();
            if answers.len() > 1 {
                answers.remove(0)
            } else {
                answers[0].clone()
            }
        })
    }

    fn unmap(&self, _request: PortRequest) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.unmaps.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

fn mapped(ip: &str) -> Result<Mapping, MapFailure> {
    Ok(Mapping {
        external_ip: ip.parse().unwrap(),
        protocol: "upnp",
        gateway_ip: Some("192.168.1.1".parse().unwrap()),
        lan_ip: Some("192.168.1.20".parse().unwrap()),
        granted: Some(Duration::from_secs(3600)),
    })
}

fn env(lan: Option<&str>) -> Environment {
    let lan: Option<IpAddr> = lan.map(|ip| ip.parse().unwrap());
    Environment {
        lan_ip: Box::new(move || lan),
        firewall: None,
        public_address: None,
    }
}

fn settings(retry_ms: u64) -> Settings {
    Settings {
        request: REQUEST,
        lease: Duration::from_secs(3600),
        retry: Duration::from_millis(retry_ms),
        budget: Duration::from_millis(300),
        // Tests cannot wait for half of a real lease.
        renew_interval: |_| Duration::from_millis(60),
    }
}

async fn eventually(
    hub: &ReachabilityHub,
    what: &str,
    ok: impl Fn(&paracord_contracts::host::Reachability) -> bool,
) -> paracord_contracts::host::Reachability {
    let mut rx = hub.subscribe();
    let waited = tokio::time::timeout(
        Duration::from_secs(5),
        rx.wait_for(|state| ok(&state.reachability)),
    )
    .await;
    match waited {
        Ok(Ok(state)) => {
            let found = state.reachability.clone();
            drop(state);
            found
        }
        _ => panic!("never reached: {what}; stuck at {:?}", hub.current()),
    }
}

async fn verdict(
    router: Arc<Scripted>,
    lan: Option<&str>,
) -> (paracord_contracts::host::Reachability, Handle) {
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env(lan),
        vec![router as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    (hub.current(), handle)
}

#[tokio::test]
async fn a_public_external_address_is_open() {
    let (r, handle) = verdict(
        Scripted::new(vec![mapped("203.0.113.9")]),
        Some("192.168.1.20"),
    )
    .await;
    assert_eq!(r.state, ReachabilityState::Open);
    assert_eq!(r.external_ip.as_deref(), Some("203.0.113.9"));
    assert_eq!(r.method.as_deref(), Some("upnp"));
    assert_eq!(r.gateway_ip.as_deref(), Some("192.168.1.1"));
    assert_eq!(r.lan_ip.as_deref(), Some("192.168.1.20"));
    assert_eq!(r.port, 8443);
    assert!(r.lease_expires_at.is_some());
    assert!(r.next_retry_at.is_none());
    assert!(r.last_error.is_none());
    handle.release().await;
}

/// Every row of the private set is "the router answered, but friends cannot
/// reach you", and the router's address is never presented as a way in.
#[tokio::test]
async fn private_and_shared_external_addresses_are_shared_address() {
    for ip in [
        "10.1.2.3",
        "172.16.0.9",
        "172.31.255.1",
        "192.168.0.50",
        "100.64.7.7",
        "100.127.0.1",
        "169.254.9.9",
    ] {
        let (r, handle) = verdict(Scripted::new(vec![mapped(ip)]), Some("192.168.1.20")).await;
        assert_eq!(r.state, ReachabilityState::SharedAddress, "{ip}");
        assert!(r.next_retry_at.is_some(), "{ip} retries");
        let share = derive(
            &ShareInputs {
                public_url: None,
                local_url: "https://192.168.1.20:8443".into(),
                scheme: "https".into(),
                port: 8443,
            },
            &r,
            None,
        );
        assert_eq!(share.url, None, "{ip}");
        assert_eq!(share.reach, ShareReach::Unknown, "{ip}");
        handle.release().await;
    }
}

#[tokio::test]
async fn an_unusable_external_address_is_a_refusal_with_the_reason() {
    let (r, handle) = verdict(Scripted::new(vec![mapped("0.0.0.0")]), Some("192.168.1.20")).await;
    assert_eq!(r.state, ReachabilityState::Refused);
    assert!(r.external_ip.is_none());
    assert!(r.last_error.unwrap().contains("0.0.0.0"));
    handle.release().await;
}

#[tokio::test]
async fn an_answer_that_says_no_is_refused_and_silence_is_no_answer() {
    let (r, handle) = verdict(
        Scripted::new(vec![Err(MapFailure::refused(
            "the router refused TCP 8443",
        ))]),
        Some("192.168.1.20"),
    )
    .await;
    assert_eq!(r.state, ReachabilityState::Refused);
    assert!(r
        .last_error
        .as_deref()
        .unwrap()
        .contains("refused TCP 8443"));
    assert!(r.next_retry_at.is_some());
    handle.release().await;

    let (r, handle) = verdict(Scripted::silent(), Some("192.168.1.20")).await;
    assert_eq!(r.state, ReachabilityState::NoAnswer);
    assert!(r.external_ip.is_none());
    handle.release().await;
}

/// The sheet names the router that said no, instead of guessing 192.168.x.1.
#[tokio::test]
async fn a_refusal_still_names_the_router_that_answered() {
    let (r, handle) = verdict(
        Scripted::new(vec![Err(MapFailure::refused(
            "the router refused TCP 8443",
        )
        .via_gateway("192.168.50.1".parse().unwrap()))]),
        Some("192.168.50.20"),
    )
    .await;
    assert_eq!(r.state, ReachabilityState::Refused);
    assert_eq!(r.gateway_ip.as_deref(), Some("192.168.50.1"));
    handle.release().await;

    // Nothing answered: no address is invented.
    let (r, handle) = verdict(Scripted::silent(), Some("192.168.50.20")).await;
    assert_eq!(r.gateway_ip, None);
    handle.release().await;
}

/// One method answering "no" outweighs another that was merely silent.
#[tokio::test]
async fn a_refusal_from_any_method_wins_over_silence() {
    let hub = Arc::new(ReachabilityHub::new());
    let routers: Vec<Arc<dyn Router>> = vec![
        Scripted::new(vec![Err(MapFailure::no_answer("quiet"))]),
        Scripted::new(vec![Err(MapFailure::refused("no"))]),
    ];
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env(Some("192.168.1.20")),
        routers,
    );
    handle.first_attempt().await;
    assert_eq!(hub.current().state, ReachabilityState::Refused);
    handle.release().await;
}

#[tokio::test]
async fn a_public_interface_address_is_direct_and_no_router_is_asked() {
    let router = Scripted::new(vec![mapped("203.0.113.9")]);
    let (r, handle) = verdict(Arc::clone(&router), Some("198.51.100.20")).await;
    assert_eq!(r.state, ReachabilityState::Direct);
    assert_eq!(r.external_ip.as_deref(), Some("198.51.100.20"));
    assert_eq!(router.maps.load(Ordering::SeqCst), 0);
    handle.release().await;
    assert_eq!(
        router.unmaps.load(Ordering::SeqCst),
        0,
        "nothing was mapped"
    );
}

struct Missing(bool);
impl FirewallCheck for Missing {
    fn blocked(&self, port: u16) -> BoxFuture<'_, Result<Option<String>, String>> {
        let blocked = self.0;
        Box::pin(async move { Ok(blocked.then(|| format!("no rule for port {port}"))) })
    }
}

#[tokio::test]
async fn a_missing_firewall_rule_overrides_the_router() {
    for (lan, router_answer) in [
        ("192.168.1.20", Some(mapped("203.0.113.9"))),
        ("198.51.100.20", None),
    ] {
        let hub = Arc::new(ReachabilityHub::new());
        let mut e = env(Some(lan));
        e.firewall = Some(Arc::new(Missing(true)));
        let routers: Vec<Arc<dyn Router>> = router_answer
            .map(|a| vec![Scripted::new(vec![a]) as Arc<dyn Router>])
            .unwrap_or_default();
        let handle = spawn(Arc::clone(&hub), settings(10_000), e, routers);
        handle.first_attempt().await;
        let r = eventually(&hub, "firewall_blocked", |r| {
            r.state == ReachabilityState::FirewallBlocked
        })
        .await;
        assert!(r.last_error.unwrap().contains("8443"));
        assert!(r.next_retry_at.is_some());
        handle.release().await;
    }
}

#[tokio::test]
async fn a_present_firewall_rule_changes_nothing() {
    let hub = Arc::new(ReachabilityHub::new());
    let mut e = env(Some("192.168.1.20"));
    e.firewall = Some(Arc::new(Missing(false)));
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        e,
        vec![Scripted::new(vec![mapped("203.0.113.9")]) as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    assert_eq!(hub.current().state, ReachabilityState::Open);
    handle.release().await;
}

/// Refused, then the owner fixes the router: the next retry finds the way open
/// without anyone pressing anything.
#[tokio::test]
async fn a_closed_door_is_retried_on_the_interval() {
    let router = Scripted::new(vec![
        Err(MapFailure::refused("not yet")),
        Err(MapFailure::refused("not yet")),
        mapped("203.0.113.9"),
    ]);
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(40),
        env(Some("192.168.1.20")),
        vec![Arc::clone(&router) as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    assert_eq!(hub.current().state, ReachabilityState::Refused);
    eventually(&hub, "open after retries", |r| {
        r.state == ReachabilityState::Open
    })
    .await;
    assert!(router.maps.load(Ordering::SeqCst) >= 3);
    handle.release().await;
}

#[tokio::test]
async fn try_again_asks_now_instead_of_waiting_for_the_interval() {
    let router = Scripted::new(vec![Err(MapFailure::refused("no")), mapped("203.0.113.9")]);
    let hub = Arc::new(ReachabilityHub::new());
    // An hour between automatic retries.
    let mut s = settings(10_000);
    s.retry = Duration::from_secs(3600);
    let handle = spawn(
        Arc::clone(&hub),
        s,
        env(Some("192.168.1.20")),
        vec![Arc::clone(&router) as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    assert_eq!(hub.current().state, ReachabilityState::Refused);
    hub.request_retry();
    eventually(&hub, "open after Try again", |r| {
        r.state == ReachabilityState::Open
    })
    .await;
    handle.release().await;
}

/// While open the mapping is renewed on its own timer, against the router
/// that gave it, and the state stays `open` throughout.
#[tokio::test]
async fn an_open_mapping_is_renewed_and_stays_open() {
    let router = Scripted::new(vec![mapped("203.0.113.9")]);
    let hub = Arc::new(ReachabilityHub::new());
    let mut rx = hub.subscribe();
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env(Some("192.168.1.20")),
        vec![Arc::clone(&router) as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(router.maps.load(Ordering::SeqCst) >= 3, "renewed");
    assert_eq!(hub.current().state, ReachabilityState::Open);
    // It never went back through `asking` on the timer.
    rx.mark_unchanged();
    handle.release().await;
}

/// A failed renewal is a fact change: the state leaves `open` (so the share
/// address falls back to the LAN), retries, and recovers.
#[tokio::test]
async fn a_failed_renewal_leaves_open_then_recovers() {
    let router = Scripted::new(vec![
        mapped("203.0.113.9"),
        Err(MapFailure::no_answer("the router stopped answering")),
        mapped("203.0.113.9"),
    ]);
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(80),
        env(Some("192.168.1.20")),
        vec![Arc::clone(&router) as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    assert_eq!(hub.current().state, ReachabilityState::Open);

    let failed = eventually(&hub, "no_answer after renewal", |r| {
        r.state == ReachabilityState::NoAnswer
    })
    .await;
    assert!(failed.external_ip.is_none());
    let share = derive(
        &ShareInputs {
            public_url: None,
            local_url: "https://192.168.1.20:8443".into(),
            scheme: "https".into(),
            port: 8443,
        },
        &failed,
        None,
    );
    assert_eq!(share.url, None);
    assert_eq!(share.reach, ShareReach::Unknown);

    eventually(&hub, "open again", |r| r.state == ReachabilityState::Open).await;
    handle.release().await;
}

/// A new external address on renewal updates the state and is remembered as a
/// change, so the invite screen can say links made earlier stop working.
#[tokio::test]
async fn a_changed_address_on_renewal_is_announced() {
    let router = Scripted::new(vec![mapped("203.0.113.9"), mapped("203.0.113.10")]);
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env(Some("192.168.1.20")),
        vec![router as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    assert_eq!(hub.current().external_ip.as_deref(), Some("203.0.113.9"));
    eventually(&hub, "new address", |r| {
        r.external_ip.as_deref() == Some("203.0.113.10")
    })
    .await;
    assert_eq!(hub.previous_external_ip().as_deref(), Some("203.0.113.9"));
    handle.release().await;
}

/// Shutdown takes down what was mapped, only on the router that mapped it.
#[tokio::test]
async fn release_unmaps_the_router_that_holds_the_mapping_and_no_other() {
    let failing = Scripted::new(vec![Err(MapFailure::no_answer("none"))]);
    let working = Scripted::new(vec![mapped("203.0.113.9")]);
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env(Some("192.168.1.20")),
        vec![
            Arc::clone(&failing) as Arc<dyn Router>,
            Arc::clone(&working) as Arc<dyn Router>,
        ],
    );
    handle.first_attempt().await;
    assert_eq!(hub.current().state, ReachabilityState::Open);
    handle.release().await;
    assert_eq!(working.unmaps.load(Ordering::SeqCst), 1);
    assert_eq!(failing.unmaps.load(Ordering::SeqCst), 0);
}

/// A router that is mid-request when the process leaves may have granted the
/// mapping without saying so; shutdown still closes it.
#[tokio::test]
async fn release_during_an_unfinished_request_still_unmaps() {
    let router = Scripted::silent();
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env(Some("192.168.1.20")),
        vec![Arc::clone(&router) as Arc<dyn Router>],
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    handle.release().await;
    assert_eq!(router.unmaps.load(Ordering::SeqCst), 1);
}

#[test]
fn the_banner_outcome_follows_the_state() {
    use paracord_contracts::host::Reachability;
    let base = Reachability {
        state: ReachabilityState::Open,
        method: Some("upnp".into()),
        external_ip: Some("203.0.113.9".into()),
        gateway_ip: None,
        lan_ip: None,
        port: 8443,
        lease_expires_at: None,
        next_retry_at: None,
        last_error: None,
        confirmed_at: None,
        observed_ip: None,
    };
    assert!(outcome_for(&base).is_mapped());
    for state in [
        ReachabilityState::SharedAddress,
        ReachabilityState::Refused,
        ReachabilityState::NoAnswer,
        ReachabilityState::FirewallBlocked,
    ] {
        let outcome = outcome_for(&Reachability {
            state,
            external_ip: Some("100.64.1.1".into()),
            ..base.clone()
        });
        assert!(!outcome.is_mapped(), "{state:?}");
        // A private address is never offered as where friends should connect.
        assert_eq!(outcome.external_ip(), None, "{state:?}");
    }
    let direct = outcome_for(&Reachability {
        state: ReachabilityState::Direct,
        ..base
    });
    assert!(direct.is_mapped());
}

#[test]
fn netsh_output_is_judged_by_exit_status_and_port_only() {
    let english = "Rule Name:                            Paracord on this computer\n\
                   Enabled:                              Yes\n\
                   Protocol:                             TCP\n\
                   LocalPort:                            8443\n";
    assert!(netsh_rule_covers_port(true, english, 8443));
    // A rule for another port does not cover this one.
    assert!(!netsh_rule_covers_port(true, english, 9000));
    // "No rules match the specified criteria." exits non-zero.
    assert!(!netsh_rule_covers_port(false, "", 8443));
    // Localized labels still work: only the number matters.
    assert!(netsh_rule_covers_port(
        true,
        "Regelname: x\nLokaler Port: 8443\n",
        8443
    ));
    // 18443 is not 8443.
    assert!(!netsh_rule_covers_port(true, "LocalPort: 18443\n", 8443));
}

// ── When the router will not say: the STUN probe ───────────────────────────

/// A STUN probe that never touches the network.
struct FakeStun {
    answer: Result<&'static str, &'static str>,
    asked: AtomicUsize,
    asked_from: Mutex<Option<IpAddr>>,
}

impl FakeStun {
    fn answering(ip: &'static str) -> Arc<Self> {
        Arc::new(Self {
            answer: Ok(ip),
            asked: AtomicUsize::new(0),
            asked_from: Mutex::new(None),
        })
    }

    fn failing() -> Arc<Self> {
        Arc::new(Self {
            answer: Err("no answer in time"),
            asked: AtomicUsize::new(0),
            asked_from: Mutex::new(None),
        })
    }
}

impl PublicAddressProbe for FakeStun {
    fn discover(&self, local: Option<IpAddr>) -> BoxFuture<'_, Result<Observed, String>> {
        Box::pin(async move {
            self.asked.fetch_add(1, Ordering::SeqCst);
            *self.asked_from.lock().unwrap() = local;
            match self.answer {
                Ok(ip) => Ok(Observed {
                    ip: ip.parse().unwrap(),
                    server: "stun.test:3478".into(),
                }),
                Err(reason) => Err(reason.to_string()),
            }
        })
    }
}

fn env_with_stun(lan: Option<&str>, probe: &Arc<FakeStun>) -> Environment {
    let mut e = env(lan);
    e.public_address = Some(Arc::clone(probe) as Arc<dyn PublicAddressProbe>);
    e
}

fn lan_inputs() -> ShareInputs {
    ShareInputs {
        public_url: None,
        local_url: "https://192.168.1.20:8443".into(),
        scheme: "https".into(),
        port: 8443,
    }
}

/// The owner's network: nothing answers UPnP or NAT-PMP/PCP. STUN names the
/// address, from this computer's own interface, and the invite uses it,
/// unconfirmed, with the home link alongside.
#[tokio::test]
async fn a_silent_router_with_stun_shares_the_public_address_unconfirmed() {
    let probe = FakeStun::answering("198.51.100.4");
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env_with_stun(Some("192.168.1.20"), &probe),
        vec![Scripted::silent() as Arc<dyn Router>],
    );
    let r = eventually(&hub, "observed address", |r| r.observed_ip.is_some()).await;
    assert_eq!(r.state, ReachabilityState::NoAnswer);
    assert_eq!(r.external_ip, None);
    assert_eq!(r.observed_ip.as_deref(), Some("198.51.100.4"));
    assert_eq!(
        *probe.asked_from.lock().unwrap(),
        Some("192.168.1.20".parse().unwrap())
    );
    let share = derive(&lan_inputs(), &r, None);
    assert_eq!(share.url.as_deref(), Some("https://198.51.100.4:8443"));
    assert_eq!(share.reach, ShareReach::InternetUnconfirmed);
    assert_eq!(share.note, Some(ShareNote::PortNotForwarded));
    assert_eq!(share.source, Some(ShareSource::Stun));
    handle.release().await;
}

/// A router that refuses the mapping but names its address: that answer is
/// kept, it is the link, and no STUN server is asked.
#[tokio::test]
async fn a_refusal_keeps_the_address_the_router_named_and_skips_stun() {
    let probe = FakeStun::answering("198.51.100.4");
    let router = Scripted::new(vec![Err(MapFailure::refused(
        "the router refused TCP 8443",
    )
    .via_gateway("192.168.1.1".parse().unwrap())
    .with_external_ip(Some("203.0.113.9".parse().unwrap())))]);
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env_with_stun(Some("192.168.1.20"), &probe),
        vec![router as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    let r = hub.current();
    assert_eq!(r.state, ReachabilityState::Refused);
    assert_eq!(r.external_ip.as_deref(), Some("203.0.113.9"));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(probe.asked.load(Ordering::SeqCst), 0);
    assert_eq!(hub.current().observed_ip, None);
    let share = derive(&lan_inputs(), &hub.current(), None);
    assert_eq!(share.url.as_deref(), Some("https://203.0.113.9:8443"));
    assert_eq!(share.reach, ShareReach::InternetUnconfirmed);
    assert_eq!(share.source, Some(ShareSource::Router));
    handle.release().await;
}

/// The router's own address is carrier-grade NAT: STUN is asked for the
/// public one, and the invite says the provider is in the way.
#[tokio::test]
async fn a_carrier_nat_router_asks_stun_and_names_the_problem() {
    let probe = FakeStun::answering("198.51.100.4");
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env_with_stun(Some("192.168.1.20"), &probe),
        vec![Scripted::new(vec![mapped("100.72.0.5")]) as Arc<dyn Router>],
    );
    let r = eventually(&hub, "observed address", |r| r.observed_ip.is_some()).await;
    assert_eq!(r.state, ReachabilityState::SharedAddress);
    let share = derive(&lan_inputs(), &r, None);
    assert_eq!(share.url.as_deref(), Some("https://198.51.100.4:8443"));
    assert_eq!(share.note, Some(ShareNote::CarrierNat));
    handle.release().await;
}

/// An open router never needs STUN.
#[tokio::test]
async fn an_open_router_never_asks_stun() {
    let probe = FakeStun::answering("198.51.100.4");
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env_with_stun(Some("192.168.1.20"), &probe),
        vec![Scripted::new(vec![mapped("203.0.113.9")]) as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(hub.current().state, ReachabilityState::Open);
    assert_eq!(probe.asked.load(Ordering::SeqCst), 0);
    handle.release().await;
}

/// The timer's one-minute retries do not ask STUN again (once per refresh);
/// "Try again" does.
#[tokio::test]
async fn stun_is_asked_once_per_refresh_and_again_on_try_again() {
    let probe = FakeStun::answering("198.51.100.4");
    let router = Scripted::new(vec![Err(MapFailure::no_answer("quiet"))]);
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(30),
        env_with_stun(Some("192.168.1.20"), &probe),
        vec![Arc::clone(&router) as Arc<dyn Router>],
    );
    eventually(&hub, "observed address", |r| r.observed_ip.is_some()).await;
    let before = router.maps.load(Ordering::SeqCst);
    while router.maps.load(Ordering::SeqCst) < before + 3 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(probe.asked.load(Ordering::SeqCst), 1);
    hub.request_retry();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while probe.asked.load(Ordering::SeqCst) < 2 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "Try again did not ask"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    handle.release().await;
}

/// A failed STUN attempt names nothing: the invite stays on the home network.
#[tokio::test]
async fn a_failed_stun_attempt_leaves_the_local_address() {
    let probe = FakeStun::failing();
    let hub = Arc::new(ReachabilityHub::new());
    let handle = spawn(
        Arc::clone(&hub),
        settings(10_000),
        env_with_stun(Some("192.168.1.20"), &probe),
        vec![Scripted::silent() as Arc<dyn Router>],
    );
    handle.first_attempt().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while probe.asked.load(Ordering::SeqCst) == 0 {
        assert!(tokio::time::Instant::now() < deadline, "STUN never asked");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let r = hub.current();
    assert_eq!(r.observed_ip, None);
    let share = derive(&lan_inputs(), &r, None);
    assert_eq!(share.url, None);
    assert_eq!(share.reach, ShareReach::Unknown);
    handle.release().await;
}
