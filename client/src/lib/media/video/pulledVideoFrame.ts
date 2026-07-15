export const PULLED_VIDEO_FRAME_HEADER_SIZE = 28;

const FORMAT_TAGS = ['i420', 'vp9', 'h264', 'av1', 'raw', 'bgra', 'rgba'] as const;
const CODEC_TAGS = ['', 'vp9', 'h264', 'av1', 'raw'] as const;

export type PulledVideoFrameFormat = (typeof FORMAT_TAGS)[number];
export type PulledVideoCodecTag = (typeof CODEC_TAGS)[number];

/** Signaled YUV<->RGB matrix for a frame (contract C1). Header byte offset 19:
 * 0 = BT.601 limited-range, 1 = BT.709 limited-range. Default BT.709. */
export type FrameColorSpace = 'bt601' | 'bt709';

function tagToColorSpace(tag: number): FrameColorSpace {
  return tag === 0 ? 'bt601' : 'bt709';
}

export interface ParsedPulledVideoFrame {
  sequence: number;
  timestampUs: number;
  isKeyframe: boolean;
  format: PulledVideoFrameFormat;
  codec: PulledVideoCodecTag | string;
  colorspace: FrameColorSpace;
  width: number;
  height: number;
  data: Uint8Array;
}

function tagToFormat(tag: number): PulledVideoFrameFormat {
  return FORMAT_TAGS[tag] ?? 'raw';
}

function tagToCodec(tag: number): PulledVideoCodecTag | string {
  return CODEC_TAGS[tag] ?? 'vp9';
}

/** Parse a packed binary frame pushed over a video subscription channel. */
export function parsePulledVideoFrameBinary(
  buffer: ArrayBuffer | Uint8Array,
): ParsedPulledVideoFrame | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < PULLED_VIDEO_FRAME_HEADER_SIZE) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sequence = Number(view.getBigUint64(0, true));
  const timestampUs = Number(view.getBigUint64(8, true));
  const isKeyframe = view.getUint8(16) !== 0;
  const format = tagToFormat(view.getUint8(17));
  const codec = tagToCodec(view.getUint8(18));
  const colorspace = tagToColorSpace(view.getUint8(19));
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const data = bytes.subarray(PULLED_VIDEO_FRAME_HEADER_SIZE);
  return {
    sequence,
    timestampUs,
    isKeyframe,
    format,
    codec,
    colorspace,
    width,
    height,
    data,
  };
}

/** Per-colorspace limited-range chroma coefficients (Y luma scale 1.164 and the
 * 16/128 offsets are shared). Kept in sync with the WebGL YUV shader. */
export const YUV_COEFFS: Record<FrameColorSpace, { rv: number; gu: number; gv: number; bu: number }> = {
  bt601: { rv: 1.596, gu: 0.391, gv: 0.813, bu: 2.018 },
  bt709: { rv: 1.793, gu: 0.213, gv: 0.533, bu: 2.112 },
};

/** Limited-range YUV -> RGBA CPU fallback. Defaults to BT.709 (contract C1);
 * pass the frame's signaled colorspace so the CPU path matches the GPU shader. */
export function convertI420ToRgba(
  data: Uint8Array,
  width: number,
  height: number,
  colorspace: FrameColorSpace = 'bt709',
): Uint8ClampedArray {
  const chromaWidth = width >> 1;
  const chromaHeight = height >> 1;
  const ySize = width * height;
  const chromaSize = chromaWidth * chromaHeight;
  if (data.length < ySize + chromaSize * 2) {
    return new Uint8ClampedArray(0);
  }

  const uOffset = ySize;
  const vOffset = ySize + chromaSize;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const { rv, gu, gv, bu } = YUV_COEFFS[colorspace];

  for (let row = 0; row < height; row += 1) {
    const yRow = row * width;
    const chromaRow = (row >> 1) * chromaWidth;
    for (let col = 0; col < width; col += 1) {
      const y = data[yRow + col];
      const chromaIndex = chromaRow + (col >> 1);
      const u = data[uOffset + chromaIndex] - 128;
      const v = data[vOffset + chromaIndex] - 128;

      const c = (y - 16) * 1.164;
      const r = c + rv * v;
      const g = c - gu * u - gv * v;
      const b = c + bu * u;

      const outIndex = (yRow + col) * 4;
      rgba[outIndex] = r;
      rgba[outIndex + 1] = g;
      rgba[outIndex + 2] = b;
      rgba[outIndex + 3] = 255;
    }
  }

  return rgba;
}
