/**
 * The last line in each of a building's text rooms (docs/lantern-stage-spec.md
 * §7.3: "text rooms as rows — window dot, name, **last author · time,
 * preview**, reader stack, mention chip").
 *
 * The Lobby already knows the last line of any room this client has *opened* —
 * `messageStore` is holding its timeline. Every other room had only a name and
 * a snowflake, so a building you had not read through rendered as a column of
 * bare names, which is the half of §7.3 that was missing.
 *
 * Why this does not go through `messageStore.fetchMessages`: that call is the
 * open room's own history loader and it **aborts every other channel's
 * in-flight fetch** when it starts, so asking it for five rooms at once would
 * cancel four of them and race the room you are actually reading. This is a
 * separate, read-only door: one `limit=1` request per room, at most
 * {@link MAX_PREVIEW_ROOMS} rooms, once per room per session, two at a time,
 * and nothing it learns is written into the message store.
 *
 * It refuses the same three things the media strip refuses (`useRecentMedia`):
 * it shows no ciphertext, it invents nothing for a room it could not read, and
 * a room that has genuinely never been written in says so rather than
 * borrowing its neighbour's line.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { channelApi } from '../../../api/channels';
import { displayName } from '../../../lib/displayName';
import { stripMarkdown } from '../../../lib/markdown';
import type { Message } from '../../../types';
import { messageTimeMs } from './useRecentMedia';

/** One room's last line, as the row draws it. */
export interface RoomPreview {
  /** The message this preview was taken from — the cache's identity. */
  messageId: string;
  /** Who wrote it. Null when the server sent no author (a system line). */
  author: string | null;
  /** When, in ms. Null when neither the stamp nor the id could say. */
  atMs: number | null;
  /** The line itself, markdown flattened. Empty for an attachment-only post. */
  preview: string;
}

/**
 * A room the Lobby wants a line for: its id and the newest message the channel
 * list says it holds (`null` = the room has never been written in).
 */
export interface PreviewRequest {
  channelId: string;
  lastMessageId: string | null;
}

/**
 * Rooms to fetch a line for in one pass. A building with forty text rooms is
 * not forty requests deep on open; the rooms below the cut keep the name and
 * stamp they already had.
 */
export const MAX_PREVIEW_ROOMS = 12;

/** Two at a time: enough to fill a Lobby quickly, far from any rate ceiling. */
const CONCURRENCY = 2;

/**
 * Session cache, keyed by channel. Survives navigating out of the building and
 * back, which is the common case and would otherwise re-fetch every room.
 * `null` means "asked, and there is nothing to show" — a 403, a deleted
 * message, an empty room — so it is never asked twice.
 */
const cache = new Map<string, RoomPreview | null>();

/** Test seam: forget everything this module has learned. */
export function resetRoomPreviewCache(): void {
  cache.clear();
}

/** Turn one API message into the row's line, or null when there is none to show. */
export function toPreview(message: Message | undefined | null): RoomPreview | null {
  if (!message) return null;
  // Ciphertext is not a preview. The row keeps its name and stamp instead.
  if (message.e2ee) return null;
  const content = typeof message.content === 'string' ? message.content : '';
  return {
    messageId: message.id,
    author: message.author ? displayName(message.author) : null,
    atMs: messageTimeMs(message),
    preview: stripMarkdown(content).replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Last lines for the rooms handed in, newest-first order preserved by the
 * caller. Rooms already known to the message store should not be listed here —
 * the Lobby prefers what it has actually loaded.
 */
export function useRoomPreviews(requests: readonly PreviewRequest[]): Map<string, RoomPreview> {
  const [version, bump] = useState(0);
  const inFlight = useRef(false);

  // The identity of the work: which rooms, at which message.
  const key = requests
    .slice(0, MAX_PREVIEW_ROOMS)
    .map((request) => `${request.channelId}:${request.lastMessageId ?? ''}`)
    .join(',');

  useEffect(() => {
    if (!key || inFlight.current) return;
    const wanted = key
      .split(',')
      .map((entry) => {
        const cut = entry.lastIndexOf(':');
        return { channelId: entry.slice(0, cut), lastMessageId: entry.slice(cut + 1) };
      })
      // A room with no last message has nothing to fetch, and a room whose
      // newest message we have already read needs no second request.
      .filter((entry) => entry.lastMessageId !== '')
      .filter((entry) => {
        const known = cache.get(entry.channelId);
        return known === undefined || (known !== null && known.messageId !== entry.lastMessageId);
      });
    if (wanted.length === 0) return;

    let cancelled = false;
    inFlight.current = true;

    const queue = [...wanted];
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || cancelled) return;
        try {
          const response = await channelApi.getMessages(next.channelId, { limit: 1 });
          const list = Array.isArray(response.data) ? response.data : [];
          cache.set(next.channelId, toPreview(list[0]));
        } catch {
          // A room this account cannot read, or a request that failed: the row
          // keeps the name and stamp it already had. Never a toast — the reader
          // did not ask for this.
          cache.set(next.channelId, null);
        }
      }
    };

    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      inFlight.current = false;
      if (!cancelled) bump((n) => n + 1);
    });

    return () => {
      cancelled = true;
      inFlight.current = false;
    };
  }, [key]);

  return useMemo(() => {
    const out = new Map<string, RoomPreview>();
    for (const entry of key ? key.split(',') : []) {
      const cut = entry.lastIndexOf(':');
      const channelId = entry.slice(0, cut);
      const known = cache.get(channelId);
      if (known) out.set(channelId, known);
    }
    return out;
    // `key` is the stable identity of `requests`; the cache is module state, so
    // `version` is what tells this memo a fetch has landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
}
