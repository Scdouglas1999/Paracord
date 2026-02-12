import { create } from 'zustand';
import type { Presence } from '../types';

interface PresenceState {
  // Presences indexed by user ID
  presences: Map<string, Presence>;

  getPresence: (userId: string) => Presence | undefined;
  updatePresence: (presence: Presence) => void;
  removePresence: (userId: string) => void;
  setPresences: (presences: Presence[]) => void;
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  presences: new Map(),

  getPresence: (userId) => get().presences.get(userId),

  updatePresence: (presence) =>
    set((state) => {
      const presences = new Map(state.presences);
      const existing = presences.get(presence.user_id);
      presences.set(presence.user_id, {
        ...existing,
        ...presence,
        activities: presence.activities ?? existing?.activities ?? [],
      });
      return { presences };
    }),

  removePresence: (userId) =>
    set((state) => {
      const presences = new Map(state.presences);
      presences.delete(userId);
      return { presences };
    }),

  setPresences: (list) =>
    set(() => {
      const presences = new Map<string, Presence>();
      for (const p of list) {
        presences.set(p.user_id, p);
      }
      return { presences };
    }),
}));
