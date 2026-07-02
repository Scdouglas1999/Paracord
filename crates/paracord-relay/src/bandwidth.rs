use std::time::Duration;

use dashmap::DashMap;
use tracing::debug;

/// Per-connection bandwidth estimation using QUIC transport stats.
///
/// Tracks available bandwidth per connection and signals constraints
/// to clients via control messages.
pub struct BandwidthEstimator {
    /// Estimated available bandwidth per user (in kbps).
    estimates: DashMap<i64, BandwidthEstimate>,
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

        // Estimate bandwidth from RTT and datagram size.
        // This is a rough estimate; real bandwidth estimation would use
        // congestion controller feedback from quinn.
        let available_kbps = estimate_bandwidth(rtt, max_datagram_size);

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

/// Rough bandwidth estimate from RTT and max datagram size.
fn estimate_bandwidth(rtt: Duration, max_datagram_size: Option<usize>) -> u32 {
    let datagram_size = max_datagram_size.unwrap_or(1200) as u32;
    let rtt_ms = rtt.as_millis() as u32;

    if rtt_ms == 0 {
        return 10_000; // 10 Mbps default for very low RTT
    }

    // Simple BDP-based estimate: packets_per_second * packet_size * 8 / 1000
    // Assume a conservative congestion window of ~100 packets in flight.
    let packets_per_second = 100_000 / rtt_ms;
    let kbps = (packets_per_second * datagram_size * 8) / 1000;

    // Clamp to reasonable range
    kbps.clamp(100, 100_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_bandwidth() {
        let estimator = BandwidthEstimator::new();
        assert_eq!(estimator.available_kbps(999), 2500);
    }

    #[test]
    fn estimate_bandwidth_reasonable() {
        // 20ms RTT, 1200 byte datagrams
        let kbps = estimate_bandwidth(Duration::from_millis(20), Some(1200));
        assert!(kbps >= 100);
        assert!(kbps <= 100_000);
    }

    #[test]
    fn estimate_bandwidth_high_rtt() {
        // 200ms RTT should give lower bandwidth
        let low_rtt = estimate_bandwidth(Duration::from_millis(20), Some(1200));
        let high_rtt = estimate_bandwidth(Duration::from_millis(200), Some(1200));
        assert!(high_rtt < low_rtt);
    }

    #[test]
    fn estimate_bandwidth_zero_rtt() {
        let kbps = estimate_bandwidth(Duration::from_millis(0), Some(1200));
        assert_eq!(kbps, 10_000);
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
