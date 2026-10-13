use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use paracord_codec::crypto::{FrameDecryptor, KEY_SIZE};
use paracord_transport::control::{SessionParticipant, SessionParticipantKind};
use tokio::time::interval;

use super::session::NativeMediaSession;
use paracord_transport::control::ControlMessage;
use paracord_transport::stream::{StreamId, TrackId};

/// Audio levels run 0 (loudest) to [`AUDIO_LEVEL_SILENCE`] (silence); see
/// `audio_pipeline::compute_audio_level`. A speaker turns "on" only once clearly
/// loud (level below [`SPEAKING_LEVEL_ON`]) and stays "on" until clearly quiet
/// (level at/above [`SPEAKING_LEVEL_OFF`]). The gap between the two thresholds is
/// the hysteresis band that stops a level hovering near one threshold from
/// flickering the indicator on and off.
const SPEAKING_LEVEL_ON: u8 = 95;
const SPEAKING_LEVEL_OFF: u8 = 110;
/// Once speaking, keep the indicator lit for at least this long after the level
/// goes quiet, so brief gaps between words do not drop it.
const SPEAKING_HOLD: Duration = Duration::from_millis(300);
/// Maximum value of the audio-level scale (silence), used to normalize the
/// reported speaking intensity into `0.0..=1.0`.
const AUDIO_LEVEL_SILENCE: u8 = 127;
/// How long a call waits for the first microphone frame before saying, out
/// loud, that nothing is arriving. Long enough for a device to settle, short
/// enough that the person is still wondering why nobody answered.
const MIC_SILENCE_DEADLINE: Duration = Duration::from_secs(3);

/// Per-speaker hysteresis state for the speaking detector. Debounces the raw
/// audio level into a stable speaking/not-speaking signal.
struct SpeakerHysteresis {
    speaking: bool,
    /// Last time the level was above the "on" loudness while speaking; the hold
    /// timer is measured from here so short quiet gaps do not drop the state.
    last_loud: Instant,
}

impl SpeakerHysteresis {
    fn new(now: Instant) -> Self {
        Self {
            speaking: false,
            last_loud: now,
        }
    }

    /// Fold one audio-level sample into the debounced state and return whether
    /// the speaker is currently considered speaking.
    fn update(&mut self, level: u8, now: Instant) -> bool {
        let is_loud = level < SPEAKING_LEVEL_ON;
        let is_quiet = level >= SPEAKING_LEVEL_OFF;
        if self.speaking {
            if is_loud {
                self.last_loud = now;
            }
            if is_quiet && now.duration_since(self.last_loud) >= SPEAKING_HOLD {
                self.speaking = false;
            }
        } else if is_loud {
            self.speaking = true;
            self.last_loud = now;
        }
        self.speaking
    }
}

/// Each participant's voice SSRC (`derive_track_ssrc(user, "audio")`, the
/// scheme every engine shares), to the user id the renderer knows them by.
fn voice_owners_of(user_ids: impl Iterator<Item = i64>) -> HashMap<u32, String> {
    user_ids
        .map(|user_id| {
            (
                NativeMediaSession::derive_track_ssrc(user_id, "audio"),
                user_id.to_string(),
            )
        })
        .collect()
}

/// The `media_speaking_change` payload: speaking user ids to their raw audio
/// level (-dBov). An SSRC nobody in the roster owns yet is left out until the
/// roster names it.
fn speakers_by_user(speaking: &[(u32, u8)], owners: &HashMap<u32, String>) -> HashMap<String, f64> {
    speaking
        .iter()
        .filter_map(|(ssrc, level)| {
            owners
                .get(ssrc)
                .map(|user| (user.clone(), f64::from((*level).min(AUDIO_LEVEL_SILENCE))))
        })
        .collect()
}

/// Spawn a task that periodically checks audio levels and emits speaking change events.
pub fn spawn_speaking_detector(session: &mut NativeMediaSession, app: super::CallEventSink) {
    let shutdown = session.shutdown.clone();
    let remote_audio = session.remote_audio.clone();
    // Your own microphone, on the same clock as everybody else's. The desktop
    // engine owns the capture graph, so nothing in the webview can measure this
    // — the level bar in the mic button and the in-call "is my microphone
    // working" readout sat at zero for the whole call until this reported it.
    let local_mic_level = session.local_mic_level.clone();
    let local_mic_frames = session.local_mic_frames.clone();
    let muted = session.muted.clone();
    let mic_capture_generation = session.mic_capture_generation.clone();
    // Who each voice SSRC belongs to. The renderer files speakers by user id
    // (the card's rows, the call tiles, `--voice-level`), as the browser engine
    // reports them; an SSRC there matches nobody, so nobody ever showed as
    // talking in a desktop call.
    let session_participants = session.session_participants.clone();

    let handle = tokio::spawn(async move {
        let mut tick = interval(Duration::from_millis(100));
        let mut hysteresis: HashMap<u32, SpeakerHysteresis> = HashMap::new();
        let mut voice_owners: HashMap<u32, String> = HashMap::new();
        let mut last_frame_count = local_mic_frames.load(Ordering::Relaxed);
        let mut last_local_emit: Option<(u8, bool)> = None;
        // A microphone that opened and then delivered nothing is the failure
        // that took a day to find, because it looks exactly like a quiet room.
        // Give it a deadline and then say so, once.
        let mut started = Instant::now();
        let mut silence_reported = false;
        // Listening in never opens the microphone; the deadline starts when a
        // capture does, and again for every new capture (device switch).
        let mut capture_generation = mic_capture_generation.load(Ordering::SeqCst);
        let mut frames_at_capture_start = local_mic_frames.load(Ordering::Relaxed);
        // Last emitted speaker set (SSRC ids only). Levels still ride along in
        // the payload, but we only emit when membership changes so a steady
        // talker does not spam the webview at 10 Hz.
        let mut last_speaker_ids: Vec<String> = Vec::new();

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tick.tick() => {
                    let remote = remote_audio.lock().await;
                    // Speaking SSRCs with their audio level as sent: RTP's
                    // -dBov convention, 0 loudest and 127 silence, which is
                    // what the renderer's `levelFromDbov` reads.
                    let mut speaking: Vec<(u32, u8)> = Vec::new();
                    let now = Instant::now();

                    for (&ssrc, state) in remote.iter() {
                        let entry = hysteresis
                            .entry(ssrc)
                            .or_insert_with(|| SpeakerHysteresis::new(now));
                        if entry.update(state.audio_level, now) {
                            speaking.push((ssrc, state.audio_level));
                        }
                    }

                    // Forget speakers that dropped out so their stale hysteresis
                    // state does not linger for the life of the session.
                    hysteresis.retain(|ssrc, _| remote.contains_key(ssrc));
                    drop(remote);

                    if speaking.iter().any(|(ssrc, _)| !voice_owners.contains_key(ssrc)) {
                        let known = session_participants.lock().await;
                        voice_owners = voice_owners_of(known.keys().copied());
                    }
                    let speakers = speakers_by_user(&speaking, &voice_owners);

                    let membership_changed = speakers.len() != last_speaker_ids.len()
                        || speakers.keys().any(|id| !last_speaker_ids.iter().any(|prev| prev == id));
                    // While anyone talks the levels are the waveform, so they go
                    // every tick, as the browser engine sends them; otherwise
                    // only a change in who talks is news.
                    if membership_changed || !speakers.is_empty() {
                        last_speaker_ids = speakers.keys().cloned().collect();
                        let _ = app.emit("media_speaking_change", &speakers);
                    }

                    // ── Your own microphone ──────────────────────────────────
                    let frames = local_mic_frames.load(Ordering::Relaxed);
                    let delivering = frames != last_frame_count;
                    last_frame_count = frames;
                    let level = local_mic_level.load(Ordering::Relaxed);
                    let is_muted = muted.load(Ordering::SeqCst);
                    // "Active" is about the capture path, not about loudness: a
                    // meter that only comes alive once you are already audible
                    // cannot tell you that your microphone is dead.
                    let active = delivering && !is_muted;
                    let reported = (level, active);
                    // Emit every tick while the mic is live (the level *is* the
                    // animation), and on change when it is not.
                    if active || last_local_emit != Some(reported) {
                        last_local_emit = Some(reported);
                        let _ = app.emit(
                            "media_local_mic_level",
                            serde_json::json!({ "audioLevel": level, "active": active }),
                        );
                    }

                    let generation = mic_capture_generation.load(Ordering::SeqCst);
                    if generation != capture_generation {
                        capture_generation = generation;
                        started = Instant::now();
                        silence_reported = false;
                        frames_at_capture_start = frames;
                    }
                    if generation != 0
                        && !silence_reported
                        && frames == frames_at_capture_start
                        && started.elapsed() >= MIC_SILENCE_DEADLINE
                    {
                        silence_reported = true;
                        tracing::error!(
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            "microphone opened but delivered no frames"
                        );
                        let _ = app.emit(
                            "media_mic_silent",
                            "Your microphone opened but is not sending any audio. \
                             Pick a different input device in Settings \u{2192} Voice & video.",
                        );
                    }
                }
            }
        }
    });

    session.speaking_task = Some(handle);
}

/// Emit a participant join event.
#[allow(dead_code)]
/// A roster entry arrived (or changed): `{ userId, kind }`. `kind` is the
/// relay's mark (`member` or `viewer`); the renderer reports only members to
/// the call.
pub fn emit_participant_join(
    app: &super::CallEventSink,
    user_id: &str,
    kind: SessionParticipantKind,
) {
    let _ = app.emit(
        "media_participant_join",
        serde_json::json!({ "userId": user_id, "kind": kind }),
    );
}

pub fn emit_participant_join_details(app: &super::CallEventSink, participant: &SessionParticipant) {
    let _ = app.emit(
        "media_participant_join_details",
        serde_json::json!({
            "userId": participant.user_id.to_string(),
            "sessionId": participant.session_id,
            "videoCapabilities": participant.video_capabilities,
            "mediaPublicKey": participant.media_public_key,
            "kind": participant.kind,
        }),
    );
}

/// Emit a participant leave event.
pub fn emit_participant_leave(
    app: &super::CallEventSink,
    user_id: &str,
    session_id: Option<&str>,
    kind: SessionParticipantKind,
) {
    let _ = app.emit(
        "media_participant_leave",
        serde_json::json!({ "userId": user_id, "sessionId": session_id, "kind": kind }),
    );
}

