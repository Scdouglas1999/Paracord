/**
 * Where this client's clip ring lives, decided once by the runtime exactly as
 * `createMediaEngine` decides the engine: the desktop app (Tauri) keeps it in
 * the native process, a browser keeps it in `clipIntake`. One path per
 * runtime; neither stands in for the other.
 */
import type { MediaEngine } from '../mediaEngine';
import type { ClipCapture } from './clipRing';
import { armBrowserClip, cutBrowserClip, disarmBrowserClip } from './clipIntake';
import { createNativeClipSource } from './nativeClipSource';

export interface ClipSource {
  readonly kind: 'native' | 'browser';
  /** Keep `streamerId`'s screen share as `engine` receives it. */
  arm(engine: MediaEngine, streamerId: string): Promise<void>;
  /** Stop, and free everything kept. */
  disarm(): Promise<void>;
  cut(): Promise<ClipCapture>;
}

/** The same test `createMediaEngine` makes (lib/media/mediaEngine.ts). */
function desktopRuntime(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

const browserSource: ClipSource = {
  kind: 'browser',
  arm: async (engine, streamerId) => armBrowserClip(engine, streamerId),
  disarm: async () => disarmBrowserClip(),
  cut: async () => cutBrowserClip(),
};

let nativeSource: ClipSource | null = null;

export function clipSourceForRuntime(): ClipSource {
  if (!desktopRuntime()) return browserSource;
  if (!nativeSource) {
    const native = createNativeClipSource();
    nativeSource = {
      kind: 'native',
      // The native ring follows the sharer, not a connection: the stream keeps
      // its ring when the watch moves into or out of the call.
      arm: (_engine, streamerId) => native.arm(streamerId),
      disarm: native.disarm,
      cut: native.cut,
    };
  }
  return nativeSource;
}
