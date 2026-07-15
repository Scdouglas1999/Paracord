import { create } from 'zustand';
import { relationshipApi, type Relationship } from '../api/relationships';
import { extractApiError } from '../api/client';
import { toast } from './toastStore';

interface RelationshipState {
  relationships: Relationship[];
  isLoading: boolean;

  fetchRelationships: () => Promise<void>;
  addFriend: (username: string) => Promise<void>;
  acceptFriend: (userId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;

  // Computed getters
  friends: () => Relationship[];
  blocked: () => Relationship[];
  pendingIncoming: () => Relationship[];
  pendingOutgoing: () => Relationship[];
}

export const useRelationshipStore = create<RelationshipState>()((set, get) => ({
  relationships: [],
  isLoading: false,

  fetchRelationships: async () => {
    set({ isLoading: true });
    try {
      const { data } = await relationshipApi.list();
      set({ relationships: data, isLoading: false });
    } catch (err) {
      set({ isLoading: false });
      toast.error(`Failed to load relationships: ${extractApiError(err)}`);
    }
  },

  addFriend: async (username) => {
    await relationshipApi.addFriend(username);
    await get().fetchRelationships();
  },

  acceptFriend: async (userId) => {
    await relationshipApi.accept(userId);
    await get().fetchRelationships();
  },

  removeFriend: async (userId) => {
    await relationshipApi.remove(userId);
    set((state) => ({
      relationships: state.relationships.filter((r) => r.user.id !== userId),
    }));
  },

  friends: () => get().relationships.filter((r) => r.type === 1),
  blocked: () => get().relationships.filter((r) => r.type === 2),
  pendingIncoming: () => get().relationships.filter((r) => r.type === 3),
  pendingOutgoing: () => get().relationships.filter((r) => r.type === 4),
}));
