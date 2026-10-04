import { useCallback, useMemo } from 'react';

import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { snowflakeToMs, type ConversationEntry } from '../../../lib/attention/conversationModel';
import { displayName } from '../../../lib/displayName';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useRelationshipStore } from '../../../stores/relationshipStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { directConversations } from './peopleModel';

/**
 * What the People sidebar reads (docs/index-spec.md §6.6), as one hook: your own
 * face, the conversations (direct and group, pinned first, newest first), what the
 * Friends row says, and what is waiting in the Inbox.
 *
 * Everything is derived from the models the dock already uses
 * (`useUnifiedConversations`, the relationship store), so the sidebar and the
 * dock's People badge cannot disagree. Presence is read as a count, through a
 * selector that returns a number, so a presence tick re-renders the sidebar only
 * when the number of friends online changes.
 */

export interface PeopleSidebarData {
  me: { id: string; name: string; avatar: string | null } | null;
  /** Direct and group conversations, pinned first, then the newest message first. */
  dms: ConversationEntry[];
  friends: { total: number; online: number; requests: number };
  inbox: InboxSummary;
}

export interface InboxSummary {
  /** Mentions waiting, across every server you are in and your direct messages. */
  mentions: number;
  /** Conversations with something unread (a mention counts). */
  unread: number;
  /** The newest conversation that needs you, a mention before a plain unread. Its preview is the row's line. */
  top: ConversationEntry | null;
}

/** Whether a conversation belongs in the Inbox: a mention, or something unread. A voice channel never does. */
export function needsYou(entry: ConversationEntry): boolean {
  if (entry.kind === 'voice') return false;
  return entry.mentionCount > 0 || entry.unread || entry.isDMUnread || entry.isThreadReply;
}

function activity(entry: ConversationEntry): number {
  return entry.lastActivityId ? snowflakeToMs(entry.lastActivityId) : 0;
}

/** The Inbox's conversations: mentions first, then by the newest message. */
export function inboxEntries(entries: readonly ConversationEntry[]): ConversationEntry[] {
  const seen = new Set<string>();
  const list: ConversationEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.key) || !needsYou(entry)) continue;
    seen.add(entry.key);
    list.push(entry);
  }
  return list.sort(
    (a, b) => Number(b.mentionCount > 0) - Number(a.mentionCount > 0) || activity(b) - activity(a) || a.key.localeCompare(b.key),
  );
}

export function summarizeInbox(entries: readonly ConversationEntry[]): InboxSummary {
  const list = inboxEntries(entries);
  return {
    mentions: list.reduce((total, entry) => total + entry.mentionCount, 0),
    unread: list.length,
    top: list[0] ?? null,
  };
}

export function usePeopleSidebar(): PeopleSidebarData {
  const user = useCurrentUser();
  const { mutedGuildKeys } = useMutedGuilds();
  const conversations = useUnifiedConversations(mutedGuildKeys);
  const relationships = useRelationshipStore((state) => state.relationships);
  const activeServerId = useServerListStore((state) => state.activeServerId);
  const scope = activeServerId ?? undefined;

  const dms = useMemo(
    () => directConversations([conversations.pinned, conversations.needsYou, conversations.recent]),
    [conversations.pinned, conversations.needsYou, conversations.recent],
  );
  const inbox = useMemo(
    () => summarizeInbox([...conversations.pinned, ...conversations.needsYou, ...conversations.recent]),
    [conversations.pinned, conversations.needsYou, conversations.recent],
  );

  const friendIds = useMemo(() => relationships.filter((entry) => entry.type === 1).map((entry) => entry.user.id), [relationships]);
  const friendKey = friendIds.join(',');
  const online = usePresenceStore(
    useCallback(
      (state) => {
        let count = 0;
        for (const id of friendKey ? friendKey.split(',') : []) {
          if ((state.getPresence(id, scope)?.status || 'offline') !== 'offline') count += 1;
        }
        return count;
      },
      [friendKey, scope],
    ),
  );

  const me = useMemo(
    () => (user ? { id: user.id, name: displayName(user), avatar: user.avatar_hash ?? null } : null),
    [user],
  );

  return {
    me,
    dms,
    friends: { total: friendIds.length, online, requests: conversations.requests.length },
    inbox,
  };
}
