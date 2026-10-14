//! Hardware bench for the camera's simulcast encoder (stream-fix V5): the
//! per-layer route the camera used (one upload per layer, and a whole new GPU
//! pipeline for a bitrate change) against the shared route it uses now (one
//! upload split on the GPU, the bitrate retargeted on the running encoder).
//! Needs an NVENC/VAAPI/QSV GPU; no camera (synthetic frames).
//!
//! Run: cargo run --release -p paracord-codec --features lavc --example camera_encode_bench -- [W H FPS KBPS]
//! (defaults 1920 1080 30 2500, the camera's top layer)
//!
//! For each route: encode-thread time per frame; the top layer's bitrate
//! changed every 2 s (preset, then 40%, then back) and what each change cost
//! the encode thread; the top layer's bitrate per 2 s window (does it follow);
//! and every top-layer frame decoded again (count, size, errors).
use paracord_codec::video::decoder::create_decoder;
use paracord_codec::video::encoder::SimulcastEncoder;
use paracord_codec::video::lavc::{LavcEncoder, LavcSimulcastEncoder};
use paracord_codec::video::{
    simulcast_ladder, DecoderConfig, EncodedFrame, PixelFormat, SimulcastKind, SimulcastLayer,
    VideoCodec, VideoContentHint,
};
use std::time::{Duration, Instant};

fn frame(w: u32, h: u32, n: u32) -> Vec<u8> {
    // A moving gradient with a sliding block: camera-like motion everywhere.
    let mut out = vec![0u8; (w * h * 4) as usize];
    let bx = (n * 7) % w.max(1);
    for y in 0..h {
        for x in 0..w {
            let p = ((y * w + x) * 4) as usize;
            let block = x >= bx && x < bx + w / 6 && y > h / 3 && y < h * 2 / 3;
            let noise =
                ((x.wrapping_mul(73) ^ y.wrapping_mul(151) ^ n.wrapping_mul(977)) & 15) as u8;
            out[p] = if block {
                240
            } else {
                ((x + n * 3) % 256) as u8
            } ^ noise;
            out[p + 1] = ((y + n * 2) % 256) as u8 ^ noise;
            out[p + 2] = if block { 30 } else { ((x + y) / 8 % 256) as u8 };
            out[p + 3] = 255;
        }
    }
    out
}

