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
use std::thread::JoinHandle;

use tokio::sync::{mpsc, oneshot};

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
    SwitchOutputDevice {
        device_index: usize,
        ssrcs: Vec<u32>,
        reply: oneshot::Sender<Result<HashMap<u32, mpsc::Sender<PcmFrame>>, String>>,
    },
    Shutdown,
}

/// Handle to the dedicated audio thread. Cloneable-safe (`Send + Sync`) because
/// it holds only a channel sender and the join handle; the cpal streams stay on
/// the far side of the channel.
pub struct AudioActor {
    tx: mpsc::UnboundedSender<AudioCommand>,
    thread: Option<JoinHandle<()>>,
}

impl AudioActor {
    /// Spawn the dedicated audio thread.
    ///
    /// Must be called from within a tokio runtime: the thread needs the runtime
    /// handle to drive the playback mixer's per-source forwarding tasks.
    pub fn spawn() -> Self {
        let handle = tokio::runtime::Handle::current();
        let (tx, rx) = mpsc::unbounded_channel();
        let thread = std::thread::Builder::new()
            .name("paracord-audio".to_string())
            .spawn(move || run_audio_thread(rx, handle))
            .expect("failed to spawn audio actor thread");
        Self {
            tx,
            thread: Some(thread),
        }
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

    /// Register a new remote playout source, returning the sender the caller
    /// pushes decoded PCM into. `None` if playback is not currently running.
    pub async fn add_playback_source(&self, ssrc: u32) -> Option<mpsc::Sender<PcmFrame>> {
        let (reply, rx) = oneshot::channel();
        self.send(AudioCommand::AddPlaybackSource { ssrc, reply })
            .ok()?;
        rx.await.ok().flatten()
    }

    /// Switch the output device, re-attaching the given remote sources to the
    /// new device and returning their fresh senders. A stale host index falls
    /// back to the system default so a failed switch never silences audio.
    pub async fn switch_output_device(
        &self,
        device_index: usize,
        ssrcs: Vec<u32>,
    ) -> Result<HashMap<u32, mpsc::Sender<PcmFrame>>, String> {
        let (reply, rx) = oneshot::channel();
        self.send(AudioCommand::SwitchOutputDevice {
            device_index,
            ssrcs,
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

fn run_audio_thread(mut rx: mpsc::UnboundedReceiver<AudioCommand>, handle: tokio::runtime::Handle) {
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
                    Some(index) => AudioPlayback::start_device(index),
                    None => AudioPlayback::start(),
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
            AudioCommand::SwitchOutputDevice {
                device_index,
                ssrcs,
                reply,
            } => {
                // Build the replacement before tearing down the current output
                // so a failed switch never leaves the user with no audio.
                let replacement = match AudioPlayback::start_device(device_index) {
                    Ok(pb) => pb,
                    Err(err) => {
                        tracing::warn!(
                            device_index,
                            error = %err,
                            "output device index unavailable; falling back to default output device"
                        );
                        match AudioPlayback::start() {
                            Ok(pb) => pb,
                            Err(err) => {
                                let _ = reply
                                    .send(Err(format!("output device (default fallback): {err}")));
                                continue;
                            }
                        }
                    }
                };
                let senders = {
                    let _runtime = handle.enter();
                    ssrcs
                        .into_iter()
                        .map(|ssrc| {
                            let sender = replacement.add_source(ssrc);
                            (ssrc, sender)
                        })
                        .collect::<HashMap<_, _>>()
                };
                if let Some(old) = playback.replace(replacement) {
                    old.stop();
                }
                let _ = reply.send(Ok(senders));
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
