//! Hardware diagnostic: real 1080p60 AV1 encode/decode, moving after a static window.
//! Run: cargo run --release -p paracord-codec --features lavc --example stream_quality_probe
use paracord_codec::video::decoder::VideoDecoder;
use paracord_codec::video::encoder::VideoEncoder;
use paracord_codec::video::lavc::{LavcDecoder, LavcEncoder};
use paracord_codec::video::{
    DecoderConfig, EncoderConfig, PixelFormat, VideoCodec, VideoContentHint,
};

fn measure(kbps: u32) -> f64 {
    let (w, h) = (1920, 1080);
    let mut encoder = LavcEncoder::new(
        VideoCodec::Av1,
        EncoderConfig {
            width: w,
            height: h,
            fps: 60,
            bitrate_kbps: kbps,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 600,
            content_hint: VideoContentHint::Detail,
        },
    )
    .expect("real AV1 encoder");
    let mut decoder = LavcDecoder::new(VideoCodec::Av1, DecoderConfig::default()).unwrap();
    let mut error = 0u64;
    let mut samples = 0u64;
    let mut bytes = 0;
    for frame in 0..180 {
        let mut source = vec![128u8; (w * h * 3 / 2) as usize];
        let shift = if frame < 60 { 0 } else { (frame - 60) * 7 };
        for y in 0..h {
            for x in 0..w {
                // Detailed desktop-like edges and textured panels scrolling together.
                let sx = x + shift;
                let tile = ((sx / 8).wrapping_mul(31337) ^ (y / 8).wrapping_mul(971)) % 180;
                source[(y * w + x) as usize] = (30 + tile) as u8;
            }
        }
        for encoded in encoder.encode(frame as i64, &source, frame == 0).unwrap() {
            bytes += encoded.data.len();
            for decoded in decoder.decode(&encoded).unwrap() {
                assert_eq!((decoded.width, decoded.height), (w, h));
                if frame >= 60 {
                    for (a, b) in source[..(w * h) as usize].iter().zip(&decoded.data) {
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
    psnr
}
fn main() {
    let starved = measure(1054); // Reproduced 1240 kbps false feedback × sender's 85% headroom.
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
