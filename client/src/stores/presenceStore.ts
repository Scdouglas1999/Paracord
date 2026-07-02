import { create } from 'zustand';
import type { Presence } from '../types';

const DEFAULT_SCOPE = 'global';

function normalizeScope(scope?: string): string {
  return scope?.trim() || DEFAULT_SCOPE;
}

export function makePresenceKey(userId: string, scope?: string): string {
  return `${normalizeScope(scope)}:${String(userId)}`;
}

interface PresenceState {
  // Presences indexed by scope + user ID (e.g. "serverA:123")
  presences: Map<string, Presence>;

  getPresence: (userId: string, scope?: string) => Presence | undefined;
  updatePresence: (presence: Presence, scope?: string) => void;
  removePresence: (userId: string, scope?: string) => void;
  setPresences: (presences: Presence[], scope?: string) => void;
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  presences: new Map(),

  getPresence: (userId, scope) => {
    const id = String(userId);
    const presences = get().presences;
    const scoped = presences.get(makePresenceKey(id, scope));
    if (scoped) return scoped;
    if (scope && normalizeScope(scope) !== DEFAULT_SCOPE) {
      const global = presences.get(makePresenceKey(id));
      if (global) return global;
    }

    // Scope can drift during reconnects. If there is exactly one known presence
    // for this user across all scopes, use it as a safe fallback.
    let fallback: Presence | undefined;
    for (const [key, value] of presences.entries()) {
      if (!key.endsWith(`:${id}`)) continue;
      if (!fallback) {
        fallback = value;
      } else {
        // Ambiguous across multiple scopes; avoid guessing.
        return undefined;
      }
    }
    return fallback;
  },

  updatePresence: (presence, scope) =>
    set((state) => {
      const presences = new Map(state.presences);
      const userId = String(presence.user_id);
      const key = makePresenceKey(userId, scope);
      const existing = presences.get(key);
      presences.set(key, {
        ...existing,
        ...presence,
        user_id: userId,
        activities: presence.activities ?? existing?.activities ?? [],
      });
      return { presences };
    }),

  removePresence: (userId, scope) =>
    set((state) => {
      const presences = new Map(state.presences);
      presences.delete(makePresenceKey(String(userId), scope));
      return { presences };
    }),

  setPresences: (list, scope) =>
    set((state) => {
      const normalizedScope = normalizeScope(scope);
      const presences = new Map<string, Presence>();
      for (const [key, value] of state.presences.entries()) {
        if (!key.startsWith(`${normalizedScope}:`)) {
          presences.set(key, value);
        }
      }
      for (const p of list) {
        const userId = String(p.user_id);
        presences.set(makePresenceKey(userId, normalizedScope), {
          ...p,
          user_id: userId,
        });
      }
      return { presences };
    }),
}));
