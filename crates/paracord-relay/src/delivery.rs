//! Whether a viewer's downlink delivers its video frames in time: the signal
//! the relay prices simulcast layers on (stream-fix V5).
//!
//! The relay used the QUIC connection's packet loss (`lost_packets /
//! sent_packets` over 5 s) and stepped a viewer down a layer above 2%. Every
//! native video frame rides a reliable stream (stream-fix V1), so a lost packet
//! is retransmitted and the frame arrives, usually a few milliseconds later;
//! and QUIC's loss count reads high (at 1% real loss it read 2 to 15%: a
//! spurious-loss declaration, a tail probe and a retransmitted retransmission
//! all count). Any loss at all sent viewers to the lowest layer.
//!
//! What costs a viewer frames is a frame that arrives too late to be shown, or
//! never: a frame acknowledged long after it was sent (it waited behind the
//! frames before it, a queue the downlink cannot drain), a frame shed or
//! superseded while still in flight, or a backlog whose oldest frame has waited
//! too long. That is what this measures, per viewer connection, from the
//! relay's own send tasks: each frame's time from hand-off to the viewer's
//! acknowledgement of all of it, against the fastest delivery seen recently.
//! It also measures the rate the viewer actually took frames at, which is the
//! downlink's capacity whenever frames are queuing.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// The window a congestion verdict looks at. The relay re-evaluates layers
/// every 2 s (`BANDWIDTH_SAMPLE_INTERVAL`).
pub(crate) const HEALTH_WINDOW: Duration = Duration::from_secs(2);

/// How far back the fastest delivery (the path's floor: one round trip, the
/// viewer's ack delay and a frame's serialization) is looked for.
const BASELINE_WINDOW: Duration = Duration::from_secs(10);

/// A frame acknowledged this much later than the path's floor arrived too late
/// to keep the picture moving: the viewer's reorder stage holds a frame 120 ms
/// for a missing predecessor before it gives the reference up. A retransmitted
/// packet costs about one round trip, well inside this on any path a layer
/// above the lowest is worth sending over.
pub(crate) const LATE_MARGIN: Duration = Duration::from_millis(200);

/// The share of a window's frames that may be late before the window counts
/// as congested. One or two late frames are a retransmission's tail, not a
/// downlink that cannot carry the layer.
const LATE_SHARE_PERCENT: u32 = 10;

/// Fewer frames than this in a window say nothing about a share of them.
const MIN_FRAMES_FOR_SHARE: u32 = 10;

/// A frame still in flight this long past the path's floor is a backlog: the
/// downlink is not keeping up even if nothing has been acknowledged late yet.
pub(crate) const STUCK_MARGIN: Duration = Duration::from_millis(400);

/// Events kept per viewer connection (a 60 fps viewer of three tracks makes
/// ~1,800 in the baseline window; older ones go first).
const MAX_EVENTS: usize = 4096;

#[derive(Clone, Copy, Debug)]
enum Event {
    /// A frame the viewer acknowledged in full `latency` after hand-off.
    Delivered {
        at: Instant,
        latency: Duration,
        bytes: usize,
    },
    /// Frames dropped while still in flight to the viewer: shed past the
    /// in-flight cap, or superseded by a keyframe after waiting too long.
    Unsent { at: Instant, frames: u32 },
}

impl Event {
    fn at(&self) -> Instant {
        match self {
            Event::Delivered { at, .. } | Event::Unsent { at, .. } => *at,
        }
    }
}

/// One viewer connection's recent frame deliveries.
#[derive(Debug, Default)]
pub(crate) struct FrameDelivery {
    events: VecDeque<Event>,
}

/// The verdict for one viewer connection at one instant.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct DeliveryHealth {
    /// Frames acknowledged in the window.
    pub frames: u32,
    /// Of those, acknowledged later than the floor plus [`LATE_MARGIN`].
    pub late: u32,
    /// Frames dropped in flight in the window.
    pub unsent: u32,
    /// The fastest delivery in the baseline window.
    pub floor: Option<Duration>,
    /// What the viewer took in the window, in kbps (frames acknowledged).
    pub delivered_kbps: Option<u32>,
    /// How long the oldest frame still in flight has waited.
    pub oldest_in_flight: Option<Duration>,
    /// Why the downlink is not carrying its frames in time, or `None`.
    pub congested: Option<String>,
}

