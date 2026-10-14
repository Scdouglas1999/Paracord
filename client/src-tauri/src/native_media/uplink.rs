//! Send-side bandwidth estimation for the screen share (stream-fix V6).
//!
//! The relay's uplink estimate falls only on packet-sequence gaps, which
//! frames on reliable streams never leave, so a share sent through a narrow
//! uplink queued at the sender: the encoder kept its preset rate, the frames
//! the uplink could not carry waited in the connection's send buffer, and
//! every viewer's picture fell further behind.
//!
//! This watches the share's own frames instead. Each frame goes out on its own
//! QUIC stream, and the stream says when the relay has acknowledged all of it
//! (`SendStream::stopped`). From that, over the last 2 s:
//!
//! - **what was sent** and **what the relay acknowledged** (the uplink's rate
//!   while frames queue);
//! - **the backlog**: the bytes handed to the connection and not yet
//!   acknowledged, in milliseconds at the acknowledged rate.
//!
//! The uplink is not keeping up when, for a second on end, the relay
//! acknowledged under 92% of what was sent while a backlog of more than 200 ms
//! stood, or the backlog passed 600 ms either way (a keyframe's burst puts the
//! acknowledgements behind for a moment, and at a low budget a keyframe is a
//! large share of the window). Random loss does neither: a lost packet is resent and
//! its frame is acknowledged a round trip or two later, so over 2 s the relay
//! acknowledges what was sent and the backlog stays near one round trip (a
//! first version judged by the oldest frame in flight, which at 5% loss is
//! always a frame waiting for a resend, and stepped a 44 Mb/s share down to
//! its lowest layer on a clear uplink). A keyframe's burst drains well inside
//! the window.
//!
//! When the uplink is not keeping up, the budget drops to 85% of what the
//! relay acknowledged (and not again for a second, while the queue drains).
//! After 3 s with under 100 ms waiting it climbs 8% a second until it reaches
//! the preset, when it lifts; a probe that builds a backlog stops climbing
//! before it is one. A layer dropped for the budget comes back only with 25%
//! to spare, and not for 10 s after it was dropped (doubling, to 80 s, each
//! time it is dropped again within 20 s of coming back): [`LayerGate`]. [`allocate_layers`] turns the budget into simulcast layers:
//! the top layer gives up bitrate first, then is dropped, then the next one. A
//! backlog past [`SHED_AFTER`] for half a second stops the highest layer still sent (its queued
//! frames are reset) until the backlog is under [`SHED_UNTIL`], so the picture
//! viewers see never falls seconds behind. Nothing is decided in the first
//! [`WARM_UP`] of a share (the first keyframes and the connection's startup).
//!
//! Every change is logged with its numbers by the caller.
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// How often the budget is re-evaluated.
const EVALUATE_EVERY: Duration = Duration::from_millis(250);
/// The window the rates and the backlog are judged over.
const WINDOW: Duration = Duration::from_secs(2);
/// No decision this early in a share.
const WARM_UP: Duration = Duration::from_secs(3);
/// A backlog this long (at the acknowledged rate) with the relay
/// acknowledging less than [`ACKED_SHARE_PERCENT`] of what was sent: the
/// uplink is not keeping up.
const BACKLOG_GROWING: Duration = Duration::from_millis(200);
const ACKED_SHARE_PERCENT: u64 = 92;
/// A backlog this long is too much whatever the rates say.
const BACKLOG_STANDING: Duration = Duration::from_millis(600);
/// The uplink must stay behind this long before the budget drops: a
/// keyframe's burst puts the relay's acknowledgements behind for a moment, and
/// at a low budget a keyframe is a large share of 2 s of sending.
const CONGESTED_FOR: Duration = Duration::from_secs(1);
/// A backlog must pass [`SHED_AFTER`] for this long before shedding.
const SHED_FOR: Duration = Duration::from_millis(500);
/// The share of the acknowledged rate the budget drops to.
const DECREASE_PERCENT: u64 = 85;
/// After a decrease, how long before another (the queue it left drains).
const DECREASE_HOLD: Duration = Duration::from_secs(1);
/// How long the uplink keeps up before the budget climbs.
const INCREASE_AFTER: Duration = Duration::from_secs(3);
/// How fast it climbs, per second.
const INCREASE_PER_SECOND: f64 = 1.08;
/// The backlog under which the uplink counts as keeping up (between this and
/// [`BACKLOG_GROWING`] the budget holds still): a probe stops before it has
/// built a queue.
const BACKLOG_CLEAR: Duration = Duration::from_millis(100);
/// A backlog this long stops the highest layer still sent until it drains...
pub(crate) const SHED_AFTER: Duration = Duration::from_millis(1000);
/// ...to here.
const SHED_UNTIL: Duration = Duration::from_millis(300);
/// The lowest budget the estimator asks for.
pub(crate) const MIN_BUDGET_KBPS: u32 = 300;
/// Frames remembered (in flight, or sent within [`WINDOW`]).
const MAX_FRAMES: usize = 4096;

