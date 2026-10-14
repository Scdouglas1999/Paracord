//! The congestion controller every media connection runs (stream-fix V5, V6).
//!
//! Every native video frame rides a reliable QUIC stream, so how fast a frame
//! may go is the congestion controller's call. Media needs one that keeps its
//! rate through random loss and still yields to other traffic when the path is
//! full:
//!
//! - **Cubic** (quinn's default) cuts its window on every loss. At 1% random
//!   loss and a 30 ms round trip it held a connection near 8 Mb/s whatever the
//!   path carried; a 44 Mb/s share stalled at 4 frames a second.
//! - **BBR** as quinn ships it (`BbrConfig`, a port of quiche's BBRv1) enters
//!   "packet conservation" on any loss and leaves only after a loss-free round
//!   trip; random loss on both directions kept it there and a keyframe could
//!   not get through for seconds.
//! - **BBR with every loss withheld** (V5) kept video moving through random
//!   loss, but it is not a good network citizen: on a 20 Mb/s link with a
//!   100 ms queue (`scripts/stream-audit/cc`), a competing TCP flow got 2.7 Mb/s
//!   of the 20 (stock BBR left it 6.3, Cubic 12.6), and alone it kept the
//!   queue full (+70 ms on every other packet's round trip).
//!
//! [`MediaCongestion`] (V6) tells the two kinds of loss apart by the queue: a
//! drop-tail queue drops a packet when it is full, so a loss that comes with
//! round trips well above the path's floor is congestion, and a loss on a path
//! whose round trips sit at the floor is not.
//!
//! - **The model** is quinn's BBR with loss withheld, as in V5: window = gain ×
//!   bandwidth-delay product from the measured delivery rate, which a random
//!   loss does not lower.
//! - **The cap.** A loss while the smoothed round trip exceeds the floor by more than
//!   [`MediaCongestion::queue_threshold`] cuts a cap on the window to 0.7 of
//!   the window (0.9 when the loss was a single packet), at most once per
//!   round trip, and the cap grows back
//!   as Cubic's window does (RFC 9438: a cubic curve back to the window at the
//!   loss, a TCP-friendly linear floor), only while the window is in use. So a
//!   path that a TCP flow shares is shared the way two Cubic flows share it.
//!   The cap is dropped once it no longer binds.
//! - **Random loss** (round trips at the floor) touches nothing; lost packets
//!   are retransmitted by the connection as always.
//!
//! Every connection with losses logs, at most every 10 s, how many it read as
//! congestion and how many as random, with the queue it saw.
use std::any::Any;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use quinn::congestion::{BbrConfig, Controller, ControllerFactory, ControllerMetrics};

/// Cubic's multiplicative decrease (RFC 9438 §4.6).
const DEFAULT_BETA: f64 = 0.7;
/// The decrease for a loss event of a single packet (see `on_congestion_event`).
const SINGLE_LOSS_BETA: f64 = 0.9;
/// Cubic's scaling constant (RFC 9438 §5.1), in segments per second cubed.
const CUBIC_C: f64 = 0.4;
/// The default queue a loss must come with to read as congestion: the larger
/// of this and a quarter of the path's floor. Jitter on a quiet path stays
/// under it; a drop-tail queue overflowing is far above it (home routers queue
/// 50 to 500 ms).
const DEFAULT_QUEUE_THRESHOLD: Duration = Duration::from_millis(10);
/// How long a raised round trip must hold before it is the path's new floor.
const FLOOR_RAISE_AFTER: Duration = Duration::from_secs(30);
/// How steady (the spread of each second's least round trip) it must be.
const FLOOR_STEADY: Duration = Duration::from_millis(5);
/// How often a connection with losses says how it read them.
const LOG_INTERVAL: Duration = Duration::from_secs(10);

/// Builds a [`MediaController`] per connection.
#[derive(Debug)]
pub struct MediaCongestion {
    bbr: Arc<BbrConfig>,
    queue_threshold: Duration,
    beta: f64,
}

impl Default for MediaCongestion {
    fn default() -> Self {
        Self {
            bbr: Arc::new(BbrConfig::default()),
            queue_threshold: DEFAULT_QUEUE_THRESHOLD,
            beta: DEFAULT_BETA,
        }
    }
}

impl MediaCongestion {
    /// A loss reads as congestion when the round trips around it exceed the
    /// path's floor by more than `max(threshold, floor / 4)`.
    pub fn with_queue_threshold(threshold: Duration) -> Self {
        Self {
            queue_threshold: threshold,
            ..Self::default()
        }
    }

