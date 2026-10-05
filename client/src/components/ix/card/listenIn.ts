import { useEffect } from 'react';
import { create } from 'zustand';

import { voiceApi } from '../../../api/voice';
import { logVoiceDiagnostic } from '../../../lib/desktopDiagnostics';
import { OlderServerError, useServerFeatureStore, useServerLacks } from '../../../lib/serverFeatures';

/**
 * Whether a room admits listeners (its `listen_in_enabled` feature setting,
 * glass-spec §7): the card's Listen control is absent where it does not
 * (index-spec §4.3). The channel object does not carry it, so the card asks
 * the server once per room per session (`GET /channels/{id}/features`).
 *
 * Until the answer comes the control is not drawn (it would only flicker away).
 * A server from before listening in has no such setting, and no listening in:
 * the control is never drawn for any of its rooms (`lib/serverFeatures.ts`).
 * If the server cannot say, the control is drawn: pressing it asks the server,
 * which refuses out loud when listening in is off (`pillActions.toggleListen`
 * reports the refusal and blocks the control), so nothing degrades in silence.
 */

type Answer = boolean | 'unknown';

interface ListenInState {
  /** `serverId:channelId` -> allowed, or 'unknown' when the server could not say. */
  allowed: Record<string, Answer>;
  set: (key: string, answer: Answer) => void;
}

const useListenInStore = create<ListenInState>()((set) => ({
  allowed: {},
  set: (key, answer) => set((state) => ({ allowed: { ...state.allowed, [key]: answer } })),
}));

const asking = new Set<string>();

/**
 * True when the Listen control should be drawn for this room, false when it
 * should not (listening in is off, or the answer has not come yet). `ask` false
 * skips the request (DMs, stage channels, or a card that does not offer Listen).
 */
export function useListenInAllowed(serverId: string, channelId: string, ask: boolean): boolean {
  const key = `${serverId}:${channelId}`;
  const answer = useListenInStore((state) => state.allowed[key]);
  const olderServer = useServerLacks(serverId, 'listenIn');
  useEffect(() => {
    if (!ask || olderServer || answer !== undefined || asking.has(key)) return;
    asking.add(key);
    voiceApi
      .getListenIn(channelId)
      .then((allowed) => useListenInStore.getState().set(key, allowed))
      .catch((error: unknown) => {
        if (error instanceof OlderServerError) {
          useServerFeatureStore.getState().markMissing(serverId, 'listenIn');
          useListenInStore.getState().set(key, false);
          return;
        }
        logVoiceDiagnostic('[ix-card] listen-in setting unavailable', { channelId, error: String(error) });
        useListenInStore.getState().set(key, 'unknown');
      })
      .finally(() => asking.delete(key));
  }, [ask, olderServer, answer, key, channelId, serverId]);
  if (!ask || olderServer) return false;
  return answer === true || answer === 'unknown';
}

/** For tests. */
export function resetListenInForTests(): void {
  asking.clear();
  useListenInStore.setState({ allowed: {} });
}
