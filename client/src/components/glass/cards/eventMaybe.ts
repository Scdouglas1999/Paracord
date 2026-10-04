import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * "Maybe" on an event card (docs/index-spec.md §4.11: "I'm in" / "Maybe").
 *
 * THE SERVER HAS ONE RSVP: you are going or you are not (`PUT` and `DELETE`
 * `…/events/:id/rsvp`, and the going count). It has no second state, so "Maybe"
 * cannot be told to anyone. It is kept here, on this device, as your own mark on
 * the card ("I may come"): it never changes the going count, nobody else sees it,
 * and the card says so (the button's title). When the server grows an RSVP status
 * this file is the one place that changes.
 *
 * A mark is for an event that has not passed: each carries the event's start, and
 * a mark a week past its event is dropped the next time one is written.
 */
interface EventMaybeState {
  /** The event's own key (account scope and id) to its start, in ms. */
  marks: Record<string, number>;
  set: (key: string, startsAtMs: number, on: boolean, nowMs?: number) => void;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const useEventMaybeStore = create<EventMaybeState>()(
  persist(
    (set) => ({
      marks: {},
      set: (key, startsAtMs, on, nowMs = Date.now()) =>
        set((state) => {
          const next: Record<string, number> = {};
          for (const [existing, start] of Object.entries(state.marks)) {
            if (existing !== key && start > nowMs - WEEK_MS) next[existing] = start;
          }
          if (on) next[key] = startsAtMs;
          return { marks: next };
        }),
    }),
    {
      name: 'paracord:index:event-maybe',
      version: 1,
      partialize: (state) => ({ marks: state.marks }),
    },
  ),
);

/** Whether this event is marked "Maybe" on this device, and the setter. */
export function useEventMaybe(key: string | null, startsAtMs: number | null): {
  maybe: boolean;
  setMaybe: (on: boolean) => void;
} {
  const maybe = useEventMaybeStore((state) => (key ? key in state.marks : false));
  const setMaybe = useCallback(
    (on: boolean) => {
      if (key && startsAtMs !== null) useEventMaybeStore.getState().set(key, startsAtMs, on);
    },
    [key, startsAtMs],
  );
  return { maybe, setMaybe };
}
