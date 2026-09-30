//! Clips on the desktop app (docs/glass-spec.md §6.4): a 30 second ring of the
//! watched screen share's decrypted encoded frames and its own Opus packets,
//! kept in the native process because that is where the stream is decrypted
//! and decoded here (the native-surface route never hands a frame to the
//! webview, and stream audio always plays natively).
//!
//! The rules and constants mirror `client/src/lib/media/clips/clipRing.ts`:
//! whole GOPs, the newest keyframe at or before now − 30 s kept, a 64 MiB
//! budget with the oldest GOP dropped first, a single GOP over the budget
//! dropped until the next keyframe, audio kept from a second before the oldest
//! video. The webview cuts a clip with `media_clip_cut`, which returns the
//! frames in the binary layout `nativeClipSource.ts` reads; the timeline and
//! the muxing are the webview's, shared with the browser.
//!
//! Nothing is buffered unless a clip is armed (`media_clip_arm`, while the
//! stage watches a stream), and disarming frees everything. Only frames that
//! reach this process decrypted are kept: a frame this client cannot decrypt
//! never gets here, and no key or ciphertext is ever stored or handed out.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

pub const CLIP_WINDOW_US: u64 = 30_000_000;
pub const CLIP_BUFFER_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const CLIP_AUDIO_LEAD_US: u64 = 1_000_000;
/// A sequence jump larger than this (about a minute of 20 ms packets) starts a new audio stream.
const AUDIO_RESTART_SEQ_GAP: i64 = 3_000;
/// The track a watch shows, and its own audio (the relay's viewable stream).
const SCREEN_TRACK: &str = "screen";
const SCREEN_AUDIO_TRACK: &str = "screen-audio";

/// Codec tags in the cut layout, matching `VideoCodec::header_id`.
pub const CODEC_NONE: u8 = 0;

const CUT_MAGIC: &[u8; 4] = b"PCLP";
const CUT_VERSION: u8 = 1;

struct VideoFrame {
    arrival_us: u64,
    sender_us: u64,
    key: bool,
    data: Vec<u8>,
}

struct Gop {
    frames: Vec<VideoFrame>,
    bytes: usize,
}

struct AudioPacket {
    arrival_us: u64,
    seq: i64,
    data: Vec<u8>,
}

/// The ring itself, on an explicit clock (µs since arming) so it can be tested.
pub struct ClipRing {
    window_us: u64,
    max_bytes: usize,
    gops: VecDeque<Gop>,
    audio: VecDeque<AudioPacket>,
    video_bytes: usize,
    audio_bytes: usize,
    codec: u8,
    need_keyframe: bool,
    last_sender_us: Option<u64>,
    last_seq: Option<i64>,
    newest_arrival_us: u64,
}

impl ClipRing {
    pub fn new(window_us: u64, max_bytes: usize) -> Self {
        Self {
            window_us,
            max_bytes,
            gops: VecDeque::new(),
            audio: VecDeque::new(),
            video_bytes: 0,
            audio_bytes: 0,
            codec: CODEC_NONE,
            need_keyframe: true,
            last_sender_us: None,
            last_seq: None,
            newest_arrival_us: 0,
        }
    }

    pub fn bytes(&self) -> usize {
        self.video_bytes + self.audio_bytes
    }

    pub fn video_frame_count(&self) -> usize {
        self.gops.iter().map(|gop| gop.frames.len()).sum()
    }

    #[cfg(test)]
    pub fn audio_packet_count(&self) -> usize {
        self.audio.len()
    }

    fn reset_video(&mut self) {
        self.gops.clear();
        self.video_bytes = 0;
        self.last_sender_us = None;
    }

    pub fn push_video(
        &mut self,
        arrival_us: u64,
        codec: u8,
        key: bool,
        sender_us: u64,
        data: &[u8],
    ) {
        if key {
            // A new codec, or a sender clock that went back (the share restarted),
            // starts a new stream: nothing before it can be muxed with it.
            let restarted = self.last_sender_us.is_some_and(|last| sender_us < last);
            if (self.codec != CODEC_NONE && codec != self.codec) || restarted {
                self.reset_video();
            }
            self.codec = codec;
            self.need_keyframe = false;
            self.gops.push_back(Gop {
                frames: Vec::new(),
                bytes: 0,
            });
        } else {
            if self.need_keyframe || self.gops.is_empty() || codec != self.codec {
                return;
            }
            if self.last_sender_us.is_some_and(|last| sender_us < last) {
                return; // older than what the chain already holds
            }
        }
        let gop = self.gops.back_mut().expect("a GOP is open");
        gop.frames.push(VideoFrame {
            arrival_us,
            sender_us,
            key,
            data: data.to_vec(),
        });
        gop.bytes += data.len();
        self.video_bytes += data.len();
        self.last_sender_us = Some(sender_us);
        self.advance(arrival_us);
    }