#[derive(Clone, Copy, Debug)]
struct Frame {
    id: u64,
    bytes: usize,
    sent: Instant,
    acked: Option<Instant>,
}

/// What the estimator decided at one evaluation.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct UplinkVerdict {
    /// The budget for every layer together, in kbps; `None` = the preset.
    pub budget_kbps: Option<u32>,
    /// Why the budget changed at this evaluation, when it did.
    pub change: Option<String>,
    /// Whether the highest layer still sent should skip frames (a backlog).
    pub shed: bool,
    /// Why shedding started or stopped at this evaluation, when it did.
    pub shed_change: Option<String>,
}

/// The screen share's uplink, from its own frames. One per share.
#[derive(Debug, Default)]
pub(crate) struct UplinkEstimator {
    frames: VecDeque<Frame>,
    next_id: u64,
    first_send: Option<Instant>,
    budget_kbps: Option<u32>,
    last_evaluated: Option<Instant>,
    last_decrease: Option<Instant>,
    /// Since when the uplink has kept up.
    clear_since: Option<Instant>,
    /// Since when it has not.
    congested_since: Option<Instant>,
    /// Since when the backlog has been past [`SHED_AFTER`].
    backlogged_since: Option<Instant>,
    shedding: bool,
}

/// The uplink over the last [`WINDOW`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct UplinkSample {
    pub sent_kbps: u32,
    pub acked_kbps: u32,
    /// Unacknowledged bytes, in ms at the acknowledged rate (or at the sent
    /// rate when nothing was acknowledged).
    pub backlog: Duration,
    pub backlog_bytes: u64,
}

impl UplinkEstimator {
    pub fn new() -> Self {
        Self::default()
    }

