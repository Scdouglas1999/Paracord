use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::mpsc;

use paracord_codec::audio::resample::{StereoResampler, STEREO_FRAME_SAMPLES};

/// Sink for captured system audio: contract C4 delivers 48kHz stereo interleaved
/// 20ms frames (1920 samples) straight into the media session's `screen_audio_tx`.
/// There is no JS round-trip anymore.
type ScreenAudioSink = mpsc::Sender<Vec<f32>>;

/// One-shot report of whether the capture device actually opened.
///
/// The capture loop runs on its own thread, so before this existed
/// `start_system_audio_capture_into` returned `Ok` the moment the thread was
/// spawned — a sound server that refused the capture source failed a beat later,
/// on that thread, into `eprintln!`. The UI had already been told audio was
/// live, and the stream went out silent with nothing in the log a person would
/// look at. Every capture backend now says "open" or "here is why not", and the
/// caller waits for one of the two.
struct StartupSignal {
    tx: Mutex<Option<std::sync::mpsc::Sender<Result<(), String>>>>,
}

impl StartupSignal {
    fn new(tx: std::sync::mpsc::Sender<Result<(), String>>) -> Self {
        Self {
            tx: Mutex::new(Some(tx)),
        }
    }

    /// The device is open and delivering; the caller may report success.
    fn ready(&self) {
        self.report(Ok(()));
    }

    /// Capture could not start. Ignored if the device already reported ready —
    /// a mid-session failure is not a startup failure.
    fn failed(&self, reason: String) {
        self.report(Err(reason));
    }

    fn report(&self, outcome: Result<(), String>) {
        if let Ok(mut guard) = self.tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(outcome);
            }
        }
    }
}

/// Accumulates arbitrary-size interleaved-stereo device-rate chunks and emits
/// complete 48kHz 20ms stereo frames (1920 interleaved samples) into the sink,
/// resampling with rubato when the source rate is not 48kHz (contract C4/AU3).
struct StereoFrameEmitter {
    resampler: Option<StereoResampler>,
    /// Interleaved-stereo 48kHz samples awaiting 1920-sample chunking.
    accumulator: Vec<f32>,
    scratch: Vec<Vec<f32>>,
}

impl StereoFrameEmitter {
    fn new(source_rate: u32) -> Result<Self, String> {
        let resampler = if source_rate != 48_000 {
            Some(StereoResampler::new(source_rate)?)
        } else {
            None
        };
        Ok(Self {
            resampler,
            accumulator: Vec::with_capacity(STEREO_FRAME_SAMPLES * 2),
            scratch: Vec::new(),
        })
    }

    /// Push an interleaved-stereo chunk at the source rate; forwards any complete
    /// 48kHz 20ms frames to `sink`.
    fn push(&mut self, interleaved_stereo: &[f32], sink: &ScreenAudioSink) {
        if let Some(resampler) = self.resampler.as_mut() {
            self.scratch.clear();
            resampler.push(interleaved_stereo, &mut self.scratch);
            for frame in self.scratch.drain(..) {
                let _ = sink.try_send(frame);
            }
        } else {
            self.accumulator.extend_from_slice(interleaved_stereo);
            while self.accumulator.len() >= STEREO_FRAME_SAMPLES {
                let frame: Vec<f32> = self.accumulator.drain(..STEREO_FRAME_SAMPLES).collect();
                let _ = sink.try_send(frame);
            }
        }
    }
}

struct CaptureHandle {
    stop_flag: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    /// Linux: the router sweep thread; it restores stream routing and unloads
    /// the capture sink when the stop flag is set.
    router_thread: Option<thread::JoinHandle<()>>,
}

static CAPTURE: Mutex<Option<CaptureHandle>> = Mutex::new(None);
static SYSTEM_AUDIO_CAPTURE_ENABLED: AtomicBool = AtomicBool::new(false);
/// Raised only by `windows_grant::ensure` once it has read the persisted grant
/// off disk (or just written it after the native prompt said yes), and lowered
/// by a revoke. The renderer has no way to set it, which is the point: it is
/// what `start_system_audio_capture_into` trusts instead of the flag above.
#[cfg(target_os = "windows")]
static WINDOWS_GRANT_VERIFIED: AtomicBool = AtomicBool::new(false);
/// Backstop for a sound server that neither opens the capture source nor
/// refuses it. A missing server or a refused source answers immediately.
const SYSTEM_AUDIO_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Consent model for system-audio capture (CWE-862/CWE-359)
//
// Capturing system audio records every other application on the machine and
// puts it in a call, so it needs a grant the webview cannot forge. Where that
// grant comes from differs by platform, and neither route asks again on every
// stream:
//
//   Linux: the grant IS the desktop portal. Screen audio is only ever captured
//     as part of a screen share, and a screen share starts by answering the
//     xdg-desktop-portal picker — an out-of-process, compositor-owned surface a
//     compromised renderer can neither fake nor auto-approve. Paracord used to
//     put a second zenity/kdialog confirmation on top of that; it was redundant,
//     it asked again every single stream, and on a Wayland session the helper
//     inherited display state it could not use, died with "Error 71 (Protocol
//     error)" before anyone saw it, and its non-zero exit was read as "the user
//     said no" (2026-09-14: "System audio capture was denied at the native
//     confirmation prompt", 1.55s after the click, nobody asked). It is gone.
//
//   Windows: there is no portal. The Process Loopback Exclusion API hands us
//     every other process's audio with no OS-level prompt at all, so Paracord
//     asks once per install and remembers the answer on disk
//     (`windows_grant::ensure`). Settings -> Voice & video revokes it.
//
// `SYSTEM_AUDIO_CAPTURE_ENABLED` below is NOT part of that boundary: the
// renderer flips it over IPC and an XSS could do the same. It only says
// "a stream wants audio", and on Windows the persisted grant is checked
// independently before any capture begins.
// ---------------------------------------------------------------------------

