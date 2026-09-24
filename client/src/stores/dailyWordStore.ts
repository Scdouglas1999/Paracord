import { create } from 'zustand';
import { extractApiError } from '../api/client';
import {
  dailyWordApi,
  type DailyWordBoard,
  type DailyWordSettings,
  type DailyWordStats,
  type DailyWordToday,
} from '../api/dailyWord';
import { registerSessionReset } from './sessionReset';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DailyWordSettingsEntry {
  settings: DailyWordSettings | null;
  status: LoadStatus;
  error: string | null;
}

export interface DailyWordBoardEntry {
  board: DailyWordBoard | null;
  error: string | null;
}

interface DailyWordStore {
  settingsByGuild: Record<string, DailyWordSettingsEntry>;
  today: DailyWordToday | null;
  todayStatus: LoadStatus;
  todayError: string | null;
  stats: DailyWordStats | null;
  statsError: string | null;
  boards: Record<string, DailyWordBoardEntry>;
  ensureSettings: (guildId: string) => Promise<void>;
  adoptSettings: (settings: DailyWordSettings) => void;
  refreshToday: () => Promise<void>;
  /** Send a guess. Resolves with the new game; rejects with the server's error. */
  guess: (word: string) => Promise<DailyWordToday>;
  refreshStats: () => Promise<void>;
  refreshBoard: (guildId: string) => Promise<void>;
  reset: () => void;
}

const inflightSettings = new Map<string, Promise<void>>();
let inflightToday: Promise<void> | null = null;

export const useDailyWordStore = create<DailyWordStore>((set, get) => ({
  settingsByGuild: {},
  today: null,
  todayStatus: 'idle',
  todayError: null,
  stats: null,
  statsError: null,
  boards: {},

  ensureSettings: (guildId) => {
    if (!guildId) return Promise.resolve();
    const pending = inflightSettings.get(guildId);
    if (pending) return pending;
    if (get().settingsByGuild[guildId]?.status === 'ready') return Promise.resolve();
    const task = (async () => {
      set((state) => ({
        settingsByGuild: {
          ...state.settingsByGuild,
          [guildId]: { settings: state.settingsByGuild[guildId]?.settings ?? null, status: 'loading', error: null },
        },
      }));
      try {
        const { data } = await dailyWordApi.getSettings(guildId);
        get().adoptSettings(data);
      } catch (err) {
        set((state) => ({
          settingsByGuild: {
            ...state.settingsByGuild,
            [guildId]: { settings: null, status: 'error', error: extractApiError(err) },
          },
        }));
      } finally {
        inflightSettings.delete(guildId);
      }
    })();
    inflightSettings.set(guildId, task);
    return task;
  },

  adoptSettings: (settings) => {
    set((state) => ({
      settingsByGuild: {
        ...state.settingsByGuild,
        [settings.guild_id]: { settings, status: 'ready', error: null },
      },
    }));
  },

  refreshToday: () => {
    if (inflightToday) return inflightToday;
    const task = (async () => {
      set((state) => ({ todayStatus: state.today ? state.todayStatus : 'loading', todayError: null }));
      try {
        const { data } = await dailyWordApi.getToday();
        set({ today: data, todayStatus: 'ready', todayError: null });
      } catch (err) {
        set({ todayStatus: 'error', todayError: extractApiError(err) });
      } finally {
        inflightToday = null;
      }
    })();
    inflightToday = task;
    return task;
  },

  guess: async (word) => {
    const { data } = await dailyWordApi.guess(word);
    set({ today: data, todayStatus: 'ready', todayError: null });
    return data;
  },

  refreshStats: async () => {
    try {
      const { data } = await dailyWordApi.getStats();
      set({ stats: data, statsError: null });
    } catch (err) {
      set({ statsError: extractApiError(err) });
    }
  },

  refreshBoard: async (guildId) => {
    if (!guildId) return;
    try {
      const { data } = await dailyWordApi.getBoard(guildId);
      set((state) => ({ boards: { ...state.boards, [guildId]: { board: data, error: null } } }));
    } catch (err) {
      set((state) => ({
        boards: {
          ...state.boards,
          [guildId]: { board: state.boards[guildId]?.board ?? null, error: extractApiError(err) },
        },
      }));
    }
  },

  reset: () => {
    inflightSettings.clear();
    inflightToday = null;
    set({
      settingsByGuild: {},
      today: null,
      todayStatus: 'idle',
      todayError: null,
      stats: null,
      statsError: null,
      boards: {},
    });
  },
}));

registerSessionReset('dailyWord', () => useDailyWordStore.getState().reset());

/** One settings read per server per session, shared by the sidebar, the page and the widget. */
export function selectDailyWordSettings(guildId: string) {
  return (state: DailyWordStore) => state.settingsByGuild[guildId];
}