    pub fn push_audio(&mut self, arrival_us: u64, seq16: u16, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let seq = match self.last_seq {
            None => i64::from(seq16),
            Some(last) => {
                let delta = i64::from(seq16.wrapping_sub((last & 0xffff) as u16) as i16);
                if delta.abs() > AUDIO_RESTART_SEQ_GAP {
                    self.audio.clear();
                    self.audio_bytes = 0;
                    i64::from(seq16)
                } else {
                    last + delta
                }
            }
        };
        // Keep sequence order; a late packet slots in, a duplicate is dropped.
        let mut at = self.audio.len();
        while at > 0 && self.audio[at - 1].seq > seq {
            at -= 1;
        }
        if at > 0 && self.audio[at - 1].seq == seq {
            return;
        }
        self.audio.insert(
            at,
            AudioPacket {
                arrival_us,
                seq,
                data: data.to_vec(),
            },
        );
        self.audio_bytes += data.len();
        if self.last_seq.is_none_or(|last| seq > last) {
            self.last_seq = Some(seq);
        }
        self.advance(arrival_us);
    }

    fn advance(&mut self, arrival_us: u64) {
        self.newest_arrival_us = self.newest_arrival_us.max(arrival_us);
        self.prune(self.newest_arrival_us);
    }

    fn drop_oldest_gop(&mut self) {
        if let Some(gop) = self.gops.pop_front() {
            self.video_bytes -= gop.bytes;
        }
    }

    fn prune(&mut self, now_us: u64) {
        let horizon = now_us.saturating_sub(self.window_us);
        let before_horizon = now_us >= self.window_us;
        // Keep the newest keyframe at or before the horizon; drop the GOPs before it.
        while before_horizon && self.gops.len() >= 2 && self.gops[1].frames[0].arrival_us <= horizon
        {
            self.drop_oldest_gop();
        }
        while self.bytes() > self.max_bytes && self.gops.len() >= 2 {
            self.drop_oldest_gop();
        }
        if self.bytes() > self.max_bytes && self.gops.len() == 1 {
            self.reset_video();
            self.need_keyframe = true;
        }
        let audio_from = match self.gops.front() {
            Some(gop) => gop.frames[0].arrival_us,
            None => horizon,
        }
        .saturating_sub(CLIP_AUDIO_LEAD_US);
        while self
            .audio
            .front()
            .is_some_and(|packet| packet.arrival_us < audio_from)
        {
            let packet = self.audio.pop_front().expect("checked");
            self.audio_bytes -= packet.data.len();
        }
        while self.bytes() > self.max_bytes {
            let Some(packet) = self.audio.pop_front() else {
                break;
            };
            self.audio_bytes -= packet.data.len();
        }
    }

    /// Everything held at `now_us`, in the layout `nativeClipSource.ts` reads
    /// (little-endian):
    ///
    /// ```text
    /// "PCLP" | version u8 | codec u8 | reserved u16 | now_us u64
    /// video_count u32 | { arrival_us u64, sender_us u64, key u8, len u32, bytes }*
    /// audio_count u32 | { arrival_us u64, seq i64, len u32, bytes }*
    /// ```
    pub fn cut(&mut self, now_us: u64) -> Vec<u8> {
        self.advance(now_us);
        let codec = if self.gops.is_empty() {
            CODEC_NONE
        } else {
            self.codec
        };
        let mut out = Vec::with_capacity(
            32 + self.bytes() + self.video_frame_count() * 21 + self.audio.len() * 20,
        );
        out.extend_from_slice(CUT_MAGIC);
        out.push(CUT_VERSION);
        out.push(codec);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&now_us.to_le_bytes());
        out.extend_from_slice(&(self.video_frame_count() as u32).to_le_bytes());
        for frame in self.gops.iter().flat_map(|gop| gop.frames.iter()) {
            out.extend_from_slice(&frame.arrival_us.to_le_bytes());
            out.extend_from_slice(&frame.sender_us.to_le_bytes());
            out.push(u8::from(frame.key));
            out.extend_from_slice(&(frame.data.len() as u32).to_le_bytes());
            out.extend_from_slice(&frame.data);
        }
        out.extend_from_slice(&(self.audio.len() as u32).to_le_bytes());
        for packet in &self.audio {
            out.extend_from_slice(&packet.arrival_us.to_le_bytes());
            out.extend_from_slice(&packet.seq.to_le_bytes());
            out.extend_from_slice(&(packet.data.len() as u32).to_le_bytes());
            out.extend_from_slice(&packet.data);
        }
        out
    }
}