    /// The cap's multiplicative decrease on a congestion loss (Cubic's 0.7 by
    /// default), for the congestion-control lab.
    pub fn with_beta(mut self, beta: f64) -> Self {
        self.beta = beta.clamp(0.5, 0.95);
        self
    }

    /// The minimum queue (above the round-trip floor) that makes a loss
    /// congestion.
    pub fn queue_threshold(&self) -> Duration {
        self.queue_threshold
    }
}

impl ControllerFactory for MediaCongestion {
    fn build(self: Arc<Self>, now: Instant, current_mtu: u16) -> Box<dyn Controller> {
        Box::new(MediaController::new(
            Arc::clone(&self.bbr).build(now, current_mtu),
            self.queue_threshold,
            self.beta,
            now,
            current_mtu,
        ))
    }
}

/// The congestion cap: Cubic's window, driven only by losses read as congestion.
#[derive(Clone, Debug)]
struct Cap {
    /// The cap, in bytes.
    window: f64,
    /// The window at the last congestion loss, in segments.
    w_max: f64,
    /// Seconds from the cut until the cubic curve is back at `w_max`.
    k: f64,
    /// When the curve started (moved forward while the window is not in use).
    epoch: Instant,
    /// The last time the curve was advanced.
    updated: Instant,
}

#[derive(Clone, Debug, Default)]
struct LossTally {
    congestion: u64,
    random: u64,
    cuts: u64,
    max_queue: Duration,
}

/// quinn's BBR (told about acknowledgements, not losses) under a cap that only
/// losses with a queue behind them move. See the module docs.
struct MediaController {
    bbr: Box<dyn Controller>,
    queue_threshold: Duration,
    beta: f64,
    mtu: u64,
    /// The path's round-trip floor: quinn's minimum over the connection, or a
    /// raised one ([`MediaController::track_floor`]).
    floor: Duration,
    connection_floor: Duration,
    raised_floor: Option<Duration>,
    /// (second start, the least round trip in that second), oldest first.
    second_mins: VecDeque<(Instant, Duration)>,
    smoothed: Duration,
    app_limited: bool,
    cap: Option<Cap>,
    /// When the cap was last cut: losses of packets sent before it belong to
    /// that cut.
    last_cut: Option<Instant>,
    tally: LossTally,
    last_log: Instant,
}

impl MediaController {
    fn new(
        bbr: Box<dyn Controller>,
        queue_threshold: Duration,
        beta: f64,
        now: Instant,
        mtu: u16,
    ) -> Self {
        Self {
            bbr,
            queue_threshold,
            beta,
            mtu: u64::from(mtu),
            floor: Duration::ZERO,
            connection_floor: Duration::ZERO,
            raised_floor: None,
            second_mins: VecDeque::new(),
            smoothed: Duration::ZERO,
            app_limited: false,
            cap: None,
            last_cut: None,
            tally: LossTally::default(),
            last_log: now,
        }
    }

    fn min_window(&self) -> u64 {
        4 * self.mtu
    }

    /// The queue: the smoothed round trip (quinn's, with the peer's
    /// acknowledgement delay taken out) above the floor. A full drop-tail
    /// queue delays every packet and moves it within a few round trips; a
    /// delayed or lost acknowledgement (random loss on the return path)
    /// inflates one raw sample, which a first version read as a queue: it cut
    /// on every loss at 5% and the window collapsed.
    fn recent_queue(&self) -> Duration {
        self.smoothed.saturating_sub(self.floor)
    }

    fn threshold(&self) -> Duration {
        self.queue_threshold.max(self.floor / 4)
    }

    fn cut(&mut self, now: Instant, beta: f64) {
        let current = self.window();
        let base = current as f64;
        let segments = base / self.mtu as f64;
        let w_max = match &self.cap {
            // Fast convergence (RFC 9438 §4.7): a flow that lost below its last
            // peak releases more.
            Some(cap) if segments < cap.w_max => segments * (1.0 + beta) / 2.0,
            _ => segments,
        };
        let window = (base * beta).max(self.min_window() as f64);
        let k = ((w_max - window / self.mtu as f64).max(0.0) / CUBIC_C).cbrt();
        self.cap = Some(Cap {
            window,
            w_max,
            k,
            epoch: now,
            updated: now,
        });
        self.last_cut = Some(now);
        self.tally.cuts += 1;
    }

