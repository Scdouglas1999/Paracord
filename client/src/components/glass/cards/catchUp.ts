import { compareMessageIds, snowflakeTime } from '../../../hooks/useChannelPreviews';
import type { Message } from '../../../types';

/**
 * The catch-up divider's logic (docs/glass-spec.md §3.2): "6 new since 8:58".
 *
 * Pure: the timeline hands over the messages it holds, the message id the
 * reader had read up to when they opened the conversation, and who the reader
 * is. Nothing here reads a store, so the rule is tested without React.
 *
 * WHAT COUNTS. The divider says how much you missed: what other people wrote
 * after your read position. Your own messages (sent from another device) and
 * the conversation's own news (a pin notice) are not something you missed, so
 * they neither open the divider nor add to its number.
 */

export interface CatchUpBoundary {
  /** Index in `messages` of the first message you missed: the divider sits above it. */
  index: number;
  /** How many you missed. A lower bound when `atLeast`. */
  count: number;
  /**
   * The loaded history starts inside what you missed, so older unread messages
   * may exist that are not loaded: the number is "N or more".
   */
  atLeast: boolean;
  /** When you had read up to (RFC 3339), or null when it cannot be told. */
  since: string | null;
}

/** Find where the reader's unread messages start, or null when they missed nothing. */
export function findCatchUp(
  messages: readonly Message[],
  readUpToId: string | null | undefined,
  selfId: string | null | undefined,
  isSystem: (message: Message) => boolean,
  hasMore: boolean,
): CatchUpBoundary | null {
  if (!readUpToId) return null;
  let first = -1;
  let count = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (compareMessageIds(message.id, readUpToId) <= 0) continue;
    if (message.author?.id === selfId || isSystem(message)) continue;
    if (first < 0) first = i;
    count += 1;
  }
  if (first < 0) return null;

  const marker = messages.find((message) => message.id === readUpToId);
  const minted = snowflakeTime(readUpToId);
  const since = minted != null
    ? new Date(minted).toISOString()
    : marker?.timestamp || marker?.created_at || null;

  return { index: first, count, atLeast: first === 0 && hasMore, since };
}

/** Is `iso` on the same calendar day as `nowMs`? */
function sameDay(iso: string, nowMs: number): boolean {
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toDateString() === new Date(nowMs).toDateString();
}

/**
 * The clock the divider quotes. Today it is the bare time ("8:58", the
 * reference's own form: the day is the conversation's, and a 12-hour "PM" here
 * is noise); on another day it says which ("Tue 8:58 PM"), because a bare time
 * from yesterday would be a lie.
 */
export function catchUpClock(iso: string, nowMs = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(iso, nowMs)) {
    return clock
      .formatToParts(date)
      .filter((part) => part.type !== 'dayPeriod')
      .map((part) => part.value)
      .join('')
      .trim();
  }
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  return `${day} ${clock.format(date)}`;
}

/** "6 new since 8:58", "50+ new since 8:58", "1 new". */
export function catchUpLabel(boundary: Pick<CatchUpBoundary, 'count' | 'atLeast' | 'since'>, nowMs = Date.now()): string {
  const number = boundary.atLeast ? `${boundary.count}+` : String(boundary.count);
  const since = boundary.since ? catchUpClock(boundary.since, nowMs) : '';
  return since ? `${number} new since ${since}` : `${number} new`;
}
