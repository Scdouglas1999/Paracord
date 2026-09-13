/**
 * "Recently in the shop" (docs/lantern-stage-spec.md §7.3).
 *
 * The strip shows images the reader **can already see**: it reads the message
 * timelines this client has itself loaded for this building's text rooms. There
 * is no new endpoint, no new store and no background fetch — an unopened room
 * contributes nothing rather than a guess, exactly like WP1's "authored"
 * reading term (`lib/attention/roomLight.ts` §3).
 *
 * Three things it refuses to do:
 *
 *  1. **Show what the reader cannot decrypt.** An end-to-end encrypted message's
 *     attachment is ciphertext until `EncryptedAttachment` unwraps it; a
 *     thumbnail strip is not the place to start that, so E2EE messages are
 *     skipped rather than rendered as a broken tile.
 *  2. **Show a federated file through the wrong door.** An attachment with an
 *     `origin_server` has to be proxied per channel; the strip skips those
 *     instead of pointing an `<img>` at a URL that will 404.
 *  3. **Invent a count.** "14 photos this week" counts what it can actually see.
 */

import { useMemo } from 'react';

import { useCurrentMessageStore } from '../../../hooks/useMessageStore';
import { isAllowedImageMimeType } from '../../../lib/security';
import { snowflakeToMs } from '../../../lib/attention/conversationModel';
import type { Attachment, Message } from '../../../types';
import { MEDIA_WEEK_MS } from './lobbyTime';

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp)$/i;

/** The same test `MessageList` applies before it renders an inline image. */
export function isImageAttachment(attachment: Pick<Attachment, 'content_type' | 'filename'>): boolean {
  const contentType = (attachment.content_type || '').toLowerCase();
  if (contentType.startsWith('image/')) return isAllowedImageMimeType(contentType);
  return IMAGE_EXTENSION_RE.test(attachment.filename || '');
}

/** When a message happened: its own stamp, else its snowflake. */
export function messageTimeMs(message: Pick<Message, 'id' | 'timestamp' | 'created_at'>): number | null {
  const stamp = message.timestamp || message.created_at;
  if (stamp) {
    const parsed = Date.parse(stamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (!/^\d{1,19}$/.test(message.id)) return null;
  try {
    return snowflakeToMs(message.id);
  } catch {
    return null;
  }
}

export interface LobbyMediaItem {
  key: string;
  channelId: string;
  attachment: Attachment;
  atMs: number;
  /** Who shared it — the alt text names a person, not a filename. */
  authorName: string;
}

export interface RecentMedia {
  /** Newest first, capped at the number the strip draws. */
  items: LobbyMediaItem[];
  /** How many images landed in the last seven days across the loaded rooms. */
  weekCount: number;
}

const EMPTY: RecentMedia = { items: [], weekCount: 0 };

/**
 * Pick the strip's images out of the loaded timelines. Pure, so the selection
 * rules are testable without a store.
 */
export function selectRecentMedia(
  messagesByChannel: Readonly<Record<string, readonly Message[]>>,
  channelIds: readonly string[],
  nowMs: number,
  limit: number,
): RecentMedia {
  const items: LobbyMediaItem[] = [];
  let weekCount = 0;

  for (const channelId of channelIds) {
    for (const message of messagesByChannel[channelId] ?? []) {
      if (message.e2ee) continue;
      const attachments = message.attachments ?? [];
      if (attachments.length === 0) continue;
      const atMs = messageTimeMs(message);
      if (atMs == null) continue;
      for (const attachment of attachments) {
        if (attachment.origin_server) continue;
        if (!attachment.url) continue;
        if (!isImageAttachment(attachment)) continue;
        if (nowMs - atMs <= MEDIA_WEEK_MS) weekCount += 1;
        items.push({
          key: `${channelId}:${attachment.id}`,
          channelId,
          attachment,
          atMs,
          authorName:
            message.author?.display_name || message.author?.username || 'Someone',
        });
      }
    }
  }

  items.sort((a, b) => b.atMs - a.atMs || a.key.localeCompare(b.key));
  return { items: items.slice(0, limit), weekCount };
}

/**
 * The strip's model for one building.
 *
 * `channelIds` is the building's own text rooms — passed in rather than read
 * here, so the Lobby stays the one place that decides which rooms belong to it.
 */
export function useRecentMedia(channelIds: readonly string[], limit = 4): RecentMedia {
  const messages = useCurrentMessageStore((state) => state.messages);
  const key = channelIds.join(',');
  return useMemo(() => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) return EMPTY;
    return selectRecentMedia(messages, ids, Date.now(), limit);
    // `key` is the stable identity of `channelIds`; depending on the array
    // itself would re-derive on every render of the Lobby.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, key, limit]);
}
