/**
 * `livekit-client`, loaded when a call actually needs it.
 *
 * LiveKit is no longer the media path: native QUIC carries every call, and a
 * LiveKit room is only ever built when a server offers nothing else. The
 * library is ~430 KiB of minified JavaScript, and it used to be imported
 * statically by the voice store — which is part of the startup bundle — so
 * every launch downloaded, parsed and compiled it before the first paint.
 *
 * Now the voice store loads it on the one path that builds a LiveKit room
 * ({@link loadLivekit}), and everything that touches a LiveKit object reads it
 * synchronously with {@link livekit}. A LiveKit object can only exist after the
 * load (the only constructor is behind it), so a synchronous read that finds
 * nothing loaded is a bug and says so.
 */
import type * as Livekit from 'livekit-client';

export type LivekitModule = typeof Livekit;

let loaded: LivekitModule | null = null;
let loading: Promise<LivekitModule> | null = null;

/** Load `livekit-client` (once). A failed load can be retried. */
export function loadLivekit(): Promise<LivekitModule> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import('livekit-client').then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The loaded library. Only callable where a LiveKit room already exists. */
export function livekit(): LivekitModule {
  if (!loaded) {
    throw new Error('livekit-client was used before it was loaded; a LiveKit call can only exist after loadLivekit().');
  }
  return loaded;
}
