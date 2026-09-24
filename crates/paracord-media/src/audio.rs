//! Dependency-free audio probing for the soundboard.
//!
//! Paracord accepts mp3 / ogg / wav / m4a sound uploads up to 1 MiB and needs
//! the decoded duration server-side to enforce the 5 s cap. There is no
//! general-purpose decoder dependency in the tree (`ffmpeg-sys-next` is an
//! opt-in feature of the native client only, `audiopus` is Opus-only), so this
//! module walks each container far enough to compute duration without
//! decoding audio:
//!
//! - WAV: RIFF `fmt ` byte rate + `data` chunk size.
//! - MP3: ID3v2 skip, then frame-header walk summing per-frame durations.
//! - Ogg: last page's granule position divided by the stream rate
//!   (Vorbis id header rate, FLAC STREAMINFO rate, Opus fixed 48 kHz).
//! - MP4/M4A: `moov`/`mvhd` timescale + duration.
//!
//! A file that does not parse is rejected — the probe doubles as the magic-byte
//! validation for the declared content type.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Wav,
    Mp3,
    Ogg,
    Mp4,
}

impl AudioFormat {
    /// Canonical content type stored on the sound row.
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Wav => "audio/wav",
            Self::Mp3 => "audio/mpeg",
            Self::Ogg => "audio/ogg",
            Self::Mp4 => "audio/mp4",
        }
    }
}

/// Maps a client-declared `Content-Type` onto a probe family, or `None` for
/// formats the soundboard does not accept.
pub fn format_for_content_type(content_type: &str) -> Option<AudioFormat> {
    let normalized = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => Some(AudioFormat::Wav),
        "audio/mpeg" | "audio/mp3" | "audio/x-mpeg" => Some(AudioFormat::Mp3),
        "audio/ogg" | "application/ogg" | "audio/oga" | "audio/x-ogg" => Some(AudioFormat::Ogg),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => Some(AudioFormat::Mp4),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioProbeError {
    /// Bytes do not match any accepted container signature.
    Unrecognized,
    /// Signature matched a container family but the file is truncated or
    /// internally inconsistent.
    Malformed(&'static str),
    /// The container parsed but carries no usable duration (e.g. a WAV with a
    /// zero `byte_rate`, or an Ogg stream whose pages all report "no packets
    /// complete").
    NoDuration,
}

impl std::fmt::Display for AudioProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unrecognized => write!(f, "not a supported audio file"),
            Self::Malformed(what) => write!(f, "malformed audio file ({what})"),
            Self::NoDuration => write!(f, "could not determine audio duration"),
        }
    }
}

impl std::error::Error for AudioProbeError {}

#[derive(Debug, Clone, Copy)]
pub struct ProbedAudio {
    pub format: AudioFormat,
    pub duration_ms: i64,
}

/// Sniff the container and return its duration. `declared` must name the same
/// container family the bytes sniff to, so a renamed PNG cannot ride in under
/// `audio/wav`.
pub fn probe_audio(data: &[u8], declared: &str) -> Result<ProbedAudio, AudioProbeError> {
    let sniffed = sniff_format(data).ok_or(AudioProbeError::Unrecognized)?;
    let expected = format_for_content_type(declared).ok_or(AudioProbeError::Unrecognized)?;
    if sniffed != expected {
        return Err(AudioProbeError::Unrecognized);
    }
    let duration_ms = match sniffed {
        AudioFormat::Wav => wav_duration_ms(data)?,
        AudioFormat::Mp3 => mp3_duration_ms(data)?,
        AudioFormat::Ogg => ogg_duration_ms(data)?,
        AudioFormat::Mp4 => mp4_duration_ms(data)?,
    };
    if duration_ms <= 0 {
        return Err(AudioProbeError::NoDuration);
    }
    Ok(ProbedAudio {
        format: sniffed,
        duration_ms,
    })
}

fn sniff_format(data: &[u8]) -> Option<AudioFormat> {
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        return Some(AudioFormat::Wav);
    }
    if data.len() >= 4 && &data[0..4] == b"OggS" {
        return Some(AudioFormat::Ogg);
    }
    if data.len() >= 3 && &data[0..3] == b"ID3" {
        return Some(AudioFormat::Mp3);
    }
    if data.len() >= 2 && data[0] == 0xFF && (data[1] & 0xE0) == 0xE0 {
        return Some(AudioFormat::Mp3);
    }
    // ISO BMFF: 4-byte box size followed by "ftyp".
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        return Some(AudioFormat::Mp4);
    }
    None
}

