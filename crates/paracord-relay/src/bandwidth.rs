use std::time::Duration;

use dashmap::DashMap;
use tracing::debug;

/// Absolute floor for a reported estimate, in kbps. Even a badly congested
/// path is assumed able to carry a minimal Opus stream.
const MIN_BANDWIDTH_KBPS: u32 = 100;

/// Absolute ceiling for a reported estimate, in kbps (100 Mbps). Caps
/// pathological BDP figures on very low-RTT / large-window paths.
const MAX_BANDWIDTH_KBPS: u32 = 100_000;

/// Per-connection bandwidth estimation using QUIC transport stats.
///
/// Tracks available bandwidth per connection and signals constraints
/// to clients via control messages.
pub struct BandwidthEstimator {
    /// Estimated available bandwidth per user (in kbps).
    estimates: DashMap<i64, BandwidthEstimate>,
}

/// A snapshot of the QUIC path state used to derive a single estimate.
///
/// Sourced from [`quinn::Connection::stats`]'s `path` statistics plus the
/// connection's current max datagram size.
struct PathSample {
    /// Smoothed round-trip time for the path.
    rtt: Duration,
    /// Congestion window in bytes, as reported by quinn's congestion controller.
    cwnd_bytes: u64,
    /// Cumulative packets lost on the path.
    lost_packets: u64,
    /// Cumulative packets sent on the path.
    sent_packets: u64,
    /// Largest datagram the path currently accepts, if known.
    max_datagram_size: Option<usize>,
}

/// Bandwidth estimate for a single connection.
#[derive(Debug, Clone)]
pub struct BandwidthEstimate {
    /// Available bandwidth in kilobits per second.
    pub available_kbps: u32,
    /// Current round-trip time.
    pub rtt: Duration,
    /// Maximum datagram size supported.
    pub max_datagram_size: Option<usize>,
}

impl BandwidthEstimator {
    pub fn new() -> Self {
        Self {
            estimates: DashMap::new(),
        }
    }

    /// Update bandwidth estimate for a user from QUIC connection stats.
    pub fn update_from_connection(&self, user_id: i64, conn: &quinn::Connection) {
        let rtt = conn.rtt();
        let max_datagram_size = conn.max_datagram_size();
        let path = conn.stats().path;

        // Derive the estimate from quinn's congestion controller (window +
        // observed loss) rather than RTT alone; see `estimate_bandwidth`.
        let available_kbps = estimate_bandwidth(&PathSample {
            rtt,
            cwnd_bytes: path.cwnd,
            lost_packets: path.lost_packets,
            sent_packets: path.sent_packets,
            max_datagram_size,
        });

        self.estimates.insert(
            user_id,
            BandwidthEstimate {
                available_kbps,
                rtt,
                max_datagram_size,
            },
        );

        debug!(
            user_id,
            available_kbps,
            rtt_ms = rtt.as_millis() as u64,
            "bandwidth: updated estimate"
        );
    }

    /// Get the bandwidth estimate for a user.
    pub fn get_estimate(&self, user_id: i64) -> Option<BandwidthEstimate> {
        self.estimates.get(&user_id).map(|e| e.clone())
    }

    /// Remove estimate for a disconnected user.
    pub fn remove_user(&self, user_id: i64) {
        self.estimates.remove(&user_id);
    }

    /// Get the available bandwidth in kbps for a user, or a default.
    pub fn available_kbps(&self, user_id: i64) -> u32 {
        self.estimates
            .get(&user_id)
            .map(|e| e.available_kbps)
            .unwrap_or(2500) // default 2.5 Mbps
    }
}

impl Default for BandwidthEstimator {
    fn default() -> Self {
        Self::new()
    }
}