// ── The process-wide clip ─────────────────────────────────────────────────────

struct TrackInfo {
    publisher_user_id: i64,
    track_id: String,
    ssrcs: Vec<u32>,
}

struct Armed {
    publisher_user_id: i64,
    epoch: Instant,
    ring: ClipRing,
}

#[derive(Default)]
struct ClipState {
    armed: Option<Armed>,
    /// Remote screen and screen-audio tracks by `stream_id:track_id`, from the
    /// relay's track announcements: who publishes a frame's track, and which
    /// SSRCs carry a stream's audio.
    tracks: HashMap<String, TrackInfo>,
}

/// Fast path for the media tasks: nothing is locked while no clip is armed.
static ARMED: AtomicBool = AtomicBool::new(false);

fn clip_state() -> &'static Mutex<ClipState> {
    static STATE: OnceLock<Mutex<ClipState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ClipState::default()))
}

fn track_key(stream_id: &str, track_id: &str) -> String {
    format!("{stream_id}:{track_id}")
}

/// Record a remote track the relay announced (TrackPublish / TrackLayers).
pub fn note_track(stream_id: &str, track_id: &str, publisher_user_id: i64, ssrcs: Vec<u32>) {
    if track_id != SCREEN_TRACK && track_id != SCREEN_AUDIO_TRACK {
        return;
    }
    if let Ok(mut state) = clip_state().lock() {
        state.tracks.insert(
            track_key(stream_id, track_id),
            TrackInfo {
                publisher_user_id,
                track_id: track_id.to_string(),
                ssrcs,
            },
        );
    }
}

/// Forget a remote track (TrackUnpublish).
pub fn forget_track(stream_id: &str, track_id: &str) {
    if let Ok(mut state) = clip_state().lock() {
        state.tracks.remove(&track_key(stream_id, track_id));
    }
}

/// Decoder intake tap for video: one decrypted, reordered encoded frame of
/// `track_key` (`stream_id:track_id`). `codec` is `VideoCodec::header_id`.
pub fn note_video_frame(track_key: &str, codec: u8, key: bool, sender_us: u64, data: &[u8]) {
    if !ARMED.load(Ordering::Relaxed) {
        return;
    }
    let Ok(mut state) = clip_state().lock() else {
        return;
    };
    let publisher = match state.tracks.get(track_key) {
        Some(track) if track.track_id == SCREEN_TRACK => track.publisher_user_id,
        _ => return,
    };
    let Some(armed) = state.armed.as_mut() else {
        return;
    };
    if armed.publisher_user_id != publisher {
        return;
    }
    let arrival_us = armed.epoch.elapsed().as_micros() as u64;
    armed
        .ring
        .push_video(arrival_us, codec, key, sender_us, data);
}

/// Decoder intake tap for audio: one decrypted audio datagram. Only the armed
/// publisher's screen audio is kept; voices never are.
pub fn note_audio_datagram(ssrc: u32, seq: u16, data: &[u8]) {
    if !ARMED.load(Ordering::Relaxed) {
        return;
    }
    let Ok(mut state) = clip_state().lock() else {
        return;
    };
    let Some(publisher) = state
        .tracks
        .values()
        .find(|track| track.track_id == SCREEN_AUDIO_TRACK && track.ssrcs.contains(&ssrc))
        .map(|track| track.publisher_user_id)
    else {
        return;
    };
    let Some(armed) = state.armed.as_mut() else {
        return;
    };
    if armed.publisher_user_id != publisher {
        return;
    }
    let arrival_us = armed.epoch.elapsed().as_micros() as u64;
    armed.ring.push_audio(arrival_us, seq, data);
}

/// Start buffering `publisher_user_id`'s screen share, dropping any other clip.
/// Arming the same publisher again keeps what is held (the watch moved to
/// another connection, e.g. into or out of the call).
pub fn arm(publisher_user_id: i64) {
    if let Ok(mut state) = clip_state().lock() {
        match state.armed.as_mut() {
            Some(armed) if armed.publisher_user_id == publisher_user_id => {}
            _ => {
                state.armed = Some(Armed {
                    publisher_user_id,
                    epoch: Instant::now(),
                    ring: ClipRing::new(CLIP_WINDOW_US, CLIP_BUFFER_MAX_BYTES),
                });
            }
        }
        ARMED.store(true, Ordering::Relaxed);
    }
}

