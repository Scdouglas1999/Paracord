import { create } from 'zustand';

import { registerSessionReset } from './sessionReset';
import type { VoiceState } from '../types';
import { speakingKey } from '../lib/voice/speakingSource';

/**
 * Who is talking in each voice channel, as the server relays it
 * (`VOICE_SPEAKING`, and the `speaking` flag on READY's voice states).
 *
 * This is the signal for people OUTSIDE a call. Inside the call you are in,
 * the local media engine's `voiceStore.speakingUsers` is faster and exact, and
 * `channelSpeakers` (lib/voice/speakingSource) prefers it.
 *
 * Keyed by guild and channel, like `voiceStore.channelParticipants` filtered
 * by `guild_id`, so the same channel id on two servers cannot share speakers.
 */

export interface VoiceSpeakingUpdate {
  guild_id: string;
  channel_id: string;
  user_id: string;
  speaking: boolean;
}

export function isVoiceSpeakingUpdate(data: unknown): data is VoiceSpeakingUpdate {
  const update = data as Partial<VoiceSpeakingUpdate> | null;
  return typeof update?.guild_id === 'string'
    && typeof update.channel_id === 'string'
    && typeof update.user_id === 'string'
    && typeof update.speaking === 'boolean';
}

type Speakers = ReadonlyMap<string, ReadonlySet<string>>;

interface RemoteSpeakingState {
  /** `speakingKey(guild, channel)` → user ids talking there now. */
  byChannel: Speakers;
  applyUpdate: (update: VoiceSpeakingUpdate) => void;
  /** Replace one guild's speakers from a READY snapshot. */
  loadGuild: (guildId: string, states: readonly VoiceState[]) => void;
  /** A voice state change: a leave, move or mute ends that person's speaking. */
  applyVoiceState: (state: VoiceState) => void;
  reset: () => void;
}

const EMPTY: Speakers = new Map();

function withUser(map: Speakers, key: string, userId: string, speaking: boolean): Speakers {
  const current = map.get(key);
  if (Boolean(current?.has(userId)) === speaking) return map;
  const next = new Map(map);
  const users = new Set(current);
  if (speaking) users.add(userId);
  else users.delete(userId);
  if (users.size) next.set(key, users);
  else next.delete(key);
  return next;
}

export const useRemoteSpeakingStore = create<RemoteSpeakingState>()((set) => ({
  byChannel: EMPTY,

  applyUpdate: (update) =>
    set((state) => {
      const next = withUser(
        state.byChannel,
        speakingKey(update.guild_id, update.channel_id),
        update.user_id,
        update.speaking,
      );
      return next === state.byChannel ? state : { byChannel: next };
    }),

  loadGuild: (guildId, states) =>
    set((state) => {
      const prefix = `${guildId}:`;
      const next = new Map([...state.byChannel].filter(([key]) => !key.startsWith(prefix)));
      for (const voiceState of states) {
        if (!voiceState.speaking || !voiceState.channel_id) continue;
        const key = speakingKey(guildId, voiceState.channel_id);
        next.set(key, new Set([...(next.get(key) ?? []), voiceState.user_id]));
      }
      if (next.size === 0 && state.byChannel.size === 0) return state;
      return { byChannel: next };
    }),

  applyVoiceState: (voiceState) =>
    set((state) => {
      if (!voiceState.guild_id) return state;
      const prefix = `${voiceState.guild_id}:`;
      const muted = voiceState.self_mute || voiceState.self_deaf || voiceState.mute || voiceState.suppress;
      let next = state.byChannel;
      for (const [key, users] of state.byChannel) {
        if (!key.startsWith(prefix) || !users.has(voiceState.user_id)) continue;
        const stillThere = key === speakingKey(voiceState.guild_id, voiceState.channel_id ?? '');
        if (!stillThere || muted) next = withUser(next, key, voiceState.user_id, false);
      }
      return next === state.byChannel ? state : { byChannel: next };
    }),

  reset: () => set({ byChannel: EMPTY }),
}));

registerSessionReset('remoteSpeaking', () => useRemoteSpeakingStore.getState().reset());
