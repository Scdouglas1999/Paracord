//! Windows: the system media transport controls
//! (`Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`),
//! the same source as the media flyout next to the volume control.
//!
//! The OS already decides which session is "current", so this reader follows
//! `CurrentSessionChanged` and, for the current session, `MediaPropertiesChanged`,
//! `PlaybackInfoChanged` and `TimelinePropertiesChanged`. Handlers only wake the
//! reader thread; all reading happens there. Nothing is polled, and no playback
//! method (`TryPlayAsync`, `TrySkipNextAsync`, …) is ever called.
//!
//! NOTE: this file is compiled only by the Windows CI build.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as WinStatus,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use super::model::{is_paracord_media, should_emit, Emitted, PlaybackStatus, PlayerState};
use super::{Sink, Update};

/// `TimeSpan` / `DateTime` tick: 100 ns.
const TICKS_PER_MS: i64 = 10_000;
/// 1601-01-01 (the `DateTime` epoch) to 1970-01-01, in ticks.
const FILETIME_UNIX_OFFSET_TICKS: i64 = 116_444_736_000_000_000;
/// How often the reader thread checks whether it has been told to stop.
const STOP_CHECK: Duration = Duration::from_millis(500);

enum Wake {
    SessionChanged,
    SessionUpdated,
}

struct Subscription {
    session: Session,
    media_token: i64,
    playback_token: i64,
    timeline_token: i64,
}

impl Subscription {
    fn new(session: Session, wake: &mpsc::Sender<Wake>) -> windows::core::Result<Self> {
        let on_media = wake.clone();
        let media_token =
            session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                let _ = on_media.send(Wake::SessionUpdated);
                Ok(())
            }))?;
        let on_playback = wake.clone();
        let playback_token =
            session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                let _ = on_playback.send(Wake::SessionUpdated);
                Ok(())
            }))?;
        let on_timeline = wake.clone();
        let timeline_token =
            session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                let _ = on_timeline.send(Wake::SessionUpdated);
                Ok(())
            }))?;
        Ok(Self {
            session,
            media_token,
            playback_token,
            timeline_token,
        })
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.session.RemoveMediaPropertiesChanged(self.media_token);
        let _ = self.session.RemovePlaybackInfoChanged(self.playback_token);
        let _ = self
            .session
            .RemoveTimelinePropertiesChanged(self.timeline_token);
    }
}

fn now_ticks() -> i64 {
    let since_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    FILETIME_UNIX_OFFSET_TICKS + (since_unix.as_nanos() / 100) as i64
}

fn ticks_to_ms(ticks: i64) -> Option<u64> {
    (ticks >= 0).then_some((ticks / TICKS_PER_MS) as u64)
}

/// Read the current session into the shared player model.
fn read_session(
    session: &Session,
    seq: &mut u64,
    previous: &Option<PlayerState>,
) -> windows::core::Result<PlayerState> {
    let app_id = session.SourceAppUserModelId()?.to_string_lossy();
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let title = props.Title()?.to_string_lossy();
    let artist = props.Artist()?.to_string_lossy();
    let status = match session.GetPlaybackInfo()?.PlaybackStatus()? {
        WinStatus::Playing => PlaybackStatus::Playing,
        WinStatus::Paused => PlaybackStatus::Paused,
        _ => PlaybackStatus::Stopped,
    };
    let timeline = session.GetTimelineProperties()?;
    let start = timeline.StartTime()?.Duration;
    let end = timeline.EndTime()?.Duration;
    let mut position = timeline.Position()?.Duration - start;
    // The position is as of `LastUpdatedTime`; bring a playing one up to now.
    if status == PlaybackStatus::Playing {
        let updated = timeline.LastUpdatedTime()?.UniversalTime;
        if updated > 0 {
            position += (now_ticks() - updated).max(0);
        }
    }
    let length_ms = ticks_to_ms(end - start).filter(|length| *length > 0);

    let title = (!title.trim().is_empty()).then_some(title);
    let artists: Vec<String> = if artist.trim().is_empty() {
        Vec::new()
    } else {
        vec![artist]
    };
    let changed = previous
        .as_ref()
        .map(|p| p.status != status || p.title != title || p.artists != artists)
        .unwrap_or(true);
    if changed {
        *seq += 1;
    }
    let identity = friendly_app_name(&app_id);
    let belongs_to_paracord = is_paracord_media(&app_id, None, title.as_deref());
    Ok(PlayerState {
        identity,
        desktop_entry: Some(app_id),
        status,
        title,
        artists,
        length_ms,
        position_ms: ticks_to_ms(position),
        position_read_at: Some(Instant::now()),
        changed_seq: *seq,
        belongs_to_paracord,
    })
}

