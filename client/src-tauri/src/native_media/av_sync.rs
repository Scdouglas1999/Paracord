//! Stream audio/video synchronization (stream audit B7).
//!
//! A shared screen's picture and its sound used to travel on unrelated clocks:
//! the video carried its capture time, the audio a sample counter that started
//! at zero whenever the send task did. The viewer played each as soon as it
//! could, and the sound came out 100 to 145 ms after the matching frame.
//!
//! Now both are stamped on the sender's wall clock at capture, against one
//! zero point per share ([`ShareClock`]): the video's `timestamp_us` and the
//! screen audio's 48 kHz `timestamp` count from the same instant. On the
//! viewer, per watched screen track:
//!
//! - the picture reports how far each frame's arrival and presentation sit
//!   behind its capture stamp ([`note_video_received`], [`note_video_presented`]);
//! - the sound reports the earliest it could be heard behind its capture stamp:
//!   the newest buffered frame, played now, through the mixer and the device
//!   ([`AudioSync`]);
//! - when the sound's path is the longer one (it usually is: two 20 ms frames,
//!   the jitter buffer, the mixer and the device against a hardware decode),
//!   the picture is held before decode by the difference ([`video_hold`]);
//! - and the sound is scheduled so each frame is heard at its capture stamp
//!   plus the picture's presentation distance: held a tick when early, skipped
//!   ahead a frame when late.
//!
//! The unknown offset between the two machines' clocks cancels: it is in every
//! one of those distances.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// 48 kHz ticks per second.
const TICKS_PER_SECOND: f64 = 48_000.0;
/// The audio timestamp is a `u32` of 48 kHz ticks: it wraps every ~24.9 h.
const AUDIO_WRAP_US: f64 = 4_294_967_296.0 * 1_000_000.0 / TICKS_PER_SECOND;
/// A video clock not refreshed for this long is stale: the picture is paused,
/// hidden or gone, and audio plays free rather than against an old picture.
const VIDEO_CLOCK_STALE_US: u64 = 1_000_000;
/// An audio report older than this means the stream has no sound (shared
/// without it, or it stopped): the picture is not held for it.
const AUDIO_REPORT_STALE_US: u64 = 1_000_000;
/// Smoothing for the picture's distances, per frame.
const VIDEO_OFFSET_ALPHA: f64 = 0.1;
/// Smoothing for the sound's earliest distance, per 20 ms tick.
const AUDIO_FLOOR_ALPHA: f64 = 0.05;
/// How fast the picture's hold follows its target, per frame: slow enough that
/// a moving hold never reads as a change of pace.
const HOLD_ALPHA: f64 = 0.05;
/// The most the picture is ever held for its sound.
const MAX_HOLD_US: f64 = 300_000.0;
/// Room left above the sound's earliest distance, so the playout keeps a frame
/// in hand against network jitter rather than running dry.
const AUDIO_MARGIN_US: f64 = 20_000.0;
/// A distance this far from the running estimate is a new timeline (the
/// sender restarted its share clock), not jitter.
const VIDEO_OFFSET_RESET_US: f64 = 500_000.0;
/// One audio frame: the unit every correction moves the audio by.
pub const AUDIO_FRAME_US: f64 = 20_000.0;
/// Error band the playout leaves alone. A correction moves 20 ms, so a band
/// narrower than half of that would oscillate.
const SYNC_TOLERANCE_US: f64 = 25_000.0;
/// Errors beyond this are corrected every tick until inside the band.
const SYNC_FAST_US: f64 = 80_000.0;
/// Inside the fast threshold, corrections are spaced so a noisy estimate does
/// not chop the sound.
const SYNC_CORRECTION_SPACING_US: u64 = 200_000;
/// Smoothing for the audio error, per 20 ms tick.
const SYNC_ERROR_ALPHA: f64 = 0.2;
/// An audio stamp further than this from the picture's is on another timeline
/// (one side restarted its share clock); audio plays free until they meet.
const TIMELINE_MISMATCH_US: f64 = 2_000_000.0;
/// The most the playout lets pile up by holding: 300 ms. Past it, audio that
/// still reads as early is on a timeline the picture has not reached yet
/// (a share restarting), and it plays rather than waiting.
const MAX_HELD_FRAMES: usize = 15;
/// The most one tick's sound floor may move the estimate: a single odd tick (a
/// share restarting, a burst of late packets) must not pull the picture's hold.
const AUDIO_FLOOR_STEP_US: f64 = 100_000.0;
/// How often the playout reports its state to the log.
const SYNC_LOG_INTERVAL_US: u64 = 5_000_000;

