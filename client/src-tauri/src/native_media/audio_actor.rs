//! Single-thread owner for the cpal-backed audio streams.
//!
//! `cpal::Stream` is `!Send`/`!Sync` as a cross-platform precaution, and on
//! macOS CoreAudio a stream must be created, used, *and dropped* on the same
//! thread — dropping it on another thread is undefined behaviour. The rest of
//! the native media session is driven from tokio worker threads and is moved
//! between them freely, so the cpal-backed [`AudioCapture`]/[`AudioPlayback`]
//! must not live directly inside `NativeMediaSession`.
//!
//! [`AudioActor`] confines both to a single dedicated OS thread. All access
//! goes through commands sent over a channel; the streams are only ever
//! touched — and dropped — on that thread. This lets `NativeMediaSession` drop
//! its blanket `unsafe impl Send`/`Sync` and hold only the (`Send + Sync`)
//! actor handle instead.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::JoinHandle;

use tokio::sync::{mpsc, oneshot};

use paracord_codec::audio::aec::{ReferenceConsumer, ReferenceRing, REFERENCE_RING_CAPACITY};
use paracord_codec::audio::capture::AudioCapture;
use paracord_codec::audio::playback::AudioPlayback;

/// 20 ms PCM f32 mono frame at 48 kHz, as produced/consumed by the codec layer.
type PcmFrame = Vec<f32>;

enum AudioCommand {
    StartCapture {
        device_index: Option<usize>,
        reply: oneshot::Sender<Result<mpsc::Receiver<PcmFrame>, String>>,
    },
    StopCapture,
    StartPlayback {
        device_index: Option<usize>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    StopPlayback,
    AddPlaybackSource {
        ssrc: u32,
        reply: oneshot::Sender<Option<mpsc::Sender<PcmFrame>>>,
    },
    AddStreamPlaybackSource {
        ssrc: u32,
        reply: oneshot::Sender<Option<mpsc::Sender<PcmFrame>>>,
    },
    RemovePlaybackSource {
        ssrc: u32,
    },
    SetSourceGain {
        ssrc: u32,
        gain: f32,
    },
    SwitchOutputDevice {
        device_index: usize,
        voice_ssrcs: Vec<u32>,
        stream_ssrcs: Vec<u32>,
        reply: oneshot::Sender<Result<SwitchedSources, String>>,
    },
    Shutdown,
}

/// Fresh per-SSRC senders after an output-device switch, split by source kind so
/// each is re-registered with the matching (mono voice / stereo stream) mixer
/// source layout.
pub struct SwitchedSources {
    pub voice: HashMap<u32, mpsc::Sender<PcmFrame>>,
    pub stream: HashMap<u32, mpsc::Sender<PcmFrame>>,
}

/// Handle to the dedicated audio thread. Cloneable-safe (`Send + Sync`) because
/// it holds only a channel sender and the join handle; the cpal streams stay on
/// the far side of the channel.
pub struct AudioActor {
    tx: mpsc::UnboundedSender<AudioCommand>,
    thread: Option<JoinHandle<()>>,
    /// Far-end reference ring for the AEC. Owned by the actor (which owns both
    /// capture and playback) so it survives output-device switches: each new
    /// `AudioPlayback` attaches a fresh producer to this same ring, and the mic
    /// send task holds one stable consumer (contract AEC4).
    reference: Arc<ReferenceRing>,
    /// Echo-cancellation / AGC enables (contract AEC3, default ON). Live here
    /// rather than on the session so the (unowned) command handlers can flip them
    /// through the `Arc<AudioActor>` the session already holds, and the mic send
    /// task reads them each frame.
    echo_cancellation_enabled: Arc<AtomicBool>,
    agc_enabled: Arc<AtomicBool>,
}

impl AudioActor {
    /// Spawn the dedicated audio thread.
    ///
    /// Must be called from within a tokio runtime: the thread needs the runtime
    /// handle to drive the playback mixer's per-source forwarding tasks.
    pub fn spawn() -> Self {
        let handle = tokio::runtime::Handle::current();
        let (tx, rx) = mpsc::unbounded_channel();
        let reference = ReferenceRing::new(REFERENCE_RING_CAPACITY);
        let thread_reference = reference.clone();
        let thread = std::thread::Builder::new()
            .name("paracord-audio".to_string())
            .spawn(move || run_audio_thread(rx, handle, thread_reference))
            .expect("failed to spawn audio actor thread");
        Self {
            tx,
            thread: Some(thread),
            reference,
            echo_cancellation_enabled: Arc::new(AtomicBool::new(true)),
            agc_enabled: Arc::new(AtomicBool::new(true)),
        }
    }

