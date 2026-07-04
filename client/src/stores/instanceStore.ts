import { create } from 'zustand';
import { instanceApi } from '../api/instance';
import { resolveActiveApiOrigin } from '../api/files';

interface InstanceState {
  /** Server-advertised max upload size (bytes), keyed by server origin. */
  maxUploadSizeByOrigin: Record<string, number>;
  /** Fetch and cache the active server's limits (no-op if already known). */
  fetchInstanceInfo: (force?: boolean) => Promise<void>;
  /** Convenience selector for the active server's limit, or null if unknown. */
  getActiveMaxUploadSize: () => number | null;
}

export const useInstanceStore = create<InstanceState>((set, get) => ({
  maxUploadSizeByOrigin: {},
  fetchInstanceInfo: async (force = false) => {
    const origin = resolveActiveApiOrigin();
    if (!origin) return;
    if (!force && get().maxUploadSizeByOrigin[origin] != null) return;
    try {
      const { data } = await instanceApi.getInstanceInfo();
      const size = data?.max_upload_size;
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
        set((s) => ({
          maxUploadSizeByOrigin: { ...s.maxUploadSizeByOrigin, [origin]: size },
        }));
      }
    } catch {
      // Leave unset; callers fall back to the client-side ceiling and the
      // server still enforces the real limit authoritatively.
    }
  },
  getActiveMaxUploadSize: () => {
    const origin = resolveActiveApiOrigin();
    return get().maxUploadSizeByOrigin[origin] ?? null;
  },
}));