/// Stop buffering and free everything held.
pub fn disarm() {
    ARMED.store(false, Ordering::Relaxed);
    if let Ok(mut state) = clip_state().lock() {
        state.armed = None;
    }
}

/// The armed clip's frames, now.
pub fn cut() -> Result<Vec<u8>, String> {
    let mut state = clip_state()
        .lock()
        .map_err(|_| "The clip buffer is unavailable.".to_string())?;
    let armed = state
        .armed
        .as_mut()
        .ok_or_else(|| "No stream is being clipped.".to_string())?;
    let now_us = armed.epoch.elapsed().as_micros() as u64;
    Ok(armed.ring.cut(now_us))
}

#[tauri::command]
pub fn media_clip_arm(publisher_user_id: String) -> Result<(), String> {
    let publisher = publisher_user_id
        .parse::<i64>()
        .map_err(|_| "A clip needs the sharer's user id.".to_string())?;
    arm(publisher);
    Ok(())
}

#[tauri::command]
pub fn media_clip_disarm() {
    disarm();
}

#[tauri::command]
pub fn media_clip_cut() -> Result<tauri::ipc::Response, String> {
    cut().map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME_US: u64 = 33_333;

    fn feed(ring: &mut ClipRing, frames: std::ops::Range<u64>, gop_frames: u64, bytes: usize) {
        for i in frames {
            let t = i * FRAME_US;
            let key = i % gop_frames == 0;
            ring.push_video(
                t + 40_000,
                1,
                key,
                t,
                &vec![0u8; if key { 2_000 } else { bytes }],
            );
        }
    }

    fn first_frame(ring: &ClipRing) -> &VideoFrame {
        &ring.gops[0].frames[0]
    }

    #[test]
    fn starts_on_a_keyframe_and_ignores_deltas_before_it() {
        let mut ring = ClipRing::new(CLIP_WINDOW_US, CLIP_BUFFER_MAX_BYTES);
        ring.push_video(0, 1, false, 0, &[1]);
        assert_eq!(ring.video_frame_count(), 0);
        ring.push_video(10, 1, true, 10, &[1]);
        ring.push_video(20, 1, false, 20, &[1]);
        assert_eq!(ring.video_frame_count(), 2);
        assert!(first_frame(&ring).key);
    }

    #[test]
    fn keeps_the_newest_keyframe_at_or_before_the_horizon() {
        let mut ring = ClipRing::new(CLIP_WINDOW_US, CLIP_BUFFER_MAX_BYTES);
        feed(&mut ring, 0..1_830, 150, 200); // 61 s, keyframes every 5 s
        let now = ring.newest_arrival_us;
        let first = first_frame(&ring);
        assert!(first.key);
        assert!(first.arrival_us <= now - CLIP_WINDOW_US);
        let next_key = ring.gops[1].frames[0].arrival_us;
        assert!(next_key > now - CLIP_WINDOW_US);
        assert_eq!(ring.gops.len(), 7);
    }

    #[test]
    fn drops_the_oldest_gops_to_stay_in_budget() {
        let mut ring = ClipRing::new(CLIP_WINDOW_US, 50_000);
        feed(&mut ring, 0..600, 150, 200);
        assert!(ring.bytes() <= 50_000);
        assert_eq!(first_frame(&ring).sender_us, 450 * FRAME_US);
    }

    #[test]
    fn drops_a_gop_bigger_than_the_budget_and_waits_for_a_keyframe() {
        let mut ring = ClipRing::new(CLIP_WINDOW_US, 10_000);
        feed(&mut ring, 0..120, 1_000, 500);
        assert_eq!(ring.bytes(), 0);
        ring.push_video(5_000_000, 1, false, 4_999_000, &[1]);
        assert_eq!(ring.video_frame_count(), 0);
        ring.push_video(5_100_000, 1, true, 5_000_000, &[1]);
        assert_eq!(ring.video_frame_count(), 1);
    }

    #[test]
    fn restarts_on_a_codec_change_or_a_sender_clock_going_back() {
        let mut ring = ClipRing::new(CLIP_WINDOW_US, CLIP_BUFFER_MAX_BYTES);
        feed(&mut ring, 0..30, 10, 100);
        ring.push_video(2_000_000, 3, true, 2_000_000, &[1]);
        assert_eq!(ring.video_frame_count(), 1);
        ring.push_video(2_100_000, 3, true, 5, &[1]);
        assert_eq!(ring.video_frame_count(), 1);
        assert_eq!(first_frame(&ring).sender_us, 5);
    }

    #[test]
    fn orders_audio_across_the_sequence_wrap() {
        let mut ring = ClipRing::new(CLIP_WINDOW_US, CLIP_BUFFER_MAX_BYTES);
        ring.push_video(0, 1, true, 0, &[1]);
        for (i, seq) in [65_533u16, 65_535, 65_534, 0, 1, 1, 2]
            .into_iter()
            .enumerate()
        {
            ring.push_audio(10 + i as u64 * 20_000, seq, &[8, i as u8]);
        }
        let seqs: Vec<i64> = ring.audio.iter().map(|p| p.seq).collect();
        assert_eq!(seqs, vec![65_533, 65_534, 65_535, 65_536, 65_537, 65_538]);
    }

    #[test]
    fn the_cut_layout_round_trips() {
        let mut ring = ClipRing::new(CLIP_WINDOW_US, CLIP_BUFFER_MAX_BYTES);
        ring.push_video(100, 2, true, 7_000, &[1, 2, 3]);
        ring.push_video(200, 2, false, 40_000, &[4]);
        ring.push_audio(150, 9, &[0x08, 0xaa]);
        let bytes = ring.cut(300);
        assert_eq!(&bytes[..4], b"PCLP");
        assert_eq!(bytes[4], 1);
        assert_eq!(bytes[5], 2);
        assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 300);
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 2);
        // First frame: arrival 100, sender 7000, key, 3 bytes.
        assert_eq!(u64::from_le_bytes(bytes[20..28].try_into().unwrap()), 100);
        assert_eq!(u64::from_le_bytes(bytes[28..36].try_into().unwrap()), 7_000);
        assert_eq!(bytes[36], 1);
        assert_eq!(u32::from_le_bytes(bytes[37..41].try_into().unwrap()), 3);
        assert_eq!(&bytes[41..44], &[1, 2, 3]);
        let audio_at = 44 + 8 + 8 + 1 + 4 + 1;
        assert_eq!(
            u32::from_le_bytes(bytes[audio_at..audio_at + 4].try_into().unwrap()),
            1
        );
        assert_eq!(bytes.len(), audio_at + 4 + 8 + 8 + 4 + 2);
    }

    #[test]
    fn only_the_armed_publishers_screen_is_kept_and_disarming_frees_it() {
        // The process-wide state is shared across tests in this module only here.
        note_track("stream:7:screen", "screen", 7, vec![71]);
        note_track("stream:7:screen", "screen-audio", 7, vec![72]);
        note_track("stream:8:camera", "camera", 8, vec![81]); // never recorded
        note_track("stream:9:screen", "screen", 9, vec![91]);

        note_video_frame("stream:7:screen:screen", 1, true, 0, &[1]);
        assert!(
            clip_state().lock().unwrap().armed.is_none(),
            "nothing is buffered before arming"
        );

        arm(7);
        note_video_frame("stream:7:screen:screen", 1, true, 0, &[1]);
        note_video_frame("stream:9:screen:screen", 1, true, 0, &[1]); // another sharer
        note_video_frame("stream:8:camera:camera", 1, true, 0, &[1]);
        note_audio_datagram(72, 1, &[8]);
        note_audio_datagram(81, 1, &[8]); // not a stream's audio
        {
            let state = clip_state().lock().unwrap();
            let armed = state.armed.as_ref().unwrap();
            assert_eq!(armed.ring.video_frame_count(), 1);
            assert_eq!(armed.ring.audio_packet_count(), 1);
        }
        // Arming the same sharer again keeps what is held.
        arm(7);
        assert_eq!(
            clip_state()
                .lock()
                .unwrap()
                .armed
                .as_ref()
                .unwrap()
                .ring
                .video_frame_count(),
            1
        );
        let bytes = cut().unwrap();
        assert_eq!(bytes[5], 1);

        disarm();
        assert!(clip_state().lock().unwrap().armed.is_none());
        assert!(cut().is_err());
        forget_track("stream:7:screen", "screen");
        forget_track("stream:7:screen", "screen-audio");
        forget_track("stream:9:screen", "screen");
    }
}