/// Microseconds on this process's monotonic clock.
pub fn mono_us() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// The decode worker key of a stream's screen picture, which its screen audio
/// is played against.
pub fn screen_track_key(stream_id: &str) -> String {
    format!("{stream_id}:screen")
}

// ── Sender ────────────────────────────────────────────────────────────────

/// One 20 ms frame of a share's sound: 1920 interleaved 48 kHz stereo samples
/// and the sender wall-clock time of its first sample (the clock the screen's
/// frames are stamped with).
pub struct ScreenAudioFrame {
    pub samples: Vec<f32>,
    pub captured_at: SystemTime,
}

/// The zero point of one share's media timestamps, on the sender's wall clock.
/// Whichever of the screen's first frame or its first audio frame comes first
/// sets it; the video encoder resets it when it starts a new share.
#[derive(Clone, Default)]
pub struct ShareClock(Arc<Mutex<Option<SystemTime>>>);

impl ShareClock {
    pub fn reset(&self) {
        if let Ok(mut base) = self.0.lock() {
            *base = None;
        }
    }

    /// The share's zero point, set to `at` if it has none yet.
    pub fn base_or_init(&self, at: SystemTime) -> SystemTime {
        match self.0.lock() {
            Ok(mut base) => *base.get_or_insert(at),
            Err(_) => at,
        }
    }

    /// The 48 kHz timestamp of an audio frame whose first sample was captured
    /// at `captured_at`. Wraps like the wire field; an instant before the zero
    /// point (a frame captured just before a restart) wraps backwards, which
    /// the viewer reads as slightly negative.
    pub fn audio_timestamp(&self, captured_at: SystemTime) -> u32 {
        let base = self.base_or_init(captured_at);
        let micros: i128 = match captured_at.duration_since(base) {
            Ok(ahead) => ahead.as_micros() as i128,
            Err(behind) => -(behind.duration().as_micros() as i128),
        };
        (micros * 48 / 1000) as u32
    }
}

// ── Viewer: one screen track's clocks ─────────────────────────────────────

#[derive(Clone, Copy, Debug, Default)]
struct TrackClock {
    /// Smoothed (local arrival µs − sender capture µs) of whole frames.
    received_us: Option<f64>,
    /// Smoothed (local presentation µs − sender capture µs), held included:
    /// where the picture is. The sound is scheduled against this.
    presented_us: Option<f64>,
    /// The same without the hold: where the picture would be on its own.
    natural_us: Option<f64>,
    /// How long frames are held before decode now.
    hold_us: f64,
    /// Capture stamp of the last presented frame, for unwrapping audio stamps.
    last_ts_us: u64,
    /// When that frame was presented, on [`mono_us`].
    last_at_us: u64,
    /// Smoothed earliest (heard µs − capture µs) the sound could manage.
    audio_floor_us: Option<f64>,
    /// When the sound last reported, on [`mono_us`].
    audio_at_us: u64,
}

fn clocks() -> &'static Mutex<HashMap<String, TrackClock>> {
    // One entry per screen track watched in this process: a handful. A stream
    // that stops goes stale (see the `*_STALE_US` constants).
    static CLOCKS: OnceLock<Mutex<HashMap<String, TrackClock>>> = OnceLock::new();
    CLOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn smooth(estimate: &mut Option<f64>, sample: f64, alpha: f64) {
    *estimate = Some(match *estimate {
        Some(previous) if (sample - previous).abs() <= VIDEO_OFFSET_RESET_US => {
            previous + alpha * (sample - previous)
        }
        _ => sample,
    });
}

/// A whole frame of `track_key` captured at `timestamp_us` (sender clock)
/// arrived from the network.
pub fn note_video_received(track_key: &str, timestamp_us: u64) {
    let now = mono_us();
    let Ok(mut clocks) = clocks().lock() else {
        return;
    };
    let clock = clocks.entry(track_key.to_string()).or_default();
    smooth(
        &mut clock.received_us,
        now as f64 - timestamp_us as f64,
        VIDEO_OFFSET_ALPHA,
    );
}

