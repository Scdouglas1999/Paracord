use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use dashmap::DashMap;

/// Sliding measurement window for ingress goodput and loss (~5s).
const WINDOW: Duration = Duration::from_secs(5);

/// Bucket granularity for the sliding window. The window is a ring of
/// `NUM_BUCKETS` buckets each covering `BUCKET_MS`, which bounds per-publisher
/// memory to a fixed number of accumulators regardless of packet rate.
const BUCKET_MS: u64 = 100;
const NUM_BUCKETS: u64 = (WINDOW.as_millis() as u64) / BUCKET_MS;

/// Absolute floor for a reported estimate, in kbps.
const MIN_BANDWIDTH_KBPS: u32 = 512;

/// Absolute ceiling for a reported estimate, in kbps (100 Mbps).
const MAX_BANDWIDTH_KBPS: u32 = 100_000;

/// Pre-measurement default used before any ingress has been observed for a
/// publisher. Also the initial value the AIMD controller probes up from.
const INITIAL_BANDWIDTH_KBPS: u32 = 2500;

/// Loss ratio above which the controller multiplicatively decreases.
const LOSS_HIGH: f64 = 0.02;

/// Loss ratio below which the controller probes upward.
const LOSS_LOW: f64 = 0.005;

/// Multiplicative-decrease factor applied when loss is high.
const AIMD_DOWN: f64 = 0.85;

/// Multiplicative-increase factor applied when loss is low.
const AIMD_UP: f64 = 1.1;

/// Largest per-SSRC forward sequence jump still attributed to real loss. A
/// jump beyond this is treated as a stream discontinuity (encoder restart /
/// SSRC reuse) rather than a burst of tens of thousands of lost packets.
const MAX_SEQ_GAP: u16 = 3000;

/// Distinct SSRCs one publisher's loss estimator tracks a sequence number for.
///
/// `ssrc` is read straight off the wire, so this map's key is attacker-chosen
/// and was inserted into on every accepted ingress packet with no eviction — a
/// publisher rotating it inserted at the relay's full per-sender packet rate.
/// The bound mirrors the relay's own per-sender fan-out cache: a publisher's
/// live SSRC set is one per (track, simulcast layer), well under ten in
/// practice. Eviction is FIFO; an evicted SSRC that reappears is simply treated
/// as a first arrival (no loss attributed), which is the same behaviour as the
/// stream genuinely restarting.
pub(crate) const MAX_TRACKED_SSRCS_PER_PUBLISHER: usize = 32;

/// Publisher-ingress bandwidth estimation at the relay.
///
/// The old estimator sampled the relay's *send-side* congestion window toward
/// each participant (relay->client downlink) and fed it back to publishers as
/// an *uplink* limit — a direction inversion that clamped WAN publishers to the
/// initial congestion window. This estimator instead measures each publisher's
/// actual ingress at the relay: a sliding (~5s) window of received goodput and
/// a loss ratio derived from per-SSRC [`MediaHeader`](paracord_transport::protocol::MediaHeader)
/// sequence gaps. A simple AIMD policy converts that into an uplink feedback
/// bitrate the publisher's encoder can apply directly.
pub struct BandwidthEstimator {
    /// Per-publisher ingress accumulators, keyed by user id.
    publishers: DashMap<i64, PublisherIngress>,
    /// Common time origin so bucket epochs are comparable across publishers.
    base: Instant,
}

/// One bucket of the sliding window covering `BUCKET_MS` of wall-clock time.
#[derive(Clone, Copy)]
struct WindowBucket {
    /// Bucket epoch: `(elapsed_since_base_ms) / BUCKET_MS`.
    epoch: u64,
    /// Bytes received (header + payload) in this bucket.
    bytes: u64,
    /// Expected packets across all SSRCs (received + inferred-lost) in this bucket.
    expected: u64,
    /// Packets inferred lost from per-SSRC sequence gaps in this bucket.
    lost: u64,
}

/// Sliding-window ingress state for one publisher.
struct PublisherIngress {
    /// Ring of recent buckets, oldest at the front. Bounded to `NUM_BUCKETS`.
    buckets: VecDeque<WindowBucket>,
    /// Last observed sequence number per SSRC, for wrap-aware gap detection.
    /// Bounded at [`MAX_TRACKED_SSRCS_PER_PUBLISHER`] entries.
    last_seq: HashMap<u32, u16>,
    /// SSRCs in `last_seq` in insertion order, oldest first, for FIFO eviction.
    ssrc_order: VecDeque<u32>,
    /// Last feedback bitrate emitted for this publisher (0 = never emitted).
    last_feedback_kbps: u32,
}

impl PublisherIngress {
    fn new() -> Self {
        Self {
            buckets: VecDeque::new(),
            last_seq: HashMap::new(),
            ssrc_order: VecDeque::new(),
            last_feedback_kbps: 0,
        }
    }