    /// A frame of `bytes` handed to the connection. Returns its id for
    /// [`Self::on_acked`] / [`Self::on_abandoned`].
    pub fn on_send(&mut self, now: Instant, bytes: usize) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.first_send.get_or_insert(now);
        self.frames.push_back(Frame {
            id,
            bytes,
            sent: now,
            acked: None,
        });
        self.prune(now);
        id
    }

    /// The relay acknowledged all of frame `id`.
    pub fn on_acked(&mut self, id: u64, now: Instant) {
        if let Some(frame) = self.frames.iter_mut().rev().find(|frame| frame.id == id) {
            frame.acked = Some(now);
        }
    }

    /// Frame `id` will never be acknowledged (its stream failed or was reset).
    pub fn on_abandoned(&mut self, id: u64) {
        self.frames.retain(|frame| frame.id != id);
    }

    fn prune(&mut self, now: Instant) {
        while self.frames.len() > MAX_FRAMES
            || self.frames.front().is_some_and(|frame| {
                frame.acked.is_some_and(|acked| {
                    now.saturating_duration_since(acked) > WINDOW
                        && now.saturating_duration_since(frame.sent) > WINDOW
                })
            })
        {
            self.frames.pop_front();
        }
    }

    /// The rates and the backlog over the last [`WINDOW`].
    pub fn sample(&self, now: Instant) -> UplinkSample {
        let start = now.checked_sub(WINDOW).unwrap_or(now);
        let (mut sent, mut acked, mut backlog) = (0u64, 0u64, 0u64);
        for frame in &self.frames {
            if frame.sent >= start {
                sent += frame.bytes as u64;
            }
            match frame.acked {
                Some(at) if at >= start => acked += frame.bytes as u64,
                Some(_) => {}
                None => backlog += frame.bytes as u64,
            }
        }
        let ms = WINDOW.as_millis() as u64;
        let sent_kbps = (sent * 8 / ms) as u32;
        let acked_kbps = (acked * 8 / ms) as u32;
        let rate = u64::from(if acked_kbps > 0 {
            acked_kbps
        } else {
            sent_kbps
        })
        .max(1);
        UplinkSample {
            sent_kbps,
            acked_kbps,
            backlog: Duration::from_millis(backlog * 8 / rate),
            backlog_bytes: backlog,
        }
    }

    /// Re-evaluate (at most every [`EVALUATE_EVERY`]). `preset_kbps` is what
    /// every layer together sends at the preset.
    pub fn evaluate(&mut self, now: Instant, preset_kbps: u32) -> UplinkVerdict {
        let mut verdict = UplinkVerdict {
            budget_kbps: self.budget_kbps,
            shed: self.shedding,
            ..UplinkVerdict::default()
        };
        if self
            .last_evaluated
            .is_some_and(|at| now.saturating_duration_since(at) < EVALUATE_EVERY)
        {
            return verdict;
        }
        let elapsed = self
            .last_evaluated
            .map(|at| now.saturating_duration_since(at))
            .unwrap_or(EVALUATE_EVERY);
        self.last_evaluated = Some(now);
        if self
            .first_send
            .is_none_or(|first| now.saturating_duration_since(first) < WARM_UP)
        {
            return verdict;
        }
        let sample = self.sample(now);

        // A backlog past SHED_AFTER (for SHED_FOR): stop the highest layer
        // still sent.
        if sample.backlog > SHED_AFTER {
            self.backlogged_since.get_or_insert(now);
        } else {
            self.backlogged_since = None;
        }
        let long_backlog = self
            .backlogged_since
            .is_some_and(|since| now.saturating_duration_since(since) >= SHED_FOR);
        if !self.shedding && long_backlog {
            self.shedding = true;
            verdict.shed_change = Some(format!(
                "{} kB waiting for the relay's acknowledgement, {} ms at the {} kbps it \
                 acknowledged: the highest layer still sent skips frames (its queued ones are \
                 dropped) until that drains",
                sample.backlog_bytes / 1000,
                sample.backlog.as_millis(),
                sample.acked_kbps
            ));
        } else if self.shedding && sample.backlog <= SHED_UNTIL {
            self.shedding = false;
            verdict.shed_change = Some(format!(
                "the uplink backlog drained ({} ms): sending every layer again from a keyframe",
                sample.backlog.as_millis()
            ));
        }
        verdict.shed = self.shedding;

        let behind =
            u64::from(sample.acked_kbps) * 100 < u64::from(sample.sent_kbps) * ACKED_SHARE_PERCENT;
        let congested =
            (behind && sample.backlog > BACKLOG_GROWING) || sample.backlog > BACKLOG_STANDING;
        if congested {
            self.clear_since = None;
            let since = *self.congested_since.get_or_insert(now);
            let held = self
                .last_decrease
                .is_some_and(|at| now.saturating_duration_since(at) < DECREASE_HOLD);
            let lasting = now.saturating_duration_since(since) >= CONGESTED_FOR;
            if lasting && !held && sample.acked_kbps > 0 {
                let next = ((u64::from(sample.acked_kbps) * DECREASE_PERCENT / 100) as u32)
                    .max(MIN_BUDGET_KBPS)
                    .min(self.budget_kbps.unwrap_or(preset_kbps));
                if self.budget_kbps != Some(next) {
                    verdict.change = Some(format!(
                        "the uplink is not keeping up: over the last {} s the relay acknowledged \
                         {} of the {} kbps sent, with {} ms ({} kB) waiting; budget {} -> {next} \
                         kbps (85% of what it acknowledged)",
                        WINDOW.as_secs(),
                        sample.acked_kbps,
                        sample.sent_kbps,
                        sample.backlog.as_millis(),
                        sample.backlog_bytes / 1000,
                        self.budget_kbps.map_or_else(
                            || format!("the preset ({preset_kbps})"),
                            |k| k.to_string()
                        ),
                    ));
                    self.budget_kbps = Some(next);
                }
                self.last_decrease = Some(now);
            }
        } else if sample.backlog > BACKLOG_CLEAR {
            // Not falling behind, not clear either: hold.
            self.congested_since = None;
            self.clear_since = None;
        } else {
            self.congested_since = None;
            let since = *self.clear_since.get_or_insert(now);
            if let Some(budget) = self.budget_kbps {
                if now.saturating_duration_since(since) >= INCREASE_AFTER {
                    let factor = INCREASE_PER_SECOND.powf(elapsed.as_secs_f64().min(1.0));
                    let next = ((f64::from(budget) * factor).ceil() as u32).max(budget + 1);
                    if next >= preset_kbps {
                        verdict.change = Some(format!(
                            "the uplink has kept up for {} s: budget {budget} -> the preset \
                             ({preset_kbps} kbps)",
                            now.saturating_duration_since(since).as_secs()
                        ));
                        self.budget_kbps = None;
                    } else {
                        self.budget_kbps = Some(next);
                    }
                }
            }
        }
        verdict.budget_kbps = self.budget_kbps;
        verdict
    }

    /// A one-line state summary for the periodic encoder report.
    pub fn summary(&self, now: Instant) -> String {
        let sample = self.sample(now);
        format!(
            "uplink: budget {}, sent {} kbps, relay acknowledged {} kbps over {} s, backlog {} ms \
             ({} kB){}",
            self.budget_kbps
                .map_or_else(|| "the preset".to_string(), |k| format!("{k} kbps")),
            sample.sent_kbps,
            sample.acked_kbps,
            WINDOW.as_secs(),
            sample.backlog.as_millis(),
            sample.backlog_bytes / 1000,
            if self.shedding {
                ", shedding the highest layer"
            } else {
                ""
            },
        )
    }
}

