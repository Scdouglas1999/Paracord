import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  captureRoom,
  fadeIn,
  flySend,
  ghostOut,
  makeRoom,
  motionToken,
  ms,
  onMotion,
  prefersReducedMotion,
  type Flight,
  type MotionEvents,
} from '../../lib/motion';
import type { Message, MessageAuthor } from '../../types';
import { createPendingSay, matchArrivals, pendingMessageId, type PendingSay } from './pendingSay';

/**
 * The timeline's half of the send flight (`lib/motion/sendFlight.ts`,
 * docs/glass-spec.md §9).
 *
 * The composer says "a message is leaving, from here" on the keystroke. This
 * hook answers on the same frame: it appends a stand-in row to the rows the
 * list draws (never to the store — see `pendingSay.ts`), keeps that row out of
 * sight, makes room for it, and sends a ghost bubble from the words to it. Then
 * it waits for the server without anyone waiting for it:
 *
 *   · the delivered message takes the stand-in's slot in the same render, and
 *     the row element is the same node, so there is no double and no flicker;
 *   · the row is revealed in the same task the ghost is removed, at the later
 *     of "the ghost landed" and "the server answered" — never twice, and no
 *     second animation on the real row;
 *   · a send that fails lets the bubble go (it freezes and fades, the rows
 *     glide back down) while the composer puts the words back;
 *   · one the outbox could not deliver in good time (the queue card above the
 *     composer shows for it) is let go the same way — the composer says so on
 *     the bus — so the card and a bubble never claim the same message.
 *
 * Reduced motion, a timeline that is not at its newest messages, one still
 * loading, or a row with no bubble to land on all decline: the send is then the plain
 * "text clears, row appears" and `onGrounded` is told, so the arrival settles
 * in as it always did.
 */

type Say = MotionEvents['say:sent'];

/**
 * A bubble the composer never lets go of and the server never answers for (a
 * stalled outbox with no card, a lost event) lets go on its own, and the
 * message settles in if it does arrive.
 */
const FAILSAFE_MS = 6_000;
/** Within this of the newest message counts as "at the bottom" (the list's own rule). */
const NEAR_BOTTOM_PX = 140;
/** More bubbles than this in the air at once is a held-down Enter, not a conversation. */
const MAX_IN_FLIGHT = 4;

interface FlightRecord {
  say: Say;
  flight: Flight | null;
  landed: boolean;
  /** The delivered message's id, once it has arrived. */
  arrivedId: string | null;
  failsafe: number;
}

interface Takeoff {
  say: Say;
  /** Where the rows were before the stand-in existed. */
  room: ReturnType<typeof captureRoom>;
}

export interface SendFlightHost {
  channelId: string;
  me: MessageAuthor | null;
  /** The delivered messages. */
  messages: Message[];
  scroller: RefObject<HTMLElement | null>;
  /** The send is not taking off: the arrival will settle in instead. */
  onGrounded: (say: Say) => void;
  /** Lay a newly mounted row out at its measured size, now rather than on the next render. */
  measureRow: (row: HTMLElement) => void;
  /** The conversation is still loading: there is no timeline to land in yet. */
  loading?: boolean;
  /**
   * Filled by the hook: a delivered message's id → the id of the stand-in it
   * replaced. The list keys a row by `sendRowKey`, so the stand-in and the
   * message that takes its slot share one key and React keeps one DOM node
   * across the hand-off, whatever else moves in the list. Never cleared while
   * the list lives: a key that changed later would remount the row.
   */
  rowKeys?: Map<string, string>;
}

/**
 * The React key of a drawn message's row: the stand-in's own id, for the
 * stand-in AND for the delivered message that replaced it (see `rowKeys`).
 */
export function sendRowKey(message: Pick<Message, 'id'>, rowKeys: ReadonlyMap<string, string> | null | undefined): string {
  return rowKeys?.get(message.id) ?? message.id;
}

function rowElement(id: string): HTMLElement | null {
  return document.getElementById(`msg-${id}`);
}