    /// Advance the cap along Cubic's curve, while the window is in use.
    fn grow_cap(&mut self, now: Instant) {
        let mtu = self.mtu as f64;
        let rtt = self.smoothed.max(Duration::from_millis(1)).as_secs_f64();
        let model = self.bbr.window();
        let app_limited = self.app_limited;
        let beta = self.beta;
        let Some(cap) = self.cap.as_mut() else {
            return;
        };
        let elapsed = now.saturating_duration_since(cap.updated);
        cap.updated = now;
        if app_limited {
            // The curve is a function of time spent using the window: hold it
            // still while the sender has less to send than the cap allows.
            cap.epoch += elapsed;
            return;
        }
        let t = now.saturating_duration_since(cap.epoch).as_secs_f64();
        let cubic = CUBIC_C * (t - cap.k).powi(3) + cap.w_max;
        // The TCP-friendly floor (RFC 9438 §4.3): where Reno would be by now.
        let reno = cap.w_max * beta + 3.0 * (1.0 - beta) / (1.0 + beta) * (t / rtt);
        // At most half again per round trip (RFC 9438 §4.4's target clamp).
        let ceiling = cap.window * (1.0 + 0.5 * (elapsed.as_secs_f64() / rtt).min(1.0));
        let target = (cubic.max(reno) * mtu).min(ceiling);
        if target > cap.window {
            cap.window = target;
        }
        // No longer binding: the model is the limit again.
        if cap.window > 2.0 * model as f64 {
            self.cap = None;
        }
    }

    /// One acknowledgement's round trip (`latest`), with the path's floor
    /// and smoothed round trip.
    fn observe_rtt(&mut self, now: Instant, latest: Duration, floor: Duration, smoothed: Duration) {
        // quinn's floor is the minimum over the connection: it only falls. A
        // floor that fell again (a better path) ends any raised one.
        if floor < self.connection_floor || self.connection_floor.is_zero() {
            self.connection_floor = floor;
            self.raised_floor = None;
            self.second_mins.clear();
        }
        self.floor = self.raised_floor.unwrap_or(self.connection_floor);
        self.smoothed = smoothed;
        self.track_floor(now, latest);
    }

    /// A path whose round trip rose for good (a new route, a link that got
    /// slower) would read every random loss as a queue against the old floor,
    /// and the cap would collapse as Cubic's does. A competing flow's queue
    /// moves (it fills and drains with that flow's sawtooth); a longer path
    /// does not. So when every second of the last [`FLOOR_RAISE_AFTER`] had
    /// its least round trip above the floor by more than the threshold, and
    /// those least round trips stayed within [`FLOOR_STEADY`] of each other,
    /// the floor rises to them.
    fn track_floor(&mut self, now: Instant, latest: Duration) {
        match self.second_mins.back_mut() {
            Some((start, least))
                if now.saturating_duration_since(*start) < Duration::from_secs(1) =>
            {
                *least = (*least).min(latest);
                return;
            }
            _ => {}
        }
        self.second_mins.push_back((now, latest));
        while self
            .second_mins
            .front()
            .is_some_and(|(start, _)| now.saturating_duration_since(*start) > FLOOR_RAISE_AFTER)
        {
            self.second_mins.pop_front();
        }
        let (Some(first), Some(lo), Some(hi)) = (
            self.second_mins.front().map(|(start, _)| *start),
            self.second_mins.iter().map(|(_, least)| *least).min(),
            self.second_mins.iter().map(|(_, least)| *least).max(),
        ) else {
            return;
        };
        let covered = now.saturating_duration_since(first) + Duration::from_secs(1);
        let steady = hi.saturating_sub(lo) <= FLOOR_STEADY.max(lo / 10);
        if covered >= FLOOR_RAISE_AFTER && steady && lo > self.floor + self.threshold() {
            tracing::info!(
                "media congestion control: the path's round-trip floor rose from {} to {} ms \
                 (steady for {} s): losses are judged against the new floor",
                self.floor.as_millis(),
                lo.as_millis(),
                FLOOR_RAISE_AFTER.as_secs()
            );
            self.raised_floor = Some(lo);
            self.floor = lo;
            self.second_mins.clear();
        }
    }

