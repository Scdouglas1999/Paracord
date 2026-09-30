/**
 * Just enough of each codec's bitstream to put its frames in a container:
 * picture size (the container must state it), the codec configuration record
 * the container carries (AV1's `av1C`, H.264's `avcC`), and the framing each
 * container expects (AV1 without temporal delimiters, H.264 length-prefixed).
 *
 * Every parser here throws on a bitstream it cannot read. A clip is never
 * written with a guessed size or a made-up configuration.
 */

export class BitReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get bitsLeft(): number {
    return this.bytes.length * 8 - this.bit;
  }

  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (this.bit >= this.bytes.length * 8) throw new Error('The bitstream ended early.');
      const byte = this.bytes[this.bit >> 3];
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }

  flag(): boolean {
    return this.u(1) === 1;
  }

  skip(n: number): void {
    if (this.bit + n > this.bytes.length * 8) throw new Error('The bitstream ended early.');
    this.bit += n;
  }

  /** Exp-Golomb, unsigned (H.264 ue(v)). */
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw new Error('A malformed Exp-Golomb code.');
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  /** Exp-Golomb, signed (H.264 se(v)). */
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }

  /** AV1 uvlc(). */
  uvlc(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros >= 32) return 2 ** 32 - 1;
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }
}

export interface PictureSize {
  width: number;
  height: number;
}

/* ---- VP9 ------------------------------------------------------------------------ */

/**
 * The size a VP9 keyframe codes (VP9 bitstream spec §6.2, uncompressed header).
 * Throws when `frame` is not a keyframe.
 */
export function vp9KeyframeSize(frame: Uint8Array): PictureSize {
  const r = new BitReader(frame);
  if (r.u(2) !== 2) throw new Error('Not a VP9 frame (frame marker).');
  const profile = r.u(1) | (r.u(1) << 1);
  if (profile === 3) r.skip(1); // reserved_zero
  if (r.flag()) throw new Error('A VP9 show_existing_frame is not a keyframe.');
  if (r.u(1) !== 0) throw new Error('Not a VP9 keyframe.');
  r.skip(2); // show_frame, error_resilient_mode
  if (r.u(8) !== 0x49 || r.u(8) !== 0x83 || r.u(8) !== 0x42) throw new Error('A VP9 keyframe without its sync code.');
  // color_config()
  if (profile >= 2) r.skip(1); // ten_or_twelve_bit
  const colorSpace = r.u(3);
  if (colorSpace !== 7) {
    r.skip(1); // color_range
    if (profile === 1 || profile === 3) r.skip(3); // subsampling_x, subsampling_y, reserved_zero
  } else if (profile === 1 || profile === 3) {
    r.skip(1); // reserved_zero
  }
  const width = r.u(16) + 1;
  const height = r.u(16) + 1;
  return { width, height };
}

/* ---- AV1 ------------------------------------------------------------------------ */

export const AV1_OBU_SEQUENCE_HEADER = 1;
export const AV1_OBU_TEMPORAL_DELIMITER = 2;

export interface Av1Obu {
  type: number;
  /** The whole OBU, header included. */
  bytes: Uint8Array;
  /** The OBU's payload. */
  payload: Uint8Array;
}

function readLeb128(bytes: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if (offset + i >= bytes.length) throw new Error('An AV1 OBU size ran past the frame.');
    const byte = bytes[offset + i];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return { value, length: i + 1 };
  }
  throw new Error('An AV1 OBU size is too long.');
}

/** Split an AV1 temporal unit (low overhead bitstream format) into its OBUs. */
export function av1Obus(frame: Uint8Array): Av1Obu[] {
  const obus: Av1Obu[] = [];
  let offset = 0;
  while (offset < frame.length) {
    const header = frame[offset];
    if (header & 0x80) throw new Error('An AV1 OBU with the forbidden bit set.');
    const type = (header >> 3) & 0x0f;
    const hasExtension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    const headerLength = hasExtension ? 2 : 1;
    let payloadStart = offset + headerLength;
    let payloadLength: number;
    if (hasSize) {
      const size = readLeb128(frame, payloadStart);
      payloadStart += size.length;
      payloadLength = size.value;
    } else {
      payloadLength = frame.length - payloadStart;
    }
    const end = payloadStart + payloadLength;
    if (end > frame.length) throw new Error('An AV1 OBU ran past the frame.');
    obus.push({ type, bytes: frame.subarray(offset, end), payload: frame.subarray(payloadStart, end) });
    offset = end;
  }
  return obus;
}