/// Ask the renderer (which holds this call's keys) to wrap and announce some of
/// this client's sender keys: the voice key when `voice`, and the named tracks'
/// keys. `recipients` null means everyone in the roster entitled to each key
/// (the voice key to members only, a track key to members and, for the
/// viewable stream, its viewers); otherwise exactly those peers, still subject
/// to the same entitlement.
fn emit_announce_sender_keys(
    app: &super::CallEventSink,
    voice: bool,
    tracks: &[(StreamId, TrackId)],
    recipients: Option<&[i64]>,
) {
    if !voice && tracks.is_empty() {
        return;
    }
    let _ = app.emit(
        "media_announce_sender_keys",
        serde_json::json!({
            "voice": voice,
            "tracks": tracks
                .iter()
                .map(|(stream_id, track_id)| serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                }))
                .collect::<Vec<_>>(),
            "recipients": recipients.map(|ids| ids.iter().map(i64::to_string).collect::<Vec<_>>()),
        }),
    );
}

/// Which of this client's sender keys a roster change rotates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyRotation {
    /// Nothing rotates.
    None,
    /// Only the keys a viewer can hold (the viewable stream's tracks): a viewer
    /// left, so it must not open what follows. The voice key never reached it.
    ViewableTracks,
    /// Every key, the voice and each track: a call member arrived or left.
    All,
}

/// Which keys go out, and to whom, after a roster change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeyAnnouncement {
    None,
    /// The voice key and every track key, to everyone entitled to each.
    All,
    /// The viewable stream's track keys, to everyone entitled to them.
    Viewable,
    /// The viewable stream's current track keys, to these new viewers only.
    ViewableTo(Vec<i64>),
}

/// What one roster change does to this client's keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeyPlan {
    pub rotation: KeyRotation,
    pub announcement: KeyAnnouncement,
}

impl KeyPlan {
    const NOTHING: Self = Self {
        rotation: KeyRotation::None,
        announcement: KeyAnnouncement::None,
    };
    const ROTATE_ALL: Self = Self {
        rotation: KeyRotation::All,
        announcement: KeyAnnouncement::All,
    };
    const ROTATE_VIEWABLE: Self = Self {
        rotation: KeyRotation::ViewableTracks,
        announcement: KeyAnnouncement::Viewable,
    };
}

fn is_member(participant: &super::session::RemoteSessionParticipant) -> bool {
    !participant.kind.is_viewer()
}

/// The key plan for a fresh roster snapshot, against the roster known before.
///
/// The first snapshot rotates nothing and announces everything. After that a
/// change among the call members rotates every key; a viewer gone rotates the
/// viewable stream's keys only; a viewer that arrived (or whose view session was
/// replaced by a newer one of the same account, which is entitled to the same
/// stream) rotates nothing and is sent the viewable stream's current keys.
pub(crate) fn plan_session_state(
    known: &HashMap<i64, super::session::RemoteSessionParticipant>,
    desired: &HashMap<i64, super::session::RemoteSessionParticipant>,
) -> KeyPlan {
    if known.is_empty() {
        return KeyPlan {
            rotation: KeyRotation::None,
            announcement: KeyAnnouncement::All,
        };
    }
    let members = |roster: &HashMap<i64, super::session::RemoteSessionParticipant>| {
        roster
            .iter()
            .filter(|(_, participant)| is_member(participant))
            .map(|(user_id, participant)| (*user_id, participant.clone()))
            .collect::<HashMap<_, _>>()
    };
    if members(known) != members(desired) {
        return KeyPlan::ROTATE_ALL;
    }
    let viewer_gone = known
        .iter()
        .filter(|(_, participant)| !is_member(participant))
        .any(|(user_id, _)| desired.get(user_id).is_none_or(is_member));
    if viewer_gone {
        return KeyPlan::ROTATE_VIEWABLE;
    }
    let mut new_viewers = desired
        .iter()
        .filter(|(_, participant)| !is_member(participant))
        .filter(|(user_id, participant)| known.get(user_id) != Some(participant))
        .map(|(user_id, _)| *user_id)
        .collect::<Vec<_>>();
    if new_viewers.is_empty() {
        return KeyPlan::NOTHING;
    }
    new_viewers.sort_unstable();
    KeyPlan {
        rotation: KeyRotation::None,
        announcement: KeyAnnouncement::ViewableTo(new_viewers),
    }
}

/// The key plan for one roster entry arriving (or changing) as `joined`.
pub(crate) fn plan_join(
    user_id: i64,
    previous: Option<&super::session::RemoteSessionParticipant>,
    joined: &super::session::RemoteSessionParticipant,
) -> KeyPlan {
    if previous == Some(joined) {
        return KeyPlan::NOTHING;
    }
    match (previous, is_member(joined)) {
        // A member arrived (or rejoined with a new receipt or call key).
        (_, true) => KeyPlan::ROTATE_ALL,
        // A member left the call and now only watches: it is gone from the
        // call, and everything it could open rotates.
        (Some(previous), false) if is_member(previous) => KeyPlan::ROTATE_ALL,
        // Somebody started watching, or a viewer's view session was replaced
        // by a newer one of the same account (entitled to the same stream): it
        // gets the viewable stream's keys as they are, and nothing rotates.
        (_, false) => KeyPlan {
            rotation: KeyRotation::None,
            announcement: KeyAnnouncement::ViewableTo(vec![user_id]),
        },
    }
}

/// The key plan for one roster entry leaving.
pub(crate) fn plan_leave(departed: &super::session::RemoteSessionParticipant) -> KeyPlan {
    if is_member(departed) {
        KeyPlan::ROTATE_ALL
    } else {
        KeyPlan::ROTATE_VIEWABLE
    }
}

/// Whether a track belongs to the stream a view session may receive (a screen
/// share's video and its own audio). Mirrors the relay's `ViewTarget::allows`.
pub(crate) fn is_viewable_stream(stream_id: &StreamId) -> bool {
    stream_id.0.ends_with(":screen")
}

/// Emit a session error event.
#[allow(dead_code)]
pub fn emit_session_error(app: &super::CallEventSink, error: &str) {
    let _ = app.emit("media_session_error", error);
}

/// Emit a keyframe request for a remote video track.
///
/// Used both when the relay asks us for a keyframe and when a local decoder
/// cannot decode a remote track and needs the sender to produce a fresh intra
/// frame. The frontend forwards this upstream.
pub fn emit_media_request_keyframe(
    app: &super::CallEventSink,
    stream_id: &str,
    track_id: &str,
    layer_id: Option<u8>,
) {
    let _ = app.emit(
        "media_request_keyframe",
        serde_json::json!({
            "streamId": stream_id,
            "trackId": track_id,
            "layerId": layer_id,
        }),
    );
}

/// Emit a user-visible native-surface render failure (spec §3.7). Surface
/// creation failure, interop init failure past the tier decision, or a
/// present() error streak tears the subscription down and fires this so the UI
/// can surface the error — there is NO fallback to raw IPC (that path no longer
/// exists) and the surface is never silently blanked.
pub fn emit_media_native_render_failed(
    app: &super::CallEventSink,
    stream_id: &str,
    track_id: &str,
    reason: &str,
) {
    let _ = app.emit(
        "media_native_render_failed",
        serde_json::json!({
            "streamId": stream_id,
            "trackId": track_id,
            "reason": reason,
        }),
    );
}

/// Emit the one-time first-presented-frame signal for a native surface. The
/// webview receives no frames on the native-surface route, so this event is its
/// only "the stream is live" edge — the media engine maps it to the
/// subscription's onFrame callback (poster teardown, active-track state).
pub fn emit_media_native_render_first_frame(
    app: &super::CallEventSink,
    stream_id: &str,
    track_id: &str,
) {
    let _ = app.emit(
        "media_native_render_first_frame",
        serde_json::json!({
            "streamId": stream_id,
            "trackId": track_id,
        }),
    );
}

/// One SSRC's run of packets that did not open (E2EE diagnostics, N11; the
/// re-share freeze, stream-fix-v2).
#[derive(Debug, Clone, Copy)]
struct DecryptFailureRun {
    consecutive: u32,
    /// The key epoch the last failing packet named.
    epoch: u8,
    /// Why it did not open.
    reason: DecryptFailureReason,
    /// When the last alert for this run went out (`None` before the first).
    alerted_at: Option<Instant>,
}

/// Why a media packet did not open, in words a log reader can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecryptFailureReason {
    /// No key at all for this SSRC and epoch: the key was never delivered, or
    /// was delivered for other SSRCs.
    NoKey,
    /// A key is installed, but it is not the one the packet was sealed with:
    /// a stale key from an earlier share, or a key mix-up.
    WrongKey,
    /// The packet opened before, or is too old for the receive window.
    Replay,
    /// Too short to be a sealed packet.
    Malformed,
}

impl DecryptFailureReason {
    fn from_error(error: &paracord_codec::crypto::CryptoError) -> Self {
        use paracord_codec::crypto::CryptoError;
        match error {
            CryptoError::NoKeyForEpoch(_) => Self::NoKey,
            CryptoError::DecryptionFailed => Self::WrongKey,
            CryptoError::ReplayDetected => Self::Replay,
            CryptoError::CiphertextTooShort | CryptoError::SequenceReuse { .. } => Self::Malformed,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NoKey => "no-key",
            Self::WrongKey => "wrong-key",
            Self::Replay => "replay",
            Self::Malformed => "malformed",
        }
    }

    /// Whether a fresh key would cure it (a replay or a malformed packet is
    /// not a key problem).
    pub(crate) fn is_key_problem(self) -> bool {
        matches!(self, Self::NoKey | Self::WrongKey)
    }
}

/// Per-SSRC decrypt-failure runs for E2EE diagnostics (N11).
fn decrypt_failure_counters() -> &'static Mutex<HashMap<u32, DecryptFailureRun>> {
    static COUNTERS: OnceLock<Mutex<HashMap<u32, DecryptFailureRun>>> = OnceLock::new();
    COUNTERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Number of consecutive per-SSRC decrypt failures that trips the alert. At a
/// stream's packet rate this is well under a second of video; a single lost
/// key-change race (a handful of packets sealed with the previous key) stays
/// under it.
const DECRYPT_FAILURE_ALERT_THRESHOLD: u32 = 50;

