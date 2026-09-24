import { create } from 'zustand';

import { guildApi, type SoundboardSound } from '../api/guilds';
import { evictSoundCache } from '../lib/features/soundboard';

/**
 * One play of a sound, for the ripple on the player's tile. `key` is a nonce —
 * the same person can play twice inside a ripple's lifetime.
 */
export interface SoundboardPlayMark {
  key: number;
  channelId: string;
  userId: string;
  emoji: string | null;
  soundName: string;
  at: number;
}

/** A mark stays visible for the ripple's animation length, then is filtered. */
export const SOUNDBOARD_MARK_TTL_MS = 2000;

const MAX_RECENT_PLAYS = 32;

let nextPlayKey = 1;

interface SoundboardStoreState {
  /** guild_id -> sounds, filled by `loadSounds` / refreshed on GUILD_SOUNDS_UPDATE. */
  soundsByGuild: Map<string, SoundboardSound[]>;
  loadingGuilds: Set<string>;
  /** Recent SOUNDBOARD_PLAY events in the current call, newest first. */
  recentPlays: SoundboardPlayMark[];

  /**
   * The guild's sounds, cached. `refresh` re-fetches — used after the gateway
   * reports a change the incremental update could not express.
   */
  loadSounds: (guildId: string, refresh?: boolean) => Promise<SoundboardSound[]>;
  /** Fold a GUILD_SOUNDS_UPDATE payload into a loaded list (no-op if not loaded). */
  applySoundsUpdate: (guildId: string, sound: SoundboardSound | null, deletedSoundId: string | null) => void;
  /** Drop a guild's list + decoded-audio cache (leave, guild switch). */
  evictGuild: (guildId: string) => void;
  recordPlay: (mark: Omit<SoundboardPlayMark, 'key' | 'at'>) => void;
}

export const useSoundboardStore = create<SoundboardStoreState>()((set, get) => ({
  soundsByGuild: new Map(),
  loadingGuilds: new Set(),
  recentPlays: [],

  loadSounds: async (guildId, refresh = false) => {
    const cached = get().soundsByGuild.get(guildId);
    if (cached && !refresh) return cached;
    const { loadingGuilds } = get();
    if (loadingGuilds.has(guildId)) {
      // A load is already in flight; wait on it rather than double-fetching.
      return new Promise<SoundboardSound[]>((resolve) => {
        const unsubscribe = useSoundboardStore.subscribe((state) => {
          if (state.loadingGuilds.has(guildId)) return;
          unsubscribe();
          resolve(state.soundsByGuild.get(guildId) ?? []);
        });
      });
    }
    set((state) => ({ loadingGuilds: new Set(state.loadingGuilds).add(guildId) }));
    try {
      const { data } = await guildApi.listSounds(guildId);
      set((state) => {
        const soundsByGuild = new Map(state.soundsByGuild);
        soundsByGuild.set(guildId, data);
        const loading = new Set(state.loadingGuilds);
        loading.delete(guildId);
        return { soundsByGuild, loadingGuilds: loading };
      });
      return data;
    } catch (err) {
      set((state) => {
        const loading = new Set(state.loadingGuilds);
        loading.delete(guildId);
        return { loadingGuilds: loading };
      });
      throw err;
    }
  },

  applySoundsUpdate: (guildId, sound, deletedSoundId) =>
    set((state) => {
      const existing = state.soundsByGuild.get(guildId);
      if (!existing) return state;
      let next: SoundboardSound[];
      if (deletedSoundId) {
        next = existing.filter((item) => item.id !== deletedSoundId);
        evictSoundCache(deletedSoundId);
      } else if (sound) {
        const idx = existing.findIndex((item) => item.id === sound.id);
        next = idx === -1 ? [sound, ...existing] : existing.map((item) => (item.id === sound.id ? sound : item));
        // A re-uploaded file under a stable id invalidates the decoded cache.
        evictSoundCache(sound.id);
      } else {
        return state;
      }
      const soundsByGuild = new Map(state.soundsByGuild);
      soundsByGuild.set(guildId, next);
      return { soundsByGuild };
    }),

  evictGuild: (guildId) =>
    set((state) => {
      if (!state.soundsByGuild.has(guildId)) return state;
      const soundsByGuild = new Map(state.soundsByGuild);
      for (const sound of soundsByGuild.get(guildId) ?? []) {
        evictSoundCache(sound.id);
      }
      soundsByGuild.delete(guildId);
      return { soundsByGuild };
    }),

  recordPlay: (mark) =>
    set((state) => ({
      recentPlays: [
        { ...mark, key: nextPlayKey++, at: Date.now() },
        ...state.recentPlays,
      ].slice(0, MAX_RECENT_PLAYS),
    })),
}));
