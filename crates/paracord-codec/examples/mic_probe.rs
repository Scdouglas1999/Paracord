//! Does the microphone actually capture? Answered in numbers.
//!
//! Opens the selected input exactly the way the desktop client opens it —
//! `AudioCapture::start_device_id`, the same resolve/`PIPEWIRE_NODE` path — and
//! reports, per half second, how many 20 ms frames arrived and how loud they
//! were (RMS, peak, and the RTP `audio_level` the wire header carries).
//!
//! ```text
//! cargo run -p paracord-codec --example mic_probe -- [device-id] [seconds]
//! ```
//!
//! Not a CI target: it needs real hardware and a person making a noise.

use paracord_codec::audio::capture::AudioCapture;
use paracord_codec::audio::devices::{Direction, SYSTEM_DEFAULT_ID};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let id = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| SYSTEM_DEFAULT_ID.to_string());
    let seconds: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(6);

    match paracord_codec::audio::devices::resolve_target(Direction::Input, &id) {
        Ok(t) => println!(
            "resolve_target({id:?}) -> cpal_index={} node={:?} display={:?} fell_back={}",
            t.cpal_index, t.node, t.display_name, t.fell_back_to_default
        ),
        Err(e) => println!("resolve_target({id:?}) FAILED: {e}"),
    }

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    let (capture, mut rx, target) = match AudioCapture::start_device_id(&id) {
        Ok(v) => v,
        Err(err) => {
            println!("OPEN FAILED: {err}");
            std::process::exit(2);
        }
    };
    println!(
        "opened {:?} (node={:?}, fell back: {})",
        target.display_name, target.node, target.fell_back_to_default
    );

    let started = Instant::now();
    let mut window_frames = 0usize;
    let mut total_frames = 0usize;
    let mut window_sum_sq = 0f64;
    let mut window_peak = 0f32;
    let mut window_started = Instant::now();
    let mut window_samples = 0usize;

    rt.block_on(async {
        while started.elapsed() < Duration::from_secs(seconds) {
            match tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
                Ok(Some(frame)) => {
                    window_frames += 1;
                    total_frames += 1;
                    window_samples += frame.len();
                    for s in &frame {
                        window_sum_sq += (*s as f64) * (*s as f64);
                        if s.abs() > window_peak {
                            window_peak = s.abs();
                        }
                    }
                }
                Ok(None) => {
                    println!("capture channel closed after {total_frames} frames");
                    break;
                }
                Err(_) => {}
            }
            if window_started.elapsed() >= Duration::from_millis(500) {
                let rms = if window_samples > 0 {
                    (window_sum_sq / window_samples as f64).sqrt()
                } else {
                    0.0
                };
                let dbfs = if rms > 0.0 {
                    20.0 * rms.log10()
                } else {
                    f64::NEG_INFINITY
                };
                // Same mapping as native_media::audio_pipeline::compute_audio_level.
                let level = if rms > 0.0 {
                    (-dbfs).clamp(0.0, 127.0) as u8
                } else {
                    127
                };
                println!(
                    "t={:>5.1}s frames={:<3} rms={:.6} ({:>7.1} dBFS) peak={:.6} audio_level={level} running={}",
                    started.elapsed().as_secs_f32(),
                    window_frames,
                    rms,
                    dbfs,
                    window_peak,
                    capture.is_running(),
                );
                window_frames = 0;
                window_sum_sq = 0.0;
                window_peak = 0.0;
                window_samples = 0;
                window_started = Instant::now();
            }
        }
    });

    println!(
        "total frames in {seconds}s: {total_frames} (expected ~{})",
        seconds * 50
    );
    capture.stop();
}
