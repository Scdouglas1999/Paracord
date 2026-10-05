import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';

import { useAuthStore } from '../stores/authStore';
import { registerSessionReset } from '../stores/sessionReset';
import { useVoiceStore } from '../stores/voiceStore';
import { useCurrentChannelStore } from './useChannels';
import { displayName } from '../lib/displayName';

/**
 * Somebody started a direct-message call you are not in.
 *
 * The server already tells every DM recipient when a call starts and ends —
 * `VOICE_STATE_UPDATE` with no `guild_id`, addressed to the recipients
 * (`routes/dms.rs`). The client filed those states away in
 * `voiceStore.channelParticipants` and reacted to them only if you were
 * *already* in the call, so a callee's window showed nothing at all: no ring,
 * no answer, no decline. This turns the states the client already has into the
 * one fact the callee needs.
 *
 * Rules this encodes:
 *  - A DM voice state carries no `guild_id`, and channel ids are only unique
 *    per server, so a colliding guild room can never be read as a DM call.
 *  - A call you are already in is not incoming, and neither is one you are the
 *    only participant of.
 *  - Declining is a local dismissal, nothing more: no new server semantics, and
 *    the caller is never told. It is forgotten when that call ends, so the next
 *    call from the same person rings again.
 */
export interface IncomingDmCall {
  channelId: string;
  /** "Ada", or "Ada, Grace" for a group. */
  callerName: string;
  /** How many people are on the call. */
  participantCount: number;
}

/**
 * The calls declined in this window, shared by every place that rings (the
 * pinned card on the root, the call strip on a phone's pushed page): a decline
 * in one silences the other.
 */
const useDeclinedStore = create<{ declined: string[]; set: (declined: string[]) => void }>()((set) => ({
  declined: [],
  set: (declined) => set({ declined }),
}));

registerSessionReset('incoming-dm-declined', () => useDeclinedStore.getState().set([]));

/** Forget every decline (a new session; tests). */
export function forgetDeclinedCalls(): void {
  useDeclinedStore.getState().set([]);
}

export interface IncomingDmCallState {
  call: IncomingDmCall | null;
  decline: () => void;
}

export function useIncomingDmCall(): IncomingDmCallState {
  const channelParticipants = useVoiceStore((state) => state.channelParticipants);
  const connectedChannelId = useVoiceStore((state) => state.channelId);
  const joiningChannelId = useVoiceStore((state) => state.joiningChannelId);
  const selfUserId = useAuthStore((state) => state.user?.id ?? null);
  const dmChannels = useCurrentChannelStore((view) => view.channelsById);
  const declined = useDeclinedStore((state) => state.declined);

  const call = useMemo<IncomingDmCall | null>(() => {
    if (!selfUserId) return null;
    for (const [channelId, states] of channelParticipants) {
      if (channelId === connectedChannelId || channelId === joiningChannelId) continue;
      const channel = dmChannels[channelId];
      // A conversation this account is not a recipient of, or a guild room that
      // merely shares a snowflake with one, is not a call for this window.
      if (!channel || channel.guild_id) continue;
      const others = states.filter((state) => !state.guild_id && state.user_id !== selfUserId);
      if (others.length === 0) continue;
      if (declined.includes(channelId)) continue;
      return {
        channelId,
        callerName: others.map((state) => displayName(state)).join(', '),
        participantCount: others.length + (states.some((state) => state.user_id === selfUserId) ? 1 : 0),
      };
    }
    return null;
  }, [channelParticipants, connectedChannelId, joiningChannelId, dmChannels, selfUserId, declined]);

  const decline = useCallback(() => {
    const channelId = call?.channelId;
    if (!channelId) return;
    const current = useDeclinedStore.getState().declined;
    if (!current.includes(channelId)) useDeclinedStore.getState().set([...current, channelId]);
  }, [call?.channelId]);

  // Forget a decline once that call is over, so the next one rings again.
  const live = useMemo(() => {
    const ids = new Set<string>();
    for (const [channelId, states] of channelParticipants) {
      if (states.some((state) => !state.guild_id && state.user_id !== selfUserId)) ids.add(channelId);
    }
    return ids;
  }, [channelParticipants, selfUserId]);
  const stale = declined.some((channelId) => !live.has(channelId));
  useEffect(() => {
    if (!stale) return;
    const current = useDeclinedStore.getState().declined;
    useDeclinedStore.getState().set(current.filter((channelId) => live.has(channelId)));
  }, [stale, live]);

  return { call, decline };
}