/** A temporal unit without its temporal delimiter (Matroska's AV1 mapping §4.4). */
export function av1WithoutTemporalDelimiters(frame: Uint8Array): Uint8Array {
  const obus = av1Obus(frame);
  if (!obus.some((obu) => obu.type === AV1_OBU_TEMPORAL_DELIMITER)) return frame;
  const kept = obus.filter((obu) => obu.type !== AV1_OBU_TEMPORAL_DELIMITER);
  return concatBytes(kept.map((obu) => obu.bytes));
}

/** The sequence header OBU carried in a keyframe, or null when it carries none. */
export function av1SequenceHeaderObu(frame: Uint8Array): Uint8Array | null {
  return av1Obus(frame).find((obu) => obu.type === AV1_OBU_SEQUENCE_HEADER)?.bytes ?? null;
}

export interface Av1SequenceInfo extends PictureSize {
  seqProfile: number;
  seqLevelIdx0: number;
  seqTier0: number;
  highBitdepth: boolean;
  twelveBit: boolean;
  monochrome: boolean;
  chromaSubsamplingX: number;
  chromaSubsamplingY: number;
  chromaSamplePosition: number;
}

/** Parse a sequence header OBU (AV1 spec §5.5). */
export function parseAv1SequenceHeader(obu: Uint8Array): Av1SequenceInfo {
  const [parsed] = av1Obus(obu);
  if (!parsed || parsed.type !== AV1_OBU_SEQUENCE_HEADER) throw new Error('Not an AV1 sequence header OBU.');
  const r = new BitReader(parsed.payload);
  const seqProfile = r.u(3);
  r.skip(1); // still_picture
  const reducedStillPictureHeader = r.flag();
  let seqLevelIdx0 = 0;
  let seqTier0 = 0;
  let decoderModelInfoPresent = false;
  let bufferDelayLength = 0;
  if (reducedStillPictureHeader) {
    seqLevelIdx0 = r.u(5);
  } else {
    if (r.flag()) {
      // timing_info()
      r.skip(32); // num_units_in_display_tick
      r.skip(32); // time_scale
      if (r.flag()) r.uvlc(); // equal_picture_interval → num_ticks_per_picture_minus_1
      decoderModelInfoPresent = r.flag();
      if (decoderModelInfoPresent) {
        bufferDelayLength = r.u(5) + 1;
        r.skip(32); // num_units_in_decoding_tick
        r.skip(5); // buffer_removal_time_length_minus_1
        r.skip(5); // frame_presentation_time_length_minus_1
      }
    }
    const initialDisplayDelayPresent = r.flag();
    const operatingPoints = r.u(5) + 1;
    for (let i = 0; i < operatingPoints; i++) {
      r.skip(12); // operating_point_idc
      const level = r.u(5);
      const tier = level > 7 ? r.u(1) : 0;
      if (i === 0) {
        seqLevelIdx0 = level;
        seqTier0 = tier;
      }
      if (decoderModelInfoPresent && r.flag()) {
        r.skip(bufferDelayLength); // decoder_buffer_delay
        r.skip(bufferDelayLength); // encoder_buffer_delay
        r.skip(1); // low_delay_mode_flag
      }
      if (initialDisplayDelayPresent && r.flag()) r.skip(4);
    }
  }
  const widthBits = r.u(4) + 1;
  const heightBits = r.u(4) + 1;
  const width = r.u(widthBits) + 1;
  const height = r.u(heightBits) + 1;
  let frameIdNumbersPresent = false;
  if (!reducedStillPictureHeader) frameIdNumbersPresent = r.flag();
  if (frameIdNumbersPresent) r.skip(4 + 3); // delta_frame_id_length_minus_2, additional_frame_id_length_minus_1
  r.skip(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  if (!reducedStillPictureHeader) {
    r.skip(4); // enable_interintra_compound, enable_masked_compound, enable_warped_motion, enable_dual_filter
    const enableOrderHint = r.flag();
    if (enableOrderHint) r.skip(2); // enable_jnt_comp, enable_ref_frame_mvs
    const seqChooseScreenContentTools = r.flag();
    const seqForceScreenContentTools = seqChooseScreenContentTools ? 2 : r.u(1);
    if (seqForceScreenContentTools > 0) {
      if (!r.flag()) r.skip(1); // seq_choose_integer_mv / seq_force_integer_mv
    }
    if (enableOrderHint) r.skip(3); // order_hint_bits_minus_1
  }
  r.skip(3); // enable_superres, enable_cdef, enable_restoration
  // color_config()
  const highBitdepth = r.flag();
  let twelveBit = false;
  if (seqProfile === 2 && highBitdepth) twelveBit = r.flag();
  const monochrome = seqProfile === 1 ? false : r.flag();
  let colorPrimaries = 2;
  let transferCharacteristics = 2;
  let matrixCoefficients = 2;
  if (r.flag()) {
    colorPrimaries = r.u(8);
    transferCharacteristics = r.u(8);
    matrixCoefficients = r.u(8);
  }
  let chromaSubsamplingX = 1;
  let chromaSubsamplingY = 1;
  let chromaSamplePosition = 0;
  if (monochrome) {
    r.skip(1); // color_range
  } else if (colorPrimaries === 1 && transferCharacteristics === 13 && matrixCoefficients === 0) {
    chromaSubsamplingX = 0;
    chromaSubsamplingY = 0;
  } else {
    r.skip(1); // color_range
    if (seqProfile === 0) {
      chromaSubsamplingX = 1;
      chromaSubsamplingY = 1;
    } else if (seqProfile === 1) {
      chromaSubsamplingX = 0;
      chromaSubsamplingY = 0;
    } else if (twelveBit) {
      chromaSubsamplingX = r.u(1);
      chromaSubsamplingY = chromaSubsamplingX ? r.u(1) : 0;
    } else {
      chromaSubsamplingX = 1;
      chromaSubsamplingY = 0;
    }
    if (chromaSubsamplingX && chromaSubsamplingY) chromaSamplePosition = r.u(2);
  }
  return {
    width,
    height,
    seqProfile,
    seqLevelIdx0,
    seqTier0,
    highBitdepth,
    twelveBit,
    monochrome,
    chromaSubsamplingX,
    chromaSubsamplingY,
    chromaSamplePosition,
  };
}

/** The AV1CodecConfigurationRecord (`av1C`), with the sequence header as its config OBU. */
export function av1CodecConfigurationRecord(sequenceHeaderObu: Uint8Array): Uint8Array {
  const info = parseAv1SequenceHeader(sequenceHeaderObu);
  const record = new Uint8Array(4 + sequenceHeaderObu.length);
  record[0] = 0x81; // marker, version 1
  record[1] = (info.seqProfile << 5) | info.seqLevelIdx0;
  record[2] =
    (info.seqTier0 << 7) |
    (Number(info.highBitdepth) << 6) |
    (Number(info.twelveBit) << 5) |
    (Number(info.monochrome) << 4) |
    (info.chromaSubsamplingX << 3) |
    (info.chromaSubsamplingY << 2) |
    info.chromaSamplePosition;
  record[3] = 0; // no initial presentation delay
  record.set(sequenceHeaderObu, 4);
  return record;
}

/* ---- H.264 ---------------------------------------------------------------------- */

export const H264_NAL_SPS = 7;
export const H264_NAL_PPS = 8;
export const H264_NAL_AUD = 9;

/** Split an Annex B access unit into its NAL units (start codes removed). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: Array<{ at: number; length: number }> = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        starts.push({ at: i, length: 3 });
        i += 2;
      } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
        starts.push({ at: i, length: 4 });
        i += 3;
      }
    }
  }
  if (starts.length === 0) throw new Error('An H.264 frame without Annex B start codes.');
  const units: Uint8Array[] = [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s].at + starts[s].length;
    let end = s + 1 < starts.length ? starts[s + 1].at : data.length;
    // A 4-byte start code's leading zero belongs to the start code, not the unit before it.
    while (end > begin && data[end - 1] === 0 && s + 1 < starts.length) end--;
    if (end > begin) units.push(data.subarray(begin, end));
  }
  return units;
}

export function h264NalType(unit: Uint8Array): number {
  return unit[0] & 0x1f;
}

/** Remove emulation prevention bytes (00 00 03 → 00 00) to read a NAL's RBSP. */
export function unescapeRbsp(unit: Uint8Array): Uint8Array {
  const out = new Uint8Array(unit.length);
  let length = 0;
  let zeros = 0;
  for (let i = 0; i < unit.length; i++) {
    const byte = unit[i];
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[length++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

export interface H264SpsInfo extends PictureSize {
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  chromaFormatIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Parse a sequence parameter set NAL unit (H.264 §7.3.2.1.1). */
export function parseH264Sps(unit: Uint8Array): H264SpsInfo {
  if (h264NalType(unit) !== H264_NAL_SPS) throw new Error('Not an H.264 SPS.');
  const r = new BitReader(unescapeRbsp(unit.subarray(1)));
  const profileIdc = r.u(8);
  const constraintFlags = r.u(8);
  const levelIdc = r.u(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  let separateColourPlane = false;
  let bitDepthLumaMinus8 = 0;
  let bitDepthChromaMinus8 = 0;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.flag();
    bitDepthLumaMinus8 = r.ue();
    bitDepthChromaMinus8 = r.ue();
    r.skip(1); // qpprime_y_zero_transform_bypass_flag
    if (r.flag()) {
      const lists = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        if (r.flag()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.skip(1); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.skip(1); // gaps_in_frame_num_value_allowed_flag
  const widthInMbs = r.ue() + 1;
  const heightInMapUnits = r.ue() + 1;
  const frameMbsOnly = r.flag();
  if (!frameMbsOnly) r.skip(1); // mb_adaptive_frame_field_flag
  r.skip(1); // direct_8x8_inference_flag
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (r.flag()) {
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }
  const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
  const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
  const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
  const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
  const cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (frameMbsOnly ? 1 : 2);
  const width = widthInMbs * 16 - cropUnitX * (cropLeft + cropRight);
  const height = (frameMbsOnly ? 1 : 2) * heightInMapUnits * 16 - cropUnitY * (cropTop + cropBottom);
  if (width <= 0 || height <= 0) throw new Error('An H.264 SPS with no picture.');
  return { width, height, profileIdc, constraintFlags, levelIdc, chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8 };
}

/** The AVCDecoderConfigurationRecord (`avcC`, ISO/IEC 14496-15 §5.3.3.1). */
export function avcDecoderConfigurationRecord(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const info = parseH264Sps(sps);
  const high = HIGH_PROFILES.has(info.profileIdc);
  const record = new Uint8Array(11 + sps.length + pps.length + (high ? 4 : 0));
  let o = 0;
  record[o++] = 1; // configurationVersion
  record[o++] = sps[1]; // AVCProfileIndication
  record[o++] = sps[2]; // profile_compatibility
  record[o++] = sps[3]; // AVCLevelIndication
  record[o++] = 0xff; // lengthSizeMinusOne = 3
  record[o++] = 0xe1; // one SPS
  record[o++] = sps.length >> 8;
  record[o++] = sps.length & 0xff;
  record.set(sps, o);
  o += sps.length;
  record[o++] = 1; // one PPS
  record[o++] = pps.length >> 8;
  record[o++] = pps.length & 0xff;
  record.set(pps, o);
  o += pps.length;
  if (high) {
    record[o++] = 0xfc | info.chromaFormatIdc;
    record[o++] = 0xf8 | info.bitDepthLumaMinus8;
    record[o++] = 0xf8 | info.bitDepthChromaMinus8;
    record[o++] = 0; // numOfSequenceParameterSetExt
  }
  return record;
}

/** An Annex B access unit as 4-byte length-prefixed NAL units, without SPS, PPS or AUD. */
export function h264ToLengthPrefixed(data: Uint8Array): Uint8Array {
  const units = splitAnnexB(data).filter((unit) => {
    const type = h264NalType(unit);
    return type !== H264_NAL_SPS && type !== H264_NAL_PPS && type !== H264_NAL_AUD;
  });
  let length = 0;
  for (const unit of units) length += 4 + unit.length;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const unit of units) {
    view.setUint32(o, unit.length);
    out.set(unit, o + 4);
    o += 4 + unit.length;
  }
  return out;
}

/** The SPS and PPS a keyframe carries in band, or null when it lacks either. */
export function h264ParameterSets(keyframe: Uint8Array): { sps: Uint8Array; pps: Uint8Array } | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const unit of splitAnnexB(keyframe)) {
    const type = h264NalType(unit);
    if (type === H264_NAL_SPS && !sps) sps = unit;
    else if (type === H264_NAL_PPS && !pps) pps = unit;
  }
  return sps && pps ? { sps, pps } : null;
}

/* ---- Shared --------------------------------------------------------------------- */

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
