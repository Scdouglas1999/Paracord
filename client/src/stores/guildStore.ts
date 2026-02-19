import { create } from 'zustand';
import type { Guild } from '../types';
import { guildApi } from '../api/guilds';
import { extractApiError } from '../api/client';
import { toast } from './toastStore';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl';

interface GuildState {
  guilds: Guild[];
  selectedGuildId: string | null;
  isLoading: boolean;

  fetchGuilds: () => Promise<void>;
  selectGuild: (id: string | null) => void;
  createGuild: (name: string, icon?: string) => Promise<Guild>;
  updateGuild: (id: string, data: Partial<Guild>) => Promise<void>;
  deleteGuild: (id: string) => Promise<void>;
  leaveGuild: (id: string) => Promise<void>;
  setGuilds: (guilds: Guild[]) => void;
  addGuild: (guild: Guild) => void;
  removeGuild: (id: string) => void;
  updateGuildData: (id: string, data: Partial<Guild>) => void;
}

export const useGuildStore = create<GuildState>()((set, _get) => ({
  guilds: [],
  selectedGuildId: null,
  isLoading: false,

  fetchGuilds: async () => {
    set({ isLoading: true });
    try {
      const serverUrl = resolveApiBaseUrl();
      const { data } = await guildApi.getAll();
      const stamped = data.map((g) => ({ ...g, server_url: g.server_url || serverUrl }));
      set({ guilds: stamped, isLoading: false });
    } catch (err) {
      set({ isLoading: false });
      toast.error(`Failed to load servers: ${extractApiError(err)}`);
    }
  },

  selectGuild: (id) => set({ selectedGuildId: id }),

  setGuilds: (guilds) => set({ guilds }),

  createGuild: async (name, icon) => {
    const serverUrl = resolveApiBaseUrl();
    const { data } = await guildApi.create({ name, icon });
    const stamped = { ...data, server_url: serverUrl };
    set((state) => ({ guilds: [...state.guilds, stamped] }));
    return stamped;
  },

  updateGuild: async (id, guildData) => {
    const { data } = await guildApi.update(id, guildData);
    set((state) => ({
      guilds: state.guilds.map((g) => (g.id === id ? data : g)),
    }));
  },

  deleteGuild: async (id) => {
    await guildApi.delete(id);
    set((state) => ({
      guilds: state.guilds.filter((g) => g.id !== id),
      selectedGuildId: state.selectedGuildId === id ? null : state.selectedGuildId,
    }));
  },

  leaveGuild: async (id) => {
    await guildApi.leaveGuild(id);
    set((state) => ({
      guilds: state.guilds.filter((g) => g.id !== id),
      selectedGuildId: state.selectedGuildId === id ? null : state.selectedGuildId,
    }));
  },

  addGuild: (guild) =>
    set((state) => {
      const normalized = {
        ...guild,
        server_url: guild.server_url || resolveApiBaseUrl(),
        created_at: guild.created_at ?? new Date().toISOString(),
        member_count: guild.member_count ?? 0,
        features: guild.features ?? [],
      };
      if (state.guilds.some((g) => g.id === guild.id)) {
        return { guilds: state.guilds.map((g) => (g.id === guild.id ? { ...g, ...normalized } : g)) };
      }
      return { guilds: [...state.guilds, normalized] };
    }),

  removeGuild: (id) =>
    set((state) => ({
      guilds: state.guilds.filter((g) => g.id !== id),
      selectedGuildId: state.selectedGuildId === id ? null : state.selectedGuildId,
    })),

  updateGuildData: (id, data) =>
    set((state) => ({
      guilds: state.guilds.map((g) => (g.id === id ? { ...g, ...data } : g)),
    })),
}));