/// How the share's layers fit a budget.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LayerPlan {
    /// How many layers, from the lowest, are sent.
    pub active: usize,
    /// Each sent layer's bitrate, lowest first (`active` entries).
    pub kbps: Vec<u32>,
}

/// Fit the ladder (each layer's preset bitrate, lowest first) into `budget`
/// (every layer together; `None` = the preset).
///
/// The highest layer gives up bitrate first, down to 1.5x the layer below it
/// (below that the layer below is the better picture for the bits); then it is
/// dropped and the next one gives up bitrate the same way. The lowest layer
/// alone goes down to [`MIN_BUDGET_KBPS`].
pub(crate) fn allocate_layers(ladder: &[u32], budget: Option<u32>) -> LayerPlan {
    let Some(budget) = budget else {
        return LayerPlan {
            active: ladder.len(),
            kbps: ladder.to_vec(),
        };
    };
    for active in (1..=ladder.len()).rev() {
        let lower: u32 = ladder[..active - 1].iter().sum();
        let floor = if active >= 2 {
            (ladder[active - 2].saturating_mul(3) / 2).min(ladder[active - 1])
        } else {
            MIN_BUDGET_KBPS.min(ladder[0])
        };
        if lower.saturating_add(floor) <= budget || active == 1 {
            let mut kbps = ladder[..active].to_vec();
            let top = budget
                .saturating_sub(lower)
                .clamp(floor, ladder[active - 1]);
            kbps[active - 1] = top;
            return LayerPlan { active, kbps };
        }
    }
    LayerPlan {
        active: 0,
        kbps: Vec::new(),
    }
}

/// When a layer the budget dropped may come back.
///
/// The budget probes upward, so without this a layer that just fits
/// (Movie 50's 5120x1440 at 1.5x the layer below needs ~19 Mb/s with the
/// others) came back, its keyframes put the uplink behind, and it was dropped
/// again, every 10 s on a 20 Mb/s uplink: a keyframe and a layer switch for
/// every viewer each time.
#[derive(Debug, Default)]
pub(crate) struct LayerGate {
    /// No layer comes back before this.
    blocked_until: Option<Instant>,
    backoff: Duration,
    /// When a layer last came back.
    restored_at: Option<Instant>,
}

/// The first wait after a layer is dropped, and the longest.
const RESTORE_BACKOFF: Duration = Duration::from_secs(10);
const RESTORE_BACKOFF_MAX: Duration = Duration::from_secs(80);
/// A layer that comes back and is dropped within this long failed.
const RESTORE_TRIAL: Duration = Duration::from_secs(20);
/// The headroom a layer comes back with, in percent of what it needs.
const RESTORE_HEADROOM_PERCENT: u64 = 125;

impl LayerGate {
    pub const fn new() -> Self {
        Self {
            blocked_until: None,
            backoff: Duration::ZERO,
            restored_at: None,
        }
    }

