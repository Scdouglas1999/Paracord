import { create } from 'zustand';
import { savedMessagesApi, type SavedMessageItem } from '../api/savedMessages';
import { extractApiError } from '../api/client';
import { useServerListStore } from './serverListStore';

function currentServerScope(): string {
  return useServerListStore.getState().activeServerId ?? '__local__';
}

interface SavedMessageState {
  serverId: string | null;
  items: SavedMessageItem[];
  savedIds: Set<string>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  save: (messageId: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  reset: () => void;
}

export const useSavedMessageStore = create<SavedMessageState>()((set, get) => ({
  serverId: null,
  items: [],
  savedIds: new Set(),
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
      savedIds: current.serverId === serverId ? current.savedIds : new Set(),
      loaded: false,
      loading: true,
      error: null,
    });
    try {
      const { data } = await savedMessagesApi.list(50);
      if (currentServerScope() !== serverId || get().serverId !== serverId) return;
      set({
        items: data.items,
        savedIds: new Set(data.items.map((item) => item.message.id)),
        loaded: true,
        error: null,
      });
    } catch (err) {
      if (currentServerScope() === serverId && get().serverId === serverId) {
        set({ error: `Failed to load saved messages: ${extractApiError(err)}` });
      }
    } finally {
      if (currentServerScope() === serverId && get().serverId === serverId) {
        set({ loading: false });
      }
    }
  },

  save: async (messageId) => {
    const serverId = currentServerScope();
    if (get().serverId !== serverId) {
      set({ serverId, items: [], savedIds: new Set(), loaded: false, error: null });
    }
    const prior = get().savedIds;
    set({ savedIds: new Set([...prior, messageId]), error: null });
    try {
      await savedMessagesApi.save(messageId);
    } catch (err) {
      if (currentServerScope() === serverId && get().serverId === serverId) {
        const rollback = new Set(get().savedIds);
        rollback.delete(messageId);
        set({ savedIds: rollback });
      }
      throw err;
    }
  },

  remove: async (messageId) => {
    const serverId = currentServerScope();
    if (get().serverId !== serverId) {
      set({ serverId, items: [], savedIds: new Set(), loaded: false, error: null });
    }
    const priorIds = get().savedIds;
    const priorItems = get().items;
    const nextIds = new Set(priorIds);
    nextIds.delete(messageId);
    set({
      savedIds: nextIds,
      items: priorItems.filter((item) => item.message.id !== messageId),
      error: null,
    });
    try {
      await savedMessagesApi.remove(messageId);
    } catch (err) {
      if (currentServerScope() === serverId && get().serverId === serverId) {
        set({ savedIds: priorIds, items: priorItems });
      }
      throw err;
    }
  },

  reset: () => set({
    serverId: null,
    items: [],
    savedIds: new Set(),
    loading: false,
    loaded: false,
    error: null,
  }),
}));