    /// Record `sequence` as the newest observation for `ssrc`, returning the
    /// previous one. Admitting a new SSRC evicts the oldest once the publisher
    /// is over [`MAX_TRACKED_SSRCS_PER_PUBLISHER`], so the map cannot be grown
    /// by rotating the wire-supplied `ssrc`.
    fn observe_seq(&mut self, ssrc: u32, sequence: u16) -> Option<u16> {
        let previous = self.last_seq.insert(ssrc, sequence);
        if previous.is_none() {
            self.ssrc_order.push_back(ssrc);
            while self.last_seq.len() > MAX_TRACKED_SSRCS_PER_PUBLISHER {
                match self.ssrc_order.pop_front() {
                    Some(oldest) => {
                        self.last_seq.remove(&oldest);
                    }
                    None => break,
                }
            }
        }
        previous
    }

    /// Drop buckets that have fallen out of the sliding window ending at `current_epoch`.
    fn prune(&mut self, current_epoch: u64) {
        while let Some(front) = self.buckets.front() {
            if front.epoch + NUM_BUCKETS <= current_epoch {
                self.buckets.pop_front();
            } else {
                break;
            }
        }
    }

    /// Record a single ingress packet into the current bucket.
    fn record(&mut self, epoch: u64, ssrc: u32, sequence: u16, bytes: u64) {
        let (expected, lost) = self.sequence_delta(ssrc, sequence);
        self.prune(epoch);
        match self.buckets.back_mut() {
            Some(back) if back.epoch == epoch => {
                back.bytes += bytes;
                back.expected += expected;
                back.lost += lost;
            }
            _ => {
                self.buckets.push_back(WindowBucket {
                    epoch,
                    bytes,
                    expected,
                    lost,
                });
            }
        }
    }

    /// Record a single whole keyframe delivered on the reliable uni-stream path.
    ///
    /// Keyframes share the per-`(ssrc, epoch)` sequence counter with datagram
    /// fragments (so AEAD nonces never collide) but are delivered reliably and
    /// are usually recorded *late* — the relay reads the whole uni stream to FIN,
    /// so the small delta datagram sent immediately after the keyframe overtakes
    /// it. That follower delta scores the keyframe's own sequence slot as one lost
    /// packet; the plain reorder path never credits it back, injecting ~+1 phantom
    /// loss per keyframe. This records goodput bytes as usual but reconciles the
    /// sequence so the keyframe's slot is not counted as loss in either arrival
    /// order.
    fn record_keyframe(&mut self, epoch: u64, ssrc: u32, sequence: u16, bytes: u64) {
        let (expected, lost, credit) = self.keyframe_sequence_delta(ssrc, sequence);
        self.prune(epoch);
        match self.buckets.back_mut() {
            Some(back) if back.epoch == epoch => {
                back.bytes += bytes;
                back.expected += expected;
                back.lost += lost;
            }
            _ => {
                self.buckets.push_back(WindowBucket {
                    epoch,
                    bytes,
                    expected,
                    lost,
                });
            }
        }
        if credit {
            // The follower delta already counted this keyframe's slot as one lost
            // packet. The window loss ratio sums lost/expected across all buckets,
            // so decrementing any in-window bucket with a loss cancels exactly that
            // phantom without needing to know which bucket scored it.
            for bucket in self.buckets.iter_mut().rev() {
                if bucket.lost > 0 {
                    bucket.lost -= 1;
                    break;
                }
            }
        }
    }

    /// Keyframe variant of [`Self::sequence_delta`]. Returns
    /// `(expected, lost, credit)` where `credit` asks the caller to remove one
    /// previously-counted phantom loss because a late (overtaken) keyframe has now
    /// arrived. In-order keyframes behave exactly like a normal arrival.
    fn keyframe_sequence_delta(&mut self, ssrc: u32, sequence: u16) -> (u64, u64, bool) {
        match self.observe_seq(ssrc, sequence) {
            None => (1, 0, false),
            Some(previous) => {
                let forward = sequence.wrapping_sub(previous);
                if forward == 0 {
                    // Duplicate: no change, and leave `last_seq` as it was.
                    self.last_seq.insert(ssrc, previous);
                    (0, 0, false)
                } else if forward <= MAX_SEQ_GAP {
                    // In-order (the keyframe arrived before its follower): its slot
                    // is consumed here, so the follower sees no gap. Any preceding
                    // gap is genuine delta loss and still counts.
                    (forward as u64, (forward - 1) as u64, false)
                } else if forward > u16::MAX / 2 {
                    // Late keyframe overtaken by the delta that followed it. Keep
                    // the newer `last_seq` and credit back the phantom loss that
                    // follower scored for this keyframe's slot.
                    self.last_seq.insert(ssrc, previous);
                    (0, 0, true)
                } else {
                    // Large forward jump: discontinuity, not loss.
                    (1, 0, false)
                }
            }
        }
    }