/// How long to hold the frame stamped `timestamp_us` before decoding it so the
/// picture waits for its sound. `None`: present as soon as decoded.
pub fn video_hold(track_key: &str, timestamp_us: u64) -> Option<Duration> {
    let now = mono_us();
    let clocks = clocks().lock().ok()?;
    let clock = clocks.get(track_key)?;
    if clock.hold_us < 1_000.0 {
        return None;
    }
    // On the frame's own schedule (its stamp plus the usual arrival distance)
    // rather than its arrival: a frame that came early waits its turn, a late
    // one is not held longer.
    let due = timestamp_us as f64 + clock.received_us? + clock.hold_us;
    let wait = due - now as f64;
    (wait > 0.0).then(|| Duration::from_micros(wait.min(MAX_HOLD_US) as u64))
}

/// A frame of `track_key` captured at `timestamp_us` (sender clock) was just
/// handed to the screen, after being held `held_us`.
pub fn note_video_presented(track_key: &str, timestamp_us: u64, held_us: u64) {
    note_video_presented_at(track_key, timestamp_us, held_us, mono_us());
}

fn note_video_presented_at(track_key: &str, timestamp_us: u64, held_us: u64, now_us: u64) {
    let Ok(mut clocks) = clocks().lock() else {
        return;
    };
    let clock = clocks.entry(track_key.to_string()).or_default();
    let presented = now_us as f64 - timestamp_us as f64;
    smooth(&mut clock.presented_us, presented, VIDEO_OFFSET_ALPHA);
    smooth(
        &mut clock.natural_us,
        presented - held_us as f64,
        VIDEO_OFFSET_ALPHA,
    );
    clock.last_ts_us = timestamp_us;
    clock.last_at_us = now_us;

    // Hold the picture by however much longer the sound's path is.
    let audio_live = now_us.saturating_sub(clock.audio_at_us) <= AUDIO_REPORT_STALE_US;
    let target = match (audio_live, clock.audio_floor_us, clock.natural_us) {
        (true, Some(floor), Some(natural)) => {
            (floor + AUDIO_MARGIN_US - natural).clamp(0.0, MAX_HOLD_US)
        }
        _ => 0.0,
    };
    if target == 0.0 && !audio_live {
        // No sound to wait for: show the picture at once.
        clock.hold_us = 0.0;
    } else {
        clock.hold_us += HOLD_ALPHA * (target - clock.hold_us);
    }
}

#[derive(Clone, Copy, Debug)]
struct PictureClock {
    presented_us: f64,
    hold_us: f64,
    last_ts_us: u64,
}

fn picture_clock(track_key: &str, now_us: u64) -> Option<PictureClock> {
    let clocks = clocks().lock().ok()?;
    let clock = clocks.get(track_key)?;
    if now_us.saturating_sub(clock.last_at_us) > VIDEO_CLOCK_STALE_US {
        return None;
    }
    Some(PictureClock {
        presented_us: clock.presented_us?,
        hold_us: clock.hold_us,
        last_ts_us: clock.last_ts_us,
    })
}

fn note_audio_floor(track_key: &str, floor_us: f64, now_us: u64) {
    let Ok(mut clocks) = clocks().lock() else {
        return;
    };
    let clock = clocks.entry(track_key.to_string()).or_default();
    clock.audio_floor_us = Some(match clock.audio_floor_us {
        // A new timeline (the share restarted its clock): start over.
        Some(previous) if (floor_us - previous).abs() > VIDEO_OFFSET_RESET_US => floor_us,
        Some(previous) => {
            let step = (floor_us - previous).clamp(-AUDIO_FLOOR_STEP_US, AUDIO_FLOOR_STEP_US);
            previous + AUDIO_FLOOR_ALPHA * step
        }
        None => floor_us,
    });
    clock.audio_at_us = now_us;
}

/// The sender-clock microseconds of a 48 kHz audio stamp, unwrapped next to
/// `reference_us` (a recent video stamp of the same share).
fn unwrap_audio_us(timestamp: u32, reference_us: u64) -> f64 {
    let candidate = timestamp as f64 * 1_000_000.0 / TICKS_PER_SECOND;
    let wraps = ((reference_us as f64 - candidate) / AUDIO_WRAP_US).round();
    candidate + wraps * AUDIO_WRAP_US
}

// ── Viewer: the audio playout ─────────────────────────────────────────────

/// What the stream-audio playout does with the head of its jitter buffer this
/// 20 ms tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncAction {
    /// Play the next frame.
    Play,
    /// Audio is early: play nothing new this tick (concealment once playing,
    /// silence before), so the buffered frames wait 20 ms longer.
    Hold,
    /// Audio is late: skip the next frame and play the one after it.
    Skip,
}