/// While an SSRC keeps failing, the alert repeats this often, so the renderer
/// asks for the key again (and the log says the freeze is still a key
/// problem) instead of one line followed by a silent, endless freeze.
const DECRYPT_FAILURE_REALERT: Duration = Duration::from_secs(2);

/// Upper bound on tracked decrypt-failure counters.
///
/// The key is the raw `header.ssrc` of an incoming packet, and an entry is only
/// removed on a *successful* decrypt — which by construction never happens for
/// an SSRC we hold no key for. The relay forwards audio bearing any SSRC from a
/// subscribed sender, so producing new keys costs an attacker nothing and no key
/// material is needed: the map grew toward 2^32 entries. A call has a handful of
/// SSRCs; 1024 is far beyond any legitimate need.
const MAX_DECRYPT_FAILURE_COUNTERS: usize = 1024;

/// Largest `layers` vector accepted from a `TrackPublish` / `TrackLayers`.
///
/// The simulcast ladder is three rungs. Each accepted layer installs an
/// `Aes128Gcm` instance in the frame decryptor and (for audio) an Opus decoder
/// plus jitter buffer, so an unbounded vector off the wire is a direct
/// memory-amplification primitive against this client. The relay applies the
/// same cap; this is the receiver-side half, because a compromised relay is
/// exactly the threat the client-side E2EE exists for.
const MAX_TRACK_LAYERS: usize = 8;

/// What one decrypt outcome means for an SSRC's failure run: nothing, or an
/// alert to raise now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DecryptAlert {
    consecutive: u32,
    epoch: u8,
    reason: DecryptFailureReason,
    /// The first alert of this run (the later ones repeat it).
    first: bool,
}

/// Fold one decrypt outcome into `runs`. Pure apart from `now`, for tests.
fn fold_decrypt_result(
    runs: &mut HashMap<u32, DecryptFailureRun>,
    ssrc: u32,
    epoch: u8,
    error: Option<DecryptFailureReason>,
    now: Instant,
) -> Option<DecryptAlert> {
    let Some(reason) = error else {
        runs.remove(&ssrc);
        return None;
    };
    // Only *existing* counters are advanced once the map is full: a new,
    // never-seen SSRC cannot add an entry. Since an entry is removed only on a
    // successful decrypt, an SSRC that never decrypts would otherwise stay
    // forever, and the SSRC is picked by whoever sends the packet.
    if !runs.contains_key(&ssrc) && runs.len() >= MAX_DECRYPT_FAILURE_COUNTERS {
        return None;
    }
    let run = runs.entry(ssrc).or_insert(DecryptFailureRun {
        consecutive: 0,
        epoch,
        reason,
        alerted_at: None,
    });
    run.consecutive = run.consecutive.saturating_add(1);
    run.epoch = epoch;
    run.reason = reason;
    if run.consecutive < DECRYPT_FAILURE_ALERT_THRESHOLD {
        return None;
    }
    let due = run
        .alerted_at
        .is_none_or(|at| now.duration_since(at) >= DECRYPT_FAILURE_REALERT);
    if !due {
        return None;
    }
    let first = run.alerted_at.is_none();
    run.alerted_at = Some(now);
    Some(DecryptAlert {
        consecutive: run.consecutive,
        epoch,
        reason,
        first,
    })
}

/// Record the outcome of one media-packet decrypt attempt for `ssrc` (the
/// epoch the packet named, and the error when it did not open), emitting
/// `media_decrypt_failing` once a run of [`DECRYPT_FAILURE_ALERT_THRESHOLD`]
/// consecutive failures is reached and again every
/// [`DECRYPT_FAILURE_REALERT`] while it lasts. Without this an undelivered or
/// stale E2EE key is silently missing audio or a frozen picture; with it the
/// log names the SSRC, its track, the epoch and why, and the renderer asks for
/// the track's key again (`tauriMediaEngine`, `media_decrypt_failing`).
///
/// Called at both decrypt sites: the datagram receive task
/// (`audio_pipeline::spawn_datagram_recv_task`, audio and video datagrams) and
/// whole frames on streams (`video_pipeline::handle_video_stream_frame`).
pub fn note_decrypt_result(
    app: &super::CallEventSink,
    ssrc: u32,
    epoch: u8,
    error: Option<&paracord_codec::crypto::CryptoError>,
) {
    let alert = {
        let mut runs = decrypt_failure_counters()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        fold_decrypt_result(
            &mut runs,
            ssrc,
            epoch,
            error.map(DecryptFailureReason::from_error),
            Instant::now(),
        )
    };
    let Some(alert) = alert else {
        return;
    };
    let track = super::video_pipeline::remote_video_track_for_ssrc(ssrc);
    let (stream_id, track_id) = track
        .as_ref()
        .map(|(stream, track)| (Some(stream.as_str()), Some(track.as_str())))
        .unwrap_or((None, None));
    if alert.first {
        tracing::warn!(
            ssrc,
            epoch = alert.epoch,
            reason = alert.reason.as_str(),
            stream_id,
            track_id,
            consecutive_failures = alert.consecutive,
            "media packets from this ssrc keep failing to decrypt: no usable key for it"
        );
    } else {
        tracing::warn!(
            ssrc,
            epoch = alert.epoch,
            reason = alert.reason.as_str(),
            stream_id,
            track_id,
            consecutive_failures = alert.consecutive,
            "media packets from this ssrc still fail to decrypt"
        );
    }
    let _ = app.emit(
        "media_decrypt_failing",
        serde_json::json!({
            "ssrc": ssrc,
            "epoch": alert.epoch,
            "reason": alert.reason.as_str(),
            "keyProblem": alert.reason.is_key_problem(),
            "streamId": stream_id,
            "trackId": track_id,
            "consecutiveFailures": alert.consecutive,
        }),
    );
}

/// Say why the media connection ended. When the relay closed it on purpose
/// (`MediaCloseReason`: superseded, ended, revoked) its own words are used,
/// because the renderer decides from them whether the session may be dialed
/// back (a view closed for any of the three may not).
pub(crate) fn describe_connection_close(reason: &quinn::ConnectionError) -> String {
    if let quinn::ConnectionError::ApplicationClosed(close) = reason {
        if let Some(relay_reason) =
            paracord_transport::control::MediaCloseReason::from_code(close.error_code.into_inner())
        {
            return format!("Closed by the relay: {}", relay_reason.reason());
        }
    }
    format!("Native voice connection lost: {reason}")
}

/// Spawn a task that watches the QUIC connection and notifies the UI on loss.
pub fn spawn_connection_monitor(session: &mut NativeMediaSession, app: super::CallEventSink) {
    let shutdown = session.shutdown.clone();
    let conn = session.connection.inner().clone();

    let handle = tokio::spawn(async move {
        tokio::select! {
            _ = shutdown.notified() => {}
            reason = conn.closed() => {
                let _ = app.emit("media_transport_lost", describe_connection_close(&reason));
            }
        }
    });

    session.connection_monitor_task = Some(handle);
}

/// Spawn a task that receives stream-control messages on QUIC bidi streams and
/// folds them into the local session stream registry.
pub fn spawn_control_recv_task(session: &mut NativeMediaSession, app: super::CallEventSink) {
    let shutdown = session.shutdown.clone();
    let conn = session.connection.inner().clone();
    let stream_registry = session.stream_registry.clone();
    let session_participants = session.session_participants.clone();
    let frame_decryptor = session.frame_decryptor.clone();
    let frame_encryptor = session.frame_encryptor.clone();
    let track_sender_keys = session.track_sender_keys.clone();
    let audio_sender_state = session.audio_sender_state.clone();
    let current_key_epoch = session.current_key_epoch.clone();
    let local_user_id = session.local_user_id;
    let local_ssrc = session.local_ssrc;
    let video_force_keyframe = session.video_force_keyframe.clone();
    let screen_force_keyframe = session.screen_force_keyframe.clone();
    let screen_bitrate_feedback_kbps = session.screen_bitrate_feedback_kbps.clone();
    let video_track_keys = session.video_track_keys.clone();

    let handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                incoming = conn.accept_bi() => {
                    let (_send, mut recv) = match incoming {
                        Ok(streams) => streams,
                        Err(err) => {
                            tracing::debug!("control recv task stopping: {err}");
                            break;
                        }
                    };

                    let mut len_buf = [0u8; 4];
                    if recv.read_exact(&mut len_buf).await.is_err() {
                        continue;
                    }
                    let len = u32::from_be_bytes(len_buf) as usize;
                    if len == 0 || len > 256 * 1024 {
                        continue;
                    }

                    let mut msg_buf = vec![0u8; len];
                    if recv.read_exact(&mut msg_buf).await.is_err() {
                        continue;
                    }

                    let message = match serde_json::from_slice::<ControlMessage>(&msg_buf) {
                        Ok(message) => message,
                        Err(err) => {
                            tracing::debug!("discarding malformed control message: {err}");
                            continue;
                        }
                    };

                    handle_control_message(
                        message,
                        &conn,
                        &stream_registry,
                        &session_participants,
                        &frame_encryptor,
                        &frame_decryptor,
                        &track_sender_keys,
                        &audio_sender_state,
                        &current_key_epoch,
                        local_user_id,
                        local_ssrc,
                        &video_force_keyframe,
                        &screen_force_keyframe,
                        &screen_bitrate_feedback_kbps,
                        &video_track_keys,
                        &app,
                    )
                    .await;
                }
            }
        }
    });

    session.control_recv_task = Some(handle);
}