    /// Wrap-aware per-SSRC gap detection. Returns `(expected, lost)` packet
    /// counts to attribute to this arrival.
    fn sequence_delta(&mut self, ssrc: u32, sequence: u16) -> (u64, u64) {
        match self.observe_seq(ssrc, sequence) {
            None => (1, 0),
            Some(previous) => {
                let forward = sequence.wrapping_sub(previous);
                if forward == 0 {
                    // Duplicate: contributes nothing and must not advance state
                    // beyond what `insert` already did (idempotent here).
                    (0, 0)
                } else if forward <= MAX_SEQ_GAP {
                    // In-order or a plausible loss burst: `forward - 1` gaps.
                    (forward as u64, (forward - 1) as u64)
                } else if forward > u16::MAX / 2 {
                    // Reordered / late packet (seq is behind the last seen).
                    // Do not advance `last_seq` and do not attribute loss.
                    self.last_seq.insert(ssrc, previous);
                    (0, 0)
                } else {
                    // Large forward jump: treat as a discontinuity, not loss.
                    (1, 0)
                }
            }
        }
    }

    /// Summarise the current window: `(goodput_kbps, loss_ratio, has_data)`.
    fn window_stats(&mut self, current_epoch: u64) -> (u32, f64, bool) {
        self.prune(current_epoch);
        let Some(front) = self.buckets.front() else {
            return (0, 0.0, false);
        };
        let oldest_epoch = front.epoch;
        let mut bytes = 0u64;
        let mut expected = 0u64;
        let mut lost = 0u64;
        for bucket in &self.buckets {
            bytes += bucket.bytes;
            expected += bucket.expected;
            lost += bucket.lost;
        }
        if bytes == 0 {
            return (0, 0.0, false);
        }
        // `saturating_sub`: a concurrent `record_ingress` on the forwarding task
        // can insert a bucket whose epoch is later than the `current_epoch`
        // captured before the lock, so `oldest_epoch` may exceed it. Guard the
        // span against underflow rather than panicking (debug) / wrapping (release).
        let span_buckets = (current_epoch.saturating_sub(oldest_epoch) + 1).clamp(1, NUM_BUCKETS);
        let span_ms = span_buckets * BUCKET_MS;
        // kbps = bytes * 8 bits / (span_ms / 1000) s / 1000 = bytes * 8 / span_ms.
        let goodput_kbps = (bytes.saturating_mul(8) / span_ms).min(u64::from(u32::MAX)) as u32;
        let loss = if expected > 0 {
            lost as f64 / expected as f64
        } else {
            0.0
        };
        (goodput_kbps, loss, true)
    }
}

impl BandwidthEstimator {
    pub fn new() -> Self {
        Self {
            publishers: DashMap::new(),
            base: Instant::now(),
        }
    }

    fn epoch(&self, now: Instant) -> u64 {
        (now.saturating_duration_since(self.base).as_millis() as u64) / BUCKET_MS
    }

    /// Record one accepted ingress datagram from `user_id` at the current instant.
    pub fn record_ingress(&self, user_id: i64, ssrc: u32, sequence: u16, bytes: u32) {
        self.record_ingress_at(user_id, ssrc, sequence, bytes, Instant::now());
    }

    /// Record one accepted ingress datagram from `user_id` at time `now`.
    pub fn record_ingress_at(
        &self,
        user_id: i64,
        ssrc: u32,
        sequence: u16,
        bytes: u32,
        now: Instant,
    ) {
        let epoch = self.epoch(now);
        self.publishers
            .entry(user_id)
            .or_insert_with(PublisherIngress::new)
            .record(epoch, ssrc, sequence, u64::from(bytes));
    }

    /// Record one whole keyframe from `user_id` (uni-stream path) at the current
    /// instant. Counts bytes for goodput but keeps the reliably-delivered
    /// keyframe from biasing the per-SSRC loss estimate (see
    /// [`PublisherIngress::record_keyframe`]).
    pub fn record_ingress_keyframe(&self, user_id: i64, ssrc: u32, sequence: u16, bytes: u32) {
        self.record_ingress_keyframe_at(user_id, ssrc, sequence, bytes, Instant::now());
    }

    /// Record one whole keyframe from `user_id` at time `now`.
    pub fn record_ingress_keyframe_at(
        &self,
        user_id: i64,
        ssrc: u32,
        sequence: u16,
        bytes: u32,
        now: Instant,
    ) {
        let epoch = self.epoch(now);
        self.publishers
            .entry(user_id)
            .or_insert_with(PublisherIngress::new)
            .record_keyframe(epoch, ssrc, sequence, u64::from(bytes));
    }

