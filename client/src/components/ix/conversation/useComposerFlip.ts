import { useEffect, useRef } from 'react';

import { onMotion } from '../../../lib/motion/bus';
import { IX_SPRING, ixReduced } from '../motion';

/**
 * The feed follows the message box (docs/index-spec.md §5.12): "the layout height
 * changes once at the start; the feed above it FLIPs from its old position, 500ms
 * spring, so nothing jumps. Closing reverses in 350ms."
 *
 * The box (and the cards above it: a queue, a recovery notice) changes height in
 * one layout; the feed's scroller, which fills what is left, changes by the
 * opposite amount. A ResizeObserver on the box's column sees it after layout and
 * before paint, so the first painted frame is already the first frame of the move.
 * What moved is played back from where it was, transform only:
 *
 *   • a feed that sits on the box (short, or scrolled to its end): the content
 *     jumped by the box's growth `d`, so it starts `d` px away and glides home;
 *   • a feed that overflows and was at its end: the scroller is moved by `d` to
 *     keep the newest message above the box (otherwise the box would cover it),
 *     and everything in it glides by `d`;
 *   • a feed scrolled away from its end does not move: the box covers the end and
 *     the reader's place is the reader's;
 *   • a welcome centered in the empty area moves half as far (`data-ix-anchor`).
 *
 * Moves add (`composite: 'add'`) so a second change mid-move continues from where
 * the first is on screen. Reduced motion snaps (the scroll keeps the end in view).
 * The send makes the box shrink too (its words are gone); the send flight owns that
 * moment, so a change within the flight's span is left alone.
 */

/** Growing, and the box opening (§5.12). */
export const FEED_GROW_MS = 500;
/** Shrinking, and the box closing. */
export const FEED_SHRINK_MS = 350;
/** The send flight's own span (`SEND_FLIGHT.duration` plus its handoff): box changes inside it are not the feed's to animate. */
export const FEED_SEND_QUIET_MS = 900;

/** A box change of less than this is layout noise (a subpixel). */
const MIN_DELTA = 1;
/** Within this of its end, a scroller counts as at its end. */
const AT_END_PX = 4;

export interface FeedMove {
  element: Element;
  /** Where it starts, relative to where it now is (px; positive = lower). */
  from: number;
}

/**
 * What moves, and by how much, when the box changes by `delta` (positive = grew).
 * Pure over the numbers the scroller reports after the change; `scrolled` is how
 * far the scroller was moved to keep its end in view (0 when it was not).
 */
export function planFeedMoves(input: {
  delta: number;
  header: Element | null;
  content: Element | null;
  receipt: Element | null;
  empty: Element | null;
  /** The empty block's anchor: how far it moves as a share of `delta`. */
  emptyShare: number;
  overflow: boolean;
  atEnd: boolean;
}): FeedMove[] {
  const { delta, header, content, receipt, empty, emptyShare, overflow, atEnd } = input;
  const moves: FeedMove[] = [];
  const add = (element: Element | null, from: number) => {
    if (element && Math.abs(from) >= 0.5) moves.push({ element, from });
  };
  if (empty) {
    // The welcome: nothing but its own block moves, and only by its share.
    add(empty.firstElementChild ?? empty, delta * emptyShare);
    return moves;
  }
  if (!atEnd) return moves;
  add(content, delta);
  add(receipt, delta);
  // The title moves only when the scroller itself was moved to keep the end in view.
  if (overflow) add(header, delta);
  return moves;
}

/** Observe the box's column and play the feed's FLIP. Both elements may be null (not mounted yet). */
export function useComposerFlip(column: HTMLElement | null, scroller: HTMLElement | null, channelId: string): void {
  const last = useRef<number | null>(null);
  const lastSend = useRef(Number.NEGATIVE_INFINITY);

  useEffect(
    () =>
      onMotion('say:sent', (detail) => {
        if (detail.channelId === channelId) lastSend.current = performance.now();
      }),
    [channelId],
  );

  useEffect(() => {
    if (!column || !scroller || typeof ResizeObserver === 'undefined') return;
    last.current = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? column.getBoundingClientRect().height;
      const before = last.current;
      last.current = height;
      if (before === null) return;
      const delta = height - before;
      if (Math.abs(delta) < MIN_DELTA) return;

      const content = scroller.querySelector(':scope > .ix-timeline__content');
      const header = scroller.querySelector(':scope > .ix-timeline__header');
      const receipt = scroller.querySelector(':scope > .glass-tl-receipt');
      const empty = scroller.querySelector(':scope > [data-timeline-empty]');
      const overflow = scroller.scrollHeight - scroller.clientHeight > 1;
      // After the change: the viewport shrank by `delta` (it grew when delta is negative), so a scroller
      // that was at its end is `delta` short of it now (or already clamped to it when the box shrank).
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      const wasAtEnd = !overflow || distance - delta <= AT_END_PX || (delta < 0 && distance <= AT_END_PX);
      if (overflow && wasAtEnd && delta > 0) scroller.scrollTop += delta;

      if (ixReduced() || performance.now() - lastSend.current < FEED_SEND_QUIET_MS) return;
      const anchor = empty?.firstElementChild?.getAttribute('data-ix-anchor') ?? empty?.getAttribute('data-ix-anchor');
      const moves = planFeedMoves({
        delta,
        header,
        content,
        receipt,
        empty,
        emptyShare: anchor === 'end' ? 1 : 0.5,
        overflow,
        atEnd: wasAtEnd,
      });
      const duration = delta > 0 ? FEED_GROW_MS : FEED_SHRINK_MS;
      for (const move of moves) {
        const element = move.element as HTMLElement;
        if (typeof element.animate !== 'function') continue;
        const animation = element.animate(
          [{ transform: `translateY(${Math.round(move.from * 100) / 100}px)` }, { transform: 'translateY(0)' }],
          { duration, easing: IX_SPRING, composite: 'add' },
        );
        animation.id = 'ix-conversation:feed';
      }
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [column, scroller]);
}