fn le_u32(data: &[u8]) -> u32 {
    u32::from_le_bytes([data[0], data[1], data[2], data[3]])
}

fn be_u32(data: &[u8]) -> u32 {
    u32::from_be_bytes([data[0], data[1], data[2], data[3]])
}

fn be_u64(data: &[u8]) -> u64 {
    u64::from_be_bytes([
        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
    ])
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

fn wav_duration_ms(data: &[u8]) -> Result<i64, AudioProbeError> {
    // RIFF(4) size(4) WAVE(4) then chunks of id(4) size(4) payload(pad to even).
    let mut pos = 12usize;
    let mut byte_rate: Option<u64> = None;
    let mut data_bytes: Option<u64> = None;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = le_u32(&data[pos + 4..pos + 8]) as usize;
        let body = pos + 8;
        if body + size > data.len() {
            return Err(AudioProbeError::Malformed("truncated RIFF chunk"));
        }
        if id == b"fmt " {
            if size < 16 {
                return Err(AudioProbeError::Malformed("short fmt chunk"));
            }
            byte_rate = Some(le_u32(&data[body + 8..body + 12]) as u64);
        } else if id == b"data" {
            // First data chunk wins; subsequent ones are rare and near-identical
            // for the short sounds this feature accepts.
            data_bytes = Some(size as u64);
            if byte_rate.is_some() {
                break;
            }
        }
        // Chunks are word-aligned: a odd payload is followed by one pad byte.
        pos = body + size + (size & 1);
    }
    match (byte_rate, data_bytes) {
        (Some(rate), Some(bytes)) if rate > 0 => Ok((bytes * 1000 / rate) as i64),
        (Some(_), Some(_)) => Err(AudioProbeError::NoDuration),
        _ => Err(AudioProbeError::Malformed("missing fmt or data chunk")),
    }
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

const MPEG1_BITRATES_KBPS: [[u16; 16]; 3] = [
    // Layer I, II, III tables (index 0 = free format, 15 = invalid).
    [
        0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
    ],
    [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
    ],
    [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ],
];
const MPEG2_BITRATES_KBPS: [[u16; 16]; 3] = [
    [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
    ],
    [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
    ],
    [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
    ],
];
const SAMPLE_RATES: [[u32; 4]; 3] = [
    [44100, 48000, 32000, 0], // MPEG-1
    [22050, 24000, 16000, 0], // MPEG-2
    [11025, 12000, 8000, 0],  // MPEG-2.5
];

struct Mp3Frame {
    /// Bytes the whole frame occupies, including the 4-byte header.
    len: usize,
    /// Samples this frame contributes.
    samples: u32,
    sample_rate: u32,
}

fn mp3_frame_at(data: &[u8], pos: usize) -> Option<Mp3Frame> {
    if pos + 4 > data.len() || data[pos] != 0xFF || (data[pos + 1] & 0xE0) != 0xE0 {
        return None;
    }
    let version = (data[pos + 1] >> 3) & 0x03; // 0=2.5, 2=2, 3=1
    let layer = (data[pos + 1] >> 1) & 0x03; // 1=III, 2=II, 3=I
    if version == 1 || layer == 0 {
        return None;
    }
    let version_idx = match version {
        3 => 0usize,
        2 => 1,
        _ => 2,
    };
    let layer_idx = (3 - layer) as usize; // I→0, II→1, III→2
    let bitrate_idx = (data[pos + 2] >> 4) as usize;
    let rate_idx = ((data[pos + 2] >> 2) & 0x03) as usize;
    let padding = (data[pos + 2] >> 1) & 0x01;
    let kbps = if version_idx == 0 {
        MPEG1_BITRATES_KBPS[layer_idx][bitrate_idx]
    } else {
        MPEG2_BITRATES_KBPS[layer_idx][bitrate_idx]
    } as u64;
    let sample_rate = SAMPLE_RATES[version_idx][rate_idx] as u64;
    if kbps == 0 || sample_rate == 0 {
        return None;
    }
    let bitrate = kbps * 1000;
    // Frame length formula per MPEG spec: Layer I pads to 4 bytes; Layer III
    // at MPEG-2/2.5 uses the 72x coefficient, everything else 144x.
    let len = match layer {
        3 => ((12 * bitrate / sample_rate + padding as u64) * 4) as usize,
        1 if version_idx != 0 => (72 * bitrate / sample_rate + padding as u64) as usize,
        _ => (144 * bitrate / sample_rate + padding as u64) as usize,
    };
    let samples = match layer {
        3 => 384,
        2 => 1152,
        _ => {
            if version_idx == 0 {
                1152
            } else {
                576
            }
        }
    };
    if len < 4 {
        return None;
    }
    Some(Mp3Frame {
        len,
        samples,
        sample_rate: sample_rate as u32,
    })
}

fn skip_id3v2(data: &[u8]) -> usize {
    if data.len() < 10 || &data[0..3] != b"ID3" {
        return 0;
    }
    // Four synchsafe bytes (7 bits each) hold the tag size after the 10-byte
    // header; flag bit 0x10 adds a 10-byte footer.
    let size = ((data[6] & 0x7F) as usize) << 21
        | ((data[7] & 0x7F) as usize) << 14
        | ((data[8] & 0x7F) as usize) << 7
        | (data[9] & 0x7F) as usize;
    let footer = if data[5] & 0x10 != 0 { 10 } else { 0 };
    (10 + size + footer).min(data.len())
}

fn mp3_duration_ms(data: &[u8]) -> Result<i64, AudioProbeError> {
    let mut pos = skip_id3v2(data);
    let mut samples_total = 0u128;
    let mut rate_sum = 0u128;
    let mut frames = 0u64;
    // Sum samples/rate per frame (VBR can change rate mid-stream, though for
    // the files we accept it is constant).
    while let Some(frame) = mp3_frame_at(data, pos) {
        samples_total += frame.samples as u128;
        rate_sum += frame.sample_rate as u128;
        frames += 1;
        pos += frame.len;
    }
    if frames == 0 {
        return Err(AudioProbeError::Malformed("no MP3 frames"));
    }
    let avg_rate = rate_sum / frames as u128;
    if avg_rate == 0 {
        return Err(AudioProbeError::NoDuration);
    }
    Ok((samples_total * 1000 / avg_rate) as i64)
}

// ---------------------------------------------------------------------------
// Ogg
// ---------------------------------------------------------------------------

struct OggCodec {
    /// Serial of the first audio stream (taken from its BOS page).
    serial: u32,
    sample_rate: u64,
}

fn ogg_page_granule(data: &[u8], pos: usize) -> Option<(u32, u64, usize)> {
    // Returns (serial, granule, offset of next page).
    if pos + 27 > data.len() || &data[pos..pos + 4] != b"OggS" {
        return None;
    }
    let granule = u64::from_le_bytes([
        data[pos + 6],
        data[pos + 7],
        data[pos + 8],
        data[pos + 9],
        data[pos + 10],
        data[pos + 11],
        data[pos + 12],
        data[pos + 13],
    ]);
    let serial = le_u32(&data[pos + 14..pos + 18]);
    let segments = data[pos + 26] as usize;
    if pos + 27 + segments > data.len() {
        return None;
    }
    let payload: usize = data[pos + 27..pos + 27 + segments]
        .iter()
        .map(|&n| n as usize)
        .sum();
    Some((serial, granule, pos + 27 + segments + payload))
}

fn ogg_first_codec(data: &[u8], pos: usize) -> Option<OggCodec> {
    // The BOS page's payload starts at pos+27+segments.
    let segments = data.get(pos + 26).copied()? as usize;
    let payload = pos + 27 + segments;
    let body = data.get(payload..)?;
    let serial = le_u32(&data[pos + 14..pos + 18]);
    if body.starts_with(b"OpusHead") {
        // Opus granule positions always run at 48 kHz regardless of the
        // input rate declared in the header.
        return Some(OggCodec {
            serial,
            sample_rate: 48000,
        });
    }
    if body.starts_with(b"\x01vorbis") && body.len() >= 16 {
        return Some(OggCodec {
            serial,
            sample_rate: le_u32(&body[12..16]) as u64,
        });
    }
    if body.starts_with(b"\x7fFLAC") {
        // Ogg-FLAC mapping: \x7f FLAC, mapping version(2), header packets(2),
        // then "fLaC" + STREAMINFO. Sample rate is the top 20 bits of the
        // 8-byte field at STREAMINFO offset 10.
        let info = body.get(13..)?;
        if info.starts_with(b"fLaC") && info.len() >= 4 + 13 {
            let s = &info[4 + 10..4 + 13];
            let rate = ((s[0] as u64) << 12) | ((s[1] as u64) << 4) | ((s[2] as u64) >> 4);
            return Some(OggCodec {
                serial,
                sample_rate: rate,
            });
        }
    }
    None
}

fn ogg_duration_ms(data: &[u8]) -> Result<i64, AudioProbeError> {
    let codec = ogg_first_codec(data, 0).ok_or(AudioProbeError::Malformed("unknown Ogg codec"))?;
    if codec.sample_rate == 0 {
        return Err(AudioProbeError::NoDuration);
    }
    let mut pos = 0usize;
    let mut last_granule: Option<u64> = None;
    while let Some((serial, granule, next)) = ogg_page_granule(data, pos) {
        // 0xFFFF… marks a page on which no packet completes; skip it.
        if serial == codec.serial && granule != u64::MAX {
            last_granule = Some(granule);
        }
        if next <= pos {
            return Err(AudioProbeError::Malformed("Ogg page did not advance"));
        }
        pos = next;
    }
    let granule = last_granule.ok_or(AudioProbeError::NoDuration)?;
    Ok((granule as u128 * 1000 / codec.sample_rate as u128) as i64)
}

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

/// Iterates top-level (and `moov` child) boxes, yielding (type, body_start,
/// body_len). Stops on malformed sizes.
fn mp4_boxes(data: &[u8], start: usize, end: usize) -> Vec<(u32, usize, usize)> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos + 8 <= end {
        let size32 = be_u32(&data[pos..pos + 4]);
        let kind = be_u32(&data[pos + 4..pos + 8]);
        let header = 8usize;
        let (box_size, body_start) = if size32 == 1 {
            if pos + 16 > end {
                break;
            }
            (be_u64(&data[pos + 8..pos + 16]) as usize, pos + 16)
        } else if size32 == 0 {
            (end - pos, pos + header)
        } else {
            (size32 as usize, pos + header)
        };
        if box_size < header
            || pos
                .checked_add(box_size)
                .is_none_or(|box_end| box_end > end)
        {
            break;
        }
        out.push((kind, body_start, pos + box_size - body_start));
        if size32 == 0 {
            break;
        }
        pos += box_size;
    }
    out
}