    /// Compute the AIMD uplink feedback for `user_id` at the current instant.
    pub fn compute_feedback(&self, user_id: i64) -> u32 {
        self.compute_feedback_at(user_id, Instant::now())
    }

    /// Compute the AIMD uplink feedback for `user_id` at time `now`.
    ///
    /// Policy: loss > 2% multiplicatively decreases to `0.85 * goodput`; loss <
    /// 0.5% probes upward to `max(goodput, last) * 1.1`; in between holds the
    /// last feedback. The result is clamped to `[MIN, MAX]` kbps. Before any
    /// ingress is seen the feedback holds the pre-measurement default.
    pub fn compute_feedback_at(&self, user_id: i64, now: Instant) -> u32 {
        let current_epoch = self.epoch(now);
        let mut entry = self
            .publishers
            .entry(user_id)
            .or_insert_with(PublisherIngress::new);
        let (goodput, loss, has_data) = entry.window_stats(current_epoch);
        let last = if entry.last_feedback_kbps == 0 {
            INITIAL_BANDWIDTH_KBPS
        } else {
            entry.last_feedback_kbps
        };

        let feedback = if !has_data {
            last as f64
        } else if loss > LOSS_HIGH {
            AIMD_DOWN * goodput as f64
        } else if loss < LOSS_LOW {
            (goodput.max(last) as f64) * AIMD_UP
        } else {
            last as f64
        };

        let feedback = (feedback as u32).clamp(MIN_BANDWIDTH_KBPS, MAX_BANDWIDTH_KBPS);
        entry.last_feedback_kbps = feedback;
        feedback
    }

    /// Seed a pre-measurement default for a freshly connected publisher.
    ///
    /// Retained for the standalone media-dev server. The real estimate comes
    /// from [`Self::record_ingress`]; this only ensures a publisher has a
    /// sensible default before any ingress has been measured.
    pub fn update_from_connection(&self, user_id: i64, _conn: &quinn::Connection) {
        self.publishers
            .entry(user_id)
            .or_insert_with(PublisherIngress::new);
    }

    /// Remove estimate for a disconnected user.
    pub fn remove_user(&self, user_id: i64) {
        self.publishers.remove(&user_id);
    }

    /// Distinct SSRCs still tracked for one publisher's loss estimate. Bounded
    /// by [`MAX_TRACKED_SSRCS_PER_PUBLISHER`]; read by the availability
    /// regression tests to assert that bound holds under SSRC rotation.
    #[cfg(test)]
    pub(crate) fn tracked_ssrc_count(&self, user_id: i64) -> usize {
        self.publishers
            .get(&user_id)
            .map(|entry| entry.last_seq.len())
            .unwrap_or(0)
    }

    /// Windowed ingress loss ratio for one publisher. Test hook: the SSRC bound
    /// must not silently stop a real ladder's gaps from being scored as loss.
    #[cfg(test)]
    pub(crate) fn windowed_ingress_loss_at(&self, user_id: i64, now: Instant) -> f64 {
        let epoch = self.epoch(now);
        self.publishers
            .get_mut(&user_id)
            .map(|mut entry| entry.window_stats(epoch).1)
            .unwrap_or(0.0)
    }

    /// Get the last feedback bitrate in kbps for a user, or the default.
    pub fn available_kbps(&self, user_id: i64) -> u32 {
        self.publishers
            .get(&user_id)
            .map(|e| {
                if e.last_feedback_kbps == 0 {
                    INITIAL_BANDWIDTH_KBPS
                } else {
                    e.last_feedback_kbps
                }
            })
            .unwrap_or(INITIAL_BANDWIDTH_KBPS)
    }
}

impl Default for BandwidthEstimator {
    fn default() -> Self {
        Self::new()
    }
}

// ── Per-viewer downlink (relay→viewer egress) estimator (spec §4.2) ──────────

/// Absolute floor for a downlink egress estimate, in kbps.
const DOWNLINK_MIN_KBPS: u32 = 200;

/// Absolute ceiling for a downlink egress estimate, in kbps (100 Mbps).
const DOWNLINK_MAX_KBPS: u32 = 100_000;

/// Pre-measurement default egress estimate used before any QUIC sample is seen
/// for a viewer.
const DOWNLINK_INITIAL_KBPS: u32 = 2500;

/// One loss-window bucket for the downlink estimator: per-sample deltas of the
/// QUIC sent/lost packet counters, bucketed so windowed loss never degrades
/// into a lifetime ratio.
#[derive(Clone, Copy)]
struct LossBucket {
    epoch: u64,
    sent: u64,
    lost: u64,
}