impl DeliveryHealth {
    pub fn is_congested(&self) -> bool {
        self.congested.is_some()
    }
}

impl FrameDelivery {
    fn push(&mut self, event: Event) {
        self.events.push_back(event);
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
    }

    fn prune(&mut self, now: Instant) {
        while self
            .events
            .front()
            .is_some_and(|event| now.saturating_duration_since(event.at()) > BASELINE_WINDOW)
        {
            self.events.pop_front();
        }
    }

    /// A frame the viewer acknowledged in full, `latency` after the relay
    /// handed it to the connection.
    pub fn record_delivered(&mut self, now: Instant, latency: Duration, bytes: usize) {
        self.prune(now);
        self.push(Event::Delivered {
            at: now,
            latency,
            bytes,
        });
    }

    /// Frames dropped while in flight (shed past the cap, or superseded by a
    /// keyframe after waiting longer than [`LATE_MARGIN`]).
    pub fn record_unsent(&mut self, now: Instant, frames: u32) {
        if frames == 0 {
            return;
        }
        self.prune(now);
        self.push(Event::Unsent { at: now, frames });
    }

    /// Judge the last [`HEALTH_WINDOW`]. `oldest_in_flight` is the age of the
    /// oldest frame the connection is still sending, when known.
    pub fn health(&mut self, now: Instant, oldest_in_flight: Option<Duration>) -> DeliveryHealth {
        self.prune(now);
        let floor = self
            .events
            .iter()
            .filter_map(|event| match event {
                Event::Delivered { latency, .. } => Some(*latency),
                Event::Unsent { .. } => None,
            })
            .min();
        let late_after = floor.map(|floor| floor + LATE_MARGIN);
        let window_start = now.checked_sub(HEALTH_WINDOW);
        let mut frames = 0u32;
        let mut late = 0u32;
        let mut unsent = 0u32;
        let mut bytes = 0u64;
        let mut first: Option<Instant> = None;
        for event in &self.events {
            if window_start.is_some_and(|start| event.at() < start) {
                continue;
            }
            match *event {
                Event::Delivered {
                    at,
                    latency,
                    bytes: size,
                } => {
                    frames += 1;
                    bytes += size as u64;
                    first.get_or_insert(at);
                    if late_after.is_some_and(|limit| latency > limit) {
                        late += 1;
                    }
                }
                Event::Unsent { frames: count, .. } => unsent += count,
            }
        }
        // Over the whole window when it is full, so a burst at its end is not
        // read as a rate; over what was seen when the connection is younger.
        let span = first
            .map(|first| now.saturating_duration_since(first))
            .unwrap_or_default()
            .max(Duration::from_millis(500))
            .min(HEALTH_WINDOW);
        let delivered_kbps =
            (frames > 0).then(|| (bytes.saturating_mul(8) / span.as_millis().max(1) as u64) as u32);

        let congested = if unsent > 0 {
            Some(format!(
                "{unsent} frame(s) dropped in flight in the last {} s (shed or superseded while queued)",
                HEALTH_WINDOW.as_secs()
            ))
        } else if frames >= MIN_FRAMES_FOR_SHARE && late * 100 >= frames * LATE_SHARE_PERCENT {
            Some(format!(
                "{late} of {frames} frames acknowledged more than {} ms after the path's floor ({} ms)",
                LATE_MARGIN.as_millis(),
                floor.unwrap_or_default().as_millis()
            ))
        } else {
            match (oldest_in_flight, floor) {
                (Some(oldest), Some(floor)) if oldest > floor + STUCK_MARGIN => Some(format!(
                    "a frame has been in flight {} ms (path floor {} ms): a backlog",
                    oldest.as_millis(),
                    floor.as_millis()
                )),
                _ => None,
            }
        };
        DeliveryHealth {
            frames,
            late,
            unsent,
            floor,
            delivered_kbps,
            oldest_in_flight,
            congested,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    /// 60 frames a second for `seconds`, each acknowledged `latency(i)` after
    /// it was sent, 40 KB each (~19 Mb/s).
    fn feed(
        delivery: &mut FrameDelivery,
        start: Instant,
        seconds: u64,
        latency: impl Fn(u64) -> Duration,
    ) -> Instant {
        let frames = seconds * 60;
        let mut now = start;
        for i in 0..frames {
            now = start + Duration::from_micros(i * 16_667);
            delivery.record_delivered(now, latency(i), 40_000);
        }
        now
    }

    #[test]
    fn retransmissions_on_a_lossy_path_are_not_congestion() {
        // 5% of frames wait one retransmission (+40 ms) over a 20 ms floor.
        let mut delivery = FrameDelivery::default();
        let now = feed(&mut delivery, Instant::now(), 6, |i| {
            if i % 20 == 0 {
                60 * MS
            } else {
                20 * MS
            }
        });
        let health = delivery.health(now, Some(30 * MS));
        assert_eq!(health.late, 0);
        assert!(!health.is_congested(), "{health:?}");
        let kbps = health.delivered_kbps.unwrap();
        assert!((18_000..=20_000).contains(&kbps), "{kbps}");
    }

    #[test]
    fn a_tail_of_late_frames_is_tolerated() {
        // A few frames a second hit a probe timeout (+250 ms): 5%, under 10%.
        let mut delivery = FrameDelivery::default();
        let now = feed(&mut delivery, Instant::now(), 6, |i| {
            if i % 20 == 0 {
                270 * MS
            } else {
                20 * MS
            }
        });
        let health = delivery.health(now, None);
        assert!(health.late > 0);
        assert!(!health.is_congested(), "{health:?}");
    }

    #[test]
    fn a_queue_the_downlink_cannot_drain_is_congestion() {
        // Latency climbs 5 ms per frame: the downlink carries less than is sent.
        let mut delivery = FrameDelivery::default();
        let now = feed(&mut delivery, Instant::now(), 4, |i| {
            if i < 120 {
                20 * MS
            } else {
                MS * (20 + (i - 120) as u32 * 5)
            }
        });
        let health = delivery.health(now, None);
        assert!(health.is_congested(), "{health:?}");
        assert!(health.late > health.frames / 2);
    }

    #[test]
    fn frames_dropped_in_flight_are_congestion() {
        let mut delivery = FrameDelivery::default();
        let now = feed(&mut delivery, Instant::now(), 3, |_| 20 * MS);
        delivery.record_unsent(now, 1);
        assert!(delivery.health(now, None).is_congested());
        // Out of the window, forgotten.
        assert!(!delivery
            .health(now + HEALTH_WINDOW + MS, None)
            .is_congested());
    }

    #[test]
    fn a_stuck_frame_is_congestion_before_any_ack_is_late() {
        let mut delivery = FrameDelivery::default();
        let now = feed(&mut delivery, Instant::now(), 3, |_| 20 * MS);
        assert!(!delivery.health(now, Some(300 * MS)).is_congested());
        assert!(delivery.health(now, Some(500 * MS)).is_congested());
    }

    #[test]
    fn a_quiet_window_says_nothing() {
        let mut delivery = FrameDelivery::default();
        let health = delivery.health(Instant::now(), None);
        assert_eq!(health, DeliveryHealth::default());
        assert!(!health.is_congested());
    }

    #[test]
    fn memory_is_bounded() {
        let mut delivery = FrameDelivery::default();
        let start = Instant::now();
        for i in 0..20_000u64 {
            delivery.record_delivered(start + Duration::from_micros(i * 100), 20 * MS, 1);
        }
        assert!(delivery.events.len() <= MAX_EVENTS);
    }
}