fn run(
    label: &str,
    mut encoder: SimulcastEncoder,
    frames: &[Vec<u8>],
    fps: u32,
    kbps: u32,
    codec: VideoCodec,
    rebuild: &dyn Fn(u32) -> Duration,
) {
    let count = (fps * 12) as usize;
    let window = (fps * 2) as usize;
    let mut decoder = create_decoder(codec, DecoderConfig::default()).expect("decoder");
    let (mut total, mut max) = (Duration::ZERO, Duration::ZERO);
    let mut window_bytes = 0usize;
    let mut per_window = Vec::new();
    let mut retargets = Vec::new();
    let (mut top_frames, mut decoded, mut decode_errors) = (0usize, 0usize, 0usize);
    let mut sizes = std::collections::BTreeSet::new();
    let mut layer_frames = [0usize; 3];
    for i in 0..count {
        if i > 0 && i % window == 0 {
            per_window.push(window_bytes as f64 * 8.0 / 2.0 / 1e6);
            window_bytes = 0;
            let target = if (i / window) % 2 == 1 {
                kbps * 2 / 5
            } else {
                kbps
            };
            let started = Instant::now();
            let applied = encoder.set_top_layer_bitrate(target).expect("retarget");
            let took = started.elapsed();
            // What the old route paid on top: a whole new pipeline for the layer.
            let rebuilt = rebuild(target);
            retargets.push((target, applied, took, rebuilt));
        }
        let started = Instant::now();
        let out: Vec<EncodedFrame> = encoder
            .encode(i as i64, &frames[i % frames.len()], i == 0)
            .expect("encode");
        let took = started.elapsed();
        if i >= 10 {
            total += took;
            max = max.max(took);
        }
        for f in out {
            let layer = f.layer.map(|l| l as usize).unwrap_or(0).min(2);
            layer_frames[layer] += 1;
            if f.layer == Some(SimulcastLayer::High) {
                top_frames += 1;
                window_bytes += f.data.len();
                match decoder.decode(&f) {
                    Ok(decoded_frames) => {
                        for d in decoded_frames {
                            decoded += 1;
                            sizes.insert((d.width, d.height));
                        }
                    }
                    Err(_) => decode_errors += 1,
                }
            }
        }
    }
    per_window.push(window_bytes as f64 * 8.0 / 2.0 / 1e6);
    let avg_ms = total.as_secs_f64() * 1000.0 / (count - 10) as f64;
    println!(
        "{label}: {avg_ms:.2} ms/frame avg, {:.2} max; frames per layer {layer_frames:?}",
        max.as_secs_f64() * 1000.0
    );
    for (target, applied, took, rebuilt) in retargets {
        println!(
            "  retarget top layer to {target} kbps: applied={applied}, {:.3} ms on the encode thread{}",
            took.as_secs_f64() * 1000.0,
            if rebuilt.is_zero() {
                String::new()
            } else {
                format!(" (the old route's rebuild of that layer: {:.1} ms)", rebuilt.as_secs_f64() * 1000.0)
            }
        );
    }
    println!(
        "  top layer Mb/s per 2 s window: {:?}",
        per_window
            .iter()
            .map(|m| (m * 100.0).round() / 100.0)
            .collect::<Vec<_>>()
    );
    println!(
        "  top layer decoded again: {decoded} of {top_frames} frames, sizes {sizes:?}, {decode_errors} errors"
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize, d: u32| args.get(i).and_then(|v| v.parse().ok()).unwrap_or(d);
    let (w, h, fps, kbps) = (arg(0, 1920), arg(1, 1080), arg(2, 30), arg(3, 2_500));
    let codec = VideoCodec::Av1;
    let layers = simulcast_ladder(
        SimulcastKind::Camera,
        w,
        h,
        fps,
        kbps,
        PixelFormat::Rgba,
        VideoContentHint::Motion,
        2,
    );
    println!(
        "camera {w}x{h}@{fps} {kbps} kbps; layers: {:?}",
        layers
            .iter()
            .map(|(_, c)| format!("{}x{}@{} {}k", c.width, c.height, c.fps, c.bitrate_kbps))
            .collect::<Vec<_>>()
    );
    let frames: Vec<Vec<u8>> = (0..30).map(|n| frame(w, h, n)).collect();
    let top = layers.last().unwrap().1.clone();

    let per_layer = SimulcastEncoder::new_with_configs(w, h, PixelFormat::Rgba, &layers, |cfg| {
        Ok(Box::new(LavcEncoder::new_with_input(codec, cfg, w, h)?))
    })
    .expect("per-layer encoder");
    let rebuild = |target: u32| {
        let started = Instant::now();
        let mut cfg = top.clone();
        cfg.bitrate_kbps = target;
        let fresh = LavcEncoder::new_with_input(codec, cfg, w, h).expect("rebuild");
        drop(fresh);
        started.elapsed()
    };
    run(
        "per-layer uploads (the camera before)",
        per_layer,
        &frames,
        fps,
        kbps,
        codec,
        &rebuild,
    );

    let shared = SimulcastEncoder::new_shared(
        w,
        h,
        PixelFormat::Rgba,
        Box::new(LavcSimulcastEncoder::new(codec, w, h, &layers).expect("shared encoder")),
    )
    .expect("shared simulcast");
    run(
        "shared upload (the camera now)",
        shared,
        &frames,
        fps,
        kbps,
        codec,
        &|_| Duration::ZERO,
    );
}
