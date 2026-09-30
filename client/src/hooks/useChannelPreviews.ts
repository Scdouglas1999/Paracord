/**
 * What is in each channel of a server, for the places panel (docs/glass-spec.md
 * §3.1; docs/design/glass-g4-checkpoint.md).
 *
 * One request, `GET /guilds/{id}/channel-previews`, answers the newest message of
 * every readable channel. That is the whole network cost of a server's rows; the
 * rest is kept live from what the client already receives:
 *
 *   - **A new message** (MESSAGE_CREATE) lands in the account's message store
 *     whether or not that channel's timeline is open. The newest message of a
 *     channel in the store, when it is newer than the fetched preview, replaces
 *     it. No request.
 *   - **An edit** updates the message in the store; when the previewed message is
 *     the one that changed, the row follows.
 *   - **A deletion** of the previewed message is the one case the client cannot
 *     answer alone (the message before it is not known), so it asks the server
 *     again, once, after a short quiet.
 *   - **A reconnect or a permission change** (the gateway's
 *     `paracord:conversation-capabilities-changed`) asks again as well, so a
 *     channel that became readable, or stopped being, shows the truth.
 *
 * The store is only trusted for a channel's newest message when it holds the
 * channel's actual tail (`channel.last_message_id`): a timeline opened "around" an
 * old message must not stand in for the latest one.
 *
 * Nothing here decrypts. An encrypted message has no text and no thumbnail, the
 * row says so, and that is all (glass-plan §6, "E2EE previews").
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { createChannelApi } from '../api/channels';
import { extractApiError } from '../api/client';
import type { ChannelPreview } from '../api/generated/ChannelPreview';
import { displayName } from '../lib/displayName';
import { captureScopedOperation } from '../lib/operationContext';
import { accountScopeKey, type AccountScope } from '../lib/serverScope';
import type { Message } from '../types';
import { useCurrentMessageStoreApi } from './useMessageStore';

/** Who wrote a message, as much as a row needs to draw a face and a name. */
export interface PreviewAuthor {
  /** A user id, a webhook or feed id, or the anonymous pseudo-id (see the wire type). */
  id: string;
  kind: ChannelPreview['author_kind'];
  name: string | null;
  /** The stored avatar value, for the face. Null draws initials. */
  avatar: string | null;
}

export interface PreviewMedia {
  attachmentId: string;
  contentType: string | null;
  filename: string;
  width: number | null;
  height: number | null;
}

/** The newest message of one channel, from the server or from the message store. */
export interface ChannelPreviewEntry {
  channelId: string;
  messageId: string;
  /** 0 default, 19 reply, 20 poll, others are system messages. */
  messageType: number;
  author: PreviewAuthor;
  /** Raw text (markdown and `<@id>` tokens intact), or null when there is none. */
  content: string | null;
  encrypted: boolean;
  /** RFC 3339. */
  createdAt: string;
  media: PreviewMedia | null;
  attachmentCount: number;
  hasSticker: boolean;
}

const EPOCH_MS = 1704067200000;

/** Snowflake ids order like time; anything else falls back to string order. */
export function compareMessageIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left > right ? 1 : -1;
  }
  return a === b ? 0 : a > b ? 1 : -1;
}

/** When a snowflake was minted, or null for an id that is not one. */
export function snowflakeTime(id: string | null | undefined): number | null {
  if (!id || !/^\d+$/.test(id)) return null;
  try {
    return Number(BigInt(id) >> 22n) + EPOCH_MS;
  } catch {
    return null;
  }
}

/** One wire preview → an entry. */
export function previewFromWire(wire: ChannelPreview): ChannelPreviewEntry {
  return {
    channelId: wire.channel_id,
    messageId: wire.message_id,
    messageType: wire.message_type,
    author: {
      id: wire.author_id,
      kind: wire.author_kind,
      name: wire.author_name,
      // The wire carries no avatar: a face is looked up by author id where the
      // roster knows it, and is initials where it does not.
      avatar: null,
    },
    content: wire.content,
    encrypted: wire.encrypted,
    createdAt: wire.created_at,
    media: wire.media
      ? {
          attachmentId: wire.media.attachment_id,
          contentType: wire.media.content_type,
          filename: wire.media.filename,
          width: wire.media.width,
          height: wire.media.height,
        }
      : null,
    attachmentCount: wire.attachment_count,
    hasSticker: wire.has_sticker,
  };
}