/// Congestion-aware bandwidth estimate from a QUIC path snapshot.
///
/// Method: the deliverable rate is the bandwidth-delay product taken directly
/// from quinn's congestion controller. The congestion window (`cwnd_bytes`) is
/// the volume the controller permits in flight for one RTT, so the sustainable
/// rate is `cwnd_bytes * 8` bits per RTT, i.e. `kbps = cwnd_bytes * 8 / rtt_ms`.
/// Before the controller reports a window (immediately post-handshake) we fall
/// back to a single-datagram window so the estimate is never zero. The raw BDP
/// is then discounted by the path's cumulative loss ratio — a lossy path cannot
/// sustain its nominal window — with the discount floored so a pathological loss
/// ratio still leaves a usable rate. A sub-millisecond RTT is clamped to 1ms to
/// avoid dividing by zero and reporting an unbounded rate. The result is clamped
/// to `[MIN_BANDWIDTH_KBPS, MAX_BANDWIDTH_KBPS]`.
fn estimate_bandwidth(sample: &PathSample) -> u32 {
    // Clamp RTT to at least 1ms so a freshly-measured sub-millisecond path does
    // not divide the window by ~0 and report an unbounded rate.
    let rtt_ms = (sample.rtt.as_micros() as f64 / 1000.0).max(1.0);

    // Fall back to a single datagram of window if the controller has not yet
    // reported a congestion window (e.g. right after the handshake).
    let cwnd_bytes = if sample.cwnd_bytes == 0 {
        sample.max_datagram_size.unwrap_or(1200) as f64
    } else {
        sample.cwnd_bytes as f64
    };

    let mut kbps = cwnd_bytes * 8.0 / rtt_ms;

    // Discount the raw BDP by the observed cumulative loss ratio. The retained
    // fraction is floored at 0.1 so a pathological loss ratio still leaves a
    // usable estimate instead of collapsing it to zero.
    let total = sample.lost_packets + sample.sent_packets;
    if total > 0 {
        let loss = sample.lost_packets as f64 / total as f64;
        let retained = (1.0 - loss).clamp(0.1, 1.0);
        kbps *= retained;
    }

    (kbps as u32).clamp(MIN_BANDWIDTH_KBPS, MAX_BANDWIDTH_KBPS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a path sample with a given RTT and congestion window and no loss.
    fn lossless_sample(rtt: Duration, cwnd_bytes: u64) -> PathSample {
        PathSample {
            rtt,
            cwnd_bytes,
            lost_packets: 0,
            sent_packets: 0,
            max_datagram_size: Some(1200),
        }
    }

    #[test]
    fn default_bandwidth() {
        let estimator = BandwidthEstimator::new();
        assert_eq!(estimator.available_kbps(999), 2500);
    }

    #[test]
    fn estimate_bandwidth_reasonable() {
        // 20ms RTT, ~120 KB congestion window.
        let kbps = estimate_bandwidth(&lossless_sample(Duration::from_millis(20), 120_000));
        assert!(kbps >= MIN_BANDWIDTH_KBPS);
        assert!(kbps <= MAX_BANDWIDTH_KBPS);
    }

    #[test]
    fn estimate_uses_congestion_window() {
        // BDP: cwnd_bytes * 8 / rtt_ms. 125_000 bytes over 10ms = 100_000 kbps,
        // which lands exactly on the ceiling.
        let kbps = estimate_bandwidth(&lossless_sample(Duration::from_millis(10), 125_000));
        assert_eq!(kbps, MAX_BANDWIDTH_KBPS);

        // A larger window over the same RTT yields at least as much bandwidth.
        let small = estimate_bandwidth(&lossless_sample(Duration::from_millis(50), 60_000));
        let large = estimate_bandwidth(&lossless_sample(Duration::from_millis(50), 120_000));
        assert!(large > small);
    }

    #[test]
    fn estimate_bandwidth_high_rtt() {
        // For a fixed window, a higher RTT drains the BDP more slowly.
        let low_rtt = estimate_bandwidth(&lossless_sample(Duration::from_millis(20), 120_000));
        let high_rtt = estimate_bandwidth(&lossless_sample(Duration::from_millis(200), 120_000));
        assert!(high_rtt < low_rtt);
    }

    #[test]
    fn estimate_bandwidth_sub_millisecond_rtt_is_clamped() {
        // A sub-millisecond RTT is treated as 1ms; it must not report an
        // unbounded rate and must respect the ceiling.
        let kbps = estimate_bandwidth(&lossless_sample(Duration::from_micros(100), 120_000));
        assert_eq!(kbps, MAX_BANDWIDTH_KBPS);
    }

    #[test]
    fn estimate_falls_back_to_datagram_window_before_first_cwnd() {
        // With no reported congestion window, a single 1200-byte datagram of
        // window over 20ms yields 1200 * 8 / 20 = 480 kbps.
        let kbps = estimate_bandwidth(&PathSample {
            rtt: Duration::from_millis(20),
            cwnd_bytes: 0,
            lost_packets: 0,
            sent_packets: 0,
            max_datagram_size: Some(1200),
        });
        assert_eq!(kbps, 480);
        assert!(kbps >= MIN_BANDWIDTH_KBPS);
    }

    #[test]
    fn estimate_discounts_for_packet_loss() {
        let base = estimate_bandwidth(&PathSample {
            rtt: Duration::from_millis(20),
            cwnd_bytes: 120_000,
            lost_packets: 0,
            sent_packets: 1000,
            max_datagram_size: Some(1200),
        });
        // 20% loss should meaningfully reduce the estimate versus no loss.
        let lossy = estimate_bandwidth(&PathSample {
            rtt: Duration::from_millis(20),
            cwnd_bytes: 120_000,
            lost_packets: 200,
            sent_packets: 800,
            max_datagram_size: Some(1200),
        });
        assert!(lossy < base);

        // Even near-total loss leaves a usable floor rather than zero.
        let catastrophic = estimate_bandwidth(&PathSample {
            rtt: Duration::from_millis(20),
            cwnd_bytes: 120_000,
            lost_packets: 999,
            sent_packets: 1,
            max_datagram_size: Some(1200),
        });
        assert!(catastrophic >= MIN_BANDWIDTH_KBPS);
        assert!(catastrophic < lossy);
    }

    #[test]
    fn remove_user() {
        let estimator = BandwidthEstimator::new();
        estimator.estimates.insert(
            1,
            BandwidthEstimate {
                available_kbps: 5000,
                rtt: Duration::from_millis(10),
                max_datagram_size: Some(1200),
            },
        );
        assert!(estimator.get_estimate(1).is_some());
        estimator.remove_user(1);
        assert!(estimator.get_estimate(1).is_none());
    }
}