const BOX_MOOV: u32 = u32::from_be_bytes(*b"moov");
const BOX_MVHD: u32 = u32::from_be_bytes(*b"mvhd");

fn mp4_duration_ms(data: &[u8]) -> Result<i64, AudioProbeError> {
    let top = mp4_boxes(data, 0, data.len());
    let moov = top
        .iter()
        .find(|(kind, _, _)| *kind == BOX_MOOV)
        .ok_or(AudioProbeError::Malformed("no moov box"))?;
    let inner = mp4_boxes(data, moov.1, moov.1 + moov.2);
    let mvhd = inner
        .iter()
        .find(|(kind, _, _)| *kind == BOX_MVHD)
        .ok_or(AudioProbeError::Malformed("no mvhd box"))?;
    let body = &data[mvhd.1..mvhd.1 + mvhd.2];
    if body.len() < 20 {
        return Err(AudioProbeError::Malformed("short mvhd box"));
    }
    let version = body[0];
    let (timescale, duration) = if version == 1 {
        if body.len() < 32 {
            return Err(AudioProbeError::Malformed("short mvhd v1 box"));
        }
        (be_u32(&body[20..24]) as u64, be_u64(&body[24..32]))
    } else {
        (be_u32(&body[12..16]) as u64, be_u32(&body[16..20]) as u64)
    };
    if timescale == 0 {
        return Err(AudioProbeError::NoDuration);
    }
    Ok((duration as u128 * 1000 / timescale as u128) as i64)
}