    fn maybe_log(&mut self, now: Instant) {
        if now.saturating_duration_since(self.last_log) < LOG_INTERVAL {
            return;
        }
        self.last_log = now;
        let tally = std::mem::take(&mut self.tally);
        if tally.congestion == 0 && tally.random == 0 {
            return;
        }
        let cap = self
            .cap
            .as_ref()
            .map(|cap| format!("{} kB", cap.window as u64 / 1000))
            .unwrap_or_else(|| "none".into());
        let line = format!(
            "{} loss event(s) came with a queue (up to {} ms over a {} ms floor, threshold {} ms) \
             and were read as congestion ({} cut(s) of the window), {} without one were \
             read as random loss and retransmitted only; window {} kB, cap {cap}",
            tally.congestion,
            tally.max_queue.as_millis(),
            self.floor.as_millis(),
            self.threshold().as_millis(),
            tally.cuts,
            tally.random,
            self.window() / 1000,
        );
        if tally.cuts > 0 {
            tracing::info!("media congestion control: {line}");
        } else {
            tracing::debug!("media congestion control: {line}");
        }
    }
}

impl Controller for MediaController {
    fn on_sent(&mut self, now: Instant, bytes: u64, last_packet_number: u64) {
        self.bbr.on_sent(now, bytes, last_packet_number);
    }

    fn on_ack(
        &mut self,
        now: Instant,
        sent: Instant,
        bytes: u64,
        app_limited: bool,
        rtt: &quinn_proto::RttEstimator,
    ) {
        self.bbr.on_ack(now, sent, bytes, app_limited, rtt);
        self.observe_rtt(
            now,
            now.saturating_duration_since(sent),
            rtt.min(),
            rtt.get(),
        );
    }

    fn on_end_acks(
        &mut self,
        now: Instant,
        in_flight: u64,
        app_limited: bool,
        largest_packet_num_acked: Option<u64>,
    ) {
        self.bbr
            .on_end_acks(now, in_flight, app_limited, largest_packet_num_acked);
        self.app_limited = app_limited;
        self.grow_cap(now);
        self.maybe_log(now);
    }

    fn on_congestion_event(
        &mut self,
        now: Instant,
        sent: Instant,
        is_persistent_congestion: bool,
        lost_bytes: u64,
    ) {
        // The model (BBR) never hears of a loss: see the module docs.
        let queue = self.recent_queue();
        if is_persistent_congestion {
            // Nothing acknowledged for several probe timeouts: start over low.
            self.tally.congestion += 1;
            self.cut(now, self.beta);
            let floor = self.min_window() as f64;
            if let Some(cap) = self.cap.as_mut() {
                cap.window = floor;
            }
            return;
        }
        if queue <= self.threshold() {
            self.tally.random += 1;
            return;
        }
        self.tally.congestion += 1;
        self.tally.max_queue = self.tally.max_queue.max(queue);
        if self.last_cut.is_none_or(|cut| sent > cut) {
            // One packet lost from a full queue: a paced sender's packet
            // lands in a drop-tail queue's last slot more often than a bursty
            // TCP flow's, so a cut per single loss left TCP two thirds of a
            // shared link. A single-packet loss cuts gently.
            let beta = if lost_bytes <= self.mtu {
                SINGLE_LOSS_BETA.max(self.beta)
            } else {
                self.beta
            };
            self.cut(now, beta);
        }
    }

    fn on_mtu_update(&mut self, new_mtu: u16) {
        self.mtu = u64::from(new_mtu);
        self.bbr.on_mtu_update(new_mtu);
    }

    fn window(&self) -> u64 {
        let model = self.bbr.window();
        let capped = match &self.cap {
            Some(cap) => model.min(cap.window as u64),
            None => model,
        };
        capped.max(self.min_window())
    }

    fn metrics(&self) -> ControllerMetrics {
        let mut metrics = self.bbr.metrics();
        metrics.congestion_window = self.window();
        metrics
    }

    fn clone_box(&self) -> Box<dyn Controller> {
        Box::new(self.duplicate())
    }