    /// A consumer for the far-end reference ring, held by the mic send task.
    pub fn reference_consumer(&self) -> ReferenceConsumer {
        self.reference.consumer()
    }

    /// Shared echo-cancellation enable flag (contract AEC3). The send task reads
    /// it; command handlers flip it via [`AudioActor::set_echo_cancellation`].
    pub fn echo_cancellation_flag(&self) -> Arc<AtomicBool> {
        self.echo_cancellation_enabled.clone()
    }

    /// Shared AGC enable flag (contract AEC3).
    pub fn agc_flag(&self) -> Arc<AtomicBool> {
        self.agc_enabled.clone()
    }

    /// Toggle echo cancellation (contract AEC3). Called by the
    /// `voice_set_echo_cancellation` command handler (in `commands.rs`, which is
    /// not owned by this change — see the AEC report notes).
    #[allow(dead_code)] // wired by the voice_set_echo_cancellation command
    pub fn set_echo_cancellation(&self, enabled: bool) {
        self.echo_cancellation_enabled
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    /// Toggle AGC (contract AEC3). Called by the `voice_set_agc` command handler.
    #[allow(dead_code)] // wired by the voice_set_agc command
    pub fn set_agc(&self, enabled: bool) {
        self.agc_enabled
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    fn send(&self, command: AudioCommand) -> Result<(), String> {
        self.tx
            .send(command)
            .map_err(|_| "audio actor thread has stopped".to_string())
    }

    /// Start (or restart) capture on the given device, returning the PCM frame
    /// stream. Any previously running capture is stopped and dropped first.
    pub async fn start_capture(
        &self,
        device_index: Option<usize>,
    ) -> Result<mpsc::Receiver<PcmFrame>, String> {
        let (reply, rx) = oneshot::channel();
        self.send(AudioCommand::StartCapture {
            device_index,
            reply,
        })?;
        rx.await
            .map_err(|_| "audio actor dropped capture reply".to_string())?
    }

    /// Stop capture (best effort). The stream is dropped on the audio thread.
    pub fn stop_capture(&self) {
        let _ = self.send(AudioCommand::StopCapture);
    }

    /// Start (or replace) playback on the given device.
    pub async fn start_playback(&self, device_index: Option<usize>) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.send(AudioCommand::StartPlayback {
            device_index,
            reply,
        })?;
        rx.await
            .map_err(|_| "audio actor dropped playback reply".to_string())?
    }

    /// Silence playback (best effort). The stream stays alive until shutdown.
    pub fn stop_playback(&self) {
        let _ = self.send(AudioCommand::StopPlayback);
    }

    /// Register a new remote **mono voice** playout source, returning the sender
    /// the caller pushes decoded PCM into. `None` if playback is not running.
    pub async fn add_playback_source(&self, ssrc: u32) -> Option<mpsc::Sender<PcmFrame>> {
        let (reply, rx) = oneshot::channel();
        self.send(AudioCommand::AddPlaybackSource { ssrc, reply })
            .ok()?;
        rx.await.ok().flatten()
    }

    /// Register a new remote **stereo stream** playout source (contract C4/AU4),
    /// returning the sender for 1920-sample interleaved-stereo frames.
    pub async fn add_stream_playback_source(&self, ssrc: u32) -> Option<mpsc::Sender<PcmFrame>> {
        let (reply, rx) = oneshot::channel();
        self.send(AudioCommand::AddStreamPlaybackSource { ssrc, reply })
            .ok()?;
        rx.await.ok().flatten()
    }

    /// Remove a playout source (best effort). Used by the idle-source reaper (AU9).
    pub async fn remove_playback_source(&self, ssrc: u32) {
        let _ = self.send(AudioCommand::RemovePlaybackSource { ssrc });
    }

    /// Set a playout source's gain (contract AU4). Clamped by the caller.
    pub fn set_source_gain(&self, ssrc: u32, gain: f32) {
        let _ = self.send(AudioCommand::SetSourceGain { ssrc, gain });
    }

    /// Switch the output device, re-attaching the given remote sources to the
    /// new device and returning their fresh senders (voice mono + stream stereo,
    /// kept separate so each is rebuilt with the right layout). A stale host
    /// index falls back to the system default so a failed switch never silences
    /// audio.
    pub async fn switch_output_device(
        &self,
        device_index: usize,
        voice_ssrcs: Vec<u32>,
        stream_ssrcs: Vec<u32>,
    ) -> Result<SwitchedSources, String> {
        let (reply, rx) = oneshot::channel();
        self.send(AudioCommand::SwitchOutputDevice {
            device_index,
            voice_ssrcs,
            stream_ssrcs,
            reply,
        })?;
        rx.await
            .map_err(|_| "audio actor dropped output-switch reply".to_string())?
    }
}

impl Drop for AudioActor {
    fn drop(&mut self) {
        // Ask the thread to drop the streams on its own stack, then join so the
        // cpal streams are guaranteed to be destroyed on the thread that built
        // them before this handle goes away.
        let _ = self.tx.send(AudioCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run_audio_thread(
    mut rx: mpsc::UnboundedReceiver<AudioCommand>,
    handle: tokio::runtime::Handle,
    reference: Arc<ReferenceRing>,
) {
    let mut capture: Option<AudioCapture> = None;
    let mut playback: Option<AudioPlayback> = None;

    // `blocking_recv` is valid here because this is a plain OS thread, never a
    // tokio worker. The runtime handle is only entered transiently, below,
    // around the `add_source` calls that internally spawn a forwarding task.
    while let Some(command) = rx.blocking_recv() {
        match command {
            AudioCommand::StartCapture {
                device_index,
                reply,
            } => {
                if let Some(old) = capture.take() {
                    old.stop();
                }
                let result = match device_index {
                    Some(index) => AudioCapture::start_device(index),
                    None => AudioCapture::start(),
                };
                match result {
                    Ok((new_capture, pcm_rx)) => {
                        capture = Some(new_capture);
                        let _ = reply.send(Ok(pcm_rx));
                    }
                    Err(err) => {
                        let _ = reply.send(Err(format!("audio capture: {err}")));
                    }
                }
            }
            AudioCommand::StopCapture => {
                if let Some(old) = capture.take() {
                    old.stop();
                }
            }
            AudioCommand::StartPlayback {
                device_index,
                reply,
            } => {
                let result = match device_index {
                    Some(index) => AudioPlayback::start_device(index, Some(reference.clone())),
                    None => AudioPlayback::start(Some(reference.clone())),
                };
                match result {
                    Ok(new_playback) => {
                        if let Some(old) = playback.replace(new_playback) {
                            old.stop();
                        }
                        let _ = reply.send(Ok(()));
                    }
                    Err(err) => {
                        let _ = reply.send(Err(format!("audio playback: {err}")));
                    }
                }
            }
            AudioCommand::StopPlayback => {
                if let Some(old) = playback.take() {
                    old.stop();
                }
            }
            AudioCommand::AddPlaybackSource { ssrc, reply } => {
                let sender = playback.as_ref().map(|pb| {
                    let _runtime = handle.enter();
                    pb.add_source(ssrc)
                });
                let _ = reply.send(sender);
            }
            AudioCommand::AddStreamPlaybackSource { ssrc, reply } => {
                let sender = playback.as_ref().map(|pb| {
                    let _runtime = handle.enter();
                    pb.add_stream_source(ssrc)
                });
                let _ = reply.send(sender);
            }
            AudioCommand::RemovePlaybackSource { ssrc } => {
                if let Some(pb) = playback.as_ref() {
                    pb.remove_source(ssrc);
                }
            }
            AudioCommand::SetSourceGain { ssrc, gain } => {
                if let Some(pb) = playback.as_ref() {
                    pb.set_source_gain(ssrc, gain);
                }
            }
            AudioCommand::SwitchOutputDevice {
                device_index,
                voice_ssrcs,
                stream_ssrcs,
                reply,
            } => {
                // Build the replacement before tearing down the current output
                // so a failed switch never leaves the user with no audio.
                let replacement = match AudioPlayback::start_device(
                    device_index,
                    Some(reference.clone()),
                ) {
                    Ok(pb) => pb,
                    Err(err) => {
                        tracing::warn!(
                            device_index,
                            error = %err,
                            "output device index unavailable; falling back to default output device"
                        );
                        match AudioPlayback::start(Some(reference.clone())) {
                            Ok(pb) => pb,
                            Err(err) => {
                                let _ = reply
                                    .send(Err(format!("output device (default fallback): {err}")));
                                continue;
                            }
                        }
                    }
                };
                let switched = {
                    let _runtime = handle.enter();
                    SwitchedSources {
                        voice: voice_ssrcs
                            .into_iter()
                            .map(|ssrc| (ssrc, replacement.add_source(ssrc)))
                            .collect(),
                        stream: stream_ssrcs
                            .into_iter()
                            .map(|ssrc| (ssrc, replacement.add_stream_source(ssrc)))
                            .collect(),
                    }
                };
                if let Some(old) = playback.replace(replacement) {
                    old.stop();
                }
                let _ = reply.send(Ok(switched));
            }
            AudioCommand::Shutdown => {
                if let Some(old) = capture.take() {
                    old.stop();
                }
                if let Some(old) = playback.take() {
                    old.stop();
                }
                break;
            }
        }
    }

    // Drop both streams here, on the thread that created them.
    drop(capture);
    drop(playback);
}
