//! Hardware bench: encode-thread time per frame for a three-layer screen
//! simulcast, the per-layer route (one upload per layer) against the shared
//! route (one upload, split on the GPU). Needs an NVENC/VAAPI/QSV GPU.
//!
//! Run: cargo run --release -p paracord-codec --features lavc --example simulcast_encode_bench -- [W H FPS KBPS HINT [pinned]]
//! (defaults 5120 1440 60 36000 detail; HINT is detail|film|motion; `pinned`
//! puts the frames in pinned host memory, as the screen capture does with an
//! NVIDIA driver)
use paracord_codec::video::encoder::SimulcastEncoder;
use paracord_codec::video::lavc::{LavcEncoder, LavcSimulcastEncoder, PinnedHostPool};
use paracord_codec::video::{
    simulcast_ladder, PixelFormat, SimulcastKind, VideoCodec, VideoContentHint,
};
use std::time::{Duration, Instant};

fn frame(w: u32, h: u32, n: u32) -> Vec<u8> {
    // A scrolling text-like page: dense 8 px glyph cells that move 6 px a frame.
    let mut out = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        let sy = y + n * 6;
        for x in 0..w {
            let cell = ((x / 8).wrapping_mul(2_654_435_761) ^ (sy / 12).wrapping_mul(40_503)) >> 7;
            let ink = cell.is_multiple_of(7) && (x % 8 < 6) && (sy % 12 < 9);
            let v = if ink { 30 } else { 230 };
            let p = ((y * w + x) * 4) as usize;
            out[p] = v;
            out[p + 1] = v.wrapping_add((x / 64) as u8);
            out[p + 2] = v;
            out[p + 3] = 255;
        }
    }
    out
}

fn run<F: std::ops::Deref<Target = [u8]>>(
    label: &str,
    mut encoder: SimulcastEncoder,
    frames: &[F],
    fps: u32,
) {
    // 30 warm-up frames (pool allocation, first keyframe) are not counted.
    let warmup = 30usize;
    let count = 900usize;
    let mut total = Duration::ZERO;
    let mut max = Duration::ZERO;
    let mut bytes = [0usize; 3];
    for i in 0..count {
        let started = Instant::now();
        let out = encoder
            .encode(i as i64, &frames[i % frames.len()], i == 0)
            .expect("encode");
        let took = started.elapsed();
        if i < warmup {
            continue;
        }
        total += took;
        max = max.max(took);
        for f in out {
            bytes[f.layer.map(|l| l as usize).unwrap_or(0).min(2)] += f.data.len();
        }
        if let Some(line) = encoder.stage_report() {
            println!("  {line}");
        }
    }
    let measured = count - warmup;
    let avg_ms = total.as_secs_f64() * 1000.0 / measured as f64;
    let secs = measured as f64 / f64::from(fps);
    println!(
        "{label}: {avg_ms:.2} ms/frame avg, {:.2} max -> {:.0} fps ceiling; Mb/s per layer at {fps} fps: {:?}",
        max.as_secs_f64() * 1000.0,
        1000.0 / avg_ms,
        bytes.map(|b| (b as f64 * 8.0 / secs / 1e6 * 10.0).round() / 10.0)
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize, d: u32| args.get(i).and_then(|v| v.parse().ok()).unwrap_or(d);
    let (w, h, fps, kbps) = (arg(0, 5120), arg(1, 1440), arg(2, 60), arg(3, 36_000));
    let hint = match args.get(4).map(String::as_str) {
        Some("film") => VideoContentHint::Film,
        Some("motion") => VideoContentHint::Motion,
        _ => VideoContentHint::Detail,
    };
    let codec = VideoCodec::Av1;
    let layers = simulcast_ladder(
        SimulcastKind::Screen,
        w,
        h,
        fps,
        kbps,
        PixelFormat::Bgra,
        hint,
        4,
    );
    println!(
        "{w}x{h}@{fps} {kbps} kbps {hint:?}; layers: {:?}",
        layers
            .iter()
            .map(|(_, c)| format!("{}x{}@{} {}k", c.width, c.height, c.fps, c.bitrate_kbps))
            .collect::<Vec<_>>()
    );
    let frames: Vec<Vec<u8>> = (0..8).map(|n| frame(w, h, n)).collect();
    let pinned = args.get(5).is_some_and(|a| a == "pinned");

    let per_layer = SimulcastEncoder::new_with_configs(w, h, PixelFormat::Bgra, &layers, |cfg| {
        Ok(Box::new(LavcEncoder::new_with_input(codec, cfg, w, h)?))
    })
    .expect("per-layer encoder");
    run("per-layer uploads", per_layer, &frames, fps);

    let shared = SimulcastEncoder::new_shared(
        w,
        h,
        PixelFormat::Bgra,
        Box::new(LavcSimulcastEncoder::new(codec, w, h, &layers).expect("shared encoder")),
    )
    .expect("shared simulcast");
    if pinned {
        let pool = PinnedHostPool::new().expect("CUDA driver for pinned memory");
        let pinned_frames: Vec<_> = frames
            .iter()
            .map(|f| {
                let mut p = pool.take(f.len()).expect("pinned buffer");
                p.copy_from_slice(f);
                p
            })
            .collect();
        run("shared upload, pinned", shared, &pinned_frames, fps);
    } else {
        run("shared upload", shared, &frames, fps);
    }
}