function authorFromMessage(message: Message): PreviewAuthor {
  if (message.anonymous?.is_anonymous) {
    return {
      id: `anon:${message.channel_id}:${message.anonymous.alias}`,
      kind: 'anonymous',
      name: message.anonymous.alias,
      avatar: null,
    };
  }
  if (message.feed) {
    return { id: message.feed.id, kind: 'feed', name: message.feed.name, avatar: null };
  }
  return {
    id: message.author.id,
    kind: 'user',
    name: displayName(message.author),
    avatar: message.author.avatar_hash ?? null,
  };
}

/** One message in the store → an entry, as the server would have described it. */
export function previewFromMessage(message: Message): ChannelPreviewEntry {
  const first = message.attachments?.[0];
  const encrypted = Boolean(message.e2ee);
  return {
    channelId: message.channel_id,
    messageId: message.id,
    messageType: message.message_type ?? (typeof message.type === 'number' ? message.type : 0),
    author: authorFromMessage(message),
    content: encrypted ? null : message.poll?.question ?? message.content ?? null,
    encrypted,
    createdAt: message.created_at ?? message.timestamp ?? new Date(snowflakeTime(message.id) ?? 0).toISOString(),
    media: first && !encrypted
      ? {
          attachmentId: first.id,
          contentType: first.content_type ?? null,
          filename: first.filename,
          width: first.width ?? null,
          height: first.height ?? null,
        }
      : null,
    attachmentCount: encrypted ? 0 : (message.attachments?.length ?? 0),
    hasSticker: (message.stickers?.length ?? 0) > 0,
  };
}

/** The distinct authors of a loaded timeline, newest first. */
export function authorsNewestFirst(messages: readonly Message[], limit: number): PreviewAuthor[] {
  const seen = new Set<string>();
  const authors: PreviewAuthor[] = [];
  for (let index = messages.length - 1; index >= 0 && authors.length < limit; index -= 1) {
    const message = messages[index];
    if (!message?.author?.id) continue;
    const author = authorFromMessage(message);
    if (seen.has(author.id)) continue;
    seen.add(author.id);
    authors.push(author);
  }
  return authors;
}

export interface PreviewChannel {
  id: string;
  last_message_id?: string | null;
}

/**
 * The preview each channel should show right now: the fetched one, replaced by
 * the store's newest message when that is newer (or is the same message, edited).
 * Pure, so the rule is unit-tested without a store.
 */
export function effectivePreviews(
  fetched: ReadonlyMap<string, ChannelPreviewEntry>,
  channels: readonly PreviewChannel[],
  messages: Readonly<Record<string, readonly Message[] | undefined>>,
): Map<string, ChannelPreviewEntry> {
  const result = new Map<string, ChannelPreviewEntry>();
  for (const channel of channels) {
    const base = fetched.get(channel.id);
    const loaded = messages[channel.id];
    const tail = loaded && loaded.length > 0 ? loaded[loaded.length - 1] : undefined;
    // The store speaks for the channel's newest message only when it holds the
    // channel's real tail: a timeline opened around an old message does not.
    const tailIsCurrent = tail
      ? channel.last_message_id
        ? compareMessageIds(tail.id, channel.last_message_id) >= 0
        : true
      : false;
    if (tail && tailIsCurrent && (!base || compareMessageIds(tail.id, base.messageId) >= 0)) {
      result.set(channel.id, previewFromMessage(tail));
    } else if (base) {
      result.set(channel.id, base);
    }
  }
  return result;
}

export interface ChannelPreviews {
  /** `loading` until the first answer for this server arrives. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** By channel id. A channel with no messages has no entry. */
  previews: ReadonlyMap<string, ChannelPreviewEntry>;
  /** The last few distinct speakers per channel, newest first, from what is loaded. */
  recentAuthors: ReadonlyMap<string, readonly PreviewAuthor[]>;
}

const NO_CHANNELS: readonly PreviewChannel[] = [];
const REFETCH_QUIET_MS = 500;
const RECENT_AUTHOR_LIMIT = 3;

interface Fetched {
  key: string;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  entries: ReadonlyMap<string, ChannelPreviewEntry>;
}

/**
 * The previews of `channels` (all in `guildId`, in `scope`). Pass the channel
 * objects from the store: their identity only changes when a channel does.
 */
