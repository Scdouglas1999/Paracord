import { create } from 'zustand';
import type { Activity, Presence } from '../types';

const DEFAULT_SCOPE = 'global';

function normalizeScope(scope?: string): string {
  return scope?.trim() || DEFAULT_SCOPE;
}

export function makePresenceKey(userId: string, scope?: string): string {
  return `${normalizeScope(scope)}:${String(userId)}`;
}

function activitiesEqual(a: Activity[] | undefined, b: Activity[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const x = left[i];
    const y = right[i];
    if (
      x.name !== y.name ||
      x.type !== y.type ||
      x.activity_type !== y.activity_type ||
      x.details !== y.details ||
      x.state !== y.state ||
      x.started_at !== y.started_at ||
      x.application_id !== y.application_id
    ) {
      return false;
    }
  }
  return true;
}

// Monotonic counter so the "most recently updated" fallback is deterministic
// even when multiple presences are written within the same millisecond.
let presenceWriteSeq = 0;

interface PresenceState {
  // Presences indexed by scope + user ID (e.g. "serverA:123")
  presences: Map<string, Presence>;
  // Write ordinal per presence key, used only to pick a deterministic fallback
  // when a user has entries under more than one scope.
  presenceOrder: Map<string, number>;

  getPresence: (userId: string, scope?: string) => Presence | undefined;
  updatePresence: (presence: Presence, scope?: string) => void;
  removePresence: (userId: string, scope?: string) => void;
  setPresences: (presences: Presence[], scope?: string) => void;
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  presences: new Map(),
  presenceOrder: new Map(),

  getPresence: (userId, scope) => {
    const id = String(userId);
    const { presences, presenceOrder } = get();
    const scoped = presences.get(makePresenceKey(id, scope));
    if (scoped) return scoped;
    if (scope && normalizeScope(scope) !== DEFAULT_SCOPE) {
      const global = presences.get(makePresenceKey(id));
      if (global) return global;
    }

    // Scope can drift during reconnects and a user may end up with entries under
    // several scopes. Prefer the requested scope (handled above), then global,
    // then fall back deterministically to the most recently written entry.
    let fallback: Presence | undefined;
    let fallbackOrder = -1;
    for (const [key, value] of presences.entries()) {
      if (!key.endsWith(`:${id}`)) continue;
      const order = presenceOrder.get(key) ?? 0;
      if (order > fallbackOrder) {
        fallbackOrder = order;
        fallback = value;
      }
    }
    return fallback;
  },

  updatePresence: (presence, scope) =>
    set((state) => {
      const userId = String(presence.user_id);
      const key = makePresenceKey(userId, scope);
      const existing = state.presences.get(key);
      const next: Presence = {
        ...existing,
        ...presence,
        user_id: userId,
        activities: presence.activities ?? existing?.activities ?? [],
      };
      // Skip Map clones / subscriber churn when the scoped presence is unchanged.
      if (
        existing &&
        existing.status === next.status &&
        existing.guild_id === next.guild_id &&
        activitiesEqual(existing.activities, next.activities)
      ) {
        return state;
      }
      const presences = new Map(state.presences);
      const presenceOrder = new Map(state.presenceOrder);
      presences.set(key, next);
      presenceOrder.set(key, ++presenceWriteSeq);
      return { presences, presenceOrder };
    }),

  removePresence: (userId, scope) =>
    set((state) => {
      const presences = new Map(state.presences);
      const presenceOrder = new Map(state.presenceOrder);
      const key = makePresenceKey(String(userId), scope);
      presences.delete(key);
      presenceOrder.delete(key);
      return { presences, presenceOrder };
    }),

  setPresences: (list, scope) =>
    set((state) => {
      const normalizedScope = normalizeScope(scope);
      const presences = new Map<string, Presence>();
      const presenceOrder = new Map<string, number>();
      for (const [key, value] of state.presences.entries()) {
        if (!key.startsWith(`${normalizedScope}:`)) {
          presences.set(key, value);
          const order = state.presenceOrder.get(key);
          if (order !== undefined) presenceOrder.set(key, order);
        }
      }
      for (const p of list) {
        const userId = String(p.user_id);
        const key = makePresenceKey(userId, normalizedScope);
        presences.set(key, {
          ...p,
          user_id: userId,
        });
        presenceOrder.set(key, ++presenceWriteSeq);
      }
      return { presences, presenceOrder };
    }),
}));