/// NOT a Tauri command. It used to carry `#[tauri::command]` and was never
/// registered in `generate_handler!`, so the only caller that ever invoked it
/// from the renderer got "command not found". System audio is driven entirely
/// from `voice_set_screen_audio_enabled` (contract C4: no JS round-trip), and
/// this is its Rust-side switch.
pub fn set_system_audio_capture_enabled(enabled: bool) {
    SYSTEM_AUDIO_CAPTURE_ENABLED.store(enabled, Ordering::SeqCst);
}

/// Whether this platform needs a Paracord-owned grant before system audio can
/// be captured, and whether that grant currently exists. Drives the
/// Settings -> Voice & video control; see the consent model note above.
pub fn system_audio_grant_state(app: &tauri::AppHandle) -> (bool, bool) {
    #[cfg(target_os = "windows")]
    {
        (true, windows_grant::is_granted(app))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        (false, true)
    }
}

/// Withdraw the persisted grant. Only ever removes one — the renderer can take
/// this permission away but can never hand itself one, which is the direction
/// that matters.
pub fn revoke_system_audio_grant(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_grant::revoke(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Make sure this machine has granted system-audio capture, asking once if it
/// never has. A no-op on Linux and macOS, where the grant belongs to the
/// portal/screen-capture consent the stream already went through.
///
/// Blocking on Windows (it raises a modal): call it from `spawn_blocking`, and
/// call it *before* taking the media transition lock — every other media command
/// queues behind that lock, and a modal held under it freezes the call.
pub fn ensure_system_audio_grant(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_grant::ensure(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Windows-only persistent grant. See the consent model note above for why this
/// platform is the one that asks.
#[cfg(target_os = "windows")]
mod windows_grant {
    use std::path::PathBuf;

    use tauri::Manager;

    const GRANTED: &str = "granted";

    fn grant_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let mut dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("failed to resolve the app config directory: {e}"))?;
        dir.push("Paracord");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create the app config directory: {e}"))?;
        dir.push("system-audio-grant");
        Ok(dir)
    }

    pub fn is_granted(app: &tauri::AppHandle) -> bool {
        grant_file(app)
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .is_some_and(|body| body.trim() == GRANTED)
    }

    pub fn revoke(app: &tauri::AppHandle) -> Result<(), String> {
        // Lowered first: whatever happens to the file, this process stops
        // treating the machine as having said yes.
        super::WINDOWS_GRANT_VERIFIED.store(false, std::sync::atomic::Ordering::SeqCst);
        let path = grant_file(app)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("failed to withdraw the system audio grant: {err}")),
        }
    }

    pub fn ensure(app: &tauri::AppHandle) -> Result<(), String> {
        if is_granted(app) {
            super::WINDOWS_GRANT_VERIFIED.store(true, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        }
        super::WINDOWS_GRANT_VERIFIED.store(false, std::sync::atomic::Ordering::SeqCst);
        if crate::NATIVE_PRIVILEGE_PROMPT_ACTIVE
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_err()
        {
            // We could not ask, which is not the same as being told no.
            return Err(
                "Another Paracord permission dialog is already open. Close it and \
                        start the stream again."
                    .into(),
            );
        }
        let answer = prompt();
        crate::NATIVE_PRIVILEGE_PROMPT_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);

        match answer {
            Answer::Allowed => {
                let path = grant_file(app)?;
                std::fs::write(&path, GRANTED)
                    .map_err(|e| format!("failed to record the system audio grant: {e}"))?;
                super::WINDOWS_GRANT_VERIFIED.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
            Answer::Declined => Err("Desktop audio is off because this computer has not been \
                                     allowed to share its own sound. You can allow it the next \
                                     time you start a stream."
                .into()),
            Answer::CouldNotAsk(detail) => {
                eprintln!("[audio_capture] system audio grant prompt failed: {detail}");
                Err(
                    "Paracord could not show the confirmation dialog for desktop audio, so it \
                     did not start capturing. Try starting the stream again."
                        .into(),
                )
            }
        }
    }

    enum Answer {
        Allowed,
        Declined,
        /// The prompt itself failed. Never reported to the user as a refusal.
        CouldNotAsk(String),
    }

    fn prompt() -> Answer {
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDNO, IDYES, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
        };
        let result = unsafe {
            MessageBoxW(
                None,
                windows::core::w!(
                    "Paracord is asking once to capture this computer's audio when you stream — \
                     this records sound from ALL other applications and shares it in your call.\r\n\r\n\
                     Only allow this if you intend to share your computer's sound.\r\n\r\n\
                     You can withdraw this in Settings > Voice & video at any time.\r\n\r\n\
                     Allow Paracord to capture this computer's audio?"
                ),
                windows::core::w!("Paracord — Desktop Audio"),
                MB_YESNO | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
            )
        };
        match result {
            IDYES => Answer::Allowed,
            IDNO => Answer::Declined,
            // 0 means the message box could not be created at all.
            other => Answer::CouldNotAsk(format!("MessageBoxW returned {}", other.0)),
        }
    }
}