/// The session names its app by AppUserModelID: `Spotify.exe`,
/// `SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify`, `Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`,
/// `308046B0AF4A39CB` (Firefox). Take the most readable part.
fn friendly_app_name(app_id: &str) -> String {
    let tail = app_id.rsplit('!').next().unwrap_or(app_id);
    let tail = tail.strip_suffix(".exe").unwrap_or(tail);
    let tail = tail.rsplit('.').next().unwrap_or(tail);
    let known = match app_id.to_ascii_lowercase() {
        id if id.contains("spotify") => Some("Spotify"),
        id if id.contains("zunemusic") => Some("Media Player"),
        id if id.contains("firefox") || id == "308046b0af4a39cb" => Some("Firefox"),
        id if id.contains("chrome") => Some("Chrome"),
        id if id.contains("msedge") => Some("Edge"),
        _ => None,
    };
    match known {
        Some(name) => name.to_string(),
        None if !tail.trim().is_empty() => tail.to_string(),
        None => "Media player".to_string(),
    }
}

/// Follow the media controls until told to stop. `ready` is answered once the
/// manager is reachable (or with why it is not).
fn follow(
    sink: &Sink,
    stop: &AtomicBool,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let manager = SessionManager::RequestAsync()
        .and_then(|op| op.get())
        .map_err(|err| format!("Could not reach the system media controls: {err}"))?;
    let (wake_tx, wake_rx) = mpsc::channel::<Wake>();
    let on_session = wake_tx.clone();
    let session_token = manager
        .CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
            let _ = on_session.send(Wake::SessionChanged);
            Ok(())
        }))
        .map_err(|err| format!("Could not follow the system media controls: {err}"))?;
    let _ = ready.send(Ok(()));

    let mut subscription: Option<Subscription> = None;
    let mut player: Option<PlayerState> = None;
    let mut seq = 0u64;
    let mut last: Option<Emitted> = None;
    let mut resubscribe = true;
    let outcome = loop {
        if stop.load(Ordering::SeqCst) {
            break Ok(());
        }
        if resubscribe {
            subscription = None;
            player = None;
            // `GetCurrentSession` fails (or returns null) when nothing is
            // playing anywhere; that is "no session", not an error.
            if let Ok(session) = manager.GetCurrentSession() {
                match Subscription::new(session, &wake_tx) {
                    Ok(sub) => subscription = Some(sub),
                    Err(err) => {
                        break Err(format!("Could not follow the current media session: {err}"))
                    }
                }
            }
            resubscribe = false;
        }
        player = match &subscription {
            Some(sub) => match read_session(&sub.session, &mut seq, &player) {
                Ok(state) => Some(state),
                Err(err) => {
                    tracing::debug!(%err, "now playing: media session unreadable");
                    None
                }
            },
            None => None,
        };
        let now = Instant::now();
        let next = player
            .as_ref()
            .filter(|state| !state.belongs_to_paracord)
            .and_then(|state| state.now_playing(now));
        if should_emit(last.as_ref(), &next, now) {
            sink(Update::Track(next.clone()));
            last = Some(Emitted {
                value: next,
                at: now,
            });
        }
        // Wait for the next change, checking for stop now and then.
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match wake_rx.recv_timeout(STOP_CHECK) {
                Ok(Wake::SessionChanged) => {
                    resubscribe = true;
                    break;
                }
                Ok(Wake::SessionUpdated) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    };
    drop(subscription);
    let _ = manager.RemoveCurrentSessionChanged(session_token);
    outcome
}

fn run(sink: Sink, stop: Arc<AtomicBool>, ready: mpsc::Sender<Result<(), String>>) {
    // WinRT needs COM on this thread.
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if com.is_err() {
        let _ = ready.send(Err(format!(
            "Could not start the media controls reader (COM): {com:?}"
        )));
        return;
    }
    let result = follow(&sink, &stop, &ready);
    unsafe { CoUninitialize() };
    match result {
        Ok(()) => {}
        Err(message) => {
            // Before `ready` was answered this reaches `spawn`'s caller; after,
            // the web layer hears it as `now_playing_failed`.
            if ready.send(Err(message.clone())).is_err() {
                sink(Update::Failed(message));
            }
        }
    }
}

/// Start the reader thread. Returns once the media controls answered (or with
/// the reason they did not), and hands back the function that stops it.
pub(crate) fn spawn(sink: Sink) -> Result<impl FnOnce() + Send + 'static, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread_stop = stop.clone();
    std::thread::Builder::new()
        .name("now-playing".into())
        .spawn(move || run(sink, thread_stop, ready_tx))
        .map_err(|err| format!("Could not start the media controls reader: {err}"))?;
    ready_rx
        .recv()
        .map_err(|_| "The media controls reader exited before it started.".to_string())??;
    Ok(move || stop.store(true, Ordering::SeqCst))
}
