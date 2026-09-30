/**
 * The room's frames on the desktop app's native-surface route.
 *
 * There the native side decodes a stream and presents it on a platform surface
 * under (Linux) or over (macOS) the webview, and no frame ever reaches
 * JavaScript, so the engine's frame tap reports `native-surface` and delivers
 * nothing (WP-G6). The desktop shell keeps a tiny downsample of what each
 * native surface presents instead, taken only while somebody asks for it, and
 * `native_render_sample` hands it over: 32x18 RGB, a few kilobytes, a few times
 * a second. See `client/src-tauri/src/native_media/native_render/sample.rs`.
 *
 * `noSurface` means nothing on this device decodes that track natively right
 * now (the room is waiting for a surface or a sampler to be attached); it is
 * reported once, not papered over with another source.
 */
import type { MediaEngine } from '../media/mediaEngine';

export const NATIVE_SAMPLE_COMMAND = 'native_render_sample';

export type NativeSampleResponse =
  | { status: 'noSurface' }
  | { status: 'waiting' }
  | { status: 'sample'; width: number; height: number; seq: number; rgb: number[] };

export type NativeInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

const tauriInvoke: NativeInvoke = async (command, args) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
};

/** RGB triplets to an RGBA `ImageData` (opaque). */
export function rgbToImageData(rgb: ArrayLike<number>, width: number, height: number): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; o < rgba.length; i += 3, o += 4) {
    rgba[o] = rgb[i];
    rgba[o + 1] = rgb[i + 1];
    rgba[o + 2] = rgb[i + 2];
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

export interface NativeSamplingOptions {
  engine: MediaEngine;
  streamerId: string;
  hz: number;
  onFrame: (frame: ImageBitmap) => void;
  invoke?: NativeInvoke;
  toBitmap?: (data: ImageData) => Promise<ImageBitmap>;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/**
 * Poll the shell for the streamer's screen track at `hz` (at most 4). Returns a
 * stop function. An error from the shell (a surface kind it cannot sample) is
 * loud and ends the polling; it is never retried quietly.
 */
export function startNativeSampling(options: NativeSamplingOptions): () => void {
  const invoke = options.invoke ?? tauriInvoke;
  const toBitmap = options.toBitmap ?? ((data: ImageData) => createImageBitmap(data));
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const interval = 1000 / Math.max(0.1, Math.min(options.hz, 4));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSeq = -1;
  let reportedNoSurface = false;

  const poll = async (track: { streamId: string; trackId: string }) => {
    if (stopped) return;
    let response: NativeSampleResponse;
    try {
      response = (await invoke(NATIVE_SAMPLE_COMMAND, track)) as NativeSampleResponse;
    } catch (error) {
      console.error('[room] the desktop shell could not sample this stream; the room stays as it is', {
        ...track,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (stopped) return;
    if (response.status === 'sample' && response.seq !== lastSeq) {
      lastSeq = response.seq;
      const bitmap = await toBitmap(rgbToImageData(response.rgb, response.width, response.height));
      if (stopped) bitmap.close();
      else options.onFrame(bitmap);
    } else if (response.status === 'noSurface' && !reportedNoSurface) {
      reportedNoSurface = true;
      console.info('[room] nothing on this device decodes the stream natively yet; the room waits for it', track);
    }
    timer = schedule(() => void poll(track), interval);
  };

  void options.engine
    .listPublishedTracks()
    .then((tracks) => {
      if (stopped) return;
      const track = tracks.find(
        (candidate) =>
          String(candidate.publisherUserId) === options.streamerId && candidate.trackId === 'screen',
      );
      if (!track) {
        console.error('[room] the native route named a stream this engine does not list', {
          streamerId: options.streamerId,
        });
        return;
      }
      void poll({ streamId: track.streamId, trackId: track.trackId });
    })
    .catch((error: unknown) => {
      console.error('[room] could not list the published tracks for native sampling', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
