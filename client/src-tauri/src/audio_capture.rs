use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::mpsc;

use paracord_codec::audio::resample::{StereoResampler, STEREO_FRAME_SAMPLES};

/// Sink for captured system audio: contract C4 delivers 48kHz stereo interleaved
/// 20ms frames (1920 samples) straight into the media session's `screen_audio_tx`.
/// There is no JS round-trip anymore.
type ScreenAudioSink = mpsc::Sender<Vec<f32>>;

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
// Trusted, out-of-webview consent gate. The renderer can flip
// SYSTEM_AUDIO_CAPTURE_ENABLED via IPC, so on its own that flag is NOT a
// security boundary — an XSS in the webview could set it and start capture
// silently. This flag is only ever set by prompt_native_consent(), a native
// OS confirmation the webview cannot forge or click. It is required in addition
// to SYSTEM_AUDIO_CAPTURE_ENABLED before any capture begins, and is reset each
// time the session is torn down so consent must be re-confirmed per session.
static NATIVE_CONSENT_GRANTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_system_audio_capture_enabled(enabled: bool) {
    SYSTEM_AUDIO_CAPTURE_ENABLED.store(enabled, Ordering::SeqCst);
    // Session teardown (JS calls this with `false` when stopping capture):
    // drop the native consent so the next capture session must be re-confirmed
    // out-of-band via the native prompt.
    if !enabled {
        NATIVE_CONSENT_GRANTED.store(false, Ordering::SeqCst);
    }
}

/// Require a trusted, native (out-of-webview) confirmation before capturing
/// system audio. The result is cached for the lifetime of the session so the
/// JS stop/start recovery sequence does not re-prompt; it is cleared when
/// `set_system_audio_capture_enabled(false)` is called on teardown.
fn require_native_consent() -> Result<(), String> {
    if NATIVE_CONSENT_GRANTED.load(Ordering::SeqCst) {
        return Ok(());
    }
    if prompt_native_consent() {
        NATIVE_CONSENT_GRANTED.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err("System audio capture was denied at the native confirmation prompt".into())
    }
}

/// Show a native OS confirmation asking the user to allow system-audio capture.
/// Returns true only if the user explicitly approves. This runs outside the
/// webview so a renderer-context compromise (XSS) cannot approve it.
fn prompt_native_consent() -> bool {
    if crate::NATIVE_PRIVILEGE_PROMPT_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    let approved = show_native_consent_dialog();
    crate::NATIVE_PRIVILEGE_PROMPT_ACTIVE.store(false, Ordering::SeqCst);
    approved
}

#[cfg(target_os = "windows")]
fn show_native_consent_dialog() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    unsafe {
        MessageBoxW(
            None,
            windows::core::w!(
                "Paracord is requesting to capture your system audio — this records sound \
                 from ALL other applications on this device and shares it in your call.\r\n\r\n\
                 Only allow this if you intended to share your system audio.\r\n\r\n\
                 Allow system audio capture for this session?"
            ),
            windows::core::w!("Paracord — System Audio Capture"),
            MB_YESNO | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
        ) == IDYES
    }
}

/// Linux: shell out to a native dialog helper (a separate, trusted process the
/// webview cannot drive). Fails closed if no dialog helper is available.
#[cfg(target_os = "linux")]
fn show_native_consent_dialog() -> bool {
    use std::process::Command;

    const TITLE: &str = "Paracord — System Audio Capture";
    const BODY: &str = "Paracord is requesting to capture your system audio — this records sound \
         from ALL other applications on this device and shares it in your call.\n\n\
         Only allow this if you intended to share your system audio.\n\n\
         Allow system audio capture for this session?";

    if let Ok(status) = Command::new("zenity")
        .arg("--question")
        .arg("--no-wrap")
        .arg(format!("--title={TITLE}"))
        .arg(format!("--text={BODY}"))
        .status()
    {
        return status.success();
    }

    if let Ok(status) = Command::new("kdialog")
        .args(["--title", TITLE, "--yesno", BODY])
        .status()
    {
        return status.success();
    }

    eprintln!(
        "[audio_capture] No native dialog helper (zenity/kdialog) available to confirm \
         system audio capture; denying. Install zenity or kdialog to enable this feature."
    );
    false
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
pub fn start_system_audio_capture_into(sink: ScreenAudioSink) -> Result<(), String> {
    if !SYSTEM_AUDIO_CAPTURE_ENABLED.load(Ordering::SeqCst) {
        return Err("System audio capture disabled".into());
    }

    // The webview can set the ENABLED flag above, but it cannot approve this
    // native prompt — so a renderer XSS cannot start covert system-audio
    // capture on its own. This is the actual consent boundary (CWE-862/CWE-359).
    require_native_consent()?;

    let mut guard = CAPTURE.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
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

    let thread = thread::spawn(move || {
        if let Err(e) = capture_loop(&sink, &stop, source_override.as_deref()) {
            eprintln!("[audio_capture] Capture loop error: {e}");
        }
    });

    *guard = Some(CaptureHandle {
        stop_flag,
        thread: Some(thread),
        router_thread,
    });

    Ok(())
}

#[tauri::command]
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
    // Note: do NOT clear SYSTEM_AUDIO_CAPTURE_ENABLED here.
    // The JS side calls stop then start in sequence to recover from stale
    // sessions; clearing the flag here would cause the subsequent start to
    // fail with "System audio capture disabled".  The flag is managed
    // exclusively by set_system_audio_capture_enabled().
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
        Ok(client) => capture_loop_with_client(sink, stop_flag, &client),
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
    .map_err(|e| format!("Failed to connect to PulseAudio ({source}): {e}"))?;

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
            .chunks_exact(4)
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

    // Exercises the native-consent lifecycle without ever triggering the native
    // prompt (which would block CI) or starting real capture: we pre-seed the
    // cached grant, confirm it short-circuits the prompt, then confirm that
    // disabling the session clears both the enabled flag and the native consent
    // so the next session must be re-confirmed out-of-band.
    #[test]
    fn native_consent_is_cached_then_cleared_on_teardown() {
        // Simulate a session where native consent was already granted.
        NATIVE_CONSENT_GRANTED.store(true, Ordering::SeqCst);
        SYSTEM_AUDIO_CAPTURE_ENABLED.store(true, Ordering::SeqCst);

        // Cached grant must be honored without re-prompting.
        assert!(require_native_consent().is_ok());

        // Session teardown must revoke consent (and the enabled flag), so a
        // subsequent capture cannot proceed on a stale grant.
        set_system_audio_capture_enabled(false);
        assert!(!NATIVE_CONSENT_GRANTED.load(Ordering::SeqCst));
        assert!(!SYSTEM_AUDIO_CAPTURE_ENABLED.load(Ordering::SeqCst));
    }
}