/// macOS and other platforms: native capture is unsupported (`capture_loop`
/// returns an error), so no audio is captured regardless of this result.
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn show_native_consent_dialog() -> bool {
    true
}

/// Start capturing system audio into the media session's screen-audio sink
/// (contract C4/AU3). Called by `commands.rs` when screen audio is enabled on
/// platforms that use loopback capture (Windows/Linux); macOS integrated capture
/// runs inside the native screen-capture path instead.
///
/// Idempotent: if a capture is already running it is a no-op success, so the
/// enable path can be called repeatedly without a spurious "already running".
pub fn start_system_audio_capture_into(
    sink: ScreenAudioSink,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    if !SYSTEM_AUDIO_CAPTURE_ENABLED.load(Ordering::SeqCst) {
        return Err("System audio capture disabled".into());
    }

    // The flag above is renderer-settable and proves nothing. On Windows the
    // persisted grant is the boundary: only `ensure_system_audio_grant`, which
    // reads it off disk and can only be satisfied by the native prompt, raises
    // the flag below — so no path into this function can start capture on a
    // machine that never allowed it, whatever the renderer asks for. On Linux
    // the grant is the desktop portal the screen share already went through
    // (see the consent model note at the top of this file).
    #[cfg(target_os = "windows")]
    if !WINDOWS_GRANT_VERIFIED.load(Ordering::SeqCst) {
        return Err(
            "Desktop audio is off because this computer has not been allowed to share its own \
             sound."
                .into(),
        );
    }

    if stop_flag.load(Ordering::SeqCst) {
        return Err("system audio capture was canceled".into());
    }

    let mut guard = CAPTURE.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let stop = stop_flag.clone();

    // Echo-free routing: capture a private null sink holding every
    // application's audio except Paracord's own playback, so voice chat can
    // never loop back into the stream. This is a hard requirement — capturing
    // the default sink monitor instead would "work" while echoing every
    // remote participant back at themselves, which is worse than failing
    // here and letting the UI report that system audio is unavailable.
    // `PulseStreamRouter::restore()` sweeps stragglers off the capture sink
    // before unloading, so routing returns to normal even for streams the
    // sound server's restore database pinned mid-session.
    #[cfg(target_os = "linux")]
    let (source_override, router) = {
        let router = crate::pulse_router::PulseStreamRouter::setup().map_err(|err| {
            format!(
                "System audio capture requires echo-free routing (pactl with \
                 PulseAudio or PipeWire), which failed: {err}"
            )
        })?;
        (
            Some(crate::pulse_router::CAPTURE_SOURCE_NAME.to_string()),
            Some(router),
        )
    };
    #[cfg(not(target_os = "linux"))]
    let source_override: Option<String> = None;

    #[cfg(target_os = "linux")]
    let router_thread = router.map(|mut router| {
        let stop = stop_flag.clone();
        thread::spawn(move || {
            // WirePlumber auto-switches the default output onto our freshly
            // created capture sink asynchronously, landing after setup()'s
            // immediate restore. Run a tight guard (default-restore + rescue of
            // our own streams) for ~3s so the user is never left more than
            // ~100ms on the wrong device, then fall into the 1s session sweep.
            // Capture already started on its own thread, so this does not delay
            // the stream.
            router.watchdog(&stop);
            while !stop.load(Ordering::Relaxed) {
                // Sweep for applications that started playing mid-stream.
                router.sync();
                for _ in 0..10 {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    thread::sleep(std::time::Duration::from_millis(100));
                }
            }
            router.restore();
        })
    });
    #[cfg(not(target_os = "linux"))]
    let router_thread: Option<thread::JoinHandle<()>> = None;

    let (startup_tx, startup_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let startup = Arc::new(StartupSignal::new(startup_tx));
    let thread_startup = startup.clone();

    let thread = thread::spawn(move || {
        if let Err(e) = capture_loop(&sink, &stop, source_override.as_deref(), &thread_startup) {
            // If the device never opened, this is the reason the caller is
            // waiting for; if it had opened, the report is dropped and this is
            // just a mid-session end.
            thread_startup.failed(e.to_string());
            eprintln!("[audio_capture] Capture loop error: {e}");
        }
    });

    // Wait for the device itself, not merely for the thread to exist. Returning
    // Ok here without this is what published a screen share with a silent audio
    // track and nothing in the UI to explain it.
    let started = startup_rx.recv_timeout(SYSTEM_AUDIO_START_TIMEOUT);
    match started {
        Ok(Ok(())) => {}
        Ok(Err(reason)) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = thread.join();
            if let Some(router_thread) = router_thread {
                let _ = router_thread.join();
            }
            return Err(reason);
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = thread.join();
            if let Some(router_thread) = router_thread {
                let _ = router_thread.join();
            }
            return Err("System audio capture stopped before it reported a result.".into());
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = thread.join();
            if let Some(router_thread) = router_thread {
                let _ = router_thread.join();
            }
            return Err(format!(
                "Your computer's sound server did not start recording within {}s, so this \
                 stream would have gone out silent.",
                SYSTEM_AUDIO_START_TIMEOUT.as_secs()
            ));
        }
    }

    *guard = Some(CaptureHandle {
        stop_flag,
        thread: Some(thread),
        router_thread,
    });

    Ok(())
}

