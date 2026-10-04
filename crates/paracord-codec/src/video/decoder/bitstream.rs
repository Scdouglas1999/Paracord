//! Pure helpers for the Windows Media Foundation decoders
//! ([`super::windows_mf`]): reading the coded size and the signaled matrix out
//! of an H.264 SPS or an AV1 sequence header, and repacking a decoder's
//! strided NV12 / I420 output into the tightly packed I420 a
//! [`DecodedFrameHandle::CpuI420`](crate::video::DecodedFrameHandle::CpuI420)
//! carries.
//!
//! None of this touches Windows, so it is compiled (and unit tested) on every
//! platform's test build; outside tests only Windows uses it.
//!
//! # Why parse at all
//! A Media Foundation decoder allocates its reference pool from the parameter
//! set before it hands anything back, and a peer's bitstream header is remote,
//! untrusted input. [`DecoderConfig::max_dimensions`](crate::video::DecoderConfig)
//! is only honored if the size is read *before* the bytes reach the MFT, so the
//! decoder parses the SPS / sequence header itself and refuses an oversized one
//! up front (the libvpx path does the same with `vpx_codec_peek_stream_info`).

use crate::video::ColorSpace;

/// What a parameter set says about the stream: the coded (allocated) size and,
/// when the stream signals one, the YUV matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StreamHeader {
    /// Coded width in pixels (H.264: macroblock-aligned, before cropping; AV1:
    /// `max_frame_width_minus_1 + 1`). What the decoder allocates for.
    pub coded_width: u32,
    /// Coded height in pixels, as [`coded_width`](Self::coded_width).
    pub coded_height: u32,
    /// The matrix the stream signals, if it signals one this crate can draw
    /// (BT.709 or BT.601); `None` when it is unspecified or absent.
    pub matrix: Option<ColorSpace>,
}

/// Map an ITU-T H.273 `matrix_coefficients` code (shared by H.264 VUI and AV1
/// `color_config`) to the matrices the renderers implement.
fn matrix_from_h273(code: u32) -> Option<ColorSpace> {
    match code {
        1 => Some(ColorSpace::Bt709),
        // 5 = BT.470 System B/G, 6 = SMPTE 170M: both the BT.601 matrix.
        5 | 6 => Some(ColorSpace::Bt601),
        _ => None,
    }
}

// ── Bit reader ───────────────────────────────────────────────────────

/// MSB-first bit reader over an RBSP / OBU payload. Every read is bounds
/// checked; running off the end is an error, never a zero fill.
struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, bit: 0 }
    }

    fn read_bit(&mut self) -> Result<u32, String> {
        let byte = self
            .data
            .get(self.bit / 8)
            .ok_or_else(|| "parameter set ended early".to_string())?;
        let value = (byte >> (7 - (self.bit % 8))) & 1;
        self.bit += 1;
        Ok(u32::from(value))
    }

    fn read_bits(&mut self, count: u32) -> Result<u32, String> {
        debug_assert!(count <= 32);
        let mut value: u64 = 0;
        for _ in 0..count {
            value = (value << 1) | u64::from(self.read_bit()?);
        }
        Ok(value as u32)
    }

    fn read_flag(&mut self) -> Result<bool, String> {
        Ok(self.read_bit()? == 1)
    }

    /// Exp-Golomb `ue(v)` (H.264 §9.1). Codes longer than 31 leading zeros
    /// cannot come from a conforming stream and are refused.
    fn read_ue(&mut self) -> Result<u32, String> {
        let mut leading_zeros = 0u32;
        while self.read_bit()? == 0 {
            leading_zeros += 1;
            if leading_zeros > 31 {
                return Err("exp-Golomb code is longer than 32 bits".to_string());
            }
        }
        let suffix = u64::from(self.read_bits(leading_zeros)?);
        let value = (1u64 << leading_zeros) - 1 + suffix;
        u32::try_from(value).map_err(|_| "exp-Golomb value overflows 32 bits".to_string())
    }

    /// Signed Exp-Golomb `se(v)`.
    fn read_se(&mut self) -> Result<i64, String> {
        let code = i64::from(self.read_ue()?);
        Ok(if code % 2 == 1 {
            (code + 1) / 2
        } else {
            -(code / 2)
        })
    }

    /// AV1 `uvlc()` (spec §4.10.3).
    fn read_uvlc(&mut self) -> Result<u32, String> {
        let mut leading_zeros = 0u32;
        while self.read_bit()? == 0 {
            leading_zeros += 1;
            if leading_zeros >= 32 {
                return Ok(u32::MAX);
            }
        }
        let suffix = u64::from(self.read_bits(leading_zeros)?);
        Ok(((1u64 << leading_zeros) - 1 + suffix).min(u64::from(u32::MAX)) as u32)
    }
}