async fn handle_control_message(
    message: ControlMessage,
    conn: &quinn::Connection,
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    session_participants: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<i64, super::session::RemoteSessionParticipant>,
        >,
    >,
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    frame_decryptor: &std::sync::Arc<std::sync::Mutex<FrameDecryptor>>,
    track_sender_keys: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<(StreamId, TrackId), super::session::SenderKeyState>,
        >,
    >,
    audio_sender_state: &std::sync::Arc<std::sync::Mutex<super::session::SenderKeyState>>,
    current_key_epoch: &std::sync::Arc<AtomicU8>,
    local_user_id: i64,
    local_ssrc: u32,
    video_force_keyframe: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    screen_force_keyframe: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    screen_bitrate_feedback_kbps: &std::sync::Arc<std::sync::atomic::AtomicU32>,
    video_track_keys: &std::sync::Mutex<std::collections::HashSet<(String, String)>>,
    app: &super::CallEventSink,
) {
    match message {
        ControlMessage::SessionState { participants } => {
            let update =
                apply_session_state(local_user_id, session_participants, &participants).await;
            // Reconcile the local subscription set against the fresh snapshot:
            // any participant that dropped out must have their subscriptions torn
            // down so bandwidth is not spent on stale tracks.
            for (user_id, _) in &update.departed {
                handle_participant_departure(conn, stream_registry, *user_id).await;
            }
            // Keys rotate before anybody is told about the change, so every
            // key the renderer announces afterwards is the new one.
            let keys = KeyState {
                stream_registry,
                track_sender_keys,
                frame_encryptor,
                frame_decryptor,
                audio_sender_state,
                current_key_epoch,
                local_ssrc,
            };
            keys.rotate(update.plan.rotation).await;
            for (user_id, departed) in &update.departed {
                emit_participant_leave(
                    app,
                    &user_id.to_string(),
                    Some(&departed.session_id),
                    departed.kind,
                );
            }
            for participant in &update.joined {
                emit_participant_join_details(app, participant);
                emit_participant_join(app, &participant.user_id.to_string(), participant.kind);
            }
            keys.announce(app, &update.plan.announcement).await;
        }
        ControlMessage::SessionParticipantJoin { participant } => {
            if participant.user_id != local_user_id {
                let joined = super::session::RemoteSessionParticipant::from_wire(&participant);
                let plan = {
                    let mut known = session_participants.lock().await;
                    let plan = plan_join(
                        participant.user_id,
                        known.get(&participant.user_id),
                        &joined,
                    );
                    known.insert(participant.user_id, joined);
                    plan
                };
                if plan == KeyPlan::NOTHING {
                    return;
                }
                let keys = KeyState {
                    stream_registry,
                    track_sender_keys,
                    frame_encryptor,
                    frame_decryptor,
                    audio_sender_state,
                    current_key_epoch,
                    local_ssrc,
                };
                keys.rotate(plan.rotation).await;
                emit_participant_join_details(app, &participant);
                emit_participant_join(app, &participant.user_id.to_string(), participant.kind);
                keys.announce(app, &plan.announcement).await;
            }
        }
        ControlMessage::SessionParticipantLeave {
            user_id,
            session_id,
        } => {
            if user_id != local_user_id {
                let departed = {
                    let mut known = session_participants.lock().await;
                    if session_id.as_deref().is_some_and(|expected| {
                        known
                            .get(&user_id)
                            .is_none_or(|participant| participant.session_id != expected)
                    }) {
                        return;
                    }
                    known.remove(&user_id)
                };
                let Some(departed) = departed else {
                    return;
                };
                // Tear down subscriptions and native decoders for the departed
                // participant so the relay stops forwarding their tracks and
                // libvpx state is released promptly instead of lingering.
                handle_participant_departure(conn, stream_registry, user_id).await;
                let plan = plan_leave(&departed);
                let keys = KeyState {
                    stream_registry,
                    track_sender_keys,
                    frame_encryptor,
                    frame_decryptor,
                    audio_sender_state,
                    current_key_epoch,
                    local_ssrc,
                };
                keys.rotate(plan.rotation).await;
                emit_participant_leave(
                    app,
                    &user_id.to_string(),
                    Some(&departed.session_id),
                    departed.kind,
                );
                keys.announce(app, &plan.announcement).await;
            }
        }
        ControlMessage::TrackPublish { track } => {
            if track.layers.len() > MAX_TRACK_LAYERS {
                tracing::warn!(
                    stream_id = %track.stream_id.0,
                    track_id = %track.track_id.0,
                    layers = track.layers.len(),
                    "discarding track publish with an implausible layer count"
                );
                return;
            }
            {
                let mut registry = stream_registry.lock().await;
                registry.publish_track(track.clone());
            }
            super::session::NativeMediaSession::remember_video_track(
                video_track_keys,
                &track.stream_id.0,
                &track.track_id.0,
            );
            // Record the relay-announced SSRC→track binding. This is the only
            // authorized statement of which SSRC belongs to which track, and it
            // is what the video pipeline cross-checks incoming frame metadata
            // against before letting a frame act as that track.
            super::video_pipeline::bind_remote_video_track(
                &track.stream_id.0,
                &track.track_id.0,
                &track.layers,
            );
            super::clip_buffer::note_track(
                &track.stream_id.0,
                &track.track_id.0,
                track.publisher_user_id,
                track.layers.iter().map(|layer| layer.ssrc).collect(),
            );
            if apply_delivered_track_key(
                stream_registry,
                frame_decryptor,
                &track.stream_id,
                &track.track_id,
            )
            .await
            {
                let request = keyframe_request_for_new_key(&*stream_registry.lock().await, &track);
                if let Some(request) = request {
                    request_keyframes_for_new_key(conn, request);
                }
            }

            let _ = app.emit("media_track_publish", track);
        }
        ControlMessage::TrackUnpublish {
            stream_id,
            track_id,
        } => {
            let mut registry = stream_registry.lock().await;
            if let Some(track) = registry.get_published_track(&stream_id, &track_id) {
                let epochs = registry
                    .delivered_track_keys_for_track(&stream_id, &track_id)
                    .into_iter()
                    .map(|(epoch, _)| epoch)
                    .collect::<Vec<_>>();
                if let Ok(mut decryptor) = frame_decryptor.lock() {
                    forget_track_keys(&mut decryptor, &track, &epochs);
                }
                tracing::info!(
                    stream_id = %stream_id.0,
                    track_id = %track_id.0,
                    ?epochs,
                    "track unpublished: dropped its stream keys"
                );
            }
            registry.unpublish_track(&stream_id, &track_id);
            super::video_pipeline::unbind_remote_video_track(&stream_id.0, &track_id.0);
            super::clip_buffer::forget_track(&stream_id.0, &track_id.0);

            let _ = app.emit(
                "media_track_unpublish",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                }),
            );
        }
        ControlMessage::TrackLayers {
            stream_id,
            track_id,
            layers,
        } => {
            if layers.len() > MAX_TRACK_LAYERS {
                tracing::warn!(
                    stream_id = %stream_id.0,
                    track_id = %track_id.0,
                    layers = layers.len(),
                    "discarding track layer update with an implausible layer count"
                );
                return;
            }
            let maybe_track = {
                let mut registry = stream_registry.lock().await;
                if let Some(mut track) = registry.get_published_track(&stream_id, &track_id) {
                    track.layers = layers;
                    registry.publish_track(track.clone());
                    Some(track)
                } else {
                    None
                }
            };
            if let Some(track) = maybe_track {
                super::video_pipeline::bind_remote_video_track(
                    &stream_id.0,
                    &track_id.0,
                    &track.layers,
                );
                super::clip_buffer::note_track(
                    &stream_id.0,
                    &track_id.0,
                    track.publisher_user_id,
                    track.layers.iter().map(|layer| layer.ssrc).collect(),
                );
                if apply_delivered_track_key(
                    stream_registry,
                    frame_decryptor,
                    &stream_id,
                    &track_id,
                )
                .await
                {
                    let request =
                        keyframe_request_for_new_key(&*stream_registry.lock().await, &track);
                    if let Some(request) = request {
                        request_keyframes_for_new_key(conn, request);
                    }
                }

                let _ = app.emit("media_track_publish", track);
            }
        }
        ControlMessage::SubscribeStream { subscription } => {
            let mut registry = stream_registry.lock().await;
            registry.subscribe(subscription);
        }
        ControlMessage::UnsubscribeStream {
            stream_id,
            track_id,
        } => {
            let mut registry = stream_registry.lock().await;
            registry.unsubscribe(&stream_id, &track_id);
        }
        ControlMessage::SubscriptionAck {
            stream_id,
            track_id,
            layer_id,
            active,
        } => {
            if active {
                // Mark the local subscription confirmed by recording the layer
                // the relay committed to forwarding.
                let mut registry = stream_registry.lock().await;
                if let Some(mut subscription) = registry
                    .subscriptions()
                    .into_iter()
                    .find(|sub| sub.stream_id == stream_id && sub.track_id == track_id)
                {
                    if layer_id.is_some() {
                        subscription.active_layer = layer_id;
                    }
                    registry.subscribe(subscription);
                    tracing::debug!(
                        stream_id = %stream_id.0,
                        track_id = %track_id.0,
                        ?layer_id,
                        "subscription confirmed by relay"
                    );
                } else {
                    tracing::debug!(
                        stream_id = %stream_id.0,
                        track_id = %track_id.0,
                        "subscription ack for a track we no longer track locally"
                    );
                }
            } else {
                // Unsubscribe ack: drop the local subscription and any decoder so
                // no stale state or libvpx context lingers.
                {
                    let mut registry = stream_registry.lock().await;
                    registry.unsubscribe(&stream_id, &track_id);
                }
                super::video_pipeline::remove_remote_video_decoder(&stream_id.0, &track_id.0);
                tracing::debug!(
                    stream_id = %stream_id.0,
                    track_id = %track_id.0,
                    "unsubscribe confirmed by relay; dropped local decoder"
                );
            }

            let _ = app.emit(
                "media_subscription_ack",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "layerId": layer_id,
                    "active": active,
                }),
            );
        }
        ControlMessage::RequestKeyframe {
            stream_id,
            track_id,
            layer_id,
        } => {
            // The relay only routes keyframe requests to the publisher, so a
            // request arriving here targets one of our own tracks. Flip the
            // matching encoder's force-keyframe flag directly — the frontend
            // does not participate in native encoding.
            match track_id.0.as_str() {
                "screen" => {
                    screen_force_keyframe.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                "camera" => {
                    video_force_keyframe.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                _ => {}
            }
            emit_media_request_keyframe(app, &stream_id.0, &track_id.0, layer_id);
        }
        ControlMessage::StreamKeyAnnounce {
            stream_id,
            track_id,
            epoch,
            ..
        } => {
            let _ = app.emit(
                "media_stream_key_announce",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "epoch": epoch,
                }),
            );
        }
        ControlMessage::StreamKeyDeliver {
            stream_id,
            track_id,
            sender_user_id,
            epoch,
            ciphertext,
        } => {
            // A delivered key is a sealed envelope addressed to this call's
            // key, and only the renderer can open it. This used to accept a
            // 16-byte ciphertext verbatim as the sender key — no envelope, no
            // key agreement, no check of who sent it — which let anything on
            // the control plane install a key of its choosing against a peer's
            // SSRC and speak in that peer's name. Nothing legitimate ever took
            // that path, and nothing takes it now.
            let _ = app.emit(
                "media_stream_key_deliver",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "senderUserId": sender_user_id.to_string(),
                    "epoch": epoch,
                    "ciphertext": ciphertext,
                }),
            );
        }
        ControlMessage::KeyDeliver {
            sender_user_id,
            epoch,
            ciphertext,
        } => {
            // Opened by the renderer, which holds this call's key; see the
            // note on `StreamKeyDeliver` above.
            let _ = app.emit(
                "media_key_deliver",
                serde_json::json!({
                    "senderUserId": sender_user_id.to_string(),
                    "epoch": epoch,
                    "ciphertext": ciphertext,
                }),
            );
        }
        ControlMessage::RequestStreamKey {
            stream_id,
            track_id,
            recipient_user_id,
        } => {
            let _ = app.emit(
                "media_request_stream_key",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "recipientUserId": recipient_user_id.to_string(),
                }),
            );
        }
        ControlMessage::ReceiverReport {
            stream_id,
            track_id,
            active_layer,
            estimated_bitrate_kbps,
            packet_loss_ppm,
            ..
        } => {
            tracing::debug!(
                stream_id = stream_id.0,
                track_id = track_id.0,
                ?active_layer,
                estimated_bitrate_kbps,
                packet_loss_ppm,
                "received receiver report"
            );
        }
        ControlMessage::BandwidthFeedback { available_kbps } => {
            // The native screen encoder reads this per frame to retarget its
            // bitrate. This is an uplink budget, not a viewer's download budget.
            screen_bitrate_feedback_kbps
                .store(available_kbps, std::sync::atomic::Ordering::Relaxed);

            let _ = app.emit(
                "media_bandwidth_feedback",
                serde_json::json!({ "availableKbps": available_kbps }),
            );
        }
        ControlMessage::SessionJoin { .. }
        | ControlMessage::SessionLeave { .. }
        | ControlMessage::Auth { .. }
        | ControlMessage::Subscribe { .. }
        | ControlMessage::Unsubscribe { .. }
        | ControlMessage::KeyAnnounce { .. }
        | ControlMessage::Ping
        | ControlMessage::Pong
        | ControlMessage::FileTransferInit { .. }
        | ControlMessage::FileTransferAccept { .. }
        | ControlMessage::FileTransferReject { .. }
        | ControlMessage::FileDownloadRequest { .. }
        | ControlMessage::FileDownloadAccept { .. }
        | ControlMessage::FileTransferProgress { .. }
        | ControlMessage::FileTransferDone { .. }
        | ControlMessage::FileTransferError { .. }
        | ControlMessage::FileTransferCancel { .. } => {}
    }
}

