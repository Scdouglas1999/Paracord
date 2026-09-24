import { create } from 'zustand';
import type { NowPlayingSnapshot } from '../lib/nowPlaying';
import { registerSessionReset } from './sessionReset';

/** What the desktop app says about reading the system's media controls. */
export interface NowPlayingSupport {
  supported: boolean;
  /** Why not, ready to show as-is ("Not available on macOS yet."). */
  reason: string | null;
}

interface NowPlayingState {
  /** Null until the desktop app has been asked (and always in a browser). */
  support: NowPlayingSupport | null;
  /** The last reading while sharing is on. */
  current: NowPlayingSnapshot | null;
  /** Why sharing stopped or could not start. Cleared on the next good start. */
  error: string | null;
  setSupport: (support: NowPlayingSupport) => void;
  setCurrent: (current: NowPlayingSnapshot | null) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useNowPlayingStore = create<NowPlayingState>()((set) => ({
  support: null,
  current: null,
  error: null,
  setSupport: (support) => set({ support }),
  setCurrent: (current) => set({ current }),
  setError: (error) => set({ error }),
  reset: () => set({ support: null, current: null, error: null }),
}));

registerSessionReset('nowPlaying', () => useNowPlayingStore.getState().reset());
