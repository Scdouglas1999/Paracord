import { useEffect } from 'react';
import { isTauri } from '../lib/tauriEnv';
import {
  NOW_PLAYING_SETTING_KEY,
  NowPlayingPublisher,
  type NowPlayingSnapshot,
} from '../lib/nowPlaying';
import { setActivitySource } from '../lib/presenceActivities';
import { useAuthStore } from '../stores/authStore';
import { useNowPlayingStore, type NowPlayingSupport } from '../stores/nowPlayingStore';
import { toast } from '../stores/toastStore';

export const NOW_PLAYING_CHANGED_EVENT = 'now_playing_changed';
export const NOW_PLAYING_FAILED_EVENT = 'now_playing_failed';

/** Whether the saved settings have "Share what I'm listening to" on. Off unless set. */
export function nowPlayingSharingEnabled(
  notifications: Record<string, unknown> | null | undefined,
): boolean {
  return notifications?.[NOW_PLAYING_SETTING_KEY] === true;
}

/**
 * Start and stop calls run one after another, in the order they were made, so
 * turning the setting off and on quickly can never leave a late `stop` from
 * the first round killing the second round's reader.
 */
let nativeQueue: Promise<unknown> = Promise.resolve();
function queueNative<T>(call: () => Promise<T>): Promise<T> {
  const next = nativeQueue.then(call, call);
  nativeQueue = next.catch(() => undefined);
  return next;
}

async function invokeNative<T>(command: string): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command);
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * While "Share what I'm listening to" is on (desktop app only), read the
 * system's media controls and keep a "Listening to" activity on your presence.
 * The native reader runs only while the setting is on.
 */
export function useNowPlayingPresence(): void {
  const token = useAuthStore((state) => state.token);
  const enabled = useAuthStore((state) =>
    nowPlayingSharingEnabled(state.settings?.notifications as Record<string, unknown> | undefined),
  );

  useEffect(() => {
    if (!token || !enabled || !isTauri()) {
      setActivitySource('listening', null);
      return;
    }

    let cancelled = false;
    const unlisten: Array<() => void> = [];
    // A listener that finished registering after cleanup ran is dropped at once.
    const keep = (stop: () => void) => {
      if (cancelled) stop();
      else unlisten.push(stop);
    };
    const store = useNowPlayingStore.getState();
    const publisher = new NowPlayingPublisher((activity) => {
      if (!cancelled) setActivitySource('listening', activity);
    });

    const fail = (message: string) => {
      publisher.update(null);
      setActivitySource('listening', null);
      store.setCurrent(null);
      store.setError(message);
      toast.error(`Stopped sharing what you're listening to. ${message}`);
    };

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const support = await invokeNative<NowPlayingSupport>('now_playing_support');
      if (cancelled) return;
      store.setSupport(support);
      if (!support.supported) return;

      // Listen before starting: the reader sends what is playing right away.
      keep(
        await listen<NowPlayingSnapshot | null>(NOW_PLAYING_CHANGED_EVENT, (event) => {
          if (cancelled) return;
          store.setCurrent(event.payload);
          publisher.update(event.payload);
        }),
      );
      keep(
        await listen<string>(NOW_PLAYING_FAILED_EVENT, (event) => {
          if (!cancelled) fail(event.payload);
        }),
      );
      if (cancelled) return;
      try {
        await queueNative(() => invokeNative('now_playing_start'));
        if (!cancelled) store.setError(null);
      } catch (err) {
        if (!cancelled) fail(errorText(err));
      }
    })().catch((err) => {
      if (!cancelled) fail(errorText(err));
    });

    return () => {
      cancelled = true;
      publisher.dispose();
      for (const stop of unlisten) stop();
      // Queued behind this round's start, so it always lands after it.
      void queueNative(() => invokeNative('now_playing_stop')).catch(() => undefined);
      // Off means off right away: no debounce on taking it down.
      setActivitySource('listening', null);
      useNowPlayingStore.getState().setCurrent(null);
    };
  }, [token, enabled]);
}
