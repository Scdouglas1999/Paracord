import { create } from 'zustand';

/**
 * The size of the screen (or window) this app is sharing, as the native
 * encoder last configured for it (`media_screen_share_source`); null when not
 * sharing or not yet known. The share menu reads it to say which presets send
 * the same picture on the shared screen.
 */
export interface ShareSourceSize {
  width: number;
  height: number;
}

export const useShareSourceStore = create<{
  size: ShareSourceSize | null;
  setSize: (size: ShareSourceSize | null) => void;
}>()((set) => ({
  size: null,
  setSize: (size) => set({ size }),
}));

/** Read a `media_screen_share_source` payload; null for anything malformed. */
export function readShareSourceSize(payload: unknown): ShareSourceSize | null {
  const value = payload as { width?: unknown; height?: unknown } | null;
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.floor(width), height: Math.floor(height) };
}