#[cfg(test)]
mod tests {
    /// Uploads are untrusted bytes: no input may panic the probe. Mutates
    /// valid headers of every supported container (truncation, random bytes,
    /// huge sizes) with a fixed-seed generator so a failure reproduces.
    #[test]
    fn hostile_input_never_panics() {
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let prefixes: [&[u8]; 6] = [
            b"RIFF\x00\x00\x00\x00WAVEfmt ",
            b"OggS",
            b"ID3\x04\x00\x00\x00\x00\x00\x00",
            b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00",
            b"\xFF\xFB\x90\x64",
            b"",
        ];
        let kinds = [
            "audio/wav",
            "audio/ogg",
            "audio/mpeg",
            "audio/mp4",
            "audio/x-m4a",
        ];
        for round in 0..20_000 {
            let prefix = prefixes[round % prefixes.len()];
            let len = (next() % 512) as usize;
            let mut data = prefix.to_vec();
            for _ in 0..len {
                data.push((next() & 0xFF) as u8);
            }
            // Sprinkle extreme length fields.
            if data.len() > 8 && round % 3 == 0 {
                let at = (next() as usize) % (data.len() - 4);
                data[at..at + 4].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
            }
            if data.len() > 16 && round % 5 == 0 {
                // A 64-bit "largesize" box claiming nearly usize::MAX bytes.
                let at = (next() as usize) % (data.len() - 16);
                data[at..at + 4].copy_from_slice(&1u32.to_be_bytes());
                data[at + 8..at + 16].copy_from_slice(&u64::MAX.to_be_bytes());
            }
            let kind = kinds[(next() as usize) % kinds.len()];
            let _ = probe_audio(&data, kind);
            let cut = (next() as usize) % (data.len() + 1);
            let _ = probe_audio(&data[..cut], kind);
        }
    }

