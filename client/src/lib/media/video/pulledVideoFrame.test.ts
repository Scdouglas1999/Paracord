import { describe, expect, it } from 'vitest';
import {
  PULLED_VIDEO_FRAME_HEADER_SIZE,
  convertI420ToRgba,
  parsePulledVideoFrameBinary,
} from './pulledVideoFrame';

function packTestFrame(
  sequence: number,
  timestampUs: number,
  isKeyframe: boolean,
  formatTag: number,
  codecTag: number,
  width: number,
  height: number,
  payload: number[],
  colorspaceTag = 0,
): Uint8Array {
  const buf = new Uint8Array(PULLED_VIDEO_FRAME_HEADER_SIZE + payload.length);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(sequence), true);
  view.setBigUint64(8, BigInt(timestampUs), true);
  view.setUint8(16, isKeyframe ? 1 : 0);
  view.setUint8(17, formatTag);
  view.setUint8(18, codecTag);
  view.setUint8(19, colorspaceTag);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  buf.set(payload, PULLED_VIDEO_FRAME_HEADER_SIZE);
  return buf;
}

describe('parsePulledVideoFrameBinary', () => {
  it('parses i420 metadata and payload', () => {
    const packed = packTestFrame(7, 42_000, true, 0, 1, 2, 2, [16, 16, 16, 16, 128, 128]);
    const parsed = parsePulledVideoFrameBinary(packed);
    expect(parsed).not.toBeNull();
    expect(parsed?.sequence).toBe(7);
    expect(parsed?.timestampUs).toBe(42_000);
    expect(parsed?.isKeyframe).toBe(true);
    expect(parsed?.format).toBe('i420');
    expect(parsed?.codec).toBe('vp9');
    expect(parsed?.width).toBe(2);
    expect(parsed?.height).toBe(2);
    expect(Array.from(parsed?.data ?? [])).toEqual([16, 16, 16, 16, 128, 128]);
  });

  it('parses the colorspace tag at offset 19 (0=BT.601, 1=BT.709)', () => {
    const bt601 = parsePulledVideoFrameBinary(packTestFrame(1, 0, true, 0, 1, 2, 2, [16, 16, 16, 16, 128, 128], 0));
    expect(bt601?.colorspace).toBe('bt601');
    const bt709 = parsePulledVideoFrameBinary(packTestFrame(1, 0, true, 0, 1, 2, 2, [16, 16, 16, 16, 128, 128], 1));
    expect(bt709?.colorspace).toBe('bt709');
  });
});

describe('convertI420ToRgba', () => {
  it('produces opaque RGBA for a 2x2 frame', () => {
    const rgba = convertI420ToRgba(new Uint8Array([16, 16, 16, 16, 128, 128]), 2, 2);
    expect(rgba.length).toBe(16);
    expect(rgba[3]).toBe(255);
    expect(rgba[7]).toBe(255);
  });

  it('applies different chroma coefficients for BT.601 vs BT.709', () => {
    // A non-neutral chroma sample exposes the coefficient difference between the
    // two matrices (contract C1); a neutral U=V=128 frame would be identical.
    const planes = new Uint8Array([200, 200, 200, 200, 60, 200]);
    const bt601 = convertI420ToRgba(planes, 2, 2, 'bt601');
    const bt709 = convertI420ToRgba(planes, 2, 2, 'bt709');
    expect(Array.from(bt601.slice(0, 3))).not.toEqual(Array.from(bt709.slice(0, 3)));
  });
});