export function useChannelPreviews(
  guildId: string | null,
  scope: AccountScope | null,
  channels: readonly PreviewChannel[] = NO_CHANNELS,
): ChannelPreviews {
  const scopeKey = scope ? accountScopeKey(scope) : null;
  const requestKey = scopeKey && guildId ? `${scopeKey}\u0000${guildId}` : null;
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [reload, setReload] = useState(0);

  const messageStore = useCurrentMessageStoreApi();
  const messages = useStore(messageStore, (state) => state.messages);
  const deleted = useStore(messageStore, (state) => state.deletedMessageIds);

  useEffect(() => {
    if (!requestKey || !scopeKey || !guildId) return;
    // The request is keyed on the scope's parts (`useCurrentAccountScope` builds a
    // new object whenever they change), so it is rebuilt from them here.
    const [serverId, userId] = JSON.parse(scopeKey) as [string, string];
    let context: ReturnType<typeof captureScopedOperation>;
    let disposed = false;
    try {
      context = captureScopedOperation({ serverId, userId });
    } catch (error) {
      // No signed-in connection for this server. Say so; do not draw guesses.
      void Promise.resolve().then(() => {
        if (!disposed) setFetched({ key: requestKey, status: 'error', error: extractApiError(error), entries: new Map() });
      });
      return () => {
        disposed = true;
      };
    }
    void (async () => {
      try {
        const { data } = await createChannelApi(() => context.api).getChannelPreviews(guildId, {
          signal: context.signal,
        });
        context.assertCurrent();
        if (disposed) return;
        setFetched({
          key: requestKey,
          status: 'ready',
          error: null,
          entries: new Map(data.map((wire) => [wire.channel_id, previewFromWire(wire)])),
        });
      } catch (error) {
        if (disposed || context.signal.aborted) return;
        setFetched({ key: requestKey, status: 'error', error: extractApiError(error), entries: new Map() });
      } finally {
        context.dispose();
      }
    })();
    return () => {
      disposed = true;
      context.dispose();
    };
  }, [requestKey, scopeKey, guildId, reload]);

  // A reconnect or a change to who may read what: ask again.
  useEffect(() => {
    if (!scopeKey) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<AccountScope | undefined>).detail;
      if (detail && accountScopeKey(detail) !== scopeKey) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setReload((value) => value + 1), REFETCH_QUIET_MS);
    };
    window.addEventListener('paracord:conversation-capabilities-changed', onChanged);
    return () => {
      window.removeEventListener('paracord:conversation-capabilities-changed', onChanged);
      if (timer) clearTimeout(timer);
    };
  }, [scopeKey]);

  const entries = fetched && fetched.key === requestKey ? fetched.entries : undefined;
  const previews = useMemo(
    () => effectivePreviews(entries ?? new Map(), channels, messages),
    [entries, channels, messages],
  );

  // A previewed message that was deleted: the message before it is not known.
  const askedAbout = useRef(new Set<string>());
  useEffect(() => {
    if (!requestKey) return;
    let stale = false;
    for (const entry of previews.values()) {
      if (deleted.has(entry.messageId) && !askedAbout.current.has(entry.messageId)) {
        askedAbout.current.add(entry.messageId);
        stale = true;
      }
    }
    if (!stale) return;
    const timer = setTimeout(() => setReload((value) => value + 1), REFETCH_QUIET_MS);
    return () => clearTimeout(timer);
  }, [previews, deleted, requestKey]);

  const recentAuthors = useMemo(() => {
    const map = new Map<string, readonly PreviewAuthor[]>();
    for (const channel of channels) {
      const preview = previews.get(channel.id);
      const loaded = messages[channel.id] ?? [];
      const authors = authorsNewestFirst(loaded, RECENT_AUTHOR_LIMIT + 1);
      // The newest speaker is always the previewed message's author, even when
      // no timeline is loaded: that is the one face the row can always show.
      const merged: PreviewAuthor[] = [];
      const seen = new Set<string>();
      for (const author of [preview?.author, ...authors]) {
        if (!author || seen.has(author.id)) continue;
        seen.add(author.id);
        merged.push(author);
        if (merged.length >= RECENT_AUTHOR_LIMIT) break;
      }
      if (merged.length > 0) map.set(channel.id, merged);
    }
    return map;
  }, [channels, previews, messages]);

  const status = !requestKey ? 'idle' : fetched && fetched.key === requestKey ? fetched.status : 'loading';
  return {
    status,
    error: fetched && fetched.key === requestKey ? fetched.error : null,
    previews,
    recentAuthors,
  };
}
