import { create } from 'zustand';
import type { ApplicationCommand } from '../types/commands';
import { commandApi } from '../api/commands';
import { extractApiError } from '../api/client';
import { toast } from './toastStore';

interface CommandStoreState {
  /** Commands indexed by guild ID. */
  guildCommands: Map<string, ApplicationCommand[]>;
  /** Loading state. */
  loading: boolean;
  /** Fetch all commands available in a guild (global + guild-specific). */
  fetchGuildCommands: (guildId: string) => Promise<void>;
  /** Clear cached commands for a guild. */
  clearGuildCommands: (guildId: string) => void;
}

export const useCommandStore = create<CommandStoreState>()((set, get) => ({
  guildCommands: new Map(),
  loading: false,

  fetchGuildCommands: async (guildId: string) => {
    set({ loading: true });
    try {
      const { data } = await commandApi.listGuildAvailableCommands(guildId);
      const next = new Map(get().guildCommands);
      next.set(guildId, data);
      set({ guildCommands: next, loading: false });
    } catch (err) {
      set({ loading: false });
      toast.error(`Failed to load commands: ${extractApiError(err)}`);
    }
  },

  clearGuildCommands: (guildId: string) => {
    const next = new Map(get().guildCommands);
    next.delete(guildId);
    set({ guildCommands: next });
  },
}));
