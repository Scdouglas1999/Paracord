import { useLayoutEffect, useRef, type RefObject } from 'react';

import { IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from '../ix/motion';
import { isPendingMessageId } from './pendingSay';
import type { TimelineRow } from './timelineRows';

/**
 * A message arrives from somebody else (docs/index-spec.md §5.10): the new
 * bubble (or group) rises from `translateY(14px) scale(.96)` and fades in,
 * 550ms spring, from the avatar's side, and what was already at the bottom of
 * the conversation glides up to make room instead of jumping.
 *
 * It composes with the send flight (`useSendFlight`, the owner's protected
 * gesture) by staying out of its way:
 *
 *   - your own rows never arrive this way: a send lands by the flight, or, when
 *     the flight declines, by its own settle; the delivered row of a flight is
 *     the stand-in's node and is never "new";
 *   - a row held for a flight (`[data-flight]`) is never moved;
 *   - the rows that glide up do so with `composite: 'add'`, on top of any glide
 *     already running (the flight making room, an earlier arrival), so two
 *     moments in a row add up instead of one cutting the other off.
 *
 * Arrivals are told from everything else that adds rows: the first list of a
 * conversation, older history above it, a jump, and a reload of the newest
 * page are not arrivals (they are not at the end, the reader is not at the
 * bottom, or there are too many at once). Reduced motion: a 150ms fade, nothing moves.
 *
 * Measuring: the rows are measured where they stand during the render that
 * brings the new one (before React touches the DOM), and again after the new
 * row has been measured and the timeline pinned to the bottom, in the same
 * task, before anything is painted.
 */

/** More new rows than this at once is a page of history, not a conversation. */
const MAX_ARRIVALS = 3;
const ARRIVE_MS = 550;

export interface ArrivalHost {
  rows: readonly TimelineRow[];
  scroller: RefObject<HTMLElement | null>;
  /** The reader's own id: their rows never arrive this way. */
  me: string | null | undefined;
  /** The reader is at the newest messages and wants to stay there. */
  following: () => boolean;
  /** Lay a new row out at its measured size now (the virtualizer's measure, flushed). */
  measureRow: (row: HTMLElement) => void;
  /** The conversation's history has loaded (even if empty): from here, what is new arrived. */
  ready: boolean;
}

interface Pending {
  /** The keys that arrived (for matching the commit to the capture). */
  signature: string;
  keys: string[];
  /** Where each row on screen stood before the new rows existed. */
  before: Map<Element, DOMRect>;
}

function arrivalKey(row: TimelineRow, me: string | null | undefined): string | null {
  if (row.type === 'voice') return row.key;
  if (row.type !== 'message') return null;
  if (isPendingMessageId(row.message.id)) return null;
  if (row.message.author?.id && row.message.author.id === me) return null;
  return row.key;
}

function trackedKey(row: TimelineRow): string | null {
  return row.type === 'message' || row.type === 'voice' ? row.key : null;
}

/** The rows on screen: each virtual row's content (the element the list positions). */
function screenRows(scroller: HTMLElement): HTMLElement[] {
  const content = scroller.querySelector<HTMLElement>('.glass-timeline__content');
  const rows: HTMLElement[] = [];
  for (const wrapper of Array.from(content?.children ?? [])) {
    const row = wrapper.firstElementChild;
    if (row instanceof HTMLElement && !row.hasAttribute('data-flight')) rows.push(row);
  }
  return rows;
}

function rowByKey(scroller: HTMLElement, key: string): HTMLElement | null {
  const content = scroller.querySelector<HTMLElement>('.glass-timeline__content');
  for (const wrapper of Array.from(content?.children ?? [])) {
    if ((wrapper as HTMLElement).dataset.rowKey === key) {
      const row = wrapper.firstElementChild;
      return row instanceof HTMLElement ? row : null;
    }
  }
  return null;
}

/** The new row rises in from the avatar's side (your own lines from the middle). */
export function popIn(row: HTMLElement): Animation | null {
  if (!canAnimate(row)) return null;
  if (ixReduced()) {
    const fade = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IX_REDUCED_MS, easing: 'linear' });
    fade.id = 'ix-timeline:arrive';
    return fade;
  }
  const origin = row.classList.contains('glass-msg') ? '0% 100%' : '50% 100%';
  const pop = row.animate(
    [
      { transform: 'translateY(14px) scale(0.96)', opacity: 0, transformOrigin: origin },
      { transform: 'none', opacity: 1, transformOrigin: origin },
    ],
    { duration: ARRIVE_MS, easing: IX_SPRING },
  );
  pop.id = 'ix-timeline:arrive';
  return pop;
}