/// NOT a Tauri command — see [`set_system_audio_capture_enabled`]. Called from
/// the screen-capture teardown on a blocking thread, because it joins the
/// capture and router threads.
pub fn stop_system_audio_capture() -> Result<(), String> {
    let mut guard = CAPTURE.lock().map_err(|e| e.to_string())?;
    if let Some(mut handle) = guard.take() {
        handle.stop_flag.store(true, Ordering::SeqCst);
        if let Some(thread) = handle.thread.take() {
            let _ = thread.join();
        }
        // Joining the router thread runs its restore step: streams move back
        // to their original sinks and the capture modules unload.
        if let Some(thread) = handle.router_thread.take() {
            let _ = thread.join();
        }
    }
    // Note: do NOT clear SYSTEM_AUDIO_CAPTURE_ENABLED here. The enable path
    // stops a stale capture before starting a fresh one; clearing the flag here
    // would make that start fail with "System audio capture disabled". The flag
    // is managed exclusively by set_system_audio_capture_enabled().
    Ok(())
}

// ---------------------------------------------------------------------------
// Windows: Process Loopback Exclusion API (Windows 10 2004+)
// Captures all system audio EXCEPT audio from our own process tree,
// which eliminates voice chat echo in live streams.
//
// There is deliberately NO legacy WASAPI-loopback fallback (contract AU10): the
// legacy path captures ALL system audio including our own voice-chat playback,
// reintroducing the exact echo the exclusion API and the Linux router exist to
// prevent. If the exclusion API is unavailable we fail loudly, matching Linux.
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
mod win_process_loopback {
    use std::sync::{Arc, Mutex};
    use windows::Win32::Foundation::*;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::BLOB;
    use windows::Win32::System::Threading::*;
    use windows::Win32::System::Variant::VT_BLOB;
    use windows_core::{implement, Interface};

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct CompletionHandler {
        event: HANDLE,
        result: Arc<Mutex<Option<windows_core::Result<windows_core::IUnknown>>>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
        fn ActivateCompleted(
            &self,
            activateoperation: windows_core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
        ) -> windows_core::Result<()> {
            unsafe {
                let op = activateoperation.ok()?;
                let mut hr = windows_core::HRESULT(0);
                let mut activated: Option<windows_core::IUnknown> = None;
                op.GetActivateResult(&mut hr, &mut activated)?;

                let mut guard = self.result.lock().unwrap();
                if hr.is_ok() {
                    *guard = Some(Ok(activated.unwrap()));
                } else {
                    *guard = Some(Err(windows_core::Error::from(hr)));
                }
                let _ = SetEvent(self.event);
            }
            Ok(())
        }
    }