    use super::*;

    fn wav_bytes(seconds: f64, sample_rate: u32) -> Vec<u8> {
        let frames = (seconds * sample_rate as f64) as u32;
        let data_len = frames * 2; // mono s16
        let byte_rate = sample_rate * 2;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // mono
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes()); // block align
        out.extend_from_slice(&16u16.to_le_bytes()); // bits
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.extend(std::iter::repeat_n(0u8, data_len as usize));
        out
    }

    #[test]
    fn wav_duration_roundtrip() {
        let data = wav_bytes(2.0, 48000);
        let probed = probe_audio(&data, "audio/wav").unwrap();
        assert_eq!(probed.format, AudioFormat::Wav);
        assert_eq!(probed.duration_ms, 2000);
    }

    #[test]
    fn wav_over_five_seconds_measured() {
        let data = wav_bytes(6.0, 44100);
        let probed = probe_audio(&data, "audio/wave").unwrap();
        assert_eq!(probed.duration_ms, 6000);
    }

    #[test]
    fn rejects_png_bytes() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&[0; 64]);
        assert_eq!(
            probe_audio(&png, "audio/wav").unwrap_err(),
            AudioProbeError::Unrecognized
        );
    }

    #[test]
    fn rejects_content_type_mismatch() {
        let data = wav_bytes(1.0, 48000);
        // A real WAV declared as MP3 is a renamed-file upload; reject it.
        assert_eq!(
            probe_audio(&data, "audio/mpeg").unwrap_err(),
            AudioProbeError::Unrecognized
        );
        // Unsupported formats are rejected outright.
        assert_eq!(
            probe_audio(&data, "video/mp4").unwrap_err(),
            AudioProbeError::Unrecognized
        );
    }

    fn mp3_frame(bitrate_idx: u8, rate_idx: u8, sample_rate: u32, kbps: u32) -> Vec<u8> {
        // MPEG-1 Layer III: sync + header, then zeroed payload.
        let len = 144 * kbps * 1000 / sample_rate; // no padding for these rates
        let mut frame = vec![0u8; len as usize];
        frame[0] = 0xFF;
        frame[1] = 0xFB; // MPEG-1, Layer III, no CRC
        frame[2] = (bitrate_idx << 4) | (rate_idx << 2);
        frame[3] = 0;
        frame
    }

    #[test]
    fn mp3_duration_roundtrip() {
        // 100 frames of MPEG-1 Layer III @ 128 kbps, 44.1 kHz:
        // 1152 samples per frame -> 115200/44100 = 2.612 s.
        let mut data = Vec::new();
        for _ in 0..100 {
            data.extend_from_slice(&mp3_frame(9, 0, 44100, 128));
        }
        let probed = probe_audio(&data, "audio/mpeg").unwrap();
        assert_eq!(probed.format, AudioFormat::Mp3);
        assert!(
            (probed.duration_ms - 2612).abs() <= 2,
            "{}",
            probed.duration_ms
        );
    }

    #[test]
    fn mp3_skips_id3v2_tag() {
        let mut data = b"ID3\x04\x00\x00\x00\x00\x00\x14".to_vec(); // 20-byte tag
        data.extend_from_slice(&[0u8; 20]);
        for _ in 0..50 {
            data.extend_from_slice(&mp3_frame(9, 0, 44100, 128));
        }
        let probed = probe_audio(&data, "audio/mpeg").unwrap();
        assert!(
            (probed.duration_ms - 1306).abs() <= 2,
            "{}",
            probed.duration_ms
        );
    }

    #[test]
    fn ogg_vorbis_duration() {
        // Two pages on one serial: BOS page (granule 0) carrying a vorbis id
        // header @ 48 kHz, then a final page with granule 96000 (2 s).
        let id_header: &[u8] = &[
            0x01, b'v', b'o', b'r', b'b', b'i', b's', // signature
            0, 0, 0, 0, // version
            2, // channels
            0x80, 0xBB, 0, 0, // 48000 le
        ];
        let page = |granule: u64, seq: u32, payload: &[u8]| -> Vec<u8> {
            assert!(payload.len() < 255, "test pages use a single segment");
            let mut p = Vec::new();
            p.extend_from_slice(b"OggS");
            p.push(0); // version
            p.push(0); // flags
            p.extend_from_slice(&granule.to_le_bytes());
            p.extend_from_slice(&0xABCDu32.to_le_bytes()); // serial
            p.extend_from_slice(&seq.to_le_bytes());
            p.extend_from_slice(&0u32.to_le_bytes()); // crc
            p.push(1); // one lacing value
            p.push(payload.len() as u8);
            p.extend_from_slice(payload);
            p
        };
        let mut data = page(0, 0, id_header);
        data.extend_from_slice(&page(96000, 1, &[1, 2, 3]));
        let probed = probe_audio(&data, "audio/ogg").unwrap();
        assert_eq!(probed.duration_ms, 2000);
    }

    #[test]
    fn mp4_mvhd_duration() {
        let mvhd = {
            let mut b = vec![0u8; 100];
            b[0] = 0; // version 0
            b[12..16].copy_from_slice(&1000u32.to_be_bytes()); // timescale
            b[16..20].copy_from_slice(&2500u32.to_be_bytes()); // duration = 2.5 s
            let mut bx = Vec::new();
            bx.extend_from_slice(&(b.len() as u32 + 8).to_be_bytes());
            bx.extend_from_slice(b"mvhd");
            bx.extend_from_slice(&b);
            bx
        };
        let moov = {
            let mut bx = Vec::new();
            bx.extend_from_slice(&(mvhd.len() as u32 + 8).to_be_bytes());
            bx.extend_from_slice(b"moov");
            bx.extend_from_slice(&mvhd);
            bx
        };
        let mut data = Vec::new();
        data.extend_from_slice(&28u32.to_be_bytes());
        data.extend_from_slice(b"ftypM4A ");
        data.extend_from_slice(&[0u8; 16]);
        data.extend_from_slice(&moov);
        let probed = probe_audio(&data, "audio/x-m4a").unwrap();
        assert_eq!(probed.format, AudioFormat::Mp4);
        assert_eq!(probed.duration_ms, 2500);
    }

    #[test]
    fn truncated_files_fail_loudly() {
        let wav = wav_bytes(1.0, 48000);
        assert!(matches!(
            probe_audio(&wav[..20], "audio/wav"),
            Err(AudioProbeError::Malformed(_))
        ));
        assert_eq!(
            probe_audio(&[], "audio/wav").unwrap_err(),
            AudioProbeError::Unrecognized
        );
    }
}
