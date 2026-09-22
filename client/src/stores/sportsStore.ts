import { create } from 'zustand';
import { apiErrorStatus, extractApiError } from '../api/client';
import { sportsApi, type SportsBoard, type SportsSettings } from '../api/sports';
import { scoreChanges, SCORE_FLASH_MS, type ScoreChange } from '../components/sports/model';
import { resetSportsPolling } from '../components/sports/poll';

export interface GuildSportsEntry {
  settings: SportsSettings | null;
  settingsStatus: 'idle' | 'loading' | 'ready' | 'error';
  settingsError: string | null;
  board: SportsBoard | null;
  boardError: string | null;
  /** Game id -> when the score flash ends, what to announce, and who scored. */
  flashes: Record<string, { until: number; message: string; side: 'home' | 'away' | null }>;
}

interface SportsStore {
  byGuild: Record<string, GuildSportsEntry>;
  ensureSettings: (guildId: string) => Promise<void>;
  refreshBoard: (guildId: string) => Promise<void>;
  adoptSettings: (settings: SportsSettings) => void;
  refreshSettings: (guildId: string) => Promise<void>;
  adoptBoard: (guildId: string, board: SportsBoard) => void;
  reset: () => void;
}

const inflightSettings = new Map<string, Promise<void>>();

function blank(): GuildSportsEntry {
  return {
    settings: null,
    settingsStatus: 'idle',
    settingsError: null,
    board: null,
    boardError: null,
    flashes: {},
  };
}

function mergeFlashes(
  existing: GuildSportsEntry['flashes'],
  changes: readonly ScoreChange[],
  now: number,
): GuildSportsEntry['flashes'] {
  const next: GuildSportsEntry['flashes'] = {};
  for (const [id, flash] of Object.entries(existing)) {
    if (flash.until > now) next[id] = flash;
  }
  const until = now + SCORE_FLASH_MS;
  for (const change of changes) next[change.id] = { until, message: change.message, side: change.side };
  return next;
}

export const useSportsStore = create<SportsStore>((set, get) => ({
  byGuild: {},

  ensureSettings: (guildId) => {
    if (!guildId) return Promise.resolve();
    const pending = inflightSettings.get(guildId);
    if (pending) return pending;
    if (get().byGuild[guildId]?.settingsStatus === 'ready') return Promise.resolve();

    // Register before any set(), which notifies subscribers synchronously.
    let settle!: () => void;
    const task = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inflightSettings.set(guildId, task);

    void (async () => {
      set((state) => ({
        byGuild: {
          ...state.byGuild,
          [guildId]: {
            ...(state.byGuild[guildId] ?? blank()),
            settingsStatus: 'loading',
            settingsError: null,
          },
        },
      }));
      try {
        const res = await sportsApi.getSettings(guildId);
        set((state) => ({
          byGuild: {
            ...state.byGuild,
            [guildId]: {
              ...(state.byGuild[guildId] ?? blank()),
              settings: res.data,
              settingsStatus: 'ready',
              settingsError: null,
            },
          },
        }));
      } catch (err) {
        set((state) => ({
          byGuild: {
            ...state.byGuild,
            [guildId]: {
              ...(state.byGuild[guildId] ?? blank()),
              settingsStatus: 'error',
              settingsError: extractApiError(err),
            },
          },
        }));
      } finally {
        inflightSettings.delete(guildId);
        settle();
      }
    })();
    return task;
  },

  refreshBoard: async (guildId) => {
    const current = get().byGuild[guildId];
    if (!guildId || current?.settings?.enabled !== true) return;
    try {
      const res = await sportsApi.getBoard(guildId);
      const now = Date.now();
      set((state) => {
        const prev = state.byGuild[guildId];
        if (!prev) return state;
        return {
          byGuild: {
            ...state.byGuild,
            [guildId]: {
              ...prev,
              board: res.data,
              boardError: null,
              flashes: mergeFlashes(
                prev.flashes,
                scoreChanges(prev.board ? prev.board.games : null, res.data.games),
                now,
              ),
            },
          },
        };
      });
    } catch (err) {
      if (apiErrorStatus(err) === 404) {
        set((state) => {
          const prev = state.byGuild[guildId];
          if (!prev?.settings) return state;
          return {
            byGuild: {
              ...state.byGuild,
              [guildId]: {
                ...prev,
                settings: { ...prev.settings, enabled: false },
                boardError: 'Sports is turned off for this server.',
              },
            },
          };
        });
        return;
      }
      set((state) => {
        const prev = state.byGuild[guildId];
        if (!prev) return state;
        return {
          byGuild: {
            ...state.byGuild,
            [guildId]: {
              ...prev,
              boardError: prev.board
                ? "Scores couldn't be loaded. Showing the last ones we got."
                : "Scores couldn't be loaded. Try again in a moment.",
            },
          },
        };
      });
    }
  },

  adoptSettings: (settings) => {
    const guildId = settings.guild_id;
    if (!guildId) return;
    set((state) => ({
      byGuild: {
        ...state.byGuild,
        [guildId]: {
          ...(state.byGuild[guildId] ?? blank()),
          settings,
          settingsStatus: 'ready',
          settingsError: null,
        },
      },
    }));
  },

  refreshSettings: async (guildId) => {
    if (!guildId) return;
    try {
      const res = await sportsApi.getSettings(guildId);
      get().adoptSettings(res.data);
    } catch {
      // Keep the pins already on screen. The next poll tries again.
    }
  },

  adoptBoard: (guildId, board) => {
    set((state) => ({
      byGuild: {
        ...state.byGuild,
        [guildId]: {
          ...(state.byGuild[guildId] ?? blank()),
          board,
          boardError: null,
        },
      },
    }));
  },

  reset: () => {
    inflightSettings.clear();
    resetSportsPolling();
    set({ byGuild: {} });
  },
}));
