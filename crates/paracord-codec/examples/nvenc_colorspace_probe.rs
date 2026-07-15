//! NVENC colorspace hardware verification probe (streaming-native-render-spec §6).
//!
//! # What this is
//! A hardware-only diagnostic that closes the one skipped review item: it proves,
//! on real silicon, which YUV matrix NVENC's internal BGRA→NV12 conversion
//! actually uses, so [`EncodedFrame::colorspace`] never lies about the bitstream
//! it ships (contract C1 — signaled must equal actual).
//!
//! It builds the *real* [`LavcEncoder`] NVENC pipeline (exactly the one the media
//! stack uses), feeds it full-frame patches of known sRGB colors, encodes ~30
//! frames of H.264, decodes the bitstream back to raw `yuv420p` with the ffmpeg
//! CLI, measures per-patch Y/Cb/Cr means, and compares them against BT.709-limited
//! AND BT.601-limited expectations (tolerance ±4). It prints a verdict table.
//!
//! # NOT a CI test — never runs in CI
//! This is an `[[example]]` target, so it is **never** built or run by
//! `cargo test` / `cargo check --workspace` (Cargo does not compile examples for
//! those). It additionally requires `--features lavc` (guarded by
//! `required-features` in Cargo.toml) and real hardware:
//!   - an NVIDIA GPU with NVENC (verified here on an RTX 4080),
//!   - system FFmpeg with `h264_nvenc` + the `ffmpeg` CLI on `PATH`.
//!
//! There is intentionally no way for it to run headless on CI infrastructure.
//!
//! # Run it
//! ```text
//! cargo run -p paracord-codec --example nvenc_colorspace_probe --features lavc
//! ```
//!
//! Exit code is non-zero if the encoder is not NVENC, if ffmpeg is missing, or if
//! the measured matrix cannot be classified — this is a loud, fail-hard probe, not
//! a silent best-effort.

use paracord_codec::video::encoder::VideoEncoder;
use paracord_codec::video::lavc::{LavcBackend, LavcEncoder};
use paracord_codec::video::{ColorSpace, EncoderConfig, PixelFormat, VideoCodec, VideoContentHint};
use std::io::Write;
use std::process::Command;

const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;
const FRAMES_PER_COLOR: usize = 5;
/// Measurement tolerance, in 8-bit code values, per §6.
const TOLERANCE: f64 = 4.0;

/// A known sRGB test patch. Values are gamma-encoded sRGB 8-bit, exactly as a
/// desktop-capture BGRA buffer would carry them; NVENC applies its matrix to
/// these code values (no linearization), which is what we measure.
struct Patch {
    name: &'static str,
    r: u8,
    g: u8,
    b: u8,
}

const PATCHES: &[Patch] = &[
    Patch {
        name: "black",
        r: 0,
        g: 0,
        b: 0,
    },
    Patch {
        name: "white",
        r: 255,
        g: 255,
        b: 255,
    },
    Patch {
        name: "gray50",
        r: 128,
        g: 128,
        b: 128,
    },
    Patch {
        name: "red",
        r: 255,
        g: 0,
        b: 0,
    },
    Patch {
        name: "green",
        r: 0,
        g: 255,
        b: 0,
    },
    Patch {
        name: "blue",
        r: 0,
        g: 0,
        b: 255,
    },
];

/// BT.709 limited-range ("studio swing") RGB→YCbCr, 8-bit code values.
/// Standard digital coefficients; Y ∈ [16,235], Cb/Cr ∈ [16,240] centered at 128.
fn expected_bt709(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64, g as f64, b as f64);
    let y = 16.0 + 0.182_586 * r + 0.614_231 * g + 0.062_007 * b;
    let cb = 128.0 - 0.100_644 * r - 0.338_572 * g + 0.439_216 * b;
    let cr = 128.0 + 0.439_216 * r - 0.398_942 * g - 0.040_274 * b;
    (y, cb, cr)
}

