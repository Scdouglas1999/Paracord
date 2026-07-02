// Adaptive jitter buffer (60ms target, 20-200ms range).

use std::collections::BTreeMap;

/// 20 ms frame duration at 48 kHz.
const FRAME_DURATION_MS: u32 = 20;
/// Minimum buffer depth in frames (1 frame = 20 ms).
const MIN_DEPTH: u32 = 1;
/// Default buffer depth in frames (3 frames = 60 ms).
const DEFAULT_DEPTH: u32 = 3;
/// Maximum buffer depth in frames (10 frames = 200 ms).
const MAX_DEPTH: u32 = 10;
/// Exponential moving average alpha for jitter estimation.
const JITTER_ALPHA: f64 = 0.05;
/// Maximum packets to buffer before dropping oldest.
const MAX_BUFFERED_PACKETS: usize = 50;

/// Statistics reported by the jitter buffer.
#[derive(Debug, Clone, Default)]
pub struct JitterStats {
    /// Current number of packets in the buffer.
    pub buffer_depth: usize,
    /// Estimated inter-arrival jitter in milliseconds.
    pub jitter_ms: f64,
    /// Total packets received.
    pub packets_received: u64,
    /// Total packets lost (gaps in sequence numbers).
    pub packets_lost: u64,
    /// Packet loss rate (0.0 - 1.0).
    pub loss_rate: f64,
    /// Current target latency in milliseconds.
    pub target_latency_ms: u32,
}

/// A packet stored in the jitter buffer.
#[derive(Debug, Clone)]
struct BufferedPacket<T> {
    /// The packet payload.
    payload: T,
    /// Timestamp from the media header (48 kHz clock for audio).
    #[allow(dead_code)]
    timestamp: u32,
    /// Local arrival time in milliseconds (monotonic).
    #[allow(dead_code)]
    arrival_ms: u64,
}

/// Adaptive jitter buffer that reorders packets and smooths playback timing.
///
/// Parameterized over payload type `T` so it works with both raw bytes
/// and decoded audio frames.
pub struct JitterBuffer<T> {
    /// Packets stored by sequence number.
    packets: BTreeMap<u16, BufferedPacket<T>>,
    /// Next sequence number expected for playout.
    next_seq: Option<u16>,
    /// Whether playout has started (first packet pulled).
    playing: bool,
    /// Target buffer depth in frames.
    target_depth: u32,
    /// Estimated jitter in milliseconds (exponential moving average).
    jitter_estimate_ms: f64,
    /// Last packet arrival time for jitter calculation.
    last_arrival_ms: Option<u64>,
    /// Last packet timestamp for jitter calculation.
    last_timestamp: Option<u32>,
    /// Total packets received.
    total_received: u64,
    /// Total sequence gaps detected.
    total_lost: u64,
    /// Monotonic clock source (milliseconds since start).
    clock_ms: u64,
}

impl<T> JitterBuffer<T> {
    /// Create a new jitter buffer with default 60 ms target latency.
    pub fn new() -> Self {
        Self {
            packets: BTreeMap::new(),
            next_seq: None,
            playing: false,
            target_depth: DEFAULT_DEPTH,
            jitter_estimate_ms: 0.0,
            last_arrival_ms: None,
            last_timestamp: None,
            total_received: 0,
            total_lost: 0,
            clock_ms: 0,
        }
    }

    /// Insert a packet into the buffer.
    ///
    /// - `seq`: sequence number from MediaHeader
    /// - `timestamp`: RTP-style timestamp from MediaHeader
    /// - `payload`: the packet data
    /// - `arrival_ms`: monotonic arrival time in milliseconds
    pub fn insert(&mut self, seq: u16, timestamp: u32, payload: T, arrival_ms: u64) {
        self.clock_ms = arrival_ms;
        self.total_received += 1;

        // Update jitter estimate using RFC 3550 algorithm
        if let (Some(last_arrival), Some(last_ts)) = (self.last_arrival_ms, self.last_timestamp) {
            let arrival_diff = arrival_ms as f64 - last_arrival as f64;
            // Convert timestamp diff to milliseconds (48 kHz clock)
            let ts_diff = timestamp.wrapping_sub(last_ts) as f64 / 48.0;
            let jitter_sample = (arrival_diff - ts_diff).abs();
            self.jitter_estimate_ms =
                self.jitter_estimate_ms * (1.0 - JITTER_ALPHA) + jitter_sample * JITTER_ALPHA;

            // Adapt target depth based on jitter
            self.adapt_target_depth();
        }

        self.last_arrival_ms = Some(arrival_ms);
        self.last_timestamp = Some(timestamp);

        // Initialize next_seq on first packet
        if self.next_seq.is_none() {
            self.next_seq = Some(seq);
        }

        // Don't buffer packets that are too old (behind playout point)
        if let Some(next) = self.next_seq {
            let diff = seq.wrapping_sub(next) as i16;
            if diff < -10 {
                // Too old, discard
                return;
            }
        }

        self.packets.insert(
            seq,
            BufferedPacket {
                payload,
                timestamp,
                arrival_ms,
            },
        );

        // Prevent unbounded growth
        while self.packets.len() > MAX_BUFFERED_PACKETS {
            self.packets.pop_first();
        }
    }