    /// Try to activate an IAudioClient using the Process Loopback Exclusion API.
    /// This captures all system audio EXCEPT audio from the specified process tree.
    pub fn activate_process_loopback_exclude(
        exclude_pid: u32,
    ) -> windows_core::Result<IAudioClient> {
        unsafe {
            let event = CreateEventW(None, true, false, None)?;

            let result_holder: Arc<Mutex<Option<windows_core::Result<windows_core::IUnknown>>>> =
                Arc::new(Mutex::new(None));

            let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler {
                event,
                result: result_holder.clone(),
            }
            .into();

            // Set up activation params for process loopback exclusion
            let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: exclude_pid,
                        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                    },
                },
            };

            // Build PROPVARIANT with VT_BLOB pointing to our activation params.
            // IMPORTANT: We wrap in ManuallyDrop because PROPVARIANT's Drop impl
            // calls PropVariantClear, which would try to CoTaskMemFree the blob
            // data pointer. Since that pointer points to our stack-local `params`,
            // freeing it would crash the process with a heap corruption.
            let mut prop = std::mem::ManuallyDrop::new(PROPVARIANT::default());
            {
                let inner = &mut prop.Anonymous.Anonymous;
                inner.vt = VT_BLOB;
                inner.Anonymous.blob = BLOB {
                    cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                    pBlobData: &mut params as *mut _ as *mut u8,
                };
            }

            let _operation = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*prop as *const PROPVARIANT),
                &handler,
            )?;

            // Wait for the completion callback (5 second timeout)
            let _ = WaitForSingleObject(event, 5000);
            let _ = CloseHandle(event);

            // Zero out the blob pointer before dropping so nothing tries to free it.
            {
                let inner = &mut prop.Anonymous.Anonymous;
                inner.vt = windows::Win32::System::Variant::VT_EMPTY;
                inner.Anonymous.blob = BLOB {
                    cbSize: 0,
                    pBlobData: std::ptr::null_mut(),
                };
            }
            // Now safe to drop (VT_EMPTY won't free anything).
            std::mem::ManuallyDrop::drop(&mut prop);

            let guard = result_holder.lock().unwrap();
            match guard.as_ref() {
                Some(Ok(unknown)) => unknown.cast::<IAudioClient>(),
                Some(Err(e)) => Err(e.clone()),
                None => Err(windows_core::Error::new(
                    windows_core::HRESULT(-2147023436i32), // HRESULT_FROM_WIN32(WAIT_TIMEOUT)
                    "Timed out waiting for audio interface activation",
                )),
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn capture_loop(
    sink: &ScreenAudioSink,
    stop_flag: &Arc<AtomicBool>,
    _source_override: Option<&str>,
    startup: &StartupSignal,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Initialize COM on this thread — required for all WASAPI / IAudioClient calls.
    unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
        .ok()
        .map_err(|e| format!("COM initialization failed: {e}"))?;
    }

    // Process Loopback Exclusion API (Windows 10 2004+) captures all system audio
    // EXCEPT our own process, eliminating echo. There is no legacy fallback
    // (AU10): degrading to whole-device loopback would loop voice chat back into
    // the stream.
    let my_pid = std::process::id();

    let result = match win_process_loopback::activate_process_loopback_exclude(my_pid) {
        Ok(client) => capture_loop_with_client(sink, stop_flag, &client, startup),
        Err(e) => Err(format!(
            "System audio capture requires the Windows Process Loopback Exclusion \
             API (Windows 10 2004+), which is unavailable: {e}. Refusing to fall \
             back to whole-device loopback, which would echo voice chat into the \
             stream."
        )
        .into()),
    };

    unsafe {
        windows::Win32::System::Com::CoUninitialize();
    }

    result
}

/// Run the capture loop using a windows-rs IAudioClient obtained from
/// the Process Loopback Exclusion API.
#[cfg(target_os = "windows")]
fn capture_loop_with_client(
    sink: &ScreenAudioSink,
    stop_flag: &Arc<AtomicBool>,
    client: &windows::Win32::Media::Audio::IAudioClient,
    startup: &StartupSignal,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let is_process_loopback = true;
    use windows::Win32::Foundation::*;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Threading::*;

    unsafe {
        // Get the mix format.  The Process Loopback virtual device doesn't
        // support GetMixFormat (returns E_NOTIMPL), so fall back to querying
        // the default render endpoint which is what the loopback captures.
        let format_ptr = match client.GetMixFormat() {
            Ok(p) => p,
            Err(_) if is_process_loopback => {
                let enumerator: IMMDeviceEnumerator =
                    windows::Win32::System::Com::CoCreateInstance(
                        &MMDeviceEnumerator,
                        None,
                        windows::Win32::System::Com::CLSCTX_ALL,
                    )?;
                let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
                let render_client: IAudioClient =
                    device.Activate(windows::Win32::System::Com::CLSCTX_ALL, None)?;
                render_client.GetMixFormat()?
            }
            Err(e) => return Err(e.into()),
        };
        let format = &*format_ptr;

        let sample_rate = format.nSamplesPerSec;
        let num_channels = format.nChannels as usize;
        let block_align = format.nBlockAlign as usize;
        let bits_per_sample = format.wBitsPerSample as usize;
        let bytes_per_sample = bits_per_sample / 8;

        // Per MSDN, both hnsBufferDuration and hnsPeriodicity MUST be 0
        // for shared-mode streams using event-driven buffering.
        let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        if let Err(e) = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            stream_flags,
            0,
            0,
            format_ptr,
            None,
        ) {
            CoTaskMemFree(Some(format_ptr as *const _ as *const core::ffi::c_void));
            return Err(e.into());
        }

        // Free the format memory allocated by GetMixFormat
        CoTaskMemFree(Some(format_ptr as *const _ as *const core::ffi::c_void));

        // Set up event handle for buffer notifications
        let event = CreateEventW(None, false, false, None)?;
        if let Err(e) = client.SetEventHandle(event) {
            let _ = CloseHandle(event);
            return Err(e.into());
        }

        // Get the capture client and buffer size
        let capture: IAudioCaptureClient = match client.GetService() {
            Ok(c) => c,
            Err(e) => {
                let _ = CloseHandle(event);
                return Err(e.into());
            }
        };
        let buffer_size = client.GetBufferSize()?;

        let mode = if is_process_loopback {
            "process loopback exclusion"
        } else {
            "loopback"
        };
        eprintln!(
            "[audio_capture] Started ({mode}): {sample_rate}Hz, {num_channels} ch, {bits_per_sample}-bit, {buffer_size} frames",
        );

        // Start the audio stream
        if let Err(e) = client.Start() {
            let _ = CloseHandle(event);
            return Err(e.into());
        }

        // The endpoint is streaming: the caller may report stream audio live.
        startup.ready();

        // Resample+chunk the device-rate stereo into 48kHz 20ms frames (C4/AU3).
        let mut emitter = match StereoFrameEmitter::new(sample_rate) {
            Ok(e) => e,
            Err(e) => {
                let _ = CloseHandle(event);
                return Err(e.into());
            }
        };

        while !stop_flag.load(Ordering::Relaxed) {
            // Wait for buffer event with 100ms timeout
            let wait_result = WaitForSingleObject(event, 100);
            if wait_result == WAIT_TIMEOUT {
                continue;
            }

            // Read all available packets
            loop {
                let packet_size = match capture.GetNextPacketSize() {
                    Ok(size) => size,
                    Err(e) => {
                        eprintln!("[audio_capture] GetNextPacketSize error: {e}");
                        break;
                    }
                };

                if packet_size == 0 {
                    break;
                }

                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut frames_read: u32 = 0;
                let mut flags: u32 = 0;

                if let Err(e) =
                    capture.GetBuffer(&mut data_ptr, &mut frames_read, &mut flags, None, None)
                {
                    eprintln!("[audio_capture] GetBuffer error: {e}");
                    break;
                }

                if frames_read > 0 {
                    // AUDCLNT_BUFFERFLAGS_SILENT = 2
                    let is_silent = (flags & 2) != 0;

                    if is_silent {
                        let stereo = vec![0.0f32; frames_read as usize * 2];
                        emitter.push(&stereo, sink);
                    } else {
                        let data_bytes = frames_read as usize * block_align;
                        let raw_data = std::slice::from_raw_parts(data_ptr, data_bytes);
                        let stereo =
                            interleaved_to_stereo_f32(raw_data, num_channels, bytes_per_sample);
                        if !stereo.is_empty() {
                            emitter.push(&stereo, sink);
                        }
                    }
                }

                if let Err(e) = capture.ReleaseBuffer(frames_read) {
                    eprintln!("[audio_capture] ReleaseBuffer error: {e}");
                    break;
                }
            }
        }

        client.Stop()?;
        let _ = CloseHandle(event);
    }

    eprintln!("[audio_capture] Stopped");
    Ok(())
}