/// BT.601 limited-range ("studio swing") RGB→YCbCr, 8-bit code values.
fn expected_bt601(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64, g as f64, b as f64);
    let y = 16.0 + 0.256_788 * r + 0.504_129 * g + 0.097_906 * b;
    let cb = 128.0 - 0.148_223 * r - 0.290_993 * g + 0.439_216 * b;
    let cr = 128.0 + 0.439_216 * r - 0.367_788 * g - 0.071_427 * b;
    (y, cb, cr)
}

fn main() {
    if let Err(err) = run() {
        eprintln!("\nnvenc_colorspace_probe FAILED: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    // ── 1. Build the real NVENC pipeline (H.264, BGRA in, 1280×720). ──
    let config = EncoderConfig {
        width: WIDTH,
        height: HEIGHT,
        fps: 30,
        bitrate_kbps: 12_000, // generous so quantization can't skew the means
        pixel_format: PixelFormat::Bgra,
        keyframe_interval: 0,
        content_hint: VideoContentHint::Default,
    };
    let mut enc = LavcEncoder::new(VideoCodec::H264, config)
        .map_err(|e| format!("construct LavcEncoder (H.264): {e}"))?;

    // This probe is meaningless on any other backend: fail loudly, don't measure
    // VAAPI/QSV and pretend it says something about NVENC.
    if enc.backend() != LavcBackend::Nvenc {
        return Err(format!(
            "selected backend is {:?}, not NVENC ({}). This probe verifies NVENC only; \
             run it on a machine where NVENC is the chosen backend.",
            enc.backend(),
            enc.backend_name()
        ));
    }
    println!(
        "encoder backend = {} (hw={})",
        enc.backend_name(),
        enc.is_hardware_accelerated()
    );

    // ── 2. Encode ~30 frames: FRAMES_PER_COLOR solid frames per patch. ──
    // Each patch group starts with a forced keyframe so the color change is a
    // clean intra frame; later frames of the group are steady-state.
    let mut bitstream: Vec<u8> = Vec::new();
    let mut signaled: Option<ColorSpace> = None;
    let mut pts: i64 = 0;
    for patch in PATCHES {
        let frame = solid_bgra(patch);
        for i in 0..FRAMES_PER_COLOR {
            let force_kf = i == 0;
            let packets = enc
                .encode(pts, &frame, force_kf)
                .map_err(|e| format!("encode {} frame {i}: {e}", patch.name))?;
            for p in packets {
                // What the encoder claims the bitstream matrix is (EncodedFrame).
                signaled.get_or_insert(p.colorspace);
                bitstream.extend_from_slice(&p.data);
            }
            pts += 1;
        }
    }
    for p in enc.flush().map_err(|e| format!("flush: {e}"))? {
        bitstream.extend_from_slice(&p.data);
    }
    let total_frames = PATCHES.len() * FRAMES_PER_COLOR;
    println!(
        "encoded {} frames ({} bytes H.264 Annex-B) across {} patches",
        total_frames,
        bitstream.len(),
        PATCHES.len()
    );

    // ── 3. Write the bitstream to a temp file. ──
    let dir = std::env::temp_dir();
    let h264_path = dir.join(format!(
        "nvenc_colorspace_probe_{}.h264",
        std::process::id()
    ));
    let yuv_path = dir.join(format!("nvenc_colorspace_probe_{}.yuv", std::process::id()));
    {
        let mut f = std::fs::File::create(&h264_path)
            .map_err(|e| format!("create {}: {e}", h264_path.display()))?;
        f.write_all(&bitstream)
            .map_err(|e| format!("write bitstream: {e}"))?;
    }

    // ── 4. Decode to raw yuv420p with the ffmpeg CLI (no matrix conversion — a
    // straight dump of the decoded planar samples the encoder actually wrote). ──
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(&h264_path)
        .args(["-f", "rawvideo", "-pix_fmt", "yuv420p"])
        .arg(&yuv_path)
        .status()
        .map_err(|e| format!("spawn ffmpeg (is it on PATH?): {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg decode failed with status {status}"));
    }
    let yuv = std::fs::read(&yuv_path).map_err(|e| format!("read decoded yuv: {e}"))?;

    // Best-effort temp cleanup; leaving these in /tmp is harmless if it fails.
    let _ = std::fs::remove_file(&h264_path);
    let _ = std::fs::remove_file(&yuv_path);

    // ── 5. Measure per-patch Y/Cb/Cr means and classify the matrix. ──
    let frame_bytes = PixelFormat::I420.frame_size(WIDTH, HEIGHT);
    let decoded = yuv.len() / frame_bytes;
    if decoded == 0 {
        return Err("ffmpeg produced no decoded frames".into());
    }
    println!("decoded {decoded} frames from the bitstream\n");

    println!(
        "{:<7} | {:^17} | {:^17} | {:^17} | verdict",
        "patch", "measured YCbCr", "BT.709 expect", "BT.601 expect"
    );
    println!("{}", "-".repeat(78));

    let mut bt709_hits = 0usize;
    let mut bt601_hits = 0usize;
    for (idx, patch) in PATCHES.iter().enumerate() {
        // Sample the last frame of this patch's group (steady state). Map through
        // the actual decoded count in case the decoder emitted a different total.
        let group_last = (idx + 1) * FRAMES_PER_COLOR - 1;
        let frame_idx = group_last.min(decoded - 1);
        let frame = &yuv[frame_idx * frame_bytes..(frame_idx + 1) * frame_bytes];
        let (my, mcb, mcr) = patch_means(frame);

        let (ey7, ecb7, ecr7) = expected_bt709(patch.r, patch.g, patch.b);
        let (ey6, ecb6, ecr6) = expected_bt601(patch.r, patch.g, patch.b);

        let match709 = (my - ey7).abs() <= TOLERANCE
            && (mcb - ecb7).abs() <= TOLERANCE
            && (mcr - ecr7).abs() <= TOLERANCE;
        let match601 = (my - ey6).abs() <= TOLERANCE
            && (mcb - ecb6).abs() <= TOLERANCE
            && (mcr - ecr6).abs() <= TOLERANCE;

        // Luma is nearly matrix-invariant for grays; chroma is the discriminator.
        // Verdict per patch uses the nearer chroma distance when both/neither hit.
        let d709 = (mcb - ecb7).abs() + (mcr - ecr7).abs();
        let d601 = (mcb - ecb6).abs() + (mcr - ecr6).abs();
        let verdict = match (match709, match601) {
            (true, false) => "709",
            (false, true) => "601",
            (true, true) => "709=601(gray)",
            (false, false) if d709 < d601 => "~709",
            (false, false) => "~601",
        };
        if match709 || (!match601 && d709 < d601) {
            bt709_hits += 1;
        }
        if match601 || (!match709 && d601 < d709) {
            bt601_hits += 1;
        }

        println!(
            "{:<7} | {:>5.1},{:>5.1},{:>5.1} | {:>5.1},{:>5.1},{:>5.1} | {:>5.1},{:>5.1},{:>5.1} | {}",
            patch.name, my, mcb, mcr, ey7, ecb7, ecr7, ey6, ecb6, ecr6, verdict
        );
    }

    println!(
        "\nchroma-discriminating patches favoring 709: {bt709_hits}, favoring 601: {bt601_hits}"
    );
    let measured = if bt709_hits > bt601_hits {
        Some(ColorSpace::Bt709)
    } else if bt601_hits > bt709_hits {
        Some(ColorSpace::Bt601)
    } else {
        None
    };
    let measured_name = match measured {
        Some(ColorSpace::Bt709) => "BT.709",
        Some(ColorSpace::Bt601) => "BT.601",
        None => "AMBIGUOUS",
    };
    println!("MEASURED NVENC INTERNAL MATRIX: {measured_name}");

    // ── 6. Confirm signaled == actual (contract C1). Two independent signals:
    // the EncodedFrame.colorspace the engine hands downstream, and the H.264 VUI
    // matrix_coefficients written into the bitstream (read back with ffprobe). ──
    let signaled = signaled.ok_or("encoder produced no packets to read a signaled colorspace")?;
    let signaled_name = match signaled {
        ColorSpace::Bt709 => "BT.709",
        ColorSpace::Bt601 => "BT.601",
    };
    let vui = ffprobe_color_space(&bitstream, &dir)?;
    println!("SIGNALED (EncodedFrame.colorspace): {signaled_name}");
    println!("SIGNALED (H.264 VUI matrix_coefficients via ffprobe): {vui}");

    let measured = measured.ok_or("measurement was ambiguous; cannot confirm signaled==actual")?;
    // ffprobe reports 601 as "smpte170m"/"bt470bg" and 709 as "bt709".
    let vui_matches = match measured {
        ColorSpace::Bt601 => vui.contains("smpte170m") || vui.contains("bt470bg") || vui == "601",
        ColorSpace::Bt709 => vui.contains("bt709"),
    };
    if signaled != measured || !vui_matches {
        return Err(format!(
            "SIGNALED != ACTUAL: measured {measured_name} but EncodedFrame signals \
             {signaled_name} and VUI says '{vui}' (contract C1 violated)"
        ));
    }
    println!("\nRESULT: signaled == actual ({measured_name}). Contract C1 holds.");
    Ok(())
}

/// Read the H.264 VUI `matrix_coefficients` back from the encoded bitstream with
/// the ffprobe CLI, so the confirmation of "signaled == actual" reads the real
/// tag ffmpeg wrote — not our own belief about it.
fn ffprobe_color_space(bitstream: &[u8], dir: &std::path::Path) -> Result<String, String> {
    let path = dir.join(format!(
        "nvenc_colorspace_probe_probe_{}.h264",
        std::process::id()
    ));
    std::fs::write(&path, bitstream).map_err(|e| format!("write ffprobe input: {e}"))?;
    let out = Command::new("ffprobe")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=color_space",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(&path)
        .output()
        .map_err(|e| format!("spawn ffprobe: {e}"))?;
    let _ = std::fs::remove_file(&path);
    if !out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A full-frame solid BGRA buffer for one patch (byte order B,G,R,A).
fn solid_bgra(patch: &Patch) -> Vec<u8> {
    let mut buf = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
    for px in buf.chunks_exact_mut(4) {
        px[0] = patch.b;
        px[1] = patch.g;
        px[2] = patch.r;
        px[3] = 255;
    }
    buf
}

/// Mean Y, Cb, Cr over a centered patch of one decoded I420 frame. Sampling the
/// center avoids any edge/deblock artifacts (there are none for a solid frame,
/// but the center patch also averages away quantization noise).
fn patch_means(frame: &[u8]) -> (f64, f64, f64) {
    let w = WIDTH as usize;
    let h = HEIGHT as usize;
    let y_size = w * h;
    let cw = w / 2;
    let ch = h / 2;
    let uv_size = cw * ch;
    let y_plane = &frame[..y_size];
    let u_plane = &frame[y_size..y_size + uv_size];
    let v_plane = &frame[y_size + uv_size..y_size + 2 * uv_size];

    // Luma patch: 400×400 centered box.
    let (x0, x1, y0, y1) = (w / 2 - 200, w / 2 + 200, h / 2 - 200, h / 2 + 200);
    let mut ysum = 0u64;
    let mut ycount = 0u64;
    for row in y0..y1 {
        for col in x0..x1 {
            ysum += y_plane[row * w + col] as u64;
            ycount += 1;
        }
    }
    // Chroma patch: same region at half resolution.
    let (cx0, cx1, cy0, cy1) = (cw / 2 - 100, cw / 2 + 100, ch / 2 - 100, ch / 2 + 100);
    let mut usum = 0u64;
    let mut vsum = 0u64;
    let mut ccount = 0u64;
    for row in cy0..cy1 {
        for col in cx0..cx1 {
            usum += u_plane[row * cw + col] as u64;
            vsum += v_plane[row * cw + col] as u64;
            ccount += 1;
        }
    }
    (
        ysum as f64 / ycount as f64,
        usum as f64 / ccount as f64,
        vsum as f64 / ccount as f64,
    )
}
