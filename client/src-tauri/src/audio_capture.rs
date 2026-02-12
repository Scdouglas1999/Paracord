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

#[tauri::command]
pub fn start_system_audio_capture(on_audio: Channel<AudioChunk>) -> Result<(), String> {
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
    Ok(())
}

fn capture_loop(
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

    // Get device period for buffer sizing.
    let (_default_period, min_period) = audio_client.get_device_period()?;

    // Initialize in loopback mode: render device + capture direction = loopback.
    // EventsShared mode uses event-driven notification for efficient waiting.
    let mode = wasapi::StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client.initialize_client(&format, &wasapi::Direction::Capture, &mode)?;

    let h_event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;

    // Allocate a buffer large enough for the maximum packet from the device.
    let buffer_size_frames = audio_client.get_buffer_size()?;
    let buffer_size_bytes = buffer_size_frames as usize * block_align;
    let mut buffer = vec![0u8; buffer_size_bytes];

    audio_client.start_stream()?;

    eprintln!(
        "[audio_capture] Started: {}Hz, {} ch, {} bits/sample",
        sample_rate, num_channels, bits_per_sample
    );

    while !stop_flag.load(Ordering::Relaxed) {
        // Wait for audio data with a short timeout so we can check the stop flag.
        if h_event.wait_for_event(100).is_err() {
            continue;
        }

        // Read interleaved PCM bytes from the loopback device.
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
        let mono = interleaved_to_mono_f32(&buffer[..data_bytes], num_channels, bytes_per_sample);
        if !mono.is_empty() {
            let _ = channel.send(AudioChunk {
                samples: mono,
                sample_rate,
            });
        }
    }

    audio_client.stop_stream()?;
    eprintln!("[audio_capture] Stopped");
    Ok(())
}

/// Convert interleaved raw PCM bytes to a mono f32 vector by averaging all channels.
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
            let sample = match bytes_per_sample {
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
            };
            sum += sample;
        }

        mono.push(sum / num_channels as f32);
    }

    mono
}
