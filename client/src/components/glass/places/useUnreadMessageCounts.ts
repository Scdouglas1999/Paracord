import { useEffect, useMemo, useReducer } from 'react';

import { captureScopedOperation } from '../../../lib/operationContext';
import { accountScopeKey, type AccountScope } from '../../../lib/serverScope';
import type { Message } from '../../../types';
import { COUNT_PROBE_LIMIT } from './model';

/**
 * How many messages are unread in a channel, when that can be known exactly.
 *
 * WHY THIS EXISTS. A read state carries only the last message you read and your
 * mention count, and a channel carries only its newest message id. Snowflake ids
 * order messages but cannot count them, so the number on a row ("Clips  3") is
 * not derivable from anything the client holds for a channel it has not opened.
 *
 * THE RULE (one path, no guessing):
 *
 *   - A channel is *unread* from the two ids alone (`isMessageUnread`): instant,
 *     exact, no request.
 *   - Its *count* is asked of the server: the messages after your read position,
 *     `GET /channels/{id}/messages?after={cursor}&limit=100`. Fewer than 100 back
 *     is the exact count; 100 back is "99+".
 *   - Until the answer is in, and if the request fails, there is no number: the
 *     row shows an unread dot. It never shows a count it did not get.
 *
 * COST. Only unread channels of the server on screen, never one that has a
 * mention (the mention badge outranks a count), at most three requests at once,
 * each answered from a cache while your read position and the channel's newest
 * message are unchanged, and a new message re-asks after a short quiet so a busy
 * channel is one request per burst. When the server reports unread counts on
 * read states this whole file goes away.
 */

export interface UnreadTarget {
  channelId: string;
  scope: AccountScope;
  /** Your read position, or null when you have never opened the channel. */
  cursor: string | null;
  /** The channel's newest message id. */
  tail: string;
}

const CONCURRENCY = 3;
const QUIET_MS = 400;
const RETRY_MS = 30_000;
const MAX_ENTRIES = 600;

interface Entry {
  cursor: string;
  tail: string;
  count: number;
}

const cache = new Map<string, Entry>();
/** What each key most recently asked for; a job that finds a newer ask stands down. */
const wanted = new Map<string, { cursor: string; tail: string }>();
const inflight = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const queue: Array<() => Promise<void>> = [];
let running = 0;

/** A channel's key: channel ids are per server, so the account is part of it. */
export const unreadKey = (scope: AccountScope, channelId: string) => `${accountScopeKey(scope)}\u0000${channelId}`;
const keyOf = unreadKey;
const cursorOf = (cursor: string | null) => cursor ?? '0';

function notify() {
  for (const listener of listeners) listener();
}

function pump() {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    running += 1;
    void job().finally(() => {
      running -= 1;
      pump();
    });
  }
}

async function countUnread(scope: AccountScope, channelId: string, cursor: string): Promise<number> {
  const context = captureScopedOperation(scope);
  try {
    const { data } = await context.request<Message[]>({
      method: 'GET',
      url: `/channels/${encodeURIComponent(channelId)}/messages`,
      params: { after: cursor, limit: COUNT_PROBE_LIMIT },
      timeout: 15_000,
    });
    context.assertCurrent();
    if (!Array.isArray(data)) throw new Error('Unexpected unread response');
    if (data.length >= COUNT_PROBE_LIMIT) return COUNT_PROBE_LIMIT;
    // What you wrote yourself, from another device, is not news to you.
    return data.filter((message) => message.author?.id !== scope.userId).length;
  } finally {
    context.dispose();
  }
}

function request(target: UnreadTarget, delay: number) {
  const key = keyOf(target.scope, target.channelId);
  const cursor = cursorOf(target.cursor);
  wanted.set(key, { cursor, tail: target.tail });
  const pending = timers.get(key);
  if (pending) clearTimeout(pending);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      queue.push(async () => {
        const ask = wanted.get(key);
        if (!ask || ask.cursor !== cursor || ask.tail !== target.tail || inflight.has(key)) return;
        inflight.add(key);
        try {
          const count = await countUnread(target.scope, target.channelId, cursor);
          const latest = wanted.get(key);
          if (latest && latest.cursor === cursor && latest.tail === target.tail) {
            cache.set(key, { cursor, tail: target.tail, count });
            while (cache.size > MAX_ENTRIES) {
              const oldest = cache.keys().next();
              if (oldest.done) break;
              cache.delete(oldest.value);
            }
            notify();
          }
        } catch {
          // No number: the row keeps its dot. Ask again in a while, and on the
          // next change to the channel.
          if (wanted.get(key)?.tail === target.tail) wanted.delete(key);
          setTimeout(notify, RETRY_MS);
        } finally {
          inflight.delete(key);
          const latest = wanted.get(key);
          if (latest && (latest.cursor !== cursor || latest.tail !== target.tail)) {
            // A newer ask may have reached the queue while this request was
            // running. Its job stood down; release it and wake the subscribers
            // so the latest cursor/tail is fetched instead of staying a dot.
            wanted.delete(key);
            notify();
          }
        }
      });
      pump();
    }, delay),
  );
}

/** Test seam: forget everything. */
export function resetUnreadCounts(): void {
  cache.clear();
  wanted.clear();
  inflight.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  queue.length = 0;
}

/**
 * The exact unread count per channel (keyed by {@link unreadKey}), or null when it
 * is not (yet) known. Pass only channels that are unread and have no mention.
 */
export function useUnreadMessageCounts(targets: readonly UnreadTarget[]): ReadonlyMap<string, number | null> {
  const [tick, bump] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  // Targets are rebuilt on every store change; what matters is what they say.
  const signature = targets
    .map((target) => `${keyOf(target.scope, target.channelId)}\u0001${cursorOf(target.cursor)}\u0001${target.tail}`)
    .join('\u0002');

  useEffect(() => {
    for (const target of targets) {
      const key = keyOf(target.scope, target.channelId);
      const cursor = cursorOf(target.cursor);
      const held = cache.get(key);
      if (held && held.cursor === cursor && held.tail === target.tail) continue;
      const current = wanted.get(key);
      if (current && current.cursor === cursor && current.tail === target.tail) continue;
      // The first ask goes out at once; a change to a channel we already counted
      // waits out the burst.
      request(target, held ? QUIET_MS : 0);
    }
    // `targets` is read through its signature; `tick` re-runs it after a failure
    // has waited out its retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, tick]);

  return useMemo(() => {
    const counts = new Map<string, number | null>();
    for (const target of targets) {
      const key = keyOf(target.scope, target.channelId);
      const held = cache.get(key);
      const exact = held && held.cursor === cursorOf(target.cursor) && held.tail === target.tail;
      counts.set(key, exact ? held.count : null);
    }
    return counts;
    // `tick` is the cache's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, tick]);
}