/// Per-viewer downlink state: the latest cwnd/RTT BDP estimate plus a sliding
/// (~5s) window of loss derived from quinn stats *deltas*.
struct ViewerDownlink {
    /// Last observed cumulative `sent_packets` counter (`None` before the first
    /// sample); windowed loss is computed from consecutive-sample deltas, never
    /// the lifetime counters themselves.
    last_sent_packets: Option<u64>,
    /// Last observed cumulative `lost_packets` counter.
    last_lost_packets: Option<u64>,
    /// Ring of recent per-sample loss deltas, oldest at the front, bounded to
    /// the 5s window.
    buckets: VecDeque<LossBucket>,
    /// Latest BDP-derived egress estimate (kbps); 0 until the first sample.
    estimate_kbps: u32,
}

impl ViewerDownlink {
    fn new() -> Self {
        Self {
            last_sent_packets: None,
            last_lost_packets: None,
            buckets: VecDeque::new(),
            estimate_kbps: 0,
        }
    }

    fn prune(&mut self, current_epoch: u64) {
        while let Some(front) = self.buckets.front() {
            if front.epoch + NUM_BUCKETS <= current_epoch {
                self.buckets.pop_front();
            } else {
                break;
            }
        }
    }

    /// Windowed loss ratio over the sliding window, or 0 when no sends observed.
    fn windowed_loss(&mut self, current_epoch: u64) -> f64 {
        self.prune(current_epoch);
        let mut sent = 0u64;
        let mut lost = 0u64;
        for bucket in &self.buckets {
            sent += bucket.sent;
            lost += bucket.lost;
        }
        if sent == 0 {
            0.0
        } else {
            (lost as f64 / sent as f64).clamp(0.0, 1.0)
        }
    }
}

/// Relay→viewer downlink bandwidth estimation (spec §4.2).
///
/// This resurrects the pre-overhaul cwnd/RTT BDP estimator for its *correct*
/// direction — the relay's send-side path toward each viewer — where it drives
/// per-viewer simulcast layer selection. It is deliberately separate from
/// [`BandwidthEstimator`], which measures publisher *ingress* (uplink feedback):
/// the direction inversion that made the old estimator wrong for uplink is
/// exactly what makes it right here.
///
/// Each sample reads the connection's congestion window and smoothed RTT
/// (`cwnd * 8 / rtt` ⇒ the classic bandwidth-delay-product rate) and folds the
/// deltas of the QUIC `sent_packets` / `lost_packets` counters into a 5s sliding
/// loss window (never lifetime totals).
pub struct DownlinkEstimator {
    viewers: DashMap<i64, ViewerDownlink>,
    base: Instant,
}

impl DownlinkEstimator {
    pub fn new() -> Self {
        Self {
            viewers: DashMap::new(),
            base: Instant::now(),
        }
    }

    fn epoch(&self, now: Instant) -> u64 {
        (now.saturating_duration_since(self.base).as_millis() as u64) / BUCKET_MS
    }

    /// Compute the BDP-derived egress rate (kbps) from a congestion window in
    /// bytes and a smoothed RTT. `kbps = cwnd_bytes * 8 / rtt_seconds / 1000`.
    fn bdp_kbps(cwnd_bytes: u64, rtt: Duration) -> u32 {
        // Sub-millisecond LAN RTTs floor at 1µs so the BDP does not divide by
        // zero; the result is clamped to the ceiling anyway.
        let rtt_us = rtt.as_micros().max(1);
        // bits/s = bytes*8 / (rtt_us/1e6); kbps = bits/s / 1000 = bytes*8*1000/rtt_us.
        let kbps = (u128::from(cwnd_bytes) * 8 * 1000) / rtt_us;
        (kbps.min(u128::from(DOWNLINK_MAX_KBPS)) as u32).clamp(DOWNLINK_MIN_KBPS, DOWNLINK_MAX_KBPS)
    }

    /// Record one QUIC path-stats sample for a viewer at the current instant.
    pub fn record_from_connection(&self, user_id: i64, conn: &quinn::Connection) {
        let path = conn.stats().path;
        self.record_sample_at(
            user_id,
            path.cwnd,
            path.rtt,
            path.sent_packets,
            path.lost_packets,
            Instant::now(),
        );
    }