// ── H.264 ────────────────────────────────────────────────────────────

/// Iterate the NAL units of an Annex-B byte stream (`00 00 01` or
/// `00 00 00 01` start codes). Trailing zero bytes before the next start code
/// are not part of the unit.
pub(crate) fn annex_b_nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0usize;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut units = Vec::with_capacity(starts.len());
    for (index, &start) in starts.iter().enumerate() {
        let mut end = match starts.get(index + 1) {
            // The next unit's start code begins 3 bytes before its payload.
            Some(&next) => next - 3,
            None => data.len(),
        };
        while end > start && data[end - 1] == 0 {
            end -= 1;
        }
        if end > start {
            units.push(&data[start..end]);
        }
    }
    units
}

/// Strip H.264 emulation-prevention bytes (`00 00 03` → `00 00`).
fn h264_rbsp(nal_payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal_payload.len());
    let mut zeros = 0usize;
    for &byte in nal_payload {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        if byte == 0 {
            zeros += 1;
        } else {
            zeros = 0;
        }
        out.push(byte);
    }
    out
}

/// Skip one `scaling_list()` (H.264 §7.3.2.1.1.1).
fn skip_h264_scaling_list(reader: &mut BitReader<'_>, size: usize) -> Result<(), String> {
    let mut last_scale: i64 = 8;
    let mut next_scale: i64 = 8;
    for _ in 0..size {
        if next_scale != 0 {
            let delta = reader.read_se()?;
            next_scale = (last_scale + delta + 256).rem_euclid(256);
        }
        if next_scale != 0 {
            last_scale = next_scale;
        }
    }
    Ok(())
}

/// The first SPS in an Annex-B access unit, if there is one: its coded size and
/// signaled matrix. `Ok(None)` when the unit carries no SPS (a delta frame).
/// A malformed SPS, or one this decoder cannot output (anything but 8-bit
/// 4:2:0), is an error.
pub(crate) fn h264_stream_header(access_unit: &[u8]) -> Result<Option<StreamHeader>, String> {
    for nal in annex_b_nal_units(access_unit) {
        if nal[0] & 0x1F == 7 {
            return parse_h264_sps(&h264_rbsp(&nal[1..])).map(Some);
        }
    }
    Ok(None)
}