/// Per-stream-audio-source scheduling state.
#[derive(Debug)]
pub struct AudioSync {
    track_key: String,
    error_us: Option<f64>,
    last_correction_us: u64,
    last_log_us: u64,
    holds: u64,
    skips: u64,
    /// Ticks the audio was late with nothing buffered to skip to (the
    /// picture's hold has not caught up yet, or is at its limit).
    starved_late: u64,
}

/// What the playout knows this tick.
#[derive(Clone, Copy, Debug)]
pub struct PlayoutState {
    /// The 48 kHz stamp of the jitter buffer's next frame, if it is there.
    pub head_timestamp: Option<u32>,
    /// The 48 kHz stamp of the newest frame buffered.
    pub newest_timestamp: Option<u32>,
    /// Frames buffered, the head included (a skip needs two).
    pub buffered: usize,
    /// How long from now until a frame handed to the mixer now is heard.
    pub output_latency_us: Option<u64>,
    /// Whether this source has played yet.
    pub has_played: bool,
}

impl AudioSync {
    /// Scheduling for the screen audio of `stream_id`.
    pub fn new(stream_id: &str) -> Self {
        Self {
            track_key: screen_track_key(stream_id),
            error_us: None,
            last_correction_us: 0,
            last_log_us: mono_us(),
            holds: 0,
            skips: 0,
            starved_late: 0,
        }
    }

    pub fn plan(&mut self, state: PlayoutState) -> SyncAction {
        let now = mono_us();
        let picture = picture_clock(&self.track_key, now);
        let action = self.plan_at(state, picture, now);
        if now.saturating_sub(self.last_log_us) >= SYNC_LOG_INTERVAL_US {
            self.last_log_us = now;
            let floor = clocks()
                .lock()
                .ok()
                .and_then(|c| c.get(&self.track_key).and_then(|c| c.audio_floor_us));
            let natural = clocks()
                .lock()
                .ok()
                .and_then(|c| c.get(&self.track_key).and_then(|c| c.natural_us));
            tracing::info!(
                track = %self.track_key,
                error_ms = ?self.error_us.map(|e| (e / 1000.0).round()),
                picture_hold_ms = ?picture.map(|p| (p.hold_us / 1000.0).round()),
                audio_floor_minus_picture_ms = ?floor.zip(natural).map(|(f, n)| ((f - n) / 1000.0).round()),
                output_ms = ?state.output_latency_us.map(|l| l / 1000),
                buffered = state.buffered,
                holds = self.holds,
                skips = self.skips,
                starved_late = self.starved_late,
                "av-sync: stream audio against its picture (error + = audio late)"
            );
            if self.starved_late > 25 {
                tracing::warn!(
                    track = %self.track_key,
                    ticks = self.starved_late,
                    "av-sync: stream audio was behind its picture with nothing buffered to skip to"
                );
            }
            self.starved_late = 0;
        }
        action
    }

    fn plan_at(
        &mut self,
        state: PlayoutState,
        picture: Option<PictureClock>,
        now_us: u64,
    ) -> SyncAction {
        let (Some(picture), Some(output_latency_us)) = (picture, state.output_latency_us) else {
            // No picture to follow (paused, hidden, not decoded yet): play free.
            self.error_us = None;
            return SyncAction::Play;
        };
        let heard_if_now = now_us as f64 + output_latency_us as f64;
        // The earliest this sound could be heard behind its capture: the newest
        // frame, played now. The picture is held to meet it.
        if let Some(newest) = state.newest_timestamp {
            let newest_us = unwrap_audio_us(newest, picture.last_ts_us);
            if (newest_us - picture.last_ts_us as f64).abs() <= TIMELINE_MISMATCH_US {
                note_audio_floor(&self.track_key, heard_if_now - newest_us, now_us);
            }
        }
        let Some(head) = state.head_timestamp else {
            self.error_us = None;
            return SyncAction::Play;
        };
        let audio_us = unwrap_audio_us(head, picture.last_ts_us);
        if (audio_us - picture.last_ts_us as f64).abs() > TIMELINE_MISMATCH_US {
            self.error_us = None;
            return SyncAction::Play;
        }
        // When the head frame should be heard (its picture's presentation),
        // and when it would be if the mixer got it now. Positive: late.
        let due_us = audio_us + picture.presented_us;
        let sample = heard_if_now - due_us;
        let error = match self.error_us {
            // Before the first sound there is nothing to smooth: start on time.
            Some(previous) if state.has_played => previous + SYNC_ERROR_ALPHA * (sample - previous),
            _ => sample,
        };
        self.error_us = Some(error);

        if error.abs() <= SYNC_TOLERANCE_US {
            return SyncAction::Play;
        }
        let since_correction = now_us.saturating_sub(self.last_correction_us);
        if state.has_played
            && error.abs() < SYNC_FAST_US
            && since_correction < SYNC_CORRECTION_SPACING_US
        {
            return SyncAction::Play;
        }
        if error < 0.0 {
            if state.buffered >= MAX_HELD_FRAMES {
                return SyncAction::Play;
            }
            self.correct(now_us, -AUDIO_FRAME_US);
            self.holds += 1;
            SyncAction::Hold
        } else if state.buffered >= 2 {
            self.correct(now_us, AUDIO_FRAME_US);
            self.skips += 1;
            SyncAction::Skip
        } else {
            self.starved_late += 1;
            SyncAction::Play
        }
    }