// ---------------------------------------------------------------------------
// Linux: PulseAudio monitor source capture
// ---------------------------------------------------------------------------
#[cfg(target_os = "linux")]
fn capture_loop(
    sink: &ScreenAudioSink,
    stop_flag: &Arc<AtomicBool>,
    source_override: Option<&str>,
    startup: &StartupSignal,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use libpulse_binding::def::BufferAttr;
    use libpulse_binding::sample::{Format, Spec};
    use libpulse_binding::stream::Direction;
    use libpulse_simple_binding::Simple;

    let sample_rate: u32 = 48000;
    let num_channels: u8 = 2;

    let spec = Spec {
        format: Format::F32le,
        channels: num_channels,
        rate: sample_rate,
    };

    if !spec.is_valid() {
        return Err("Invalid PulseAudio sample spec".into());
    }

    // Pin the record fragment to one 20ms stereo frame (960 × 2ch × 4 bytes) for
    // deterministic capture latency (AU11b): the server hands us a fragment per
    // 20ms rather than choosing an opaque default. maxlength is left unbounded.
    let frag_bytes = 960 * num_channels as u32 * 4;
    let buffer_attr = BufferAttr {
        maxlength: u32::MAX,
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        fragsize: frag_bytes,
    };

    // Echo-free routing is mandatory on Linux: reading a plain sink monitor
    // (e.g. @DEFAULT_MONITOR@) would include Paracord's own voice playback
    // and echo every remote participant back at themselves. Refuse rather
    // than degrade.
    let source =
        source_override.ok_or("system audio capture started without the echo-free capture sink")?;
    let pulse = Simple::new(
        None,                   // default server
        "Paracord",             // app name
        Direction::Record,      // recording
        Some(source),           // monitor source for loopback
        "System Audio Capture", // stream description
        &spec,
        None,               // default channel map
        Some(&buffer_attr), // 20ms fragment for deterministic latency (AU11b)
    )
    .map_err(|e| {
        format!(
            "Your computer's sound server would not hand Paracord a recording of \
             this machine's audio (capture source \"{source}\"): {e}"
        )
    })?;
    // The device is open: everything below this line is a running capture, and
    // the caller may tell the UI that stream audio is live.
    startup.ready();

    // Read buffer: 20ms of stereo f32 audio at 48kHz = 960 frames * 2 ch * 4 bytes = 7680 bytes
    let frames_per_chunk: usize = 960;
    let mut buffer = vec![0u8; frames_per_chunk * num_channels as usize * 4]; // f32 = 4 bytes

    eprintln!(
        "[audio_capture] Started PulseAudio: {}Hz, {} ch, f32",
        sample_rate, num_channels
    );

    // The pulse spec forces 48kHz stereo, so the emitter never resamples here;
    // it just re-chunks each read into the canonical 1920-sample frame (C4/AU3).
    let mut emitter = StereoFrameEmitter::new(sample_rate)?;

    while !stop_flag.load(Ordering::Relaxed) {
        if let Err(e) = pulse.read(&mut buffer) {
            eprintln!("[audio_capture] PulseAudio read error: {e}");
            break;
        }

        // Convert raw f32le bytes to Vec<f32>
        let samples: Vec<f32> = buffer
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();

        if !samples.is_empty() {
            emitter.push(&samples, sink);
        }
    }

    eprintln!("[audio_capture] Stopped");
    Ok(())
}

