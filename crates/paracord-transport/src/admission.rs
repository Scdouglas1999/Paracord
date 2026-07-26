//! Admission control for QUIC connections that have not yet authenticated.
//!
//! Everything else in the media stack is gated on an authenticated participant:
//! the relay's per-sender rate limiters, the per-room participant cap, the
//! recipient-cache bounds. The accept loop in front of them is not — a peer that
//! has only proved it can receive a UDP packet gets a full `quinn::Connection`
//! with its own transport state and datagram buffers, held for the whole
//! pre-auth window. That is the only unauthenticated resource-exhaustion surface
//! in the media path, so it needs its own bound.
//!
//! [`PreAuthAdmission`] is that bound: a global ceiling plus a per-source-IP
//! ceiling on connections that are between "handshake started" and
//! "authenticated". A slot is held by an [`AdmissionGuard`] and released when the
//! guard drops, which the accept loop does as soon as auth succeeds — an
//! authenticated call therefore occupies a slot for about one round trip, not
//! for the duration of the call.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

/// Concurrent unauthenticated media connections accepted server-wide.
///
/// Each slot costs one `quinn::Connection`'s transport state plus whatever the
/// peer manages to buffer before authenticating, so this is the number that
/// converts "attacker uplink" into "server memory". It must clear the worst
/// legitimate burst: every member of a full room reconnecting at once after a
/// server restart or a network blip. A room holds at most 50 participants and a
/// modest self-hosted server runs a handful of concurrent calls, so 128
/// simultaneous *in-flight handshakes* is several times the real peak — each one
/// is released after a single round trip, giving a sustained admission
/// throughput in the thousands of joins per second.
pub const MAX_PENDING_CONNECTIONS: usize = 128;

/// Concurrent unauthenticated media connections accepted from one source IP.
///
/// Without this, one host takes every global slot and locks out every other
/// client. Legitimate clients open one media connection per voice session, so
/// even several users behind one NAT joining together stay well under this;
/// re-joins release their slot as soon as they authenticate.
pub const MAX_PENDING_CONNECTIONS_PER_IP: usize = 8;

/// Why a pre-auth connection was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionRefusal {
    /// The server-wide pre-auth ceiling is full.
    GlobalLimit,
    /// This source IP already holds its share of pre-auth slots.
    PerIpLimit,
}

impl std::fmt::Display for AdmissionRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GlobalLimit => write!(f, "global pre-auth connection limit reached"),
            Self::PerIpLimit => write!(f, "per-IP pre-auth connection limit reached"),
        }
    }
}

#[derive(Default)]
struct AdmissionState {
    /// Total slots currently held. Kept alongside `per_ip` so the global check
    /// is one read rather than a sum over the map.
    total: usize,
    /// Slots held per source IP. An entry is removed when it reaches zero, so
    /// the map is bounded by the number of *currently pending* peers, not by the
    /// number of addresses ever seen.
    per_ip: HashMap<IpAddr, usize>,
}

/// Bounded admission for connections that have not yet authenticated.
pub struct PreAuthAdmission {
    max_total: usize,
    max_per_ip: usize,
    state: Mutex<AdmissionState>,
}

impl PreAuthAdmission {
    /// Build an admission controller with the default ceilings.
    pub fn new() -> Self {
        Self::with_limits(MAX_PENDING_CONNECTIONS, MAX_PENDING_CONNECTIONS_PER_IP)
    }

    /// Build an admission controller with explicit ceilings (tests).
    pub fn with_limits(max_total: usize, max_per_ip: usize) -> Self {
        Self {
            max_total,
            max_per_ip,
            state: Mutex::new(AdmissionState::default()),
        }
    }

    /// Reserve a pre-auth slot for `ip`, or report why it was refused.
    ///
    /// The returned guard releases the slot on drop; callers drop it the moment
    /// the connection authenticates.
    pub fn try_admit(self: &Arc<Self>, ip: IpAddr) -> Result<AdmissionGuard, AdmissionRefusal> {
        let mut state = self
            .state
            .lock()
            .expect("pre-auth admission mutex poisoned");
        if state.total >= self.max_total {
            return Err(AdmissionRefusal::GlobalLimit);
        }
        let slot = state.per_ip.entry(ip).or_insert(0);
        if *slot >= self.max_per_ip {
            return Err(AdmissionRefusal::PerIpLimit);
        }
        *slot += 1;
        state.total += 1;
        drop(state);
        Ok(AdmissionGuard {
            admission: Arc::clone(self),
            ip,
        })
    }

    /// Number of pre-auth slots currently held server-wide.
    pub fn pending(&self) -> usize {
        self.state
            .lock()
            .expect("pre-auth admission mutex poisoned")
            .total
    }

    /// Number of pre-auth slots currently held by one source IP.
    pub fn pending_for_ip(&self, ip: IpAddr) -> usize {
        self.state
            .lock()
            .expect("pre-auth admission mutex poisoned")
            .per_ip
            .get(&ip)
            .copied()
            .unwrap_or(0)
    }

    /// Number of source IPs currently holding at least one slot. Used by tests
    /// to assert the per-IP map does not retain departed peers.
    pub fn tracked_ips(&self) -> usize {
        self.state
            .lock()
            .expect("pre-auth admission mutex poisoned")
            .per_ip
            .len()
    }

    fn release(&self, ip: IpAddr) {
        let mut state = self
            .state
            .lock()
            .expect("pre-auth admission mutex poisoned");
        state.total = state.total.saturating_sub(1);
        if let std::collections::hash_map::Entry::Occupied(mut slot) = state.per_ip.entry(ip) {
            *slot.get_mut() -= 1;
            if *slot.get() == 0 {
                slot.remove();
            }
        }
    }
}

impl Default for PreAuthAdmission {
    fn default() -> Self {
        Self::new()
    }
}

/// Holds one pre-auth slot; releases it on drop.
pub struct AdmissionGuard {
    admission: Arc<PreAuthAdmission>,
    ip: IpAddr,
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        self.admission.release(self.ip);
    }
}