    /// A correction moves the audio by one frame; the smoothed error moves with
    /// it so the next tick does not correct the same error again.
    fn correct(&mut self, now_us: u64, shift_us: f64) {
        self.last_correction_us = now_us;
        if let Some(error) = self.error_us.as_mut() {
            *error -= shift_us;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(presented_ms: f64, last_ts_us: u64) -> PictureClock {
        PictureClock {
            presented_us: presented_ms * 1000.0,
            hold_us: 0.0,
            last_ts_us,
        }
    }

    fn state(head_ms: u64, buffered: usize, output_ms: u64, has_played: bool) -> PlayoutState {
        PlayoutState {
            head_timestamp: Some((head_ms * 48) as u32),
            newest_timestamp: Some(
                ((head_ms + 20 * buffered.saturating_sub(1) as u64) * 48) as u32,
            ),
            buffered,
            output_latency_us: Some(output_ms * 1000),
            has_played,
        }
    }

    #[test]
    fn share_clock_stamps_audio_and_video_from_one_zero_point() {
        let clock = ShareClock::default();
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert_eq!(clock.base_or_init(t0), t0);
        let later = t0 + Duration::from_millis(250);
        assert_eq!(clock.audio_timestamp(later), 250 * 48);
        // A frame captured before the zero point reads as slightly negative.
        let before = t0 - Duration::from_millis(10);
        assert_eq!(
            unwrap_audio_us(clock.audio_timestamp(before), 0).round(),
            -10_000.0
        );
        clock.reset();
        assert_eq!(clock.base_or_init(later), later);
    }

    #[test]
    fn audio_stamps_unwrap_next_to_the_picture() {
        let wrapped = (AUDIO_WRAP_US as u64) + 5_000_000;
        let stamp = (5_000_000u64 * 48 / 1000) as u32;
        assert!((unwrap_audio_us(stamp, wrapped) - wrapped as f64).abs() < 1.0);
        assert!((unwrap_audio_us(stamp, 5_100_000) - 5_000_000.0).abs() < 1.0);
    }

    #[test]
    fn picture_distances_smooth_jitter_and_reset_on_a_new_timeline() {
        let key = "test:smooth:screen";
        note_video_presented_at(key, 1_000_000, 0, 1_050_000);
        note_video_presented_at(key, 1_033_000, 0, 1_093_000); // 60 ms this time
        let c = picture_clock(key, 1_093_000).unwrap();
        assert!(
            (c.presented_us - 51_000.0).abs() < 1.0,
            "{}",
            c.presented_us
        );
        // The sender restarted its share clock: stamps start again near zero.
        note_video_presented_at(key, 10_000, 0, 2_000_000);
        let c = picture_clock(key, 2_000_000).unwrap();
        assert_eq!(c.presented_us, 1_990_000.0);
        assert!(picture_clock(key, 2_000_000 + VIDEO_CLOCK_STALE_US + 1).is_none());
    }

    #[test]
    fn the_picture_is_held_by_how_much_longer_the_sound_takes() {
        let key = "test:hold:screen";
        // The sound can at best be heard 150 ms after capture; the picture
        // shows 50 ms after. Over a few seconds of frames the hold settles at
        // the difference plus the margin.
        let mut now = 10_000_000u64;
        let mut ts = 9_950_000u64;
        for _ in 0..200 {
            note_audio_floor(key, 150_000.0, now);
            let held = clocks().lock().unwrap().get(key).map_or(0.0, |c| c.hold_us);
            note_video_presented_at(key, ts, held as u64, now + held as u64);
            now += 16_667;
            ts += 16_667;
        }
        let hold = clocks().lock().unwrap().get(key).unwrap().hold_us;
        assert!((hold - 120_000.0).abs() < 5_000.0, "{hold}");
        // The sound goes away: the picture is shown at once again.
        now += AUDIO_REPORT_STALE_US + 1;
        note_video_presented_at(key, ts, 0, now);
        assert_eq!(clocks().lock().unwrap().get(key).unwrap().hold_us, 0.0);
    }

    #[test]
    fn frames_are_held_on_their_own_schedule() {
        let key = "test:schedule:screen";
        // Sender stamps far ahead of this process's young monotonic clock.
        note_video_received(key, 1_000_000_000);
        {
            let mut clocks = clocks().lock().unwrap();
            let clock = clocks.get_mut(key).unwrap();
            clock.hold_us = 80_000.0;
        }
        let received = clocks()
            .lock()
            .unwrap()
            .get(key)
            .unwrap()
            .received_us
            .unwrap();
        // A frame stamped now - received arrives "on time"; it waits the hold.
        let now = mono_us() as f64;
        let wait = video_hold(key, (now - received) as u64).unwrap();
        assert!(
            wait.as_micros() > 70_000 && wait.as_micros() <= 80_000,
            "{wait:?}"
        );
        // One that is already 100 ms behind its schedule is not held at all.
        assert!(video_hold(key, (now - received - 100_000.0) as u64).is_none());
    }

    #[test]
    fn audio_that_would_be_heard_on_time_plays() {
        let mut sync = AudioSync::new("s");
        // Picture: 50 ms after capture. Audio head captured at 1000 ms; now is
        // local 1000 ms; heard 50 ms from now → exactly on time.
        assert_eq!(
            sync.plan_at(
                state(1_000, 3, 50, true),
                Some(picture(50.0, 1_000_000)),
                1_000_000
            ),
            SyncAction::Play
        );
    }

    #[test]
    fn late_audio_skips_and_early_audio_holds() {
        let p = picture(50.0, 1_000_000);
        let mut sync = AudioSync::new("s");
        assert_eq!(
            sync.plan_at(state(1_000, 4, 150, true), Some(p), 1_000_000),
            SyncAction::Skip
        );
        // Audio would be heard 40 ms before its picture: wait.
        let mut sync = AudioSync::new("s");
        assert_eq!(
            sync.plan_at(state(1_000, 4, 10, false), Some(p), 1_000_000),
            SyncAction::Hold
        );
    }

    #[test]
    fn late_audio_with_nothing_to_skip_to_plays_and_is_counted() {
        let mut sync = AudioSync::new("s");
        assert_eq!(
            sync.plan_at(
                state(1_000, 1, 150, true),
                Some(picture(50.0, 1_000_000)),
                1_000_000
            ),
            SyncAction::Play
        );
        assert_eq!(sync.starved_late, 1);
    }

    #[test]
    fn small_errors_are_corrected_at_most_every_200_ms() {
        let mut sync = AudioSync::new("s");
        // 40 ms late: past the band, below the fast threshold.
        assert_eq!(
            sync.plan_at(
                state(1_000, 4, 90, false),
                Some(picture(50.0, 1_000_000)),
                1_000_000
            ),
            SyncAction::Skip
        );
        // 20 ms later the smoothed error, which already counts the skip, is
        // still outside the band, but the last correction was too recent.
        assert_eq!(
            sync.plan_at(
                state(1_000, 4, 110, true),
                Some(picture(50.0, 1_020_000)),
                1_020_000
            ),
            SyncAction::Play
        );
    }

    #[test]
    fn no_picture_means_free_play() {
        let mut sync = AudioSync::new("s");
        assert_eq!(
            sync.plan_at(state(1_000, 4, 500, true), None, 1_000_000),
            SyncAction::Play
        );
        // A picture on another timeline (sender restarted) is not followed.
        assert_eq!(
            sync.plan_at(
                state(1_000, 4, 500, true),
                Some(picture(50.0, 900_000_000)),
                1_000_000
            ),
            SyncAction::Play
        );
    }
}