export function useArrivals({ rows, scroller, me, following, measureRow, ready }: ArrivalHost): void {
  const committed = useRef<Set<string> | null>(null);
  const pending = useRef<Pending | null>(null);
  const latest = useRef({ following, measureRow });
  latest.current = { following, measureRow };

  // During render: notice new rows at the end and measure the old ones before
  // the DOM changes. Reading layout here is deliberate (and idempotent): after
  // the commit it is too late to know where the rows were.
  const seen = committed.current;
  if (seen) {
    let lastSeen = -1;
    rows.forEach((row, index) => {
      const key = trackedKey(row);
      if (key && seen.has(key)) lastSeen = index;
    });
    const fresh: string[] = [];
    let other = false;
    rows.forEach((row, index) => {
      const key = trackedKey(row);
      if (!key || seen.has(key)) return;
      if (index < lastSeen) {
        other = true;
        return;
      }
      const arrival = arrivalKey(row, me);
      if (arrival) fresh.push(arrival);
    });
    const signature = fresh.join('|');
    const element = scroller.current;
    if (fresh.length > 0 && !other && fresh.length <= MAX_ARRIVALS && element && pending.current?.signature !== signature) {
      if (latest.current.following()) {
        const before = new Map<Element, DOMRect>();
        if (!ixReduced()) for (const row of screenRows(element)) before.set(row, row.getBoundingClientRect());
        pending.current = { signature, keys: fresh, before };
      }
    }
  }

  useLayoutEffect(() => {
    const keys = new Set<string>();
    for (const row of rows) {
      const key = trackedKey(row);
      if (key) keys.add(key);
    }
    // The first list a conversation shows is its history: nothing arrives.
    if (ready || committed.current) committed.current = keys;
    const arrival = pending.current;
    pending.current = null;
    if (!arrival) return;
    const element = scroller.current;
    if (!element) return;
    // After the commit's own follow-up renders: the virtualizer measures the new
    // rows and renders again, synchronously, before paint.
    queueMicrotask(() => {
      const added = arrival.keys
        .map((key) => rowByKey(element, key))
        .filter((row): row is HTMLElement => row !== null && !row.hasAttribute('data-flight'));
      if (added.length === 0) return;
      for (const row of added) latest.current.measureRow(row);
      if (latest.current.following()) {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      }
      if (!ixReduced()) {
        for (const [row, from] of arrival.before) {
          if (!row.isConnected || added.includes(row as HTMLElement) || row.hasAttribute('data-flight')) continue;
          const to = row.getBoundingClientRect();
          const dy = from.top - to.top;
          if (Math.abs(dy) < 0.5 || !canAnimate(row)) continue;
          const glide = row.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
            { duration: ARRIVE_MS, easing: IX_SPRING, composite: 'add' },
          );
          glide.id = 'ix-timeline:make-room';
        }
      }
      for (const row of added) popIn(row);
    });
  });
}

/** Where each row on screen stands now (rows held for a send flight excluded). */
export function captureRows(scroller: HTMLElement | null): Map<Element, DOMRect> {
  const before = new Map<Element, DOMRect>();
  if (!scroller || ixReduced()) return before;
  for (const row of screenRows(scroller)) before.set(row, row.getBoundingClientRect());
  return before;
}

/**
 * Glide every captured row from where it stood to where it is now: translate
 * only, added on top of anything already moving it. Rows that left are skipped.
 */
export function glideFrom(before: Map<Element, DOMRect>, options: { duration: number; id: string }): Animation[] {
  const animations: Animation[] = [];
  if (ixReduced()) return animations;
  for (const [row, from] of before) {
    if (!row.isConnected || row.hasAttribute('data-flight') || !canAnimate(row)) continue;
    const dy = from.top - row.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    const glide = row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
      duration: options.duration,
      easing: IX_SPRING,
      composite: 'add',
    });
    glide.id = options.id;
    animations.push(glide);
  }
  return animations;
}
