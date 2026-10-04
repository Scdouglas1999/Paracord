//! Hardware diagnostic: real BGRA three-layer NVENC encode/decode, moving after idle.
//! Run: cargo run --release -p paracord-codec --features lavc --example stream_quality_probe
use paracord_codec::video::decoder::VideoDecoder;
use paracord_codec::video::encoder::SimulcastEncoder;
use paracord_codec::video::lavc::{LavcDecoder, LavcEncoder};
use paracord_codec::video::{
    DecoderConfig, EncoderConfig, PixelFormat, SimulcastLayer, VideoCodec, VideoContentHint,
};
use std::time::{Duration, Instant};

fn measure(kbps: u32) -> f64 {
    let (w, h) = (1920, 1080);
    let layers: Vec<_> = [
        (SimulcastLayer::Low, 640, 360, 1000),
        (SimulcastLayer::Medium, 1280, 720, 5000),
        (SimulcastLayer::High, w, h, kbps),
    ]
    .into_iter()
    .map(|(layer, width, height, bitrate_kbps)| {
        (
            layer,
            EncoderConfig {
                width,
                height,
                fps: 60,
                bitrate_kbps,
                pixel_format: PixelFormat::Bgra,
                keyframe_interval: 600,
                content_hint: VideoContentHint::Detail,
            },
        )
    })
    .collect();
    let mut encoder =
        SimulcastEncoder::new_with_configs(w, h, PixelFormat::Bgra, &layers, |config| {
            Ok(Box::new(LavcEncoder::new_with_input(
                VideoCodec::Av1,
                config,
                w,
                h,
            )?))
        })
        .expect("real packed three-layer encoder");
    let mut encode_elapsed = Duration::ZERO;
    let mut decoder = LavcDecoder::new(VideoCodec::Av1, DecoderConfig::default()).unwrap();
    let mut error = 0u64;
    let mut samples = 0u64;
    let mut bytes = 0;
    for frame in 0..180 {
        let mut source = vec![255u8; (w * h * 4) as usize];
        let mut reference_y = vec![0u8; (w * h) as usize];
        let shift = if frame < 60 { 0 } else { (frame - 60) * 7 };
        for y in 0..h {
            for x in 0..w {
                // Detailed desktop-like edges and textured panels scrolling together.
                let sx = x + shift;
                let tile = ((sx / 8).wrapping_mul(31337) ^ (y / 8).wrapping_mul(971)) % 180;
                let gray = (30 + tile) as u8;
                let pixel = (y * w + x) as usize;
                source[pixel * 4..pixel * 4 + 3].fill(gray);
                reference_y[pixel] = (16.0 + f64::from(gray) * 219.0 / 255.0).round() as u8;
            }
        }
        let started = Instant::now();
        let frames = encoder.encode(frame as i64, &source, frame == 0).unwrap();
        encode_elapsed += started.elapsed();
        for encoded in frames
            .into_iter()
            .filter(|f| f.layer == Some(SimulcastLayer::High))
        {
            bytes += encoded.data.len();
            for decoded in decoder.decode(&encoded).unwrap() {
                assert_eq!((decoded.width, decoded.height), (w, h));
                if frame >= 60 {
                    for (a, b) in reference_y.iter().zip(&decoded.data) {
                        let d = i64::from(*a) - i64::from(*b);
                        error += (d * d) as u64;
                        samples += 1;
                    }
                }
            }
        }
    }
    assert_eq!(
        samples,
        120 * u64::from(w * h),
        "every moving frame decodes"
    );
    let psnr = 10.0 * (255.0f64.powi(2) / (error as f64 / samples as f64)).log10();
    println!(
        "{}: target={kbps} kbps, bytes={bytes}, moving luma PSNR={psnr:.2} dB",
        encoder.backend_name()
    );
    println!(
        "packed simulcast encode time: {:.2} ms/frame",
        encode_elapsed.as_secs_f64() * 1000.0 / 180.0
    );
    psnr
}
fn main() {
    let starved = measure(632); // Bitrate observed during the live motion failure.
    let healthy = measure(12000);
    assert!(
        healthy > starved + 3.0,
        "restored budget must materially improve moving detail"
    );
    assert!(
        healthy > 34.0,
        "1080p moving-detail fidelity must remain usable"
    );
}
