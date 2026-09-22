import { create } from 'zustand';
import { extractApiError } from '../api/client';
import { remindersApi, type ReminderItem } from '../api/reminders';
import { useServerListStore } from './serverListStore';

function currentServerScope(): string {
  return useServerListStore.getState().activeServerId ?? '__local__';
}

interface ReminderState {
  serverId: string | null;
  items: ReminderItem[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  save: (channelId: string, messageId: string, remindAt: string) => Promise<ReminderItem>;
  remove: (channelId: string, messageId: string) => Promise<void>;
  applyFired: (item: ReminderItem) => void;
  reset: () => void;
}

export const useReminderStore = create<ReminderState>()((set, get) => ({
  serverId: null,
  items: [],
  loading: false,
  loaded: false,
  error: null,

  load: async (force = false) => {
    const serverId = currentServerScope();
    const current = get();
    if (current.serverId === serverId && (current.loading || (current.loaded && !force))) return;
    set({
      serverId,
      items: current.serverId === serverId ? current.items : [],
      loaded: false,
      loading: true,
      error: null,
    });
    try {
      const { data } = await remindersApi.list();
      if (currentServerScope() !== serverId || get().serverId !== serverId) return;
      set({ items: data.items, loaded: true, error: null });
    } catch (err) {
      if (currentServerScope() === serverId && get().serverId === serverId) {
        set({ error: `Failed to load reminders: ${extractApiError(err)}` });
      }
    } finally {
      if (currentServerScope() === serverId && get().serverId === serverId) {
        set({ loading: false });
      }
    }
  },

  save: async (channelId, messageId, remindAt) => {
    const { data } = await remindersApi.put(channelId, messageId, remindAt);
    const serverId = currentServerScope();
    set((state) => {
      const without = state.items.filter((item) => item.message.id !== messageId);
      return { serverId, items: [data, ...without], loaded: true, error: null };
    });
    return data;
  },

  remove: async (channelId, messageId) => {
    await remindersApi.remove(channelId, messageId);
    set((state) => ({
      items: state.items.filter((item) => item.message.id !== messageId),
    }));
  },

  applyFired: (item) => {
    set((state) => {
      const without = state.items.filter((row) => row.id !== item.id && row.message.id !== item.message.id);
      return { items: [item, ...without] };
    });
  },

  reset: () => set({
    serverId: null,
    items: [],
    loading: false,
    loaded: false,
    error: null,
  }),
}));

export function pendingReminderMessageIds(items: readonly ReminderItem[]): Set<string> {
  return new Set(
    items.filter((item) => item.fired_at == null).map((item) => item.message.id),
  );
}