struct SessionStateUpdate {
    plan: KeyPlan,
    /// Entries new or changed in this snapshot, to report to the renderer.
    joined: Vec<SessionParticipant>,
    /// Entries gone from this snapshot, as they were known.
    departed: Vec<(i64, super::session::RemoteSessionParticipant)>,
}

async fn apply_session_state(
    local_user_id: i64,
    session_participants: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<i64, super::session::RemoteSessionParticipant>,
        >,
    >,
    participants: &[SessionParticipant],
) -> SessionStateUpdate {
    let desired = participants
        .iter()
        .filter(|participant| participant.user_id != local_user_id)
        .map(|participant| {
            (
                participant.user_id,
                super::session::RemoteSessionParticipant::from_wire(participant),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut known = session_participants.lock().await;
    let plan = plan_session_state(&known, &desired);
    let joined = participants
        .iter()
        .filter(|participant| participant.user_id != local_user_id)
        .filter(|participant| known.get(&participant.user_id) != desired.get(&participant.user_id))
        .cloned()
        .collect::<Vec<_>>();
    let departed = known
        .iter()
        .filter(|(user_id, _)| !desired.contains_key(user_id))
        .map(|(user_id, participant)| (*user_id, participant.clone()))
        .collect::<Vec<_>>();
    *known = desired;
    SessionStateUpdate {
        plan,
        joined,
        departed,
    }
}

/// The sender-key state one roster change acts on.
struct KeyState<'a> {
    stream_registry: &'a std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    track_sender_keys: &'a std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<(StreamId, TrackId), super::session::SenderKeyState>,
        >,
    >,
    frame_encryptor: &'a std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    frame_decryptor: &'a std::sync::Arc<std::sync::Mutex<FrameDecryptor>>,
    audio_sender_state: &'a std::sync::Arc<std::sync::Mutex<super::session::SenderKeyState>>,
    current_key_epoch: &'a std::sync::Arc<AtomicU8>,
    local_ssrc: u32,
}

impl KeyState<'_> {
    /// Rotate what `rotation` names. The voice key rotates only for a change
    /// among call members; a viewer's departure rotates the viewable stream's
    /// keys and nothing else.
    async fn rotate(&self, rotation: KeyRotation) {
        let viewable_only = match rotation {
            KeyRotation::None => return,
            KeyRotation::ViewableTracks => true,
            KeyRotation::All => {
                if let Err(err) = rotate_audio_sender_key(
                    self.frame_encryptor,
                    self.audio_sender_state,
                    self.current_key_epoch,
                    self.local_ssrc,
                ) {
                    tracing::warn!(error = %err, "failed to rotate native audio sender key on a roster change");
                }
                false
            }
        };
        if let Err(err) = rotate_track_sender_keys(
            self.stream_registry,
            self.track_sender_keys,
            self.frame_encryptor,
            self.frame_decryptor,
            viewable_only,
        )
        .await
        {
            tracing::warn!(error = %err, "failed to rotate native track sender keys on a roster change");
        }
    }

    /// Ask the renderer to announce what `announcement` names.
    async fn announce(&self, app: &super::CallEventSink, announcement: &KeyAnnouncement) {
        let (voice, viewable_only, recipients) = match announcement {
            KeyAnnouncement::None => return,
            KeyAnnouncement::All => (true, false, None),
            KeyAnnouncement::Viewable => (false, true, None),
            KeyAnnouncement::ViewableTo(recipients) => (false, true, Some(recipients.as_slice())),
        };
        let tracks =
            local_keyed_tracks(self.stream_registry, self.track_sender_keys, viewable_only).await;
        emit_announce_sender_keys(app, voice, &tracks, recipients);
    }
}

/// This client's published tracks that have a sender key (only the viewable
/// stream's when `viewable_only`), in a stable order.
async fn local_keyed_tracks(
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    track_sender_keys: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<(StreamId, TrackId), super::session::SenderKeyState>,
        >,
    >,
    viewable_only: bool,
) -> Vec<(StreamId, TrackId)> {
    let keyed = {
        let sender_keys = track_sender_keys.lock().await;
        sender_keys.keys().cloned().collect::<Vec<_>>()
    };
    let registry = stream_registry.lock().await;
    let mut tracks = keyed
        .into_iter()
        .filter(|(stream_id, _)| !viewable_only || is_viewable_stream(stream_id))
        .filter(|(stream_id, track_id)| registry.get_published_track(stream_id, track_id).is_some())
        .collect::<Vec<_>>();
    tracks.sort_by(|a, b| (&a.0 .0, &a.1 .0).cmp(&(&b.0 .0, &b.1 .0)));
    tracks
}

/// Build the `UnsubscribeStream` messages the client should send when `user_id`
/// leaves: one per track that participant published and we still hold a live
/// subscription for.
fn unsubscribe_messages_for_participant(
    registry: &super::stream_registry::StreamRegistry,
    user_id: i64,
) -> Vec<ControlMessage> {
    let subscribed: std::collections::HashSet<(StreamId, TrackId)> = registry
        .subscriptions()
        .into_iter()
        .map(|subscription| (subscription.stream_id, subscription.track_id))
        .collect();
    registry
        .published_tracks()
        .into_iter()
        .filter(|track| track.publisher_user_id == user_id)
        .filter(|track| subscribed.contains(&(track.stream_id.clone(), track.track_id.clone())))
        .map(|track| ControlMessage::UnsubscribeStream {
            stream_id: track.stream_id,
            track_id: track.track_id,
        })
        .collect()
}

/// Reconcile local state after a participant leaves the session: remove local
/// subscription entries, drop native decoders for every track they published,
/// and tell the relay to stop forwarding the tracks we were subscribed to.
async fn handle_participant_departure(
    conn: &quinn::Connection,
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    user_id: i64,
) {
    let (published_tracks, unsubscribes) = {
        let registry = stream_registry.lock().await;
        let published_tracks: Vec<(String, String)> = registry
            .published_tracks()
            .into_iter()
            .filter(|track| track.publisher_user_id == user_id)
            .map(|track| (track.stream_id.0, track.track_id.0))
            .collect();
        let unsubscribes = unsubscribe_messages_for_participant(&registry, user_id);
        (published_tracks, unsubscribes)
    };

    if !unsubscribes.is_empty() {
        let mut registry = stream_registry.lock().await;
        for message in &unsubscribes {
            if let ControlMessage::UnsubscribeStream {
                stream_id,
                track_id,
            } = message
            {
                registry.unsubscribe(stream_id, track_id);
            }
        }
    }

    for (stream_id, track_id) in published_tracks {
        super::video_pipeline::remove_remote_video_decoder(&stream_id, &track_id);
    }

    for message in unsubscribes {
        if let Err(err) = send_control_over_connection(conn, &message).await {
            tracing::warn!(
                error = %err,
                "failed to send UnsubscribeStream for departed participant"
            );
        }
    }
}

/// Send a single control message over the session's QUIC connection using the
/// length-prefixed framing the relay expects.
pub(crate) async fn send_control_over_connection(
    conn: &quinn::Connection,
    message: &ControlMessage,
) -> Result<(), String> {
    let (mut send, _recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("open control stream: {e}"))?;
    let encoded = message
        .encode()
        .map_err(|e| format!("encode control message: {e}"))?;
    send.write_all(&encoded)
        .await
        .map_err(|e| format!("write control message: {e}"))?;
    send.finish()
        .map_err(|e| format!("finish control message: {e}"))?;
    Ok(())
}

fn rotate_audio_sender_key(
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    audio_sender_state: &std::sync::Arc<std::sync::Mutex<super::session::SenderKeyState>>,
    current_key_epoch: &std::sync::Arc<AtomicU8>,
    local_ssrc: u32,
) -> Result<super::session::SenderKeyState, String> {
    use rand::random;

    let current = current_key_epoch.load(Ordering::SeqCst);
    let next_epoch = {
        let candidate = current.wrapping_add(1);
        if candidate == 0 {
            1
        } else {
            candidate
        }
    };
    let next_key = random::<[u8; KEY_SIZE]>();

    {
        let mut encryptor = frame_encryptor
            .lock()
            .map_err(|_| "frame encryptor lock poisoned".to_string())?;
        encryptor.set_peer_key(local_ssrc, next_epoch, &next_key);
    }
    {
        let mut state = audio_sender_state
            .lock()
            .map_err(|_| "audio sender state lock poisoned".to_string())?;
        *state = super::session::SenderKeyState {
            epoch: next_epoch,
            key: next_key,
        };
    }
    current_key_epoch.store(next_epoch, Ordering::SeqCst);

    Ok(super::session::SenderKeyState {
        epoch: next_epoch,
        key: next_key,
    })
}

/// Give each published track (only the viewable stream's when
/// `viewable_only`) a new key under the next epoch of its own.
///
/// Each track counts its own epochs: a track can rotate without the voice
/// (a viewer left), and the receiver files keys by `(ssrc, epoch)`, so a new
/// key must never reuse the epoch its previous key was sent under.
async fn rotate_track_sender_keys(
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    track_sender_keys: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<(StreamId, TrackId), super::session::SenderKeyState>,
        >,
    >,
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    frame_decryptor: &std::sync::Arc<std::sync::Mutex<FrameDecryptor>>,
    viewable_only: bool,
) -> Result<(), String> {
    use rand::random;

    let track_keys = {
        let sender_keys = track_sender_keys.lock().await;
        sender_keys
            .keys()
            .filter(|(stream_id, _)| !viewable_only || is_viewable_stream(stream_id))
            .cloned()
            .collect::<Vec<_>>()
    };
    if track_keys.is_empty() {
        return Ok(());
    }

    let tracks = {
        let registry = stream_registry.lock().await;
        track_keys
            .iter()
            .filter_map(|(stream_id, track_id)| {
                registry
                    .get_published_track(stream_id, track_id)
                    .map(|track| ((stream_id.clone(), track_id.clone()), track))
            })
            .collect::<std::collections::HashMap<_, _>>()
    };

    let mut sender_keys = track_sender_keys.lock().await;
    let mut encryptor = frame_encryptor
        .lock()
        .map_err(|_| "frame encryptor lock poisoned".to_string())?;
    let mut decryptor = frame_decryptor
        .lock()
        .map_err(|_| "frame decryptor lock poisoned".to_string())?;
    for track_key in track_keys {
        let Some(track) = tracks.get(&track_key) else {
            continue;
        };
        let Some(current) = sender_keys.get(&track_key).copied() else {
            continue;
        };
        let epoch = next_key_epoch(current.epoch);
        let next_key = random::<[u8; KEY_SIZE]>();
        sender_keys.insert(
            track_key.clone(),
            super::session::SenderKeyState {
                epoch,
                key: next_key,
            },
        );
        for layer in &track.layers {
            encryptor.set_peer_key(layer.ssrc, epoch, &next_key);
            // Self-view: our own frames come back from the server encrypted
            // with this key, so the local decryptor needs it too.
            decryptor.set_peer_key(layer.ssrc, epoch, &next_key);
        }
    }

    Ok(())
}

/// The epoch after `epoch`: 1..=255, skipping 0 (the wire's "no key").
fn next_key_epoch(epoch: u8) -> u8 {
    match epoch.wrapping_add(1) {
        0 => 1,
        next => next,
    }
}

/// The epoch a new key for a local track starts under: the one after its last
/// key's when the track ran before in this call (`retired`), else the call's
/// current epoch. A restarted share never reuses its last key's epoch, so a
/// receiver can never try its frames against the previous share's key, and a
/// late delivery of that key can never overwrite the new one.
pub(crate) fn fresh_track_key_epoch(retired: Option<u8>, current: u8) -> u8 {
    match retired {
        Some(epoch) => next_key_epoch(epoch),
        None => current,
    }
}

/// Install the stream keys this session holds for a just-published (or
/// re-layered) track. Returns whether any SSRC got a key it did not open under
/// before, which calls for a keyframe (see [`request_keyframes_for_new_key`]).
async fn apply_delivered_track_key(
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    frame_decryptor: &std::sync::Arc<std::sync::Mutex<FrameDecryptor>>,
    stream_id: &StreamId,
    track_id: &TrackId,
) -> bool {
    let (track, epochs) = {
        let registry = stream_registry.lock().await;
        let Some(track) = registry.get_published_track(stream_id, track_id) else {
            return false;
        };
        let epochs = registry.delivered_track_keys_for_track(stream_id, track_id);
        (track, epochs)
    };

    if epochs.is_empty() {
        return false;
    }

    let Ok(mut decryptor) = frame_decryptor.lock() else {
        tracing::warn!("failed to lock frame decryptor while applying delivered track key");
        return false;
    };

    let mut changed = false;
    for (epoch, key) in &epochs {
        changed |= install_track_key(&mut decryptor, &track, *epoch, key);
    }
    tracing::info!(
        stream_id = %stream_id.0,
        track_id = %track_id.0,
        epochs = ?epochs.iter().map(|(epoch, _)| *epoch).collect::<Vec<_>>(),
        ssrcs = ?track.layers.iter().map(|layer| layer.ssrc).collect::<Vec<_>>(),
        changed,
        "installed the stream keys held for a published track"
    );
    changed
}

/// Install one stream key for every layer of `track`. Returns whether any
/// layer's SSRC now opens under a key it did not before.
pub(crate) fn install_track_key(
    decryptor: &mut FrameDecryptor,
    track: &paracord_transport::stream::PublishedTrack,
    epoch: u8,
    key: &[u8; KEY_SIZE],
) -> bool {
    let mut changed = false;
    for layer in &track.layers {
        changed |= decryptor.set_peer_key(layer.ssrc, epoch, key);
    }
    changed
}

/// Drop every key this session holds for a remote track that was unpublished,
/// for all of its layers. The share is over; its key protects nothing now, and
/// a packet of the next share sealed with a key that has not arrived yet must
/// read as "no key" (a key on its way) rather than open-attempts against the
/// last share's key ("wrong key").
pub(crate) fn forget_track_keys(
    decryptor: &mut FrameDecryptor,
    track: &paracord_transport::stream::PublishedTrack,
    epochs: &[u8],
) {
    for layer in &track.layers {
        for epoch in epochs {
            decryptor.remove_peer_key(layer.ssrc, *epoch);
        }
    }
}

/// How long after a key-change keyframe request the receiver asks once more.
/// The relay folds requests for one layer that come within 250 ms of each
/// other into one (`KEYFRAME_REQUEST_MIN_INTERVAL`), and a subscription made in
/// the same moment as the key's arrival has just asked: the repeat lands
/// outside that window.
const KEY_CHANGE_KEYFRAME_REPEAT: Duration = Duration::from_millis(350);

/// The keyframe request a newly installed key calls for, if any: a video
/// track this session is subscribed to. A publisher seals a new share (or a
/// rotated key) from its first frame, but the key reaches viewers a few hundred
/// milliseconds later, through the renderer; every frame before it, the
/// share's opening keyframe included, cannot be opened, and the picture would
/// stay frozen until the next periodic keyframe (stream audit B1).
pub(crate) fn keyframe_request_for_new_key(
    registry: &super::stream_registry::StreamRegistry,
    track: &paracord_transport::stream::PublishedTrack,
) -> Option<ControlMessage> {
    if !matches!(track.kind, paracord_transport::control::TrackKind::Video) {
        return None;
    }
    let subscription = registry
        .subscriptions()
        .into_iter()
        .find(|sub| sub.stream_id == track.stream_id && sub.track_id == track.track_id)?;
    Some(ControlMessage::RequestKeyframe {
        stream_id: track.stream_id.clone(),
        track_id: track.track_id.clone(),
        layer_id: subscription.active_layer.or(subscription.requested_layer),
    })
}

/// Ask the publisher for a keyframe now that a new key opens its track, and
/// once more after [`KEY_CHANGE_KEYFRAME_REPEAT`] (see there), logging why.
pub(crate) fn request_keyframes_for_new_key(conn: &quinn::Connection, request: ControlMessage) {
    if let ControlMessage::RequestKeyframe {
        stream_id,
        track_id,
        layer_id,
    } = &request
    {
        tracing::info!(
            stream_id = %stream_id.0,
            track_id = %track_id.0,
            ?layer_id,
            "asking for a keyframe: a new stream key was installed, and the frames sealed before it arrived could not be opened"
        );
    }
    let conn = conn.clone();
    tokio::spawn(async move {
        if let Err(err) = send_control_over_connection(&conn, &request).await {
            tracing::warn!(error = %err, "failed to ask for a keyframe after a key change");
            return;
        }
        tokio::time::sleep(KEY_CHANGE_KEYFRAME_REPEAT).await;
        if let Err(err) = send_control_over_connection(&conn, &request).await {
            tracing::warn!(error = %err, "failed to repeat the keyframe request after a key change");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use paracord_transport::control::TrackKind;
    use paracord_transport::stream::{
        PublishedLayer, PublishedTrack, TrackSubscription, VideoCodec,
    };

    #[test]
    fn speakers_are_named_by_user_id_with_their_raw_level() {
        let owners = voice_owners_of([42_i64, 7].into_iter());
        let vincent = NativeMediaSession::derive_track_ssrc(42, "audio");
        let brendan = NativeMediaSession::derive_track_ssrc(7, "audio");
        assert_eq!(owners.get(&vincent).map(String::as_str), Some("42"));
        // Vincent loud, Brendan just over the line, and a source the roster has
        // not named yet (left out rather than reported as a number nobody owns).
        let speakers = speakers_by_user(&[(vincent, 20), (brendan, 94), (12345, 30)], &owners);
        assert_eq!(speakers.len(), 2);
        assert_eq!(speakers.get("42"), Some(&20.0));
        assert_eq!(speakers.get("7"), Some(&94.0));
        // A level beyond the 7-bit scale reads as silence, never louder.
        let speakers = speakers_by_user(&[(vincent, 200)], &owners);
        assert_eq!(speakers.get("42"), Some(&127.0));
    }

    fn video_track(publisher_user_id: i64, stream: &str, track: &str) -> PublishedTrack {
        PublishedTrack {
            stream_id: StreamId::new(stream),
            track_id: TrackId::new(track),
            publisher_user_id,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::Vp9),
            layers: vec![PublishedLayer {
                layer_id: 0,
                ssrc: 42,
                width: Some(1280),
                height: Some(720),
                max_bitrate_kbps: Some(2500),
                active: true,
            }],
        }
    }

    fn subscription(stream: &str, track: &str) -> TrackSubscription {
        TrackSubscription {
            stream_id: StreamId::new(stream),
            track_id: TrackId::new(track),
            requested_layer: Some(0),
            active_layer: Some(0),
            viewport: None,
        }
    }

    #[test]
    fn participant_leave_enqueues_unsubscribe_for_registered_tracks() {
        let mut registry = super::super::stream_registry::StreamRegistry::default();

        // Departing participant 42 publishes a track we are subscribed to.
        registry.publish_track(video_track(42, "stream-a", "screen"));
        registry.subscribe(subscription("stream-a", "screen"));

        // A different participant's subscribed track must be left untouched.
        registry.publish_track(video_track(99, "stream-b", "camera"));
        registry.subscribe(subscription("stream-b", "camera"));

        let messages = unsubscribe_messages_for_participant(&registry, 42);
        assert_eq!(
            messages.len(),
            1,
            "exactly one unsubscribe for participant 42"
        );
        match &messages[0] {
            ControlMessage::UnsubscribeStream {
                stream_id,
                track_id,
            } => {
                assert_eq!(stream_id.0, "stream-a");
                assert_eq!(track_id.0, "screen");
            }
            other => panic!("expected UnsubscribeStream, got {other:?}"),
        }
    }

    #[test]
    fn participant_leave_ignores_published_tracks_without_subscription() {
        let mut registry = super::super::stream_registry::StreamRegistry::default();
        // Published but never subscribed: leaving must not emit an unsubscribe.
        registry.publish_track(video_track(42, "stream-a", "screen"));
        assert!(unsubscribe_messages_for_participant(&registry, 42).is_empty());
    }

    // ── G6b: viewers never rotate the voice key ────────────────────────────

    fn remote(
        session: &str,
        kind: SessionParticipantKind,
    ) -> super::super::session::RemoteSessionParticipant {
        super::super::session::RemoteSessionParticipant {
            session_id: session.into(),
            video_capabilities: Vec::new(),
            media_public_key: Some("ab".repeat(32)),
            kind,
        }
    }

    const MEMBER: SessionParticipantKind = SessionParticipantKind::Member;
    const VIEWER: SessionParticipantKind = SessionParticipantKind::Viewer;

    #[test]
    fn a_viewer_joining_rotates_nothing_and_is_sent_only_the_viewable_keys() {
        let plan = plan_join(9, None, &remote("view-9", VIEWER));
        assert_eq!(plan.rotation, KeyRotation::None);
        assert_eq!(plan.announcement, KeyAnnouncement::ViewableTo(vec![9]));
    }

    #[test]
    fn a_viewer_leaving_rotates_the_stream_keys_but_never_the_voice() {
        let plan = plan_leave(&remote("view-9", VIEWER));
        assert_eq!(plan.rotation, KeyRotation::ViewableTracks);
        assert_eq!(plan.announcement, KeyAnnouncement::Viewable);
    }

    #[test]
    fn a_member_joining_or_leaving_still_rotates_every_key() {
        assert_eq!(
            plan_join(2, None, &remote("s2", MEMBER)).rotation,
            KeyRotation::All
        );
        assert_eq!(plan_leave(&remote("s2", MEMBER)).rotation, KeyRotation::All);
        // A member that left the call and now only watches has left the call.
        assert_eq!(
            plan_join(2, Some(&remote("s2", MEMBER)), &remote("view-2", VIEWER)).rotation,
            KeyRotation::All
        );
        // A viewer's view session replaced by the same account's newer one
        // rotates nothing; the new session is sent the current screen keys.
        assert_eq!(
            plan_join(
                9,
                Some(&remote("view-9", VIEWER)),
                &remote("view-9b", VIEWER)
            ),
            KeyPlan {
                rotation: KeyRotation::None,
                announcement: KeyAnnouncement::ViewableTo(vec![9])
            }
        );
        // The same entry again changes nothing.
        assert_eq!(
            plan_join(2, Some(&remote("s2", MEMBER)), &remote("s2", MEMBER)),
            KeyPlan::NOTHING
        );
    }

    #[test]
    fn a_roster_snapshot_rotates_the_voice_only_for_members() {
        let roster = |entries: &[(i64, &str, SessionParticipantKind)]| {
            entries
                .iter()
                .map(|(uid, session, kind)| (*uid, remote(session, *kind)))
                .collect::<HashMap<_, _>>()
        };
        let before = roster(&[(2, "s2", MEMBER), (9, "view-9", VIEWER)]);
        // First snapshot: nothing rotates, everything is announced.
        assert_eq!(
            plan_session_state(&HashMap::new(), &before),
            KeyPlan {
                rotation: KeyRotation::None,
                announcement: KeyAnnouncement::All
            }
        );
        // A viewer arrives: nothing rotates.
        let viewer_arrived = roster(&[
            (2, "s2", MEMBER),
            (9, "view-9", VIEWER),
            (8, "view-8", VIEWER),
        ]);
        assert_eq!(
            plan_session_state(&before, &viewer_arrived),
            KeyPlan {
                rotation: KeyRotation::None,
                announcement: KeyAnnouncement::ViewableTo(vec![8])
            }
        );
        // A viewer leaves: the viewable keys rotate, the voice does not.
        let viewer_left = roster(&[(2, "s2", MEMBER)]);
        assert_eq!(
            plan_session_state(&before, &viewer_left).rotation,
            KeyRotation::ViewableTracks
        );
        // A member leaves: everything rotates.
        let member_left = roster(&[(9, "view-9", VIEWER)]);
        assert_eq!(
            plan_session_state(&before, &member_left).rotation,
            KeyRotation::All
        );
        assert_eq!(plan_session_state(&before, &before), KeyPlan::NOTHING);
    }

    fn published(stream: &str, track: &str, ssrc: u32) -> PublishedTrack {
        let mut track = video_track(1, stream, track);
        track.layers[0].ssrc = ssrc;
        track
    }

    /// The rotation itself: a viewer's departure gives the screen and its
    /// audio new keys under new epochs of their own, and leaves the voice key
    /// and the camera key exactly as they were. A member's departure changes
    /// all of them.
    #[tokio::test]
    async fn rotating_for_a_viewer_leaves_the_voice_and_camera_keys_alone() {
        use super::super::session::SenderKeyState;
        use std::sync::Arc;

        let mut registry = super::super::stream_registry::StreamRegistry::default();
        let tracks = [
            published("stream:1:screen", "screen", 10),
            published("stream:1:screen", "screen-audio", 11),
            published("stream:1:camera", "camera", 12),
        ];
        let mut keys = HashMap::new();
        for (index, track) in tracks.iter().enumerate() {
            registry.publish_track(track.clone());
            keys.insert(
                (track.stream_id.clone(), track.track_id.clone()),
                SenderKeyState {
                    epoch: 3,
                    key: [index as u8; KEY_SIZE],
                },
            );
        }
        let registry = Arc::new(tokio::sync::Mutex::new(registry));
        let track_keys = Arc::new(tokio::sync::Mutex::new(keys));
        let encryptor = Arc::new(std::sync::Mutex::new(
            paracord_codec::crypto::FrameEncryptor::new(),
        ));
        let decryptor = Arc::new(std::sync::Mutex::new(FrameDecryptor::new()));
        let voice = Arc::new(std::sync::Mutex::new(SenderKeyState {
            epoch: 5,
            key: [9; KEY_SIZE],
        }));
        let voice_epoch = Arc::new(AtomicU8::new(5));
        let state = KeyState {
            stream_registry: &registry,
            track_sender_keys: &track_keys,
            frame_encryptor: &encryptor,
            frame_decryptor: &decryptor,
            audio_sender_state: &voice,
            current_key_epoch: &voice_epoch,
            local_ssrc: 99,
        };
        let key_of = |track: &PublishedTrack| {
            let keys = track_keys.try_lock().unwrap();
            keys[&(track.stream_id.clone(), track.track_id.clone())]
        };

        state
            .rotate(plan_leave(&remote("view-9", VIEWER)).rotation)
            .await;
        let voice_after = *voice.lock().unwrap();
        assert_eq!(
            (voice_after.epoch, voice_after.key),
            (5, [9; KEY_SIZE]),
            "voice untouched"
        );
        assert_eq!(voice_epoch.load(Ordering::SeqCst), 5);
        for track in &tracks[..2] {
            let rotated = key_of(track);
            assert_eq!(
                rotated.epoch, 4,
                "{:?} moved to its next epoch",
                track.track_id
            );
        }
        let camera = key_of(&tracks[2]);
        assert_eq!(
            (camera.epoch, camera.key),
            (3, [2; KEY_SIZE]),
            "camera untouched"
        );

        state
            .rotate(plan_leave(&remote("s2", MEMBER)).rotation)
            .await;
        let voice_after = *voice.lock().unwrap();
        assert_eq!(voice_after.epoch, 6, "a member leaving rotates the voice");
        assert_ne!(voice_after.key, [9; KEY_SIZE]);
        assert_eq!(key_of(&tracks[0]).epoch, 5);
        assert_eq!(key_of(&tracks[2]).epoch, 4, "and the camera");
    }

    #[test]
    fn a_relay_close_is_reported_in_the_relays_words() {
        use paracord_transport::control::MediaCloseReason;
        for reason in MediaCloseReason::ALL {
            let closed = quinn::ConnectionError::ApplicationClosed(quinn::ApplicationClose {
                error_code: quinn::VarInt::from_u32(reason.code()),
                reason: bytes::Bytes::from_static(reason.reason().as_bytes()),
            });
            assert_eq!(
                describe_connection_close(&closed),
                format!("Closed by the relay: {}", reason.reason())
            );
        }
        let lost = describe_connection_close(&quinn::ConnectionError::TimedOut);
        assert!(lost.starts_with("Native voice connection lost"), "{lost}");
    }

    #[test]
    fn speaking_hysteresis_needs_loud_to_start_and_quiet_hold_to_stop() {
        let t0 = Instant::now();
        let mut h = SpeakerHysteresis::new(t0);

        // A level inside the hysteresis band never starts speaking.
        assert!(!h.update((SPEAKING_LEVEL_ON + SPEAKING_LEVEL_OFF) / 2, t0));
        // Clearly loud (below the "on" threshold) starts speaking.
        assert!(h.update(SPEAKING_LEVEL_ON - 1, t0));
        // A mid-band level holds the speaking state.
        assert!(h.update((SPEAKING_LEVEL_ON + SPEAKING_LEVEL_OFF) / 2, t0));
        // Quiet but still within the hold window keeps it lit.
        assert!(h.update(AUDIO_LEVEL_SILENCE, t0 + Duration::from_millis(50)));
        // Quiet past the hold window finally drops it.
        assert!(!h.update(
            AUDIO_LEVEL_SILENCE,
            t0 + SPEAKING_HOLD + Duration::from_millis(1)
        ));
    }

    #[test]
    fn speaking_hysteresis_hold_resets_when_loud_again() {
        let t0 = Instant::now();
        let mut h = SpeakerHysteresis::new(t0);

        assert!(h.update(SPEAKING_LEVEL_ON - 1, t0));
        // Quiet within the hold window, then loud again refreshes `last_loud`.
        assert!(h.update(AUDIO_LEVEL_SILENCE, t0 + Duration::from_millis(200)));
        assert!(h.update(SPEAKING_LEVEL_ON - 1, t0 + Duration::from_millis(250)));
        // The hold window is now measured from the refreshed instant, so a quiet
        // sample that would have exceeded the original hold still keeps speaking.
        assert!(h.update(AUDIO_LEVEL_SILENCE, t0 + Duration::from_millis(400)));
    }

    // ── Re-share key lifecycle (stream-fix-v2) ──────────────────────────────

    fn screen_ladder(stream: &str) -> PublishedTrack {
        let mut track = video_track(7, stream, "screen");
        track.layers = (0..3)
            .map(|layer_id| PublishedLayer {
                layer_id,
                ssrc: 100 + u32::from(layer_id),
                width: Some(640 << layer_id),
                height: Some(360 << layer_id),
                max_bitrate_kbps: Some(1000),
                active: layer_id == 2,
            })
            .collect();
        track
    }

    /// Seal one packet the way a publisher does, for `ssrc` under `epoch`.
    fn seal(
        encryptor: &mut paracord_codec::crypto::FrameEncryptor,
        ssrc: u32,
        epoch: u8,
        sequence: u16,
    ) -> ([u8; 16], Vec<u8>) {
        let header = [epoch; 16];
        let ciphertext = encryptor
            .encrypt(&header, ssrc, epoch, sequence, b"frame")
            .expect("seal");
        (header, ciphertext)
    }

    #[test]
    fn a_restarted_track_never_reuses_its_last_key_epoch() {
        // First share: the call's epoch. Later shares: the epoch after the
        // last key's (a rotation moved it on, or the share before).
        assert_eq!(fresh_track_key_epoch(None, 1), 1);
        assert_eq!(fresh_track_key_epoch(Some(1), 1), 2);
        assert_eq!(fresh_track_key_epoch(Some(4), 1), 5);
        // 0 is the wire's "no key": the epoch after 255 is 1.
        assert_eq!(fresh_track_key_epoch(Some(255), 1), 1);
    }

    /// The audit's B1, end to end at the key level: a viewer watching a share
    /// that stops and starts again. Frames sealed with the new share's key
    /// before it arrives read as "no key" (not as the old share's key failing),
    /// the key's arrival is a change that asks for a keyframe, and the new
    /// share's frames then open.
    #[test]
    fn a_reshare_reads_as_no_key_until_its_key_lands_and_then_asks_for_a_keyframe() {
        use paracord_codec::crypto::{CryptoError, FrameEncryptor};
        let stream = "stream:sharer:screen";
        let mut registry = super::super::stream_registry::StreamRegistry::default();
        let mut decryptor = FrameDecryptor::new();
        let mut publisher = FrameEncryptor::new();

        // The first share, watched: key 1 under epoch 1 for every layer.
        let track = screen_ladder(stream);
        registry.publish_track(track.clone());
        registry.subscribe(subscription(stream, "screen"));
        for layer in &track.layers {
            publisher.set_peer_key(layer.ssrc, 1, &[1; KEY_SIZE]);
        }
        registry.store_delivered_track_key(&track.stream_id, &track.track_id, 1, [1; KEY_SIZE]);
        assert!(install_track_key(&mut decryptor, &track, 1, &[1; KEY_SIZE]));
        // A repeated delivery of the same key is not a change: no keyframe.
        assert!(!install_track_key(
            &mut decryptor,
            &track,
            1,
            &[1; KEY_SIZE]
        ));
        let (header, sealed) = seal(&mut publisher, 101, 1, 10);
        assert!(decryptor.decrypt(&header, 101, 1, 10, &sealed).is_ok());

        // The sharer stops: the track's keys go with it.
        let epochs = registry
            .delivered_track_keys_for_track(&track.stream_id, &track.track_id)
            .into_iter()
            .map(|(epoch, _)| epoch)
            .collect::<Vec<_>>();
        forget_track_keys(&mut decryptor, &track, &epochs);
        registry.unpublish_track(&track.stream_id, &track.track_id);

        // It shares again: key 2 under the next epoch, sealing from frame one.
        let epoch = fresh_track_key_epoch(Some(1), 1);
        for layer in &track.layers {
            publisher.set_peer_key(layer.ssrc, epoch, &[2; KEY_SIZE]);
        }
        let (header, opening_keyframe) = seal(&mut publisher, 101, epoch, 11);
        registry.publish_track(track.clone());
        // The viewer's engine subscribes again on the publish.
        registry.subscribe(subscription(stream, "screen"));
        let error = decryptor
            .decrypt(&header, 101, epoch, 11, &opening_keyframe)
            .unwrap_err();
        assert!(matches!(error, CryptoError::NoKeyForEpoch(_)));
        assert_eq!(
            DecryptFailureReason::from_error(&error),
            DecryptFailureReason::NoKey
        );

        // The key lands: a change, on a subscribed video track, so a keyframe
        // is asked for on the layer the viewer receives.
        assert!(install_track_key(
            &mut decryptor,
            &track,
            epoch,
            &[2; KEY_SIZE]
        ));
        match keyframe_request_for_new_key(&registry, &track) {
            Some(ControlMessage::RequestKeyframe {
                stream_id,
                track_id,
                layer_id,
            }) => {
                assert_eq!(stream_id.0, stream);
                assert_eq!(track_id.0, "screen");
                assert_eq!(layer_id, Some(0));
            }
            other => panic!("expected a keyframe request, got {other:?}"),
        }
        let (header, keyframe) = seal(&mut publisher, 101, epoch, 12);
        assert_eq!(
            decryptor
                .decrypt(&header, 101, epoch, 12, &keyframe)
                .unwrap(),
            b"frame"
        );
    }

    #[test]
    fn a_stale_key_reads_as_wrong_key_and_no_keyframe_is_asked_for_audio_or_unwatched_tracks() {
        use paracord_codec::crypto::FrameEncryptor;
        let mut decryptor = FrameDecryptor::new();
        let mut publisher = FrameEncryptor::new();
        decryptor.set_peer_key(101, 1, &[1; KEY_SIZE]);
        publisher.set_peer_key(101, 1, &[2; KEY_SIZE]);
        let (header, sealed) = seal(&mut publisher, 101, 1, 1);
        let error = decryptor.decrypt(&header, 101, 1, 1, &sealed).unwrap_err();
        assert_eq!(
            DecryptFailureReason::from_error(&error),
            DecryptFailureReason::WrongKey
        );
        assert!(DecryptFailureReason::WrongKey.is_key_problem());
        assert!(!DecryptFailureReason::Replay.is_key_problem());

        let registry = super::super::stream_registry::StreamRegistry::default();
        // Not subscribed here: nothing to ask for.
        assert!(keyframe_request_for_new_key(&registry, &screen_ladder("s:7:screen")).is_none());
        // Audio has no keyframes.
        let mut registry = registry;
        let mut audio = screen_ladder("s:7:screen");
        audio.track_id = TrackId::new("screen-audio");
        audio.kind = TrackKind::Audio;
        registry.subscribe(subscription("s:7:screen", "screen-audio"));
        assert!(keyframe_request_for_new_key(&registry, &audio).is_none());
    }

    #[test]
    fn decrypt_failures_alert_at_the_threshold_and_again_while_they_last() {
        let mut runs = HashMap::new();
        let t0 = Instant::now();
        let fail = Some(DecryptFailureReason::NoKey);
        for _ in 1..DECRYPT_FAILURE_ALERT_THRESHOLD {
            assert_eq!(fold_decrypt_result(&mut runs, 9, 2, fail, t0), None);
        }
        let first = fold_decrypt_result(&mut runs, 9, 2, fail, t0).expect("alert");
        assert!(first.first);
        assert_eq!(first.consecutive, DECRYPT_FAILURE_ALERT_THRESHOLD);
        assert_eq!(first.epoch, 2);
        assert_eq!(first.reason, DecryptFailureReason::NoKey);
        // Still failing, but within the repeat interval: quiet.
        assert_eq!(
            fold_decrypt_result(&mut runs, 9, 2, fail, t0 + Duration::from_millis(500)),
            None
        );
        // Past it: the alert repeats (the renderer asks for the key again).
        let again = fold_decrypt_result(&mut runs, 9, 2, fail, t0 + DECRYPT_FAILURE_REALERT)
            .expect("repeat");
        assert!(!again.first);
        // One packet that opens ends the run.
        assert_eq!(fold_decrypt_result(&mut runs, 9, 2, None, t0), None);
        assert!(runs.is_empty());
    }

    #[test]
    fn decrypt_failure_runs_are_bounded() {
        let mut runs = HashMap::new();
        let now = Instant::now();
        let fail = Some(DecryptFailureReason::WrongKey);
        for ssrc in 0..MAX_DECRYPT_FAILURE_COUNTERS as u32 {
            fold_decrypt_result(&mut runs, ssrc, 1, fail, now);
        }
        // A never-seen SSRC adds nothing once the map is full.
        fold_decrypt_result(&mut runs, u32::MAX, 1, fail, now);
        assert_eq!(runs.len(), MAX_DECRYPT_FAILURE_COUNTERS);
        assert!(!runs.contains_key(&u32::MAX));
    }
}