fn parse_h264_sps(rbsp: &[u8]) -> Result<StreamHeader, String> {
    let mut r = BitReader::new(rbsp);
    let profile_idc = r.read_bits(8)?;
    let _constraint_flags = r.read_bits(8)?;
    let _level_idc = r.read_bits(8)?;
    let _sps_id = r.read_ue()?;

    let mut chroma_format_idc = 1u32;
    if matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        chroma_format_idc = r.read_ue()?;
        if chroma_format_idc == 3 {
            let _separate_colour_plane = r.read_flag()?;
        }
        let bit_depth_luma = r.read_ue()? + 8;
        let bit_depth_chroma = r.read_ue()? + 8;
        if bit_depth_luma != 8 || bit_depth_chroma != 8 {
            return Err(format!(
                "H.264 stream is {bit_depth_luma}-bit; only 8-bit 4:2:0 can be shown"
            ));
        }
        let _qpprime_y_zero_transform_bypass = r.read_flag()?;
        if r.read_flag()? {
            let lists = if chroma_format_idc != 3 { 8 } else { 12 };
            for index in 0..lists {
                if r.read_flag()? {
                    skip_h264_scaling_list(&mut r, if index < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    if chroma_format_idc != 1 {
        return Err(format!(
            "H.264 stream has chroma_format_idc {chroma_format_idc}; only 4:2:0 can be shown"
        ));
    }

    let _log2_max_frame_num = r.read_ue()?;
    match r.read_ue()? {
        0 => {
            let _log2_max_poc_lsb = r.read_ue()?;
        }
        1 => {
            let _delta_pic_order_always_zero = r.read_flag()?;
            let _offset_for_non_ref_pic = r.read_se()?;
            let _offset_for_top_to_bottom_field = r.read_se()?;
            let cycle = r.read_ue()?;
            if cycle > 255 {
                return Err(format!("H.264 SPS has {cycle} POC cycle entries (max 255)"));
            }
            for _ in 0..cycle {
                let _offset_for_ref_frame = r.read_se()?;
            }
        }
        2 => {}
        other => return Err(format!("H.264 SPS has pic_order_cnt_type {other}")),
    }
    let _max_num_ref_frames = r.read_ue()?;
    let _gaps_in_frame_num_allowed = r.read_flag()?;
    let width_in_mbs = u64::from(r.read_ue()?) + 1;
    let height_in_map_units = u64::from(r.read_ue()?) + 1;
    let frame_mbs_only = r.read_flag()?;
    if !frame_mbs_only {
        let _mb_adaptive_frame_field = r.read_flag()?;
    }
    let _direct_8x8_inference = r.read_flag()?;
    // Cropping only shrinks the displayed area; the allocation is the coded
    // size, which is what the ceiling check is about. Read past it.
    if r.read_flag()? {
        for _ in 0..4 {
            let _crop_offset = r.read_ue()?;
        }
    }

    let coded_width = width_in_mbs * 16;
    let coded_height = (if frame_mbs_only { 1 } else { 2 }) * height_in_map_units * 16;
    let to_u32 = |v: u64, what: &str| {
        u32::try_from(v).map_err(|_| format!("H.264 SPS {what} {v} does not fit 32 bits"))
    };

    let mut matrix = None;
    if r.read_flag()? {
        // vui_parameters(): only as far as the colour description.
        if r.read_flag()? {
            let aspect_ratio_idc = r.read_bits(8)?;
            if aspect_ratio_idc == 255 {
                let _sar_width = r.read_bits(16)?;
                let _sar_height = r.read_bits(16)?;
            }
        }
        if r.read_flag()? {
            let _overscan_appropriate = r.read_flag()?;
        }
        if r.read_flag()? {
            let _video_format = r.read_bits(3)?;
            let _video_full_range = r.read_flag()?;
            if r.read_flag()? {
                let _colour_primaries = r.read_bits(8)?;
                let _transfer_characteristics = r.read_bits(8)?;
                matrix = matrix_from_h273(r.read_bits(8)?);
            }
        }
    }

    Ok(StreamHeader {
        coded_width: to_u32(coded_width, "width")?,
        coded_height: to_u32(coded_height, "height")?,
        matrix,
    })
}

// ── AV1 ──────────────────────────────────────────────────────────────

const AV1_OBU_SEQUENCE_HEADER: u8 = 1;

fn read_leb128(data: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for (index, byte) in data.iter().take(8).enumerate() {
        value |= u64::from(byte & 0x7F) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}

/// The sequence header in an AV1 temporal unit (low-overhead OBU format), if
/// there is one: its maximum frame size and signaled matrix. `Ok(None)` when
/// the unit carries none. A malformed header, or a stream this decoder cannot
/// output (anything but 8-bit 4:2:0, profile 0), is an error.
pub(crate) fn av1_stream_header(temporal_unit: &[u8]) -> Result<Option<StreamHeader>, String> {
    let mut offset = 0usize;
    while offset < temporal_unit.len() {
        let header = temporal_unit[offset];
        if header & 0x80 != 0 {
            return Err("AV1 OBU header has the forbidden bit set".to_string());
        }
        let obu_type = (header >> 3) & 0x0F;
        let has_extension = header & 0x04 != 0;
        let has_size = header & 0x02 != 0;
        offset += 1 + usize::from(has_extension);
        let payload_len = if has_size {
            let (size, leb_len) = read_leb128(temporal_unit.get(offset..).unwrap_or(&[]))
                .ok_or_else(|| "AV1 OBU size is truncated".to_string())?;
            offset += leb_len;
            usize::try_from(size).map_err(|_| "AV1 OBU size overflows".to_string())?
        } else {
            temporal_unit.len().saturating_sub(offset)
        };
        let end = offset
            .checked_add(payload_len)
            .filter(|&end| end <= temporal_unit.len())
            .ok_or_else(|| "AV1 OBU runs past the end of the temporal unit".to_string())?;
        if obu_type == AV1_OBU_SEQUENCE_HEADER {
            return parse_av1_sequence_header(&temporal_unit[offset..end]).map(Some);
        }
        offset = end;
    }
    Ok(None)
}

fn parse_av1_sequence_header(payload: &[u8]) -> Result<StreamHeader, String> {
    let mut r = BitReader::new(payload);
    let seq_profile = r.read_bits(3)?;
    let _still_picture = r.read_flag()?;
    let reduced_still_picture_header = r.read_flag()?;
    if reduced_still_picture_header {
        let _seq_level_idx = r.read_bits(5)?;
    } else {
        let timing_info_present = r.read_flag()?;
        let mut decoder_model_info_present = false;
        let mut buffer_delay_length = 0u32;
        if timing_info_present {
            let _num_units_in_display_tick = r.read_bits(32)?;
            let _time_scale = r.read_bits(32)?;
            if r.read_flag()? {
                let _num_ticks_per_picture_minus_1 = r.read_uvlc()?;
            }
            decoder_model_info_present = r.read_flag()?;
            if decoder_model_info_present {
                buffer_delay_length = r.read_bits(5)? + 1;
                let _num_units_in_decoding_tick = r.read_bits(32)?;
                let _buffer_removal_time_length_minus_1 = r.read_bits(5)?;
                let _frame_presentation_time_length_minus_1 = r.read_bits(5)?;
            }
        }
        let initial_display_delay_present = r.read_flag()?;
        let operating_points = r.read_bits(5)? + 1;
        for _ in 0..operating_points {
            let _operating_point_idc = r.read_bits(12)?;
            let seq_level_idx = r.read_bits(5)?;
            if seq_level_idx > 7 {
                let _seq_tier = r.read_flag()?;
            }
            if decoder_model_info_present && r.read_flag()? {
                let _decoder_buffer_delay = r.read_bits(buffer_delay_length)?;
                let _encoder_buffer_delay = r.read_bits(buffer_delay_length)?;
                let _low_delay_mode = r.read_flag()?;
            }
            if initial_display_delay_present && r.read_flag()? {
                let _initial_display_delay_minus_1 = r.read_bits(4)?;
            }
        }
    }
    let width_bits = r.read_bits(4)? + 1;
    let height_bits = r.read_bits(4)? + 1;
    let coded_width = u64::from(r.read_bits(width_bits)?) + 1;
    let coded_height = u64::from(r.read_bits(height_bits)?) + 1;

    if !reduced_still_picture_header && r.read_flag()? {
        // frame_id_numbers_present_flag
        let _delta_frame_id_length_minus_2 = r.read_bits(4)?;
        let _additional_frame_id_length_minus_1 = r.read_bits(3)?;
    }
    let _use_128x128_superblock = r.read_flag()?;
    let _enable_filter_intra = r.read_flag()?;
    let _enable_intra_edge_filter = r.read_flag()?;
    if !reduced_still_picture_header {
        let _enable_interintra_compound = r.read_flag()?;
        let _enable_masked_compound = r.read_flag()?;
        let _enable_warped_motion = r.read_flag()?;
        let _enable_dual_filter = r.read_flag()?;
        let enable_order_hint = r.read_flag()?;
        if enable_order_hint {
            let _enable_jnt_comp = r.read_flag()?;
            let _enable_ref_frame_mvs = r.read_flag()?;
        }
        let seq_choose_screen_content_tools = r.read_flag()?;
        let seq_force_screen_content_tools = if seq_choose_screen_content_tools {
            2 // SELECT_SCREEN_CONTENT_TOOLS
        } else {
            r.read_bits(1)?
        };
        if seq_force_screen_content_tools > 0 {
            let seq_choose_integer_mv = r.read_flag()?;
            if !seq_choose_integer_mv {
                let _seq_force_integer_mv = r.read_bits(1)?;
            }
        }
        if enable_order_hint {
            let _order_hint_bits_minus_1 = r.read_bits(3)?;
        }
    }
    let _enable_superres = r.read_flag()?;
    let _enable_cdef = r.read_flag()?;
    let _enable_restoration = r.read_flag()?;

    // color_config() (§5.5.2), as far as the matrix.
    let high_bitdepth = r.read_flag()?;
    if high_bitdepth {
        return Err("AV1 stream is 10/12-bit; only 8-bit 4:2:0 can be shown".to_string());
    }
    if seq_profile != 0 {
        return Err(format!(
            "AV1 stream is profile {seq_profile}; only profile 0 (4:2:0) can be shown"
        ));
    }
    let mono_chrome = r.read_flag()?;
    if mono_chrome {
        return Err("AV1 stream is monochrome; only 4:2:0 color can be shown".to_string());
    }
    let mut matrix = None;
    if r.read_flag()? {
        let _color_primaries = r.read_bits(8)?;
        let _transfer_characteristics = r.read_bits(8)?;
        matrix = matrix_from_h273(r.read_bits(8)?);
    }

    Ok(StreamHeader {
        coded_width: u32::try_from(coded_width).map_err(|_| "AV1 width overflow".to_string())?,
        coded_height: u32::try_from(coded_height).map_err(|_| "AV1 height overflow".to_string())?,
        matrix,
    })
}

// ── Plane repacking ──────────────────────────────────────────────────

/// The planar layout a decoder wrote its output in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanarLayout {
    /// Y plane, then one interleaved UV plane at the same pitch.
    Nv12,
    /// Y plane, then U, then V, each chroma plane at half the luma pitch.
    I420,
}

/// Where a decoder's output sits in its buffer and which part of it is the
/// picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PlaneGeometry {
    pub layout: PlanarLayout,
    /// Bytes from one luma row to the next.
    pub pitch: usize,
    /// Rows in the luma plane as allocated (the media type's frame height, e.g.
    /// 1088 for a 1080p H.264 stream): where the chroma plane starts.
    pub plane_rows: usize,
    /// The visible picture inside the plane (the display aperture).
    pub crop_x: usize,
    pub crop_y: usize,
    pub crop_width: usize,
    pub crop_height: usize,
}

/// Repack a decoder's strided NV12 / I420 output into tightly packed I420 of
/// the visible picture. An odd visible size is emitted at the largest even
/// size it contains (every I420 consumer computes chroma as a truncating
/// `w/2 * h/2`, see the VP9 decoder). Every read is bounds checked against
/// `buffer`; a layout that does not fit is an error, never a short frame.
/// Returns `(data, width, height)`.
pub(crate) fn repack_to_i420(
    buffer: &[u8],
    geometry: &PlaneGeometry,
) -> Result<(Vec<u8>, u32, u32), String> {
    let width = geometry.crop_width & !1;
    let height = geometry.crop_height & !1;
    if width == 0 || height == 0 {
        return Err(format!(
            "decoded picture {}x{} is too small to represent as I420",
            geometry.crop_width, geometry.crop_height
        ));
    }
    // Chroma sits at half resolution, so an odd crop origin rounds down to the
    // chroma sample it shares.
    let crop_x = geometry.crop_x & !1;
    let crop_y = geometry.crop_y & !1;
    if crop_x + width > geometry.pitch || crop_y + height > geometry.plane_rows {
        return Err(format!(
            "decoded picture {width}x{height}+{crop_x}+{crop_y} lies outside its {}-byte \
             pitch / {}-row plane",
            geometry.pitch, geometry.plane_rows
        ));
    }
    let pitch = geometry.pitch;
    let luma_len = pitch
        .checked_mul(geometry.plane_rows)
        .ok_or_else(|| "decoded plane size overflows".to_string())?;
    let chroma_rows = geometry.plane_rows / 2;
    let required = match geometry.layout {
        PlanarLayout::Nv12 => luma_len + pitch * chroma_rows,
        PlanarLayout::I420 => luma_len + 2 * (pitch / 2) * chroma_rows,
    };
    if buffer.len() < required {
        return Err(format!(
            "decoded buffer holds {} bytes, its layout needs {required}",
            buffer.len()
        ));
    }

    let (cw, ch) = (width / 2, height / 2);
    let mut out = Vec::with_capacity(width * height + 2 * cw * ch);
    for row in 0..height {
        let start = (crop_y + row) * pitch + crop_x;
        out.extend_from_slice(&buffer[start..start + width]);
    }
    let (cx, cy) = (crop_x / 2, crop_y / 2);
    match geometry.layout {
        PlanarLayout::Nv12 => {
            let uv = &buffer[luma_len..];
            let mut v_plane = Vec::with_capacity(cw * ch);
            for row in 0..ch {
                let start = (cy + row) * pitch + cx * 2;
                let (pairs, _) = uv[start..start + cw * 2].as_chunks::<2>();
                for &[u, v] in pairs {
                    out.push(u);
                    v_plane.push(v);
                }
            }
            out.extend_from_slice(&v_plane);
        }
        PlanarLayout::I420 => {
            let chroma_pitch = pitch / 2;
            let chroma_len = chroma_pitch * chroma_rows;
            for plane in 0..2 {
                let base = luma_len + plane * chroma_len;
                for row in 0..ch {
                    let start = base + (cy + row) * chroma_pitch + cx;
                    out.extend_from_slice(&buffer[start..start + cw]);
                }
            }
        }
    }
    Ok((out, width as u32, height as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn annex_b(nal: &str) -> Vec<u8> {
        let mut out = vec![0, 0, 0, 1];
        out.extend(hex(nal));
        // A trailing slice NAL so the SPS is not the last unit.
        out.extend([0, 0, 1, 0x65, 0x88, 0x84]);
        out
    }

    // SPS NALs produced by libx264 (ffmpeg, `-f h264`).
    const SPS_1080_HIGH_BT709: &str =
        "67640028acd940780227e5c05a810100a0000003002000000781e30632c0";
    const SPS_360_BASELINE_SMPTE170M: &str =
        "6742c01ed900a02ff97016a04040c8000003000800000301e078b17240";
    const SPS_720_HIGH_UNTAGGED: &str = "6764001facd9405005bb0110000003001000000303c0f1831960";

    // Sequence-header OBUs (with their OBU header) produced by libaom.
    const AV1_SEQ_720_BT709: &str = "0a0e0000002d4cffb3ccaf9102020104";
    const AV1_SEQ_1918X1078_SMPTE170M: &str = "0a0e00000042abbec3532be440808181";

    #[test]
    fn h264_sps_gives_the_coded_size_and_matrix() {
        let header = h264_stream_header(&annex_b(SPS_1080_HIGH_BT709))
            .unwrap()
            .unwrap();
        // 1080p is coded as 68 macroblock rows; the crop removes 8.
        assert_eq!((header.coded_width, header.coded_height), (1920, 1088));
        assert_eq!(header.matrix, Some(ColorSpace::Bt709));

        let header = h264_stream_header(&annex_b(SPS_360_BASELINE_SMPTE170M))
            .unwrap()
            .unwrap();
        assert_eq!((header.coded_width, header.coded_height), (640, 368));
        assert_eq!(header.matrix, Some(ColorSpace::Bt601));

        let header = h264_stream_header(&annex_b(SPS_720_HIGH_UNTAGGED))
            .unwrap()
            .unwrap();
        assert_eq!((header.coded_width, header.coded_height), (1280, 720));
        assert_eq!(header.matrix, None, "no colour description: unknown");
    }

    #[test]
    fn h264_without_an_sps_has_no_header() {
        let delta = [0u8, 0, 0, 1, 0x41, 0x9a, 0x02, 0, 0, 1, 0x41, 0x9b];
        assert_eq!(h264_stream_header(&delta).unwrap(), None);
        assert_eq!(h264_stream_header(&[]).unwrap(), None);
    }

    #[test]
    fn a_truncated_h264_sps_is_refused() {
        let full = hex(SPS_1080_HIGH_BT709);
        let mut cut = vec![0u8, 0, 0, 1];
        cut.extend_from_slice(&full[..6]);
        assert!(h264_stream_header(&cut).is_err());
    }

    #[test]
    fn emulation_prevention_bytes_are_removed() {
        assert_eq!(h264_rbsp(&[0, 0, 3, 1, 0, 0, 3, 0]), vec![0, 0, 1, 0, 0, 0]);
        assert_eq!(h264_rbsp(&[1, 0, 3]), vec![1, 0, 3]);
    }

    #[test]
    fn annex_b_units_split_on_both_start_codes() {
        let data = [
            0u8, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4,
        ];
        let units = annex_b_nal_units(&data);
        assert_eq!(
            units,
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4][..]]
        );
    }

    #[test]
    fn av1_sequence_header_gives_the_size_and_matrix() {
        // A temporal delimiter first, as encoders emit it.
        let mut tu = vec![0x12, 0x00];
        tu.extend(hex(AV1_SEQ_720_BT709));
        let header = av1_stream_header(&tu).unwrap().unwrap();
        assert_eq!((header.coded_width, header.coded_height), (1280, 720));
        assert_eq!(header.matrix, Some(ColorSpace::Bt709));

        let header = av1_stream_header(&hex(AV1_SEQ_1918X1078_SMPTE170M))
            .unwrap()
            .unwrap();
        assert_eq!((header.coded_width, header.coded_height), (1918, 1078));
        assert_eq!(header.matrix, Some(ColorSpace::Bt601));
    }

    #[test]
    fn av1_without_a_sequence_header_has_no_header() {
        // Temporal delimiter + an (empty-payload) frame OBU.
        assert_eq!(av1_stream_header(&[0x12, 0x00, 0x32, 0x00]).unwrap(), None);
        // An OBU whose size runs past the unit is malformed.
        assert!(av1_stream_header(&[0x32, 0x05, 0x00]).is_err());
    }

    fn nv12_frame(pitch: usize, rows: usize) -> Vec<u8> {
        // Luma = row*16 + col, chroma pairs = (U=100+col, V=200+row).
        let mut buf = vec![0u8; pitch * rows + pitch * rows / 2];
        for row in 0..rows {
            for col in 0..pitch {
                buf[row * pitch + col] = (row * 16 + col) as u8;
            }
        }
        for row in 0..rows / 2 {
            for pair in 0..pitch / 2 {
                buf[pitch * rows + row * pitch + pair * 2] = (100 + pair) as u8;
                buf[pitch * rows + row * pitch + pair * 2 + 1] = (200 + row) as u8;
            }
        }
        buf
    }

    #[test]
    fn nv12_with_padding_repacks_to_tight_i420() {
        // A 6x4 picture in an 8-byte pitch, 6-row plane (2 rows of padding).
        let buffer = nv12_frame(8, 6);
        let geometry = PlaneGeometry {
            layout: PlanarLayout::Nv12,
            pitch: 8,
            plane_rows: 6,
            crop_x: 0,
            crop_y: 0,
            crop_width: 6,
            crop_height: 4,
        };
        let (data, w, h) = repack_to_i420(&buffer, &geometry).unwrap();
        assert_eq!((w, h), (6, 4));
        assert_eq!(data.len(), 6 * 4 + 2 * 3 * 2);
        assert_eq!(&data[..6], &[0, 1, 2, 3, 4, 5]);
        assert_eq!(&data[6..12], &[16, 17, 18, 19, 20, 21]);
        // U plane: 3x2 of 100+col; V plane: 3x2 of 200+row.
        assert_eq!(&data[24..30], &[100, 101, 102, 100, 101, 102]);
        assert_eq!(&data[30..36], &[200, 200, 200, 201, 201, 201]);
    }

    #[test]
    fn i420_with_padding_and_an_odd_crop_repacks_evenly() {
        // 4-byte pitch, 4 rows; Y = 1, U = 2, V = 3.
        let mut buffer = vec![1u8; 16];
        buffer.extend(vec![2u8; 4]);
        buffer.extend(vec![3u8; 4]);
        let geometry = PlaneGeometry {
            layout: PlanarLayout::I420,
            pitch: 4,
            plane_rows: 4,
            crop_x: 0,
            crop_y: 0,
            crop_width: 3,
            crop_height: 4,
        };
        let (data, w, h) = repack_to_i420(&buffer, &geometry).unwrap();
        assert_eq!((w, h), (2, 4), "odd width rounds down to even");
        assert_eq!(data, vec![1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3]);
    }

    #[test]
    fn a_layout_that_does_not_fit_the_buffer_is_refused() {
        let geometry = PlaneGeometry {
            layout: PlanarLayout::Nv12,
            pitch: 8,
            plane_rows: 6,
            crop_x: 0,
            crop_y: 0,
            crop_width: 6,
            crop_height: 4,
        };
        assert!(repack_to_i420(&[0u8; 50], &geometry).is_err());
        let outside = PlaneGeometry {
            crop_width: 10,
            ..geometry
        };
        assert!(repack_to_i420(&nv12_frame(8, 6), &outside).is_err());
        let empty = PlaneGeometry {
            crop_width: 1,
            ..geometry
        };
        assert!(repack_to_i420(&nv12_frame(8, 6), &empty).is_err());
    }
}
