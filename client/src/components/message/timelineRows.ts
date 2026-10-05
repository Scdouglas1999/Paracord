import type { Message } from '../../types';

/**
 * The rows the Index timeline draws (docs/index-spec.md §4.11), as a pure
 * function of what is on the conversation, so the rules are tested without
 * React or a virtualizer:
 *
 *   - messages GROUP by author: the same author, nothing between them, within
 *     five minutes; a reply, a system line or the New divider starts a new group;
 *   - a TIME DIVIDER precedes the first row, and any row that starts a new
 *     calendar day or comes more than 30 minutes after the one before it;
 *   - nobody's voice joins or leaves are drawn here: who is in a voice channel
 *     is the room card's to show (§4.11);
 *   - the NEW divider sits above the first message you had not read;
 *   - while older history exists, three skeleton bubbles sit at the top.
 *
 * Every row has a key that is its identity, never its position: the send
 * flight's stand-in and the message that replaces it share one (`sendRowKey`),
 * and a row that moves in the list keeps its DOM node.
 */

/** Two messages by one author within this of each other read as one group. */
export const GROUP_WINDOW_MS = 5 * 60_000;
/** More than this between two rows puts a time divider between them. */
export const DIVIDER_GAP_MS = 30 * 60_000;

export interface MessageRow {
  type: 'message';
  key: string;
  message: Message;
  /** Position among the drawn messages (for `aria-posinset`). */
  messageIndex: number;
  /** Continues the group above it. */
  isGrouped: boolean;
  /** Nothing in the same group follows: the group's face goes on this row. */
  isLastInGroup: boolean;
  /** Written by the server about the conversation: a centered line, not a bubble. */
  isSystem: boolean;
  replyParentId: string | null;
}

export type TimelineRow =
  | { type: 'history'; key: 'history' }
  | { type: 'divider'; key: string; at: string }
  | { type: 'new'; key: 'new' }
  | MessageRow
  | { type: 'typing'; key: 'typing' }
  | { type: 'sentinel'; key: 'sentinel' };

export function messageTime(message: { timestamp?: string; created_at?: string }): string {
  return message.timestamp || message.created_at || '';
}

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

export function isDifferentDay(a: string, b: string): boolean {
  const first = new Date(a);
  const second = new Date(b);
  if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) return false;
  return first.toDateString() !== second.toDateString();
}

type GroupableMessage = {
  author?: { id?: string | null } | null;
  timestamp?: string;
  created_at?: string;
};

/** Same author, close in time (§4.11: five minutes). Nothing else is decided here. */
export function shouldGroup(prev: GroupableMessage | null, curr: GroupableMessage): boolean {
  if (!prev) return false;
  // Author may be absent on a malformed payload. Two authorless rows are not
  // "the same author": never group them, and never dereference blindly.
  const prevAuthorId = prev.author?.id;
  const currAuthorId = curr.author?.id;
  if (!prevAuthorId || !currAuthorId || prevAuthorId !== currAuthorId) return false;
  const prevTs = messageTime(prev);
  const currTs = messageTime(curr);
  if (!prevTs || !currTs) return false;
  const diff = timeOf(currTs) - timeOf(prevTs);
  return diff >= 0 && diff < GROUP_WINDOW_MS;
}

/** A divider between two instants: a new calendar day, or more than 30 minutes apart. */
export function needsDivider(previous: string | null, current: string): boolean {
  if (!current) return false;
  if (!previous) return true;
  if (isDifferentDay(previous, current)) return true;
  const gap = timeOf(current) - timeOf(previous);
  return Number.isFinite(gap) && gap > DIVIDER_GAP_MS;
}

export interface BuildRowsInput {
  /** The messages to draw (delivered, then the send flight's open stand-ins). */
  drawn: readonly Message[];
  /** A message row's key (`sendRowKey`). */
  keyOf: (message: Message) => string;
  /** The message this one answers, if any. */
  replyParentOf: (message: Message, previous: Message | null) => string | null;
  isSystem: (message: Message) => boolean;
  /** The drawn index of the first unread message, or null. */
  newIndex?: number | null;
  typing?: boolean;
  /** Older history exists that is not loaded. */
  hasMore?: boolean;
}

export function buildTimelineRows({
  drawn,
  keyOf,
  replyParentOf,
  isSystem,
  newIndex = null,
  typing = false,
  hasMore = false,
}: BuildRowsInput): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const used = new Set<string>();
  /** A key never repeats, even if a pairing went wrong upstream: React would merge two rows. */
  const unique = (key: string, fallback: string): string => {
    const chosen = used.has(key) ? `${key}#${fallback}` : key;
    used.add(chosen);
    return chosen;
  };

  if (hasMore) rows.push({ type: 'history', key: 'history' });

  let previousAt: string | null = null;
  let previousMessage: Message | null = null;
  /** The last row was a plain message that a following one may continue. */
  let open: MessageRow | null = null;

  drawn.forEach((message, index) => {
    const at = messageTime(message);
    const divider = needsDivider(previousAt, at);
    const key = unique(keyOf(message), message.id);
    const system = isSystem(message);
    const parent = replyParentOf(message, previousMessage);
    const atNew = newIndex === index;
    if (divider) rows.push({ type: 'divider', key: unique(`divider:${key}`, key), at });
    if (atNew) rows.push({ type: 'new', key: 'new' });
    const continues =
      open !== null &&
      !divider &&
      !atNew &&
      !system &&
      !parent &&
      shouldGroup(open.message, message);
    if (open && !continues) open.isLastInGroup = true;
    const row: MessageRow = {
      type: 'message',
      key,
      message,
      messageIndex: index,
      isGrouped: continues,
      isLastInGroup: true,
      isSystem: system,
      replyParentId: parent,
    };
    if (continues && open) open.isLastInGroup = false;
    rows.push(row);
    open = system ? null : row;
    previousAt = at || previousAt;
    previousMessage = message;
  });

  if (typing) rows.push({ type: 'typing', key: 'typing' });
  rows.push({ type: 'sentinel', key: 'sentinel' });
  return rows;
}

/* ---- Time divider words (§4.11) ---------------------------------------------------- */

let clock: Intl.DateTimeFormat | null = null;
let monthDay: Intl.DateTimeFormat | null = null;
let monthDayYear: Intl.DateTimeFormat | null = null;
let weekday: Intl.DateTimeFormat | null = null;

/** A message's clock: "9:41 PM", in the locale's own form. One formatter for the whole timeline. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  clock ??= new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  return clock.format(date);
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * What a time divider says: the day part and the clock, "Today" / "9:41 PM",
 * "Yesterday" / "6:20 PM", "Tuesday" (within six days), "Sep 28", "Sep 28, 2025".
 */
export function timeDividerParts(iso: string, nowMs = Date.now()): { day: string; time: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { day: '', time: iso };
  const days = Math.round((startOfDay(nowMs) - startOfDay(date.getTime())) / 86_400_000);
  let day: string;
  if (days === 0) day = 'Today';
  else if (days === 1) day = 'Yesterday';
  else if (days > 1 && days <= 6) {
    weekday ??= new Intl.DateTimeFormat(undefined, { weekday: 'long' });
    day = weekday.format(date);
  } else if (date.getFullYear() === new Date(nowMs).getFullYear()) {
    monthDay ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    day = monthDay.format(date);
  } else {
    monthDayYear ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    day = monthDayYear.format(date);
  }
  return { day, time: clockTime(iso) };
}
