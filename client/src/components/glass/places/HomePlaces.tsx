import { useMemo } from 'react';

import { useConversationPreview } from '../../ix/people/useConversationPreview';
import { snowflakeTime } from '../../../hooks/useChannelPreviews';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { dmCompanions } from '../../../lib/dmTitle';
import { displayName } from '../../../lib/displayName';
import { accountScopeKey, entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { GlyphRow, TextRow, type RowFocus } from './PlaceRows';
import { badgeFor, badgeWords, capped, formatRowTime, type FaceModel } from './model';
import type { TextRowModel } from './rows';
import { unreadKey, useUnreadMessageCounts, type UnreadTarget } from './useUnreadMessageCounts';

/**
 * Home mode: direct messages as rows in the same style as a server's channels
 * (docs/glass-spec.md §3.1: "Home mode lists DMs in the same row style"), under a
 * Friends row (docs/design/glass-plan.md §1.3, "Friends as a row at the top of
 * Home's places list").
 *
 * A 1:1 conversation leads with the person's face and a light dot when they are
 * here; a group leads with two faces overlapped, as a channel does. The line is
 * the newest message, fetched the way Home fetches it (one request per row, never
 * decrypting: an encrypted message reads as such).
 */

export const FRIENDS_ID = 'home:friends';
export const dmIdOf = (entry: Pick<ConversationEntry, 'key'>) => `dm:${entry.key}`;

/** Direct and group conversations, pinned first, then newest first. */
export function directConversations(lists: readonly (readonly ConversationEntry[])[]): ConversationEntry[] {
  const seen = new Set<string>();
  const entries: ConversationEntry[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if ((entry.kind !== 'dm' && entry.kind !== 'group_dm') || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
  }
  const time = (entry: ConversationEntry) => snowflakeTime(entry.lastActivityId) ?? 0;
  return entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || time(b) - time(a));
}

/** Unread conversations, for the tray's badge and the Home title's line. */
export function unreadConversations(entries: readonly ConversationEntry[]): number {
  return entries.filter((entry) => entry.isDMUnread || entry.mentionCount > 0).length;
}

interface HomePlacesProps {
  entries: readonly ConversationEntry[];
  requests: number;
  selectedChannelId: string | null;
  friendsSelected: boolean;
  nowMs: number;
  focusOf: (id: string) => RowFocus;
  onOpenConversation: (entry: ConversationEntry) => void;
  onOpenFriends: () => void;
}

export function HomePlaces({
  entries,
  requests,
  selectedChannelId,
  friendsSelected,
  nowMs,
  focusOf,
  onOpenConversation,
  onOpenFriends,
}: HomePlacesProps) {
  // Unread direct messages want a count; ask the server once per row that needs it.
  const readStates = useReadStateStore((state) => state.byAccount);
  const targets = useMemo<UnreadTarget[]>(() => {
    const list: UnreadTarget[] = [];
    for (const entry of entries) {
      if (!entry.isDMUnread || entry.mentionCount > 0 || !entry.lastActivityId) continue;
      const cursor = readStates[accountScopeKey(entry.scope)]?.[entry.channelId]?.last_message_id ?? null;
      list.push({ channelId: entry.channelId, scope: entry.scope, cursor: cursor || null, tail: entry.lastActivityId });
    }
    return list;
  }, [entries, readStates]);
  const counts = useUnreadMessageCounts(targets);

  return (
    <>
      <GlyphRow
        id={FRIENDS_ID}
        href="/app/friends"
        glyph="people"
        name="Friends"
        line={requests > 0 ? (requests === 1 ? '1 request waiting' : `${requests} requests waiting`) : 'Friends and requests'}
        selected={friendsSelected}
        badge={requests > 0 ? { kind: 'mention', count: requests, label: capped(requests) } : null}
        badgeWords={requests > 0 ? (requests === 1 ? '1 request' : `${requests} requests`) : null}
        onOpen={onOpenFriends}
        {...focusOf(FRIENDS_ID)}
      />
      {entries.map((entry) => (
        <DirectRow
          key={entry.key}
          entry={entry}
          selected={selectedChannelId === entry.channelId}
          unreadCount={counts.get(unreadKey(entry.scope, entry.channelId)) ?? null}
          nowMs={nowMs}
          focus={focusOf(dmIdOf(entry))}
          onOpen={() => onOpenConversation(entry)}
        />
      ))}
      {entries.length === 0 && <p className="glass-places__empty">Your direct messages will appear here.</p>}
    </>
  );
}

function DirectRow({
  entry,
  selected,
  unreadCount,
  nowMs,
  focus,
  onOpen,
}: {
  entry: ConversationEntry;
  selected: boolean;
  unreadCount: number | null;
  nowMs: number;
  focus: RowFocus;
  onOpen: () => void;
}) {
  const channel = useChannelStore((state) => state.channelsById[entityScopeKey(entry.scope, entry.channelId)]);
  const online = usePresenceStore((state) => {
    if (entry.kind !== 'dm' || !entry.userId) return false;
    const status = state.getPresence(entry.userId, entry.serverId)?.status;
    return status === 'online';
  });
  const { preview, failed } = useConversationPreview(entry, 'latest');

  const row = useMemo<TextRowModel>(() => {
    const companions = dmCompanions(channel, entry.scope.userId);
    const faces: FaceModel[] = companions.slice(0, 2).map((person) => ({
      userId: person.id,
      name: displayName(person),
      avatar: (person as { avatar_hash?: string | null }).avatar_hash ?? null,
    }));
    if (faces.length === 0) faces.push({ userId: entry.userId ?? entry.channelId, name: entry.title, avatar: entry.avatar ?? null });
    const group = entry.kind === 'group_dm';
    const own = preview?.authorId != null && preview.authorId === entry.scope.userId;
    const line = preview
      ? own
        ? `You: ${preview.text}`
        : group && preview.author
          ? `${preview.author}: ${preview.text}`
          : preview.text
      : null;
    const time = snowflakeTime(entry.lastActivityId);
    const badge = badgeFor({
      muted: false,
      mentions: entry.mentionCount,
      unread: entry.isDMUnread,
      unreadCount,
    });
    return {
      kind: 'text',
      id: dmIdOf(entry),
      channelId: entry.channelId,
      name: entry.title,
      selected,
      lead: { kind: 'faces', faces: group ? faces.slice(-2) : faces.slice(0, 1), variant: group ? 'authors' : 'person', online },
      line,
      lineNote: failed ? 'Preview unavailable' : null,
      time: formatRowTime(time, nowMs),
      timeIso: time !== null ? new Date(time).toISOString() : null,
      badge,
      badgeWords: badgeWords(badge),
    };
  }, [channel, entry, preview, failed, selected, unreadCount, nowMs, online]);

  return (
    <TextRow
      row={row}
      href={`/app/dms/${entry.channelId}`}
      onOpen={onOpen}
      {...focus}
    />
  );
}