    /// Record one path-stats sample for a viewer at time `now`. Split out from
    /// [`Self::record_from_connection`] so the BDP math and loss windowing are
    /// unit-testable without a live QUIC connection.
    pub fn record_sample_at(
        &self,
        user_id: i64,
        cwnd_bytes: u64,
        rtt: Duration,
        sent_packets: u64,
        lost_packets: u64,
        now: Instant,
    ) {
        let epoch = self.epoch(now);
        let mut entry = self
            .viewers
            .entry(user_id)
            .or_insert_with(ViewerDownlink::new);
        entry.estimate_kbps = Self::bdp_kbps(cwnd_bytes, rtt);

        // Windowed loss from counter deltas — never the lifetime counters. The
        // first sample only seeds the baselines (no delta to attribute yet).
        if let (Some(prev_sent), Some(prev_lost)) =
            (entry.last_sent_packets, entry.last_lost_packets)
        {
            let sent_delta = sent_packets.saturating_sub(prev_sent);
            let lost_delta = lost_packets.saturating_sub(prev_lost);
            if sent_delta > 0 || lost_delta > 0 {
                entry.prune(epoch);
                match entry.buckets.back_mut() {
                    Some(back) if back.epoch == epoch => {
                        back.sent += sent_delta;
                        back.lost += lost_delta;
                    }
                    _ => entry.buckets.push_back(LossBucket {
                        epoch,
                        sent: sent_delta,
                        lost: lost_delta,
                    }),
                }
            }
        }
        entry.last_sent_packets = Some(sent_packets);
        entry.last_lost_packets = Some(lost_packets);
    }

    /// Latest egress estimate (kbps) for a viewer, or the pre-measurement default.
    pub fn estimate_kbps(&self, user_id: i64) -> u32 {
        self.viewers
            .get(&user_id)
            .map(|e| {
                if e.estimate_kbps == 0 {
                    DOWNLINK_INITIAL_KBPS
                } else {
                    e.estimate_kbps
                }
            })
            .unwrap_or(DOWNLINK_INITIAL_KBPS)
    }

    /// Whether at least one QUIC sample has been folded in for this viewer.
    /// Layer selection defers until a real sample exists so a fresh viewer is
    /// not downswitched off the pre-measurement default.
    pub fn is_sampled(&self, user_id: i64) -> bool {
        self.viewers
            .get(&user_id)
            .is_some_and(|e| e.estimate_kbps > 0)
    }

    /// Windowed (~5s) downlink loss ratio for a viewer at the current instant.
    pub fn windowed_loss(&self, user_id: i64) -> f64 {
        self.windowed_loss_at(user_id, Instant::now())
    }

    /// Windowed downlink loss ratio for a viewer at time `now`.
    pub fn windowed_loss_at(&self, user_id: i64, now: Instant) -> f64 {
        let current_epoch = self.epoch(now);
        self.viewers
            .get_mut(&user_id)
            .map(|mut e| e.windowed_loss(current_epoch))
            .unwrap_or(0.0)
    }

    /// Drop a disconnected viewer's downlink state.
    pub fn remove_user(&self, user_id: i64) {
        self.viewers.remove(&user_id);
    }
}

