/**
 * Stills of a natively drawn video (the desktop app; docs/glass-spec.md §2).
 *
 * In the desktop app no frame of a remote video reaches the page: the native
 * side decodes it and draws it under the webview. Everything in the page that
 * wants a picture of it (the room light, the stage's glow, the call pill's
 * preview, a tile's poster, a clip's thumbnail) asks the shell for a still
 * instead: `native_render_still`, the latest frame its surface presented,
 * scaled to fit the size asked for, as binary RGBA. See
 * `client/src-tauri/src/native_media/native_render/still.rs` for the layout.
 */

export const NATIVE_STILL_COMMAND = 'native_render_still';

const HEADER = 20;

export type NativeStill =
  /** Nothing on this device decodes the track (no surface, no sampler). */
  | { status: 'no-surface' }
  /** Bound, but no frame has been presented yet. */
  | { status: 'waiting' }
  /** The latest copy is the one asked about (`afterSeq`). */
  | { status: 'unchanged' }
  | { status: 'still'; width: number; height: number; seq: number; rgba: Uint8ClampedArray };

function bytesOf(raw: unknown): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  // The postMessage IPC transport encodes a binary response as a JSON number
  // array. Slower, still correct.
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error(`native_render_still answered with ${typeof raw}, not bytes`);
}

/** Read the shell's answer. A malformed one is an error, never a blank still. */
export function parseNativeStill(raw: unknown): NativeStill {
  const bytes = bytesOf(raw);
  if (bytes.length < 1) throw new Error('native_render_still answered with no bytes');
  switch (bytes[0]) {
    case 0:
      return { status: 'no-surface' };
    case 1:
      return { status: 'waiting' };
    case 3:
      return { status: 'unchanged' };
    case 2: {
      if (bytes.length < HEADER) throw new Error('native_render_still header is truncated');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(4, true);
      const height = view.getUint32(8, true);
      const seq = Number(view.getBigUint64(12, true));
      const length = width * height * 4;
      if (width === 0 || height === 0 || bytes.length < HEADER + length) {
        throw new Error(`native_render_still is ${bytes.length} bytes for a ${width}x${height} still`);
      }
      const rgba = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + HEADER, length);
      return { status: 'still', width, height, seq, rgba };
    }
    default:
      throw new Error(`native_render_still answered with status ${bytes[0]}`);
  }
}

/** A still as an `ImageBitmap` the caller owns and must `close()`. */
export function nativeStillBitmap(still: { width: number; height: number; rgba: Uint8ClampedArray }): Promise<ImageBitmap> {
  // ImageData wants its own buffer when the bytes are a view into a bigger one.
  const data =
    still.rgba.byteOffset === 0 && still.rgba.byteLength === still.rgba.buffer.byteLength
      ? still.rgba
      : new Uint8ClampedArray(still.rgba);
  return createImageBitmap(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, still.width, still.height));
}
