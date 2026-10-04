import { compareMessageIds, snowflakeTime } from '../../../hooks/useChannelPreviews';
import type { Message } from '../../../types';

/**
 * Where the New divider goes (docs/index-spec.md §4.11): above the first
 * message the reader had not read when they opened the conversation.
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