    /// The plan to apply, given what is sent now (`current` layers) and the
    /// budget's plan. Fewer layers apply at once; more only past the gate,
    /// one at a time, with headroom.
    pub fn admit(
        &mut self,
        now: Instant,
        ladder: &[u32],
        budget: Option<u32>,
        current: usize,
        plan: LayerPlan,
    ) -> LayerPlan {
        if plan.active < current {
            let failed = self
                .restored_at
                .is_some_and(|at| now.saturating_duration_since(at) < RESTORE_TRIAL);
            self.backoff = if failed {
                (self.backoff * 2).clamp(RESTORE_BACKOFF, RESTORE_BACKOFF_MAX)
            } else {
                RESTORE_BACKOFF
            };
            self.blocked_until = Some(now + self.backoff);
            self.restored_at = None;
            return plan;
        }
        if plan.active == current {
            return plan;
        }
        // One more layer, if the budget has room for it with headroom.
        let next = current + 1;
        let needed: u64 = ladder[..next - 1]
            .iter()
            .map(|&k| u64::from(k))
            .sum::<u64>()
            + u64::from(ladder[next - 2].saturating_mul(3) / 2).min(u64::from(ladder[next - 1]));
        let room = budget
            .is_none_or(|budget| u64::from(budget) * 100 >= needed * RESTORE_HEADROOM_PERCENT);
        let open = self.blocked_until.is_none_or(|until| now >= until);
        if room && open {
            self.restored_at = Some(now);
            return allocate_layers(&ladder[..next], budget).with_active(next, ladder);
        }
        allocate_layers(&ladder[..current], budget).with_active(current, ladder)
    }
}

