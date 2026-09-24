import { useEffect } from 'react';
import { isTauri } from '../lib/tauriEnv';
import { useNowPlayingStore, type NowPlayingSupport } from '../stores/nowPlayingStore';

export const NOW_PLAYING_BROWSER_SUPPORT: NowPlayingSupport = {
  supported: false,
  reason: 'Not available in the browser. The Paracord desktop app on Windows and Linux can share it.',
};

/**
 * Whether this client can read the system's media controls. The browser never
 * can; the desktop app answers for its platform (macOS: not yet).
 */
export function useNowPlayingSupport(): NowPlayingSupport | null {
  const support = useNowPlayingStore((state) => state.support);
  const tauri = isTauri();

  useEffect(() => {
    if (!tauri || support) return;
    let canceled = false;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<NowPlayingSupport>('now_playing_support'))
      .then((answer) => {
        if (!canceled) useNowPlayingStore.getState().setSupport(answer);
      })
      .catch((err) => {
        if (!canceled) {
          useNowPlayingStore.getState().setSupport({
            supported: false,
            reason: `The desktop app did not answer: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    return () => {
      canceled = true;
    };
  }, [tauri, support]);

  return tauri ? support : NOW_PLAYING_BROWSER_SUPPORT;
}