impl Default for DownlinkEstimator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `count` packets of `bytes` each, one per SSRC-consecutive sequence,
    /// all landing at time `at`.
    fn feed_lossless(
        est: &BandwidthEstimator,
        user: i64,
        ssrc: u32,
        count: u32,
        bytes: u32,
        at: Instant,
    ) {
        for i in 0..count {
            est.record_ingress_at(user, ssrc, i as u16, bytes, at);
        }
    }

    #[test]
    fn default_before_any_ingress() {
        let est = BandwidthEstimator::new();
        assert_eq!(est.available_kbps(999), INITIAL_BANDWIDTH_KBPS);
        // With no data the feedback holds the pre-measurement default.
        let now = Instant::now();
        assert_eq!(est.compute_feedback_at(42, now), INITIAL_BANDWIDTH_KBPS);
    }

    #[test]
    fn goodput_is_measured_from_ingress() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        // 1000 packets of 1200 bytes over one 100ms bucket = 1.2MB in 0.1s.
        // Spread them so the window span is ~1s: 100 packets per 100ms bucket
        // across 10 buckets.
        let mut seq = 0u16;
        for b in 0..10u64 {
            let at = start + Duration::from_millis(b * BUCKET_MS + 1);
            for _ in 0..100 {
                est.record_ingress_at(1, 7, seq, 1200, at);
                seq = seq.wrapping_add(1);
            }
        }
        let now = start + Duration::from_millis(10 * BUCKET_MS + 1);
        let (goodput, loss, has_data) = est
            .publishers
            .get_mut(&1)
            .unwrap()
            .window_stats(est.epoch(now));
        assert!(has_data);
        assert!(loss < LOSS_LOW, "no gaps means ~0 loss, got {loss}");
        // 1000 * 1200 * 8 = 9.6Mbit over ~1s ≈ 9600 kbps.
        assert!(goodput > 8000 && goodput < 12000, "goodput was {goodput}");
    }

    #[test]
    fn low_loss_probes_upward() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        // Fill the window with a steady, lossless ~5 Mbps stream.
        let mut seq = 0u16;
        for b in 0..(NUM_BUCKETS) {
            let at = start + Duration::from_millis(b * BUCKET_MS + 1);
            for _ in 0..52 {
                est.record_ingress_at(1, 7, seq, 1200, at);
                seq = seq.wrapping_add(1);
            }
        }
        let now = start + Duration::from_millis(NUM_BUCKETS * BUCKET_MS + 1);
        let first = est.compute_feedback_at(1, now);
        // Probing up multiplies max(goodput, last) by 1.1, so feedback exceeds
        // the raw goodput and never falls below the default it probes from.
        assert!(first >= INITIAL_BANDWIDTH_KBPS);
        assert!(first <= MAX_BANDWIDTH_KBPS);
    }

    #[test]
    fn high_loss_backs_off() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        // Inject a stream with large sequence gaps (heavy loss) across the window.
        let mut seq = 0u16;
        for b in 0..NUM_BUCKETS {
            let at = start + Duration::from_millis(b * BUCKET_MS + 1);
            for _ in 0..40 {
                est.record_ingress_at(1, 7, seq, 1200, at);
                // Skip 4 sequence numbers per packet => ~80% loss.
                seq = seq.wrapping_add(5);
            }
        }
        let now = start + Duration::from_millis(NUM_BUCKETS * BUCKET_MS + 1);
        let (goodput, loss, _) = {
            let mut e = est.publishers.get_mut(&1).unwrap();
            e.window_stats(est.epoch(now))
        };
        assert!(loss > LOSS_HIGH, "expected heavy loss, got {loss}");
        let feedback = est.compute_feedback_at(1, now);
        // Backing off yields 0.85 * goodput (clamped to the floor).
        let expected =
            ((AIMD_DOWN * goodput as f64) as u32).clamp(MIN_BANDWIDTH_KBPS, MAX_BANDWIDTH_KBPS);
        assert_eq!(feedback, expected);
    }

    #[test]
    fn feedback_is_clamped() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        // A single huge bucket well above the ceiling.
        for _ in 0..200_000 {
            est.record_ingress_at(1, 7, 0, 1500, start);
        }
        // Sequence 0 repeated is treated as duplicate, so use distinct seqs.
        let mut seq = 0u16;
        for _ in 0..200_000 {
            est.record_ingress_at(2, 9, seq, 1500, start);
            seq = seq.wrapping_add(1);
        }
        let now = start + Duration::from_millis(1);
        let feedback = est.compute_feedback_at(2, now);
        assert!(feedback <= MAX_BANDWIDTH_KBPS);
        assert!(feedback >= MIN_BANDWIDTH_KBPS);
    }

    #[test]
    fn window_is_sliding_not_lifetime() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        // Burst at t=0.
        feed_lossless(&est, 1, 7, 500, 1200, start);
        // Then a long silence: measure well beyond the window.
        let later = start + WINDOW + Duration::from_secs(2);
        let (_g, _l, has_data) = {
            let mut e = est.publishers.get_mut(&1).unwrap();
            e.window_stats(est.epoch(later))
        };
        // The old burst has slid out of the window entirely.
        assert!(
            !has_data,
            "stale burst must not persist in a sliding window"
        );
    }

    #[test]
    fn reordered_packets_do_not_count_as_loss() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        est.record_ingress_at(1, 7, 10, 1200, start);
        est.record_ingress_at(1, 7, 11, 1200, start);
        // A late/reordered packet with a lower sequence must not inflate loss.
        est.record_ingress_at(1, 7, 9, 1200, start);
        est.record_ingress_at(1, 7, 12, 1200, start);
        let (_g, loss, has_data) = {
            let mut e = est.publishers.get_mut(&1).unwrap();
            e.window_stats(est.epoch(start))
        };
        assert!(has_data);
        assert_eq!(loss, 0.0, "in-order arrivals with one reorder are lossless");
    }

    #[test]
    fn late_uni_stream_keyframe_does_not_inflate_loss() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        // Contiguous stream: deltas 0,1,2 then keyframe slot 3 (uni-stream) is
        // overtaken by delta 4 (recorded first), then delta 5. Without the
        // keyframe-aware path, delta 4 scores slot 3 as one lost packet and the
        // late keyframe never credits it back.
        est.record_ingress_at(1, 7, 0, 1200, start);
        est.record_ingress_at(1, 7, 1, 1200, start);
        est.record_ingress_at(1, 7, 2, 1200, start);
        est.record_ingress_at(1, 7, 4, 1200, start);
        est.record_ingress_keyframe_at(1, 7, 3, 40_000, start);
        est.record_ingress_at(1, 7, 5, 1200, start);
        let (_g, loss, has_data) = {
            let mut e = est.publishers.get_mut(&1).unwrap();
            e.window_stats(est.epoch(start))
        };
        assert!(has_data);
        assert_eq!(
            loss, 0.0,
            "a reliably-delivered keyframe must not be scored as loss, got {loss}"
        );
    }

    #[test]
    fn keyframe_path_still_counts_real_preceding_loss() {
        let est = BandwidthEstimator::new();
        let start = est.base;
        // Deltas 0,1,2 arrive; deltas 3,4 are genuinely lost; an in-order
        // keyframe at slot 5 must still surface those two losses.
        est.record_ingress_at(1, 7, 0, 1200, start);
        est.record_ingress_at(1, 7, 1, 1200, start);
        est.record_ingress_at(1, 7, 2, 1200, start);
        est.record_ingress_keyframe_at(1, 7, 5, 40_000, start);
        let (_g, loss, has_data) = {
            let mut e = est.publishers.get_mut(&1).unwrap();
            e.window_stats(est.epoch(start))
        };
        assert!(has_data);
        // expected 4 (slots 0,1,2 received + forward gap to 5), lost 2 (slots 3,4).
        assert!(
            loss > 0.0,
            "genuine delta loss before a keyframe must count"
        );
    }

    #[test]
    fn remove_user_clears_state() {
        let est = BandwidthEstimator::new();
        est.record_ingress(1, 7, 0, 1200);
        assert!(est.publishers.contains_key(&1));
        est.remove_user(1);
        assert!(!est.publishers.contains_key(&1));
    }

    // ── DownlinkEstimator (spec §4.2) ───────────────────────────────────────

    #[test]
    fn downlink_default_before_any_sample() {
        let est = DownlinkEstimator::new();
        assert_eq!(est.estimate_kbps(42), DOWNLINK_INITIAL_KBPS);
        assert_eq!(est.windowed_loss(42), 0.0);
    }

    #[test]
    fn downlink_bdp_scales_with_cwnd_and_rtt() {
        // BDP = cwnd*8 / rtt. 125 KB cwnd @ 20ms RTT ≈ 50 Mbps.
        let kbps = DownlinkEstimator::bdp_kbps(125_000, Duration::from_millis(20));
        assert!(
            (49_000..=51_000).contains(&kbps),
            "125KB/20ms should be ~50Mbps, got {kbps}"
        );
        // Same window at 2x the RTT halves the estimate.
        let slower = DownlinkEstimator::bdp_kbps(125_000, Duration::from_millis(40));
        assert!(slower < kbps);
        // A tiny window on a slow path floors at the minimum, never zero.
        assert_eq!(
            DownlinkEstimator::bdp_kbps(100, Duration::from_millis(500)),
            DOWNLINK_MIN_KBPS
        );
        // A huge window on a fast path is clamped to the ceiling.
        assert_eq!(
            DownlinkEstimator::bdp_kbps(50_000_000, Duration::from_micros(1)),
            DOWNLINK_MAX_KBPS
        );
    }

    #[test]
    fn downlink_loss_is_windowed_from_deltas_not_lifetime() {
        let est = DownlinkEstimator::new();
        let start = est.base;
        // First sample seeds baselines only (no delta attributed yet).
        est.record_sample_at(1, 100_000, Duration::from_millis(20), 1000, 0, start);
        assert_eq!(est.windowed_loss_at(1, start), 0.0);

        // Over the next second: +1000 sent, +50 lost ⇒ 5% loss in-window.
        let mut sent = 1000u64;
        let mut lost = 0u64;
        for b in 1..=10u64 {
            let at = start + Duration::from_millis(b * BUCKET_MS);
            sent += 100;
            lost += 5;
            est.record_sample_at(1, 100_000, Duration::from_millis(20), sent, lost, at);
        }
        let loss = est.windowed_loss_at(1, start + Duration::from_millis(10 * BUCKET_MS));
        assert!(
            (0.045..=0.055).contains(&loss),
            "expected ~5% loss, got {loss}"
        );

        // After a long lossless stretch the old loss slides fully out of the
        // window (windowed, not lifetime).
        let later = start + WINDOW + Duration::from_secs(3);
        for extra in 0..3u64 {
            let at = later + Duration::from_millis(extra * BUCKET_MS);
            sent += 100;
            est.record_sample_at(1, 100_000, Duration::from_millis(20), sent, lost, at);
        }
        let loss_after = est.windowed_loss_at(1, later + Duration::from_millis(3 * BUCKET_MS));
        assert_eq!(loss_after, 0.0, "stale loss must slide out of the window");
    }

    #[test]
    fn downlink_remove_user_clears_state() {
        let est = DownlinkEstimator::new();
        est.record_sample_at(1, 100_000, Duration::from_millis(20), 10, 0, est.base);
        assert!(est.viewers.contains_key(&1));
        est.remove_user(1);
        assert!(!est.viewers.contains_key(&1));
    }
}
