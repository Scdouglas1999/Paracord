use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
pub struct AudioChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

struct CaptureHandle {
    stop_flag: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

static CAPTURE: Mutex<Option<CaptureHandle>> = Mutex::new(None);
static SYSTEM_AUDIO_CAPTURE_ENABLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_system_audio_capture_enabled(enabled: bool) {
    SYSTEM_AUDIO_CAPTURE_ENABLED.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
pub fn start_system_audio_capture(on_audio: Channel<AudioChunk>) -> Result<(), String> {
    if !SYSTEM_AUDIO_CAPTURE_ENABLED.load(Ordering::SeqCst) {
        return Err("System audio capture disabled".into());
    }

    let mut guard = CAPTURE.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Audio capture already running".into());
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop = stop_flag.clone();

    let thread = thread::spawn(move || {
        if let Err(e) = capture_loop(&on_audio, &stop) {
            eprintln!("[audio_capture] Capture loop error: {e}");
        }
    });

    *guard = Some(CaptureHandle {
        stop_flag,
        thread: Some(thread),
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
// Falls back to legacy WASAPI loopback if the new API is unavailable.
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
    channel: &Channel<AudioChunk>,
    stop_flag: &Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Initialize COM on this thread — required for all WASAPI / IAudioClient calls.
    // Both the Process Loopback path and the legacy WASAPI path need COM.
    unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
        .ok()
        .map_err(|e| format!("COM initialization failed: {e}"))?;
    }

    // Try the Process Loopback Exclusion API first (Windows 10 2004+).
    // This captures all system audio EXCEPT our own process, eliminating echo.
    let my_pid = std::process::id();

    let result = match win_process_loopback::activate_process_loopback_exclude(my_pid) {
        Ok(client) => match capture_loop_with_client(channel, stop_flag, &client, true) {
            Ok(()) => Ok(()),
            Err(e) => {
                eprintln!(
                    "[audio_capture] Process Loopback capture failed ({e}), \
                         falling back to legacy WASAPI loopback"
                );
                capture_loop_legacy(channel, stop_flag)
            }
        },
        Err(e) => {
            eprintln!(
                "[audio_capture] Process Loopback Exclusion API unavailable ({e}), \
                 falling back to legacy WASAPI loopback"
            );
            capture_loop_legacy(channel, stop_flag)
        }
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
    channel: &Channel<AudioChunk>,
    stop_flag: &Arc<AtomicBool>,
    client: &windows::Win32::Media::Audio::IAudioClient,
    is_process_loopback: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
                        // Send silence
                        let stereo = vec![0.0f32; frames_read as usize * 2];
                        let _ = channel.send(AudioChunk {
                            samples: stereo,
                            sample_rate,
                        });
                    } else {
                        let data_bytes = frames_read as usize * block_align;
                        let raw_data = std::slice::from_raw_parts(data_ptr, data_bytes);
                        let stereo =
                            interleaved_to_stereo_f32(raw_data, num_channels, bytes_per_sample);
                        if !stereo.is_empty() {
                            let _ = channel.send(AudioChunk {
                                samples: stereo,
                                sample_rate,
                            });
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

/// Legacy WASAPI loopback capture using the wasapi crate.
/// Used as a fallback when the Process Loopback Exclusion API is unavailable
/// (e.g. on Windows versions older than 10 2004).
/// Note: This captures ALL system audio including our own voice chat playback.
#[cfg(target_os = "windows")]
fn capture_loop_legacy(
    channel: &Channel<AudioChunk>,
    stop_flag: &Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    wasapi::initialize_mta().ok()?;

    let enumerator = wasapi::DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&wasapi::Direction::Render)?;
    let mut audio_client = device.get_iaudioclient()?;
    let format = audio_client.get_mixformat()?;

    let sample_rate = format.get_samplespersec();
    let num_channels = format.get_nchannels() as usize;
    let block_align = format.get_blockalign() as usize;
    let bits_per_sample = format.get_bitspersample() as usize;
    let bytes_per_sample = bits_per_sample / 8;

    let (_default_period, min_period) = audio_client.get_device_period()?;

    let mode = wasapi::StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client.initialize_client(&format, &wasapi::Direction::Capture, &mode)?;

    let h_event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;

    let buffer_size_frames = audio_client.get_buffer_size()?;
    let buffer_size_bytes = buffer_size_frames as usize * block_align;
    let mut buffer = vec![0u8; buffer_size_bytes];

    audio_client.start_stream()?;

    eprintln!(
        "[audio_capture] Started WASAPI legacy loopback: {}Hz, {} ch, {} bits/sample",
        sample_rate, num_channels, bits_per_sample
    );

    while !stop_flag.load(Ordering::Relaxed) {
        if h_event.wait_for_event(100).is_err() {
            continue;
        }

        let (frames_read, _info) = match capture_client.read_from_device(&mut buffer) {
            Ok(result) => result,
            Err(e) => {
                eprintln!("[audio_capture] Read error: {e}");
                break;
            }
        };

        if frames_read == 0 {
            continue;
        }

        let data_bytes = frames_read as usize * block_align;
        let stereo =
            interleaved_to_stereo_f32(&buffer[..data_bytes], num_channels, bytes_per_sample);
        if !stereo.is_empty() {
            let _ = channel.send(AudioChunk {
                samples: stereo,
                sample_rate,
            });
        }
    }

    audio_client.stop_stream()?;
    eprintln!("[audio_capture] Stopped");
    Ok(())
}

// ---------------------------------------------------------------------------
// Linux: PulseAudio monitor source capture
// ---------------------------------------------------------------------------
#[cfg(target_os = "linux")]
fn capture_loop(
    channel: &Channel<AudioChunk>,
    stop_flag: &Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

    // @DEFAULT_MONITOR@ captures the default output sink's monitor source,
    // which provides system audio loopback.
    let pulse = Simple::new(
        None,                      // default server
        "Paracord",                // app name
        Direction::Record,         // recording
        Some("@DEFAULT_MONITOR@"), // monitor source for loopback
        "System Audio Capture",    // stream description
        &spec,
        None, // default channel map
        None, // default buffering attributes
    )
    .map_err(|e| format!("Failed to connect to PulseAudio: {e}"))?;

    // Read buffer: 20ms of stereo f32 audio at 48kHz = 960 frames * 2 ch * 4 bytes = 7680 bytes
    let frames_per_chunk: usize = 960;
    let mut buffer = vec![0u8; frames_per_chunk * num_channels as usize * 4]; // f32 = 4 bytes

    eprintln!(
        "[audio_capture] Started PulseAudio: {}Hz, {} ch, f32",
        sample_rate, num_channels
    );

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
            let _ = channel.send(AudioChunk {
                samples,
                sample_rate,
            });
        }
    }

    eprintln!("[audio_capture] Stopped");
    Ok(())
}

// ---------------------------------------------------------------------------
// macOS: stub (not yet implemented)
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
fn capture_loop(
    _channel: &Channel<AudioChunk>,
    _stop_flag: &Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err(
        "Native system audio capture is not yet supported on macOS. \
         Audio from screen shares will still work via browser APIs."
            .into(),
    )
}

// ---------------------------------------------------------------------------
// Fallback for other platforms
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn capture_loop(
    _channel: &Channel<AudioChunk>,
    _stop_flag: &Arc<AtomicBool>,
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