/** The rows on screen, as the flight measures them: each virtual row's content. */
function timelineRows(scroller: HTMLElement): HTMLElement[] {
  const content = scroller.querySelector<HTMLElement>('.glass-timeline__content');
  const view = scroller.getBoundingClientRect();
  const rows: HTMLElement[] = [];
  for (const wrapper of Array.from(content?.children ?? [])) {
    const row = wrapper.firstElementChild;
    if (!(row instanceof HTMLElement)) continue;
    const box = row.getBoundingClientRect();
    // Rows the virtualizer keeps mounted beyond the edge are not seen to move.
    if (box.bottom < view.top - 80 || box.top > view.bottom + 80) continue;
    rows.push(row);
  }
  const receipt = scroller.querySelector<HTMLElement>('.glass-tl-receipt');
  if (receipt) rows.push(receipt);
  return rows;
}

function hold(row: HTMLElement | null, phase: 'air' | 'held'): void {
  if (!row) return;
  if (row.getAttribute('data-flight') !== phase) row.setAttribute('data-flight', phase);
  row.setAttribute('aria-hidden', 'true');
}

function release(row: HTMLElement | null): void {
  if (!row) return;
  row.removeAttribute('data-flight');
  row.removeAttribute('aria-hidden');
}

/** The messages to draw: the delivered ones, then the stand-ins not yet answered for. */
export function useSendFlight({ channelId, me, messages, scroller, onGrounded, measureRow, loading = false, rowKeys }: SendFlightHost): Message[] {
  const [pendings, setPendings] = useState<PendingSay[]>([]);
  const records = useRef(new Map<string, FlightRecord>());
  const takeoffs = useRef(new Map<string, Takeoff>());
  const gliding = useRef<ReturnType<typeof captureRoom> | null>(null);

  const arrivals = useMemo(() => matchArrivals(messages, pendings, me?.id), [messages, pendings, me?.id]);
  // The pairing is known here, in the render the delivered message first
  // replaces its stand-in: record it now, so that render already keys the
  // delivered row as the stand-in. Idempotent (a re-render writes the same pair).
  if (rowKeys) {
    for (const [nonce, arrived] of arrivals) {
      if (!rowKeys.has(arrived.id)) rowKeys.set(arrived.id, pendingMessageId(nonce));
    }
  }
  const open = useMemo(() => pendings.filter((pending) => !arrivals.has(pending.nonce)), [pendings, arrivals]);
  const drawn = useMemo<Message[]>(
    () => (open.length > 0 ? [...messages, ...open.map((pending) => pending.message)] : messages),
    [messages, open],
  );

  // What the handlers need to know NOW, without re-subscribing every render.
  const latest = useRef({ messages, me, arrivals, onGrounded, measureRow, loading });
  useLayoutEffect(() => {
    latest.current = { messages, me, arrivals, onGrounded, measureRow, loading };
  });

  /** The row a send is, wherever it is now: the stand-in, or the message that replaced it. */
  const rowOf = (nonce: string): HTMLElement | null =>
    rowElement(latest.current.arrivals.get(nonce)?.id ?? pendingMessageId(nonce));
  const bubbleOf = (nonce: string): HTMLElement | null =>
    rowOf(nonce)?.querySelector<HTMLElement>('.glass-bubble') ?? null;
  const receiptLine = (): HTMLElement | null =>
    scroller.current?.querySelector<HTMLElement>('.glass-tl-receipt') ?? null;

  const forget = (nonce: string): FlightRecord | undefined => {
    const record = records.current.get(nonce);
    if (!record) return undefined;
    records.current.delete(nonce);
    window.clearTimeout(record.failsafe);
    takeoffs.current.delete(nonce);
    return record;
  };

  /** The bubble is on its mark AND the server has answered: this send is over. */
  const settle = (nonce: string) => {
    const record = records.current.get(nonce);
    if (!record || !record.landed || !record.arrivedId) return;
    forget(nonce);
    release(rowElement(record.arrivedId));
    const line = receiptLine();
    if (line && records.current.size === 0) {
      // The server's answer comes last, and only once the bubble is on its mark.
      fadeIn(line.querySelector<HTMLElement>('[data-motion-receipt]'), { delay: ms('--duration-fast') });
      line.removeAttribute('data-flight-hold');
    }
  };

  const landed = (nonce: string) => {
    const record = records.current.get(nonce);
    if (!record) return;
    record.landed = true;
    if (record.arrivedId) settle(nonce);
    // Still waiting on the server: the bubble stays where it landed, inert.
    else hold(rowOf(nonce), 'held');
  };

  /** Let a send's bubble go: it never arrived, or it was refused. */
  const drop = (nonce: string, grounded = false) => {
    const record = forget(nonce);
    if (!record) return;
    record.flight?.retire();
    const rows = scroller.current ? timelineRows(scroller.current) : [];
    // The rows the stand-in made room for glide back, instead of jumping.
    gliding.current = rows.length > 0 ? captureRoom(rows) : null;
    setPendings((current) => current.filter((pending) => pending.nonce !== nonce));
    if (records.current.size === 0) receiptLine()?.removeAttribute('data-flight-hold');
    // A send that was only slow still settles in when it does arrive.
    if (grounded) latest.current.onGrounded(record.say);
  };

  useEffect(
    () => onMotion('say:sent', (say) => {
      if (say.channelId !== channelId) return;
      const { messages: shown, me: author, onGrounded: ground, loading: busy } = latest.current;
      const element = scroller.current;
      const nearBottom = element
        ? element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX
        : false;
      if (!say.origin || prefersReducedMotion() || !author || !element || busy || !nearBottom
        || records.current.size >= MAX_IN_FLIGHT) {
        ground(say);
        return;
      }
      takeoffs.current.set(say.nonce, { say, room: captureRoom(timelineRows(element)) });
      // The first thing said in a conversation takes the empty state's place: it
      // leaves the way anything dismissed does, instead of vanishing.
      ghostOut(element.querySelector('[data-timeline-empty]'), (copy) =>
        copy.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: ms('--duration-exit-slow'),
          easing: motionToken('--ease-in'),
          fill: 'forwards',
        }),
      );
      records.current.set(say.nonce, {
        say,
        flight: null,
        landed: false,
        arrivedId: null,
        failsafe: window.setTimeout(() => drop(say.nonce, true), FAILSAFE_MS),
      });
      const pending = createPendingSay({
        nonce: say.nonce,
        channelId,
        text: say.text,
        author,
        replyToId: say.replyToId,
        knownIds: shown.map((message) => message.id),
        now: Date.now(),
      });
      // Finished sends are forgotten as the next begins, so nothing renders for them.
      setPendings((current) => [...current.filter((entry) => records.current.has(entry.nonce)), pending]);
    }),
    // The handlers read refs and a stable setter only, so they never go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelId, scroller],
  );

  useEffect(
    () => onMotion('say:settled', (say) => {
      if (say.channelId === channelId && !say.ok) drop(say.nonce);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelId],
  );

  // After every render: keep the stand-ins out of sight (React may have made
  // the row's node again), notice the arrivals, take off.
  useLayoutEffect(() => {
    for (const [nonce, record] of [...records.current]) {
      const arrived = arrivals.get(nonce);
      if (arrived && !record.arrivedId) {
        record.arrivedId = arrived.id;
        if (record.landed) {
          settle(nonce);
          continue;
        }
      }
      hold(rowOf(nonce), record.landed ? 'held' : 'air');
    }
    if (records.current.size > 0) receiptLine()?.setAttribute('data-flight-hold', '');

    const glide = gliding.current;
    gliding.current = null;
    if (glide) makeRoom(glide);

    if (takeoffs.current.size === 0) return;
    const flights = [...takeoffs.current];
    takeoffs.current.clear();
    // After the render's own follow-up renders (the virtualizer measures the
    // new row and renders again, synchronously, before paint): measure once
    // the layout is the one that will be painted.
    queueMicrotask(() => {
      for (const [nonce, { say, room }] of flights) {
        const record = records.current.get(nonce);
        const element = scroller.current;
        if (!record || !element || !say.origin) continue;
        const row = rowOf(nonce);
        if (!row?.querySelector('.glass-bubble')) {
          // Nothing to land on (an event card is not a bubble): no flight.
          drop(nonce, true);
          continue;
        }
        hold(row, 'air');
        // The list is virtual: until the new row has been measured it is laid
        // out at an estimate, and the measuring render comes later than this
        // task. Take the measurement now, so the layout the flight reads is the
        // one that will be painted.
        latest.current.measureRow(row);
        // Hold the newest message where the reader is looking.
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
        makeRoom(room);
        record.flight = flySend({
          text: say.text,
          origin: say.origin,
          bubble: () => bubbleOf(nonce),
          onLand: () => landed(nonce),
        });
        if (!record.flight) landed(nonce);
      }
    });
  });

  // Leaving the conversation ends every flight with it.
  useEffect(() => () => {
    for (const record of records.current.values()) {
      window.clearTimeout(record.failsafe);
      record.flight?.land();
    }
    records.current.clear();
    takeoffs.current.clear();
  }, []);

  return drawn;
}
