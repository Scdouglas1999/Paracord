import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

import { extractApiError } from '../../../api/client';
import { stageApi, type StageInstance } from '../../../api/stage';
import { registerSessionReset } from '../../../stores/sessionReset';

/**
 * A stage channel's session (type 13; docs/design/glass-plan.md §8.4: "stage
 * channels use the stage look"). The instance, its topic, and what moderators
 * and the audience can do with it: open, retitle and end it, invite someone to
 * speak or move them back to the audience, answer a raised hand, and raise or
 * lower your own.
 *
 * Moved here from the Lantern voice page (`VoiceStageChannel`), with the same
 * requests and the same rules. One store for the app, keyed by channel, so the
 * channel's panel (`StageChannelPanel`, on the channel's chat) and the stage's
 * control row read one instance and one request instead of each asking the
 * server. `paracord:stage-instance-changed` (gateway/dispatch.ts) refreshes it.
 */

export interface StageChannelState {
  instance: StageInstance | null;
  /** Asked the server and not answered yet. */
  loading: boolean;
  /** A change is on its way (open, save, end, invite, move). */
  busy: boolean;
  /** Your raised hand is being raised or lowered, or a request answered. */
  requestBusy: boolean;
  /** What the server said went wrong, in its words. */
  error: string | null;
}

const EMPTY: StageChannelState = { instance: null, loading: false, busy: false, requestBusy: false, error: null };

interface StageChannelStore {
  byChannel: Record<string, StageChannelState>;
  patch: (channelId: string, patch: Partial<StageChannelState>) => void;
  reset: () => void;
}

export const useStageChannelStore = create<StageChannelStore>()((set) => ({
  byChannel: {},
  patch: (channelId, patch) =>
    set((state) => ({
      byChannel: { ...state.byChannel, [channelId]: { ...(state.byChannel[channelId] ?? EMPTY), ...patch } },
    })),
  reset: () => set({ byChannel: {} }),
}));

registerSessionReset('stage-channels', () => useStageChannelStore.getState().reset());

const inflight = new Map<string, Promise<void>>();

const status = (error: unknown) => (error as { response?: { status?: number } }).response?.status;

/** Ask the server for the channel's stage session. A 404 is "nobody has opened it". */
export function refreshStageChannel(channelId: string): Promise<void> {
  const running = inflight.get(channelId);
  if (running) return running;
  const { patch } = useStageChannelStore.getState();
  patch(channelId, { loading: true });
  const request = stageApi
    .getForChannel(channelId)
    .then(({ data }) => patch(channelId, { instance: data, error: null }))
    .catch((error: unknown) => {
      if (status(error) === 404) patch(channelId, { instance: null, error: null });
      else patch(channelId, { error: extractApiError(error) });
    })
    .finally(() => {
      inflight.delete(channelId);
      useStageChannelStore.getState().patch(channelId, { loading: false });
    });
  inflight.set(channelId, request);
  return request;
}

async function run(
  channelId: string,
  flag: 'busy' | 'requestBusy',
  work: (instance: StageInstance | null) => Promise<unknown>,
  refresh = true,
): Promise<void> {
  const { patch } = useStageChannelStore.getState();
  const instance = useStageChannelStore.getState().byChannel[channelId]?.instance ?? null;
  patch(channelId, { [flag]: true, error: null });
  try {
    await work(instance);
    if (refresh) await refreshStageChannel(channelId);
  } catch (error) {
    patch(channelId, { error: extractApiError(error) });
  } finally {
    useStageChannelStore.getState().patch(channelId, { [flag]: false });
  }
}

export interface StageChannelActions {
  /** Open the stage, with `topic` (or the channel's name when empty). */
  open: (topic: string, channelName: string) => void;
  saveTopic: (topic: string) => void;
  end: () => void;
  inviteSpeaker: (userId: string) => void;
  moveToAudience: (userId: string) => void;
  /** Raise your hand, or lower it when `raised`. */
  toggleRequest: (raised: boolean) => void;
  dismissRequest: (userId: string) => void;
}

/**
 * The stage session of `channelId` (null: not a stage channel, nothing is
 * fetched), kept fresh while mounted.
 */
export function useStageChannel(channelId: string | null): StageChannelState & StageChannelActions {
  const state = useStageChannelStore((store) => (channelId ? store.byChannel[channelId] ?? EMPTY : EMPTY));

  useEffect(() => {
    if (!channelId) return undefined;
    void refreshStageChannel(channelId);
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ channel_id?: string }>).detail;
      if (detail?.channel_id && detail.channel_id !== channelId) return;
      void refreshStageChannel(channelId);
    };
    window.addEventListener('paracord:stage-instance-changed', onChanged);
    return () => window.removeEventListener('paracord:stage-instance-changed', onChanged);
  }, [channelId]);

  const open = useCallback(
    (topic: string, channelName: string) => {
      if (!channelId) return;
      void run(channelId, 'busy', () =>
        stageApi.create({ channel_id: channelId, topic: topic.trim() || channelName, privacy_level: 2 }),
      );
    },
    [channelId],
  );
  const saveTopic = useCallback(
    (topic: string) => {
      if (!channelId) return;
      void run(channelId, 'busy', (instance) =>
        instance
          ? stageApi.update(instance.id, { topic: topic.trim(), privacy_level: instance.privacy_level })
          : Promise.resolve(),
      );
    },
    [channelId],
  );
  const end = useCallback(() => {
    if (!channelId) return;
    void run(channelId, 'busy', (instance) => (instance ? stageApi.remove(instance.id) : Promise.resolve()));
  }, [channelId]);
  const inviteSpeaker = useCallback(
    (userId: string) => {
      if (!channelId) return;
      void run(channelId, 'busy', (instance) => (instance ? stageApi.inviteSpeaker(instance.id, userId) : Promise.resolve()), false);
    },
    [channelId],
  );
  const moveToAudience = useCallback(
    (userId: string) => {
      if (!channelId) return;
      void run(channelId, 'busy', (instance) => (instance ? stageApi.removeSpeaker(instance.id, userId) : Promise.resolve()), false);
    },
    [channelId],
  );
  const toggleRequest = useCallback(
    (raised: boolean) => {
      if (!channelId) return;
      void run(
        channelId,
        'requestBusy',
        (instance) =>
          instance
            ? raised
              ? stageApi.cancelSpeakerRequest(instance.id)
              : stageApi.requestToSpeak(instance.id)
            : Promise.resolve(),
        false,
      );
    },
    [channelId],
  );
  const dismissRequest = useCallback(
    (userId: string) => {
      if (!channelId) return;
      void run(channelId, 'requestBusy', (instance) =>
        instance ? stageApi.dismissSpeakerRequest(instance.id, userId) : Promise.resolve(), false);
    },
    [channelId],
  );

  return { ...state, open, saveTopic, end, inviteSpeaker, moveToAudience, toggleRequest, dismissRequest };
}