    fn initial_window(&self) -> u64 {
        self.bbr.initial_window()
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

impl MediaController {
    fn duplicate(&self) -> MediaController {
        MediaController {
            bbr: self.bbr.clone_box(),
            queue_threshold: self.queue_threshold,
            beta: self.beta,
            mtu: self.mtu,
            floor: self.floor,
            connection_floor: self.connection_floor,
            raised_floor: self.raised_floor,
            second_mins: self.second_mins.clone(),
            smoothed: self.smoothed,
            app_limited: self.app_limited,
            cap: self.cap.clone(),
            last_cut: self.last_cut,
            tally: self.tally.clone(),
            last_log: self.last_log,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);
    const MTU: u64 = 1200;

    fn controller(now: Instant) -> MediaController {
        MediaController::new(
            Arc::new(BbrConfig::default()).build(now, MTU as u16),
            DEFAULT_QUEUE_THRESHOLD,
            DEFAULT_BETA,
            now,
            MTU as u16,
        )
    }

    #[test]
    fn random_loss_on_a_quiet_path_changes_nothing() {
        let now = Instant::now();
        let mut c = controller(now);
        let before = c.window();
        for i in 0..50u32 {
            let at = now + i * 10 * MS;
            c.observe_rtt(at, 31 * MS, 30 * MS, 30 * MS);
            c.on_congestion_event(at, at - 5 * MS, false, 3 * MTU);
        }
        assert_eq!(c.window(), before);
        assert!(c.cap.is_none());
        assert_eq!(c.tally.random, 50);
    }

    #[test]
    fn a_loss_from_a_full_queue_cuts_once_per_round_trip() {
        let now = Instant::now();
        let mut c = controller(now);
        let before = c.window() as f64;
        // 80 ms of queue over a 30 ms floor.
        c.observe_rtt(now, 110 * MS, 30 * MS, 100 * MS);
        c.on_congestion_event(now, now - 20 * MS, false, 3 * MTU);
        let after = c.window() as f64;
        assert!(
            (after - before * DEFAULT_BETA).abs() < 2.0,
            "{before} -> {after}"
        );
        // Another loss of a packet sent before the cut belongs to it.
        c.on_congestion_event(now + 5 * MS, now - 10 * MS, false, 2 * MTU);
        assert_eq!(c.window() as f64, after);
        // A single packet lost later, from the same queue, cuts gently.
        c.observe_rtt(now + 150 * MS, 110 * MS, 30 * MS, 100 * MS);
        c.on_congestion_event(now + 150 * MS, now + 50 * MS, false, MTU);
        let gentle = c.window() as f64;
        assert!(
            (gentle - after * SINGLE_LOSS_BETA).abs() < 2.0,
            "{after} -> {gentle}"
        );
        assert_eq!(c.tally.cuts, 2);
    }

    #[test]
    fn the_cap_grows_back_while_the_window_is_used_and_lifts() {
        let now = Instant::now();
        let mut c = controller(now);
        c.observe_rtt(now, 110 * MS, 30 * MS, 100 * MS);
        c.on_congestion_event(now, now - 20 * MS, false, 3 * MTU);
        let cut = c.window();
        // Idle (application-limited): the curve holds still.
        c.app_limited = true;
        c.grow_cap(now + 2_000 * MS);
        assert_eq!(c.window(), cut);
        // In use: back past the window at the loss within a few seconds, then
        // no longer a cap at all.
        c.app_limited = false;
        let mut at = now + 2_000 * MS;
        for _ in 0..400 {
            at += 50 * MS;
            c.observe_rtt(at, 31 * MS, 30 * MS, 31 * MS);
            c.grow_cap(at);
        }
        assert!(c.cap.is_none(), "the cap lifted once it stopped binding");
    }

    #[test]
    fn persistent_congestion_starts_over_low() {
        let now = Instant::now();
        let mut c = controller(now);
        c.on_congestion_event(now, now - 500 * MS, true, 10 * MTU);
        assert_eq!(c.window(), 4 * MTU);
    }

    #[test]
    fn a_longer_path_becomes_the_floor_but_a_moving_queue_does_not() {
        let now = Instant::now();
        let mut c = controller(now);
        c.observe_rtt(now, 1 * MS, 1 * MS, 1 * MS);
        // The path now takes 30 ms, steadily, for 31 s.
        let mut at = now;
        for _ in 0..(31 * 20) {
            at += 50 * MS;
            c.observe_rtt(at, 31 * MS, 1 * MS, 31 * MS);
        }
        assert_eq!(c.floor, 31 * MS);
        c.on_congestion_event(at, at - 5 * MS, false, 3 * MTU);
        assert!(
            c.cap.is_none(),
            "random loss on the longer path is not a queue"
        );

        // A queue that fills and drains (a competing flow's sawtooth) never does.
        let mut c = controller(now);
        c.observe_rtt(now, 30 * MS, 30 * MS, 30 * MS);
        let mut at = now;
        for i in 0..(40 * 20u32) {
            at += 50 * MS;
            let queue = (i % 100) * MS;
            c.observe_rtt(at, 60 * MS + queue, 30 * MS, 80 * MS);
        }
        assert_eq!(c.floor, 30 * MS);
    }
}