impl LayerPlan {
    /// This plan, forced to `active` layers of `ladder` (a plan computed on a
    /// shorter ladder).
    fn with_active(mut self, active: usize, ladder: &[u32]) -> LayerPlan {
        self.active = active.min(ladder.len());
        self.kbps.truncate(self.active);
        while self.kbps.len() < self.active {
            self.kbps.push(ladder[self.kbps.len()]);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    /// 60 frames a second of `bytes` for `seconds`, each acknowledged
    /// `delay(i)` after it was sent. Returns the time after the last frame.
    fn run(
        estimator: &mut UplinkEstimator,
        start: Instant,
        seconds: u64,
        bytes: usize,
        preset: u32,
        delay: impl Fn(u64) -> Duration,
        verdicts: &mut Vec<UplinkVerdict>,
    ) -> Instant {
        let mut pending: Vec<(Instant, u64)> = Vec::new();
        let frames = seconds * 60;
        let mut now = start;
        for i in 0..frames {
            now = start + Duration::from_micros(i * 16_667);
            pending.retain(|(at, id)| {
                if *at <= now {
                    estimator.on_acked(*id, *at);
                    false
                } else {
                    true
                }
            });
            let id = estimator.on_send(now, bytes);
            pending.push((now + delay(i), id));
            verdicts.push(estimator.evaluate(now, preset));
        }
        for (at, id) in pending {
            estimator.on_acked(id, at);
        }
        now
    }

    #[test]
    fn a_clear_uplink_keeps_the_preset() {
        let mut estimator = UplinkEstimator::new();
        let mut verdicts = Vec::new();
        run(
            &mut estimator,
            Instant::now(),
            10,
            90_000,
            44_000,
            |_| 40 * MS,
            &mut verdicts,
        );
        assert!(verdicts.iter().all(|v| v.budget_kbps.is_none() && !v.shed));
    }

    #[test]
    fn a_keyframe_burst_is_not_a_queue() {
        let mut estimator = UplinkEstimator::new();
        let mut verdicts = Vec::new();
        // Every 2 s a frame takes 400 ms (a keyframe at the uplink's rate).
        run(
            &mut estimator,
            Instant::now(),
            10,
            90_000,
            44_000,
            |i| if i % 120 == 0 { 400 * MS } else { 40 * MS },
            &mut verdicts,
        );
        assert!(verdicts.iter().all(|v| v.budget_kbps.is_none() && !v.shed));
    }

    #[test]
    fn random_loss_is_not_a_narrow_uplink() {
        // 5% loss on both legs: most frames wait for a resend or two. Every
        // third frame is acknowledged 250 ms late, every tenth 600 ms late.
        let mut estimator = UplinkEstimator::new();
        let mut verdicts = Vec::new();
        run(
            &mut estimator,
            Instant::now(),
            20,
            90_000,
            44_000,
            |i| match (i % 10, i % 3) {
                (0, _) => 600 * MS,
                (_, 0) => 250 * MS,
                _ => 60 * MS,
            },
            &mut verdicts,
        );
        assert!(verdicts.iter().all(|v| v.budget_kbps.is_none() && !v.shed));
    }

    #[test]
    fn a_narrow_uplink_brings_the_budget_down_to_what_it_carries_then_back() {
        let mut estimator = UplinkEstimator::new();
        let mut verdicts = Vec::new();
        let start = Instant::now();
        // Past the warm-up on a clear path.
        let now = run(
            &mut estimator,
            start,
            4,
            90_000,
            44_000,
            |_| 40 * MS,
            &mut verdicts,
        );
        // Then a 10 Mb/s uplink under a 43 Mb/s share: each frame waits behind
        // the ones before it.
        let backlog_start = now + 17 * MS;
        let mut pending: Vec<(Instant, u64)> = Vec::new();
        let mut link_free = backlog_start;
        let mut t = backlog_start;
        let mut budgets = Vec::new();
        let mut sheds = 0u32;
        for i in 0..(20 * 60) {
            t = backlog_start + Duration::from_micros(i * 16_667);
            pending.retain(|(at, id)| {
                if *at <= t {
                    estimator.on_acked(*id, *at);
                    false
                } else {
                    true
                }
            });
            let verdict = estimator.evaluate(t, 44_000);
            if verdict.shed && !pending.is_empty() {
                // The sender resets the shed layer's queued frames.
                for (_, id) in pending.drain(..) {
                    estimator.on_abandoned(id);
                }
                link_free = t;
            }
            // Every 2 s a keyframe, 15x a delta.
            let delta = verdict
                .budget_kbps
                .map_or(90_000, |kbps| (kbps as usize) * 1000 / 8 / 60);
            let bytes = if i % 120 == 0 { delta * 15 } else { delta };
            if verdict.shed {
                sheds += 1;
            } else {
                let id = estimator.on_send(t, bytes);
                // 10 Mb/s: 1.25 MB/s of serialization, after what is queued.
                let serialize = Duration::from_micros(bytes as u64 * 1_000_000 / 1_250_000);
                link_free = link_free.max(t) + serialize;
                pending.push((link_free + 20 * MS, id));
            }
            budgets.push(verdict.budget_kbps);
        }
        assert!(sheds > 0, "the onset's backlog was shed");
        let last = budgets.last().copied().flatten().expect("a budget");
        assert!((6_000..=10_000).contains(&last), "budget settled at {last}");
        // Keyframes at the settled budget do not walk it down.
        let settled = budgets[budgets.len() - 10 * 60..]
            .iter()
            .flatten()
            .min()
            .copied()
            .unwrap();
        assert!(
            settled >= 6_000,
            "budget fell to {settled} with keyframes on a 10 Mb/s uplink"
        );
        // Bounded: under a second of backlog at the end.
        assert!(
            estimator.sample(t).backlog < 1_000 * MS,
            "{:?}",
            estimator.sample(t)
        );
        for (at, id) in pending {
            estimator.on_acked(id, at);
        }
        // The limit lifts: the budget climbs back to the preset.
        let mut verdicts = Vec::new();
        run(
            &mut estimator,
            t + 50 * MS,
            40,
            90_000,
            44_000,
            |_| 40 * MS,
            &mut verdicts,
        );
        assert_eq!(verdicts.last().unwrap().budget_kbps, None);
    }

    #[test]
    fn a_backlog_sheds_the_highest_layer_until_it_drains() {
        let mut estimator = UplinkEstimator::new();
        let mut verdicts = Vec::new();
        let now = run(
            &mut estimator,
            Instant::now(),
            4,
            90_000,
            44_000,
            |_| 40 * MS,
            &mut verdicts,
        );
        // 6 MB stuck: over a second at the 43 Mb/s acknowledged.
        let stuck = estimator.on_send(now + 10 * MS, 6_000_000);
        let verdict = estimator.evaluate(now + 300 * MS, 44_000);
        assert!(!verdict.shed, "not before it has lasted");
        let verdict = estimator.evaluate(now + 850 * MS, 44_000);
        assert!(verdict.shed && verdict.shed_change.is_some(), "{verdict:?}");
        estimator.on_acked(stuck, now + 900 * MS);
        let verdict = estimator.evaluate(now + 1_200 * MS, 44_000);
        assert!(
            !verdict.shed && verdict.shed_change.is_some(),
            "{verdict:?}"
        );
    }

    #[test]
    fn layers_give_up_bitrate_top_first_then_drop() {
        // Movie 50 on 5120x1440: 1280x360, 2560x720, 5120x1440.
        let ladder = [1_600, 7_000, 44_400];
        assert_eq!(
            allocate_layers(&ladder, None),
            LayerPlan {
                active: 3,
                kbps: vec![1_600, 7_000, 44_400]
            }
        );
        assert_eq!(
            allocate_layers(&ladder, Some(42_000)),
            LayerPlan {
                active: 3,
                kbps: vec![1_600, 7_000, 33_400]
            }
        );
        // 20 Mb/s: the top layer down to 11.4 (at least 1.5x the middle one).
        assert_eq!(
            allocate_layers(&ladder, Some(20_000)),
            LayerPlan {
                active: 3,
                kbps: vec![1_600, 7_000, 11_400]
            }
        );
        // 17 Mb/s: under that, the top layer is dropped.
        assert_eq!(
            allocate_layers(&ladder, Some(17_000)),
            LayerPlan {
                active: 2,
                kbps: vec![1_600, 7_000]
            }
        );
        // 8.5 Mb/s: no room for the top layer at 1.5x the middle one.
        assert_eq!(
            allocate_layers(&ladder, Some(8_500)),
            LayerPlan {
                active: 2,
                kbps: vec![1_600, 6_900]
            }
        );
        assert_eq!(
            allocate_layers(&ladder, Some(3_000)),
            LayerPlan {
                active: 1,
                kbps: vec![1_600]
            }
        );
        assert_eq!(
            allocate_layers(&ladder, Some(900)),
            LayerPlan {
                active: 1,
                kbps: vec![900]
            }
        );
        assert_eq!(
            allocate_layers(&ladder, Some(100)),
            LayerPlan {
                active: 1,
                kbps: vec![MIN_BUDGET_KBPS]
            }
        );
    }

    #[test]
    fn a_dropped_layer_comes_back_with_headroom_after_a_backoff() {
        let ladder = [1_600, 7_000, 44_400];
        let start = Instant::now();
        let mut gate = LayerGate::default();
        // Dropped at 17 Mb/s.
        let plan = gate.admit(
            start,
            &ladder,
            Some(17_000),
            3,
            allocate_layers(&ladder, Some(17_000)),
        );
        assert_eq!(plan.active, 2);
        // 19.5 Mb/s fits it (19.1 needed) but without 25% to spare, and the
        // backoff has not run: stay at two.
        let at = start + Duration::from_secs(12);
        let plan = gate.admit(
            at,
            &ladder,
            Some(19_500),
            2,
            allocate_layers(&ladder, Some(19_500)),
        );
        assert_eq!(
            plan,
            LayerPlan {
                active: 2,
                kbps: vec![1_600, 7_000]
            }
        );
        let plan = gate.admit(
            start + Duration::from_secs(5),
            &ladder,
            Some(30_000),
            2,
            allocate_layers(&ladder, Some(30_000)),
        );
        assert_eq!(plan.active, 2, "still backed off");
        let plan = gate.admit(
            at,
            &ladder,
            Some(30_000),
            2,
            allocate_layers(&ladder, Some(30_000)),
        );
        assert_eq!(
            plan,
            LayerPlan {
                active: 3,
                kbps: vec![1_600, 7_000, 21_400]
            }
        );
        // Dropped again within 20 s: the next wait is 20 s.
        let plan = gate.admit(
            at + Duration::from_secs(5),
            &ladder,
            Some(17_000),
            3,
            allocate_layers(&ladder, Some(17_000)),
        );
        assert_eq!(plan.active, 2);
        let plan = gate.admit(
            at + Duration::from_secs(20),
            &ladder,
            Some(30_000),
            2,
            allocate_layers(&ladder, Some(30_000)),
        );
        assert_eq!(plan.active, 2);
        let plan = gate.admit(
            at + Duration::from_secs(26),
            &ladder,
            Some(30_000),
            2,
            allocate_layers(&ladder, Some(30_000)),
        );
        assert_eq!(plan.active, 3);
        // The preset (no budget): everything, one layer at a time.
        let mut gate = LayerGate::default();
        let plan = gate.admit(at, &ladder, None, 1, allocate_layers(&ladder, None));
        assert_eq!(plan.active, 2);
    }
}