// ---------------------------------------------------------------------------
// macOS: not routed here — integrated ScreenCaptureKit audio is captured inside
// the native screen-capture path and pushed directly into `screen_audio_tx`, so
// `commands.rs` never starts this loop on macOS.
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
fn capture_loop(
    _sink: &ScreenAudioSink,
    _stop_flag: &Arc<AtomicBool>,
    _source_override: Option<&str>,
    _startup: &StartupSignal,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err(
        "Native loopback system-audio capture is not used on macOS; integrated \
         ScreenCaptureKit audio is captured by the screen-capture path instead."
            .into(),
    )
}

// ---------------------------------------------------------------------------
// Fallback for other platforms
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn capture_loop(
    _sink: &ScreenAudioSink,
    _stop_flag: &Arc<AtomicBool>,
    _source_override: Option<&str>,
    _startup: &StartupSignal,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err("System audio capture is not supported on this platform.".into())
}

/// Decode a single PCM sample from raw bytes at the given offset.
#[inline]
fn decode_sample(data: &[u8], offset: usize, bytes_per_sample: usize) -> f32 {
    match bytes_per_sample {
        // 32-bit IEEE float (most common for WASAPI shared mode)
        4 => f32::from_le_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]),
        // 16-bit signed integer
        2 => {
            let s = i16::from_le_bytes([data[offset], data[offset + 1]]);
            s as f32 / 32768.0
        }
        // 24-bit signed integer (packed)
        3 => {
            let raw = (data[offset] as i32)
                | ((data[offset + 1] as i32) << 8)
                | ((data[offset + 2] as i32) << 16);
            let signed = if raw & 0x80_0000 != 0 {
                raw | !0xFF_FFFF
            } else {
                raw
            };
            signed as f32 / 8_388_608.0
        }
        _ => 0.0,
    }
}

/// Convert interleaved raw PCM bytes to interleaved stereo f32 (L, R, L, R, ...).
/// Mono sources are duplicated to both channels; >2 channels are downmixed.
#[allow(dead_code)]
fn interleaved_to_stereo_f32(
    data: &[u8],
    num_channels: usize,
    bytes_per_sample: usize,
) -> Vec<f32> {
    let frame_size = num_channels * bytes_per_sample;
    if frame_size == 0 {
        return Vec::new();
    }
    let num_frames = data.len() / frame_size;
    let mut stereo = Vec::with_capacity(num_frames * 2);

    for frame_idx in 0..num_frames {
        let frame_start = frame_idx * frame_size;
        match num_channels {
            1 => {
                let s = decode_sample(data, frame_start, bytes_per_sample);
                stereo.push(s);
                stereo.push(s);
            }
            2 => {
                let l = decode_sample(data, frame_start, bytes_per_sample);
                let r = decode_sample(data, frame_start + bytes_per_sample, bytes_per_sample);
                stereo.push(l);
                stereo.push(r);
            }
            _ => {
                // Downmix N channels to stereo: left = average of even channels,
                // right = average of odd channels (standard surround downmix).
                let mut left_sum = 0.0f32;
                let mut right_sum = 0.0f32;
                let mut left_count = 0u32;
                let mut right_count = 0u32;
                for ch in 0..num_channels {
                    let offset = frame_start + ch * bytes_per_sample;
                    let s = decode_sample(data, offset, bytes_per_sample);
                    if ch % 2 == 0 {
                        left_sum += s;
                        left_count += 1;
                    } else {
                        right_sum += s;
                        right_count += 1;
                    }
                }
                stereo.push(if left_count > 0 {
                    left_sum / left_count as f32
                } else {
                    0.0
                });
                stereo.push(if right_count > 0 {
                    right_sum / right_count as f32
                } else {
                    0.0
                });
            }
        }
    }

    stereo
}