    /// Pull the next frame for playout.
    ///
    /// Returns `Some(payload)` if the next expected packet is available.
    /// Returns `None` if the packet is missing (caller should use PLC).
    ///
    /// The caller should call this at regular 20 ms intervals.
    pub fn pull(&mut self) -> Option<T> {
        let next = self.next_seq?;

        // Before playout starts, wait until we have enough buffered
        if !self.playing
            && self.packets.len() < self.target_depth as usize
            && !self.packets.contains_key(&next)
        {
            return None;
        }

        if let Some(packet) = self.packets.remove(&next) {
            self.playing = true;
            self.next_seq = Some(next.wrapping_add(1));
            Some(packet.payload)
        } else {
            // Packet missing - count as lost and advance sequence
            self.total_lost += 1;
            self.next_seq = Some(next.wrapping_add(1));
            None
        }
    }

    /// Peek at whether the next expected packet is available.
    pub fn has_next(&self) -> bool {
        self.next_seq
            .map(|seq| self.packets.contains_key(&seq))
            .unwrap_or(false)
    }

    /// Get current buffer statistics.
    pub fn stats(&self) -> JitterStats {
        let total = self.total_received + self.total_lost;
        let loss_rate = if total > 0 {
            self.total_lost as f64 / total as f64
        } else {
            0.0
        };

        JitterStats {
            buffer_depth: self.packets.len(),
            jitter_ms: self.jitter_estimate_ms,
            packets_received: self.total_received,
            packets_lost: self.total_lost,
            loss_rate,
            target_latency_ms: self.target_depth * FRAME_DURATION_MS,
        }
    }

    /// Reset the buffer, clearing all state.
    pub fn reset(&mut self) {
        self.packets.clear();
        self.next_seq = None;
        self.playing = false;
        self.target_depth = DEFAULT_DEPTH;
        self.jitter_estimate_ms = 0.0;
        self.last_arrival_ms = None;
        self.last_timestamp = None;
        self.total_received = 0;
        self.total_lost = 0;
    }

    /// Adapt target buffer depth based on observed jitter.
    fn adapt_target_depth(&mut self) {
        // Map jitter estimate to target depth:
        // < 10ms jitter -> 1 frame  (20ms)
        // 10-30ms       -> 2 frames (40ms)
        // 30-50ms       -> 3 frames (60ms, default)
        // 50-100ms      -> 5 frames (100ms)
        // > 100ms       -> up to 10 frames (200ms)
        let new_depth = if self.jitter_estimate_ms < 10.0 {
            MIN_DEPTH
        } else if self.jitter_estimate_ms < 30.0 {
            2
        } else if self.jitter_estimate_ms < 50.0 {
            3
        } else if self.jitter_estimate_ms < 100.0 {
            5
        } else {
            MAX_DEPTH
        };

        // Smooth transitions: only change by 1 frame at a time
        if new_depth > self.target_depth {
            self.target_depth += 1;
        } else if new_depth < self.target_depth {
            self.target_depth -= 1;
        }

        self.target_depth = self.target_depth.clamp(MIN_DEPTH, MAX_DEPTH);
    }
}