/// Convert interleaved raw PCM bytes to a mono f32 vector by averaging all channels.
#[allow(dead_code)]
fn interleaved_to_mono_f32(data: &[u8], num_channels: usize, bytes_per_sample: usize) -> Vec<f32> {
    let frame_size = num_channels * bytes_per_sample;
    if frame_size == 0 {
        return Vec::new();
    }
    let num_frames = data.len() / frame_size;
    let mut mono = Vec::with_capacity(num_frames);
    for frame_idx in 0..num_frames {
        let frame_start = frame_idx * frame_size;
        let mut sum = 0.0f32;
        for ch in 0..num_channels {
            let offset = frame_start + ch * bytes_per_sample;
            sum += decode_sample(data, offset, bytes_per_sample);
        }
        mono.push(sum / num_channels as f32);
    }
    mono
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// The renderer-settable flag is a request for audio, not a permission.
    /// Nothing about it should read as consent to a future reader — the grant
    /// lives with the portal on Linux and on disk on Windows.
    #[test]
    fn the_enable_flag_is_only_a_request_for_audio() {
        set_system_audio_capture_enabled(true);
        assert!(SYSTEM_AUDIO_CAPTURE_ENABLED.load(Ordering::SeqCst));
        set_system_audio_capture_enabled(false);
        assert!(!SYSTEM_AUDIO_CAPTURE_ENABLED.load(Ordering::SeqCst));
    }

    /// Real capture, against a real sound server, with no display attached.
    ///
    /// Two things are proved at once. Audio actually arrives — the handshake
    /// says "open" and 48kHz stereo frames land in the sink. And nothing in the
    /// path asks the user anything: the test runs with `DISPLAY` and
    /// `WAYLAND_DISPLAY` cleared, so a zenity/kdialog confirmation could not
    /// have been shown even if one were still there. That prompt used to sit in
    /// front of every single stream, and on a Wayland session it died before it
    /// was ever seen and its exit code was read as a refusal.
    ///
    /// Needs a sound server, so it does not run in CI. Run it against an
    /// isolated one:
    ///
    /// ```text
    /// XDG_RUNTIME_DIR=/path/to/private/runtime \
    ///   cargo test -p paracord-desktop --lib real_system_audio -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs a running sound server; run explicitly (see doc comment)"]
    fn real_system_audio_is_captured_without_asking_anyone() {
        use std::io::Write;

        // If a prompt were still in the path it could not possibly be answered.
        std::env::remove_var("DISPLAY");
        std::env::remove_var("WAYLAND_DISPLAY");

        let tone = std::env::temp_dir().join("paracord-qa-tone.wav");
        write_sine_wav(&tone, 6).expect("write tone");

        set_system_audio_capture_enabled(true);
        let (tx, mut rx) = mpsc::channel::<Vec<f32>>(512);
        let stop = Arc::new(AtomicBool::new(false));

        start_system_audio_capture_into(tx, stop.clone()).expect("capture must start");
        println!("capture started; no dialog was shown (DISPLAY/WAYLAND_DISPLAY are unset)");

        let mut player = std::process::Command::new("paplay")
            .arg(&tone)
            .spawn()
            .expect("paplay");

        let deadline = Instant::now() + Duration::from_secs(12);
        let mut frames = 0usize;
        let mut loudest = 0.0f32;
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok(frame) => {
                    frames += 1;
                    for sample in &frame {
                        loudest = loudest.max(sample.abs());
                    }
                    if frames > 50 && loudest > 0.01 {
                        break;
                    }
                }
                Err(_) => thread::sleep(Duration::from_millis(20)),
            }
        }

        let _ = player.kill();
        let _ = player.wait();
        let _ = stop_system_audio_capture();
        set_system_audio_capture_enabled(false);
        let _ = std::fs::remove_file(&tone);

        println!("captured {frames} frames, peak amplitude {loudest:.4}");
        assert!(
            frames > 50,
            "expected a stream of captured frames, got {frames}"
        );
        assert!(
            loudest > 0.01,
            "captured frames were silent (peak {loudest:.5}); audio is not reaching the sink"
        );
        let _ = std::io::stdout().flush();
    }

    /// A few seconds of 440Hz, 16-bit stereo 48kHz, as a WAV on disk.
    #[cfg(test)]
    fn write_sine_wav(path: &std::path::Path, seconds: u32) -> std::io::Result<()> {
        use std::io::Write;
        let rate = 48_000u32;
        let total = rate * seconds;
        let data_len = total * 4; // 2 channels * 2 bytes
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&2u16.to_le_bytes()); // stereo
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 4).to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for n in 0..total {
            let phase = 2.0 * std::f32::consts::PI * 440.0 * (n as f32) / rate as f32;
            let value = (phase.sin() * 12_000.0) as i16;
            out.extend_from_slice(&value.to_le_bytes());
            out.extend_from_slice(&value.to_le_bytes());
        }
        let mut file = std::fs::File::create(path)?;
        file.write_all(&out)
    }

    /// A capture loop that dies before the device opens must hand the caller the
    /// reason. This is the seam that let a screen share publish a silent audio
    /// track: the start returned Ok the moment the thread existed, and the real
    /// failure arrived afterwards, on that thread, with nobody listening.
    #[test]
    fn a_capture_that_never_opens_reports_why_to_the_caller() {
        let (tx, rx) = std::sync::mpsc::channel();
        let signal = StartupSignal::new(tx);
        signal.failed("the sound server refused the capture source".to_string());
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(1)),
            Ok(Err(
                "the sound server refused the capture source".to_string()
            ))
        );
    }

    /// Once the device is open, capture is live; a later error is the end of a
    /// working session, not a failure to start, and must not be reported as one.
    #[test]
    fn a_failure_after_the_device_opened_is_not_a_startup_failure() {
        let (tx, rx) = std::sync::mpsc::channel();
        let signal = StartupSignal::new(tx);
        signal.ready();
        signal.failed("device disappeared mid-session".to_string());
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(1)),
            Ok(Ok(()))
        );
        assert!(
            rx.try_recv().is_err(),
            "exactly one startup outcome is ever reported"
        );
    }
}