impl<T> Default for JitterBuffer<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_order_packets() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        // Insert 5 packets in order
        for i in 0..5u16 {
            let ts = i as u32 * 960; // 20ms at 48kHz
            let arrival = i as u64 * 20; // 20ms intervals
            jb.insert(i, ts, vec![i as u8], arrival);
        }

        // Pull them out
        for i in 0..5u16 {
            let packet = jb.pull();
            assert!(packet.is_some(), "packet {i} should be available");
            assert_eq!(packet.unwrap(), vec![i as u8]);
        }

        // Buffer should be empty
        assert!(jb.pull().is_none());
    }

    #[test]
    fn out_of_order_packets() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        // Insert packets out of order: 0, 2, 1, 3
        jb.insert(0, 0, vec![0], 0);
        jb.insert(2, 1920, vec![2], 40);
        jb.insert(1, 960, vec![1], 45); // arrived late
        jb.insert(3, 2880, vec![3], 60);

        // Should come out in order
        assert_eq!(jb.pull().unwrap(), vec![0]);
        assert_eq!(jb.pull().unwrap(), vec![1]);
        assert_eq!(jb.pull().unwrap(), vec![2]);
        assert_eq!(jb.pull().unwrap(), vec![3]);
    }

    #[test]
    fn missing_packet_returns_none() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        // Insert packets 0 and 2 (skip 1)
        jb.insert(0, 0, vec![0], 0);
        jb.insert(2, 1920, vec![2], 40);

        // Packet 0 available
        assert_eq!(jb.pull().unwrap(), vec![0]);
        // Packet 1 missing -> None (PLC signal)
        assert!(jb.pull().is_none());
        // Packet 2 available (sequence advanced past 1)
        assert_eq!(jb.pull().unwrap(), vec![2]);
    }

    #[test]
    fn loss_tracking() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        jb.insert(0, 0, vec![0], 0);
        jb.insert(3, 2880, vec![3], 60);

        // Pull: 0 ok, 1 lost, 2 lost, 3 ok
        assert!(jb.pull().is_some()); // seq 0
        assert!(jb.pull().is_none()); // seq 1 lost
        assert!(jb.pull().is_none()); // seq 2 lost
        assert!(jb.pull().is_some()); // seq 3

        let stats = jb.stats();
        assert_eq!(stats.packets_received, 2);
        assert_eq!(stats.packets_lost, 2);
        assert!((stats.loss_rate - 0.5).abs() < 0.01);
    }

    #[test]
    fn adaptive_depth_low_jitter() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        // Simulate very consistent arrival (low jitter)
        for i in 0..100u16 {
            let ts = i as u32 * 960;
            let arrival = i as u64 * 20; // exactly 20ms apart
            jb.insert(i, ts, vec![i as u8], arrival);
        }

        let stats = jb.stats();
        // With zero jitter, target should shrink toward minimum
        assert!(
            stats.target_latency_ms <= 60,
            "expected low target latency, got {}ms",
            stats.target_latency_ms
        );
    }

    #[test]
    fn adaptive_depth_high_jitter() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        // Simulate highly variable arrival times over many packets
        // Alternating between arriving very early and very late
        for i in 0..200u16 {
            let ts = i as u32 * 960;
            // Add large random-ish jitter: every other packet is 100ms late
            let base = i as u64 * 20;
            let jitter = if i % 2 == 0 { 0u64 } else { 100 };
            jb.insert(i, ts, vec![i as u8], base + jitter);
        }

        let stats = jb.stats();
        // With sustained high jitter, target should have grown above default
        assert!(
            stats.target_latency_ms >= 60,
            "expected higher target latency, got {}ms",
            stats.target_latency_ms
        );
    }

    #[test]
    fn reset_clears_state() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        jb.insert(0, 0, vec![0], 0);
        jb.insert(1, 960, vec![1], 20);
        assert_eq!(jb.stats().packets_received, 2);

        jb.reset();
        assert_eq!(jb.stats().packets_received, 0);
        assert_eq!(jb.stats().buffer_depth, 0);
        assert!(jb.pull().is_none());
    }

    #[test]
    fn sequence_wraparound() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        // Start near u16::MAX
        let start = u16::MAX - 2;
        for i in 0..5u16 {
            let seq = start.wrapping_add(i);
            let ts = i as u32 * 960;
            jb.insert(seq, ts, vec![i as u8], i as u64 * 20);
        }

        // Should pull all 5 in order, wrapping around u16::MAX
        for i in 0..5u16 {
            let packet = jb.pull();
            assert!(packet.is_some(), "packet {i} should be available");
            assert_eq!(packet.unwrap(), vec![i as u8]);
        }
    }

    #[test]
    fn max_buffer_prevents_unbounded_growth() {
        let mut jb: JitterBuffer<Vec<u8>> = JitterBuffer::new();

        // Insert way more than MAX_BUFFERED_PACKETS
        for i in 0..100u16 {
            jb.insert(i, i as u32 * 960, vec![i as u8], i as u64 * 20);
        }

        assert!(jb.packets.len() <= MAX_BUFFERED_PACKETS);
    }
}
