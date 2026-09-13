import { useAvailableChannels } from './useChannels';
import { accountScopeKey, entityScopeKey } from '../lib/serverScope';
import type { AccountScope } from '../lib/serverScope';
import { useAvailableGuilds } from '../hooks/useGuilds';
import { useEffect, useMemo } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useAvailableAccountScopes } from './useAvailableAccountScopes';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { usePinnedStore } from '../stores/pinnedStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { computeGuildUnread } from './useUnreadCounts';
import { scoreEntry } from '../lib/attention/scoreConversation';
import {
  conversationKey,
  snowflakeToMs,
  type ConversationEntry,
  type ConversationKind,
} from '../lib/attention/conversationModel';
import { ChannelType, type Channel, type ReadState, type VoiceState } from '../types';
import { displayName } from '../lib/displayName';

/**
 * The single cross-server unified-conversation selector (layout-spec §3.2, §3.3).
 *
 * ONE memoized hook builds the merged `{ needsYou, recent, pinned, spaces }` list
 * across every connected server from the DATA-1/2/3 primitives. It is O(channels):
 * iterate `channelsByGuild` + the per-server DM index, resolve each guild's owning
 * server from the guild's own `serverId`, attach unread/mention by REUSING
 * `computeGuildUnread`
 * per channel (never forked), attach voice membership from `channelParticipants`,
 * then partition — pinned pulled out first, needs-you scored + capped, the rest by
 * recency.
 *
 * Invalidation = the memo deps only (§3.2). Ordered message activity updates the
 * channel tail; recipient-targeted mention events refresh authoritative counts.
 * `VOICE_STATE_UPDATE` updates `channelParticipants`. On mount we
 * fire-and-forget the DM + read-state fan-out; the active-server-first seam means
 * the list is correct and green whether only the active server or every server has
 * reported yet.
 *
 * PRESENCE IS NEVER READ HERE. Entries carry `userId` (recipient of a DM) so a row
 * runs its OWN `usePresenceStore` selector for the presence dot — a presence tick
 * must not re-run this whole cross-server build. For the same reason `speakingUsers`
 * is intentionally NOT subscribed: the voice signal in the list is membership-only
 * (`channelParticipants`), and speaking rings are a per-row concern like presence.
 */

export interface GuildSummary {
  key: string;
  scope: AccountScope;
  id: string;
  name: string;
  icon: string | null;
  /** Resolved owning server, so a caller can route without re-resolving. */
  serverId: string;
}

/**
 * An incoming friend request surfaced at the TOP of "Needs you" (they are literally
 * waiting on the user). Sourced from `relationshipStore` — NOT the channel merge — so
 * it lives in its own isolated memo and a relationship change never re-runs the
 * expensive cross-server conversation build (and vice-versa), preserving the
 * per-message re-render fix.
 */
export interface FriendRequestEntry {
  /** `request:${userId}` — stable, collision-free against conversation keys. */
  key: string;
  userId: string;
  username: string;
  /**
   * Request creation time (ms), derived from the relationship's snowflake id when it
   * is one; null for the composite `${user_id}:${target_id}` fallback id. Rendered as
   * a compact relative label when present ("timestamp if available", §1 of the brief).
   */
  createdMs: number | null;
}

export interface UnifiedConversations {
  needsYou: ConversationEntry[];
  /** Attention-bearing entries beyond the six-row glanceable shortlist. */
  needsYouOverflowCount: number;
  recent: ConversationEntry[];
  pinned: ConversationEntry[];
  spaces: GuildSummary[];
  /** Incoming friend requests, newest first — rendered above Needs-you rows. */
  requests: FriendRequestEntry[];
}

/** Relationship.type === 3 is a pending INCOMING friend request (see relationshipStore). */
const RELATIONSHIP_PENDING_INCOMING = 3;

/** Needs-you is capped so the section stays a glanceable shortlist (§3.2). */
const NEEDS_YOU_CAP = 6;

/** Map a guild channel type to its conversation kind, or null to skip (categories). */
function guildChannelKind(type: ChannelType): ConversationKind | null {
  switch (type) {
    case ChannelType.Category:
      return null;
    case ChannelType.Voice:
    case ChannelType.Stage:
      return 'voice';
    case ChannelType.Thread:
      return 'thread';
    // Text, Announcement, Forum, and any future text-like type.
    default:
      return 'guild_text';
  }
}

/** Best-effort DM/group-DM title from the channel's recipient(s). */
function dmTitle(ch: Channel): string {
  if (ch.name) return ch.name;
  if (ch.recipient) return displayName(ch.recipient);
  if (ch.recipients?.length) return ch.recipients.map((r) => displayName(r)).join(', ');
  return 'Direct Message';
}

/**
 * A needs-you entry must carry a REAL attention signal. §3.3's `scoreEntry > 0`
 * gate is realized as "has a signal" because the recency term is a pure tie-shaper
 * (`scoreEntry` adds it for any dated channel): a fully-read channel must never
 * enter Needs-you merely for being recent — that is what Recent is for.
 */
function hasAttentionSignal(e: ConversationEntry): boolean {
  return (
    e.mentionCount > 0 ||
    e.isDMUnread ||
    e.isThreadReply ||
    e.unread ||
    e.hasVoiceActivity
  );
}

function lastActivityMs(e: ConversationEntry): number {
  return e.lastActivityId ? snowflakeToMs(e.lastActivityId) : 0;
}

/**
 * Collision-safe voice occupancy. `voiceStore.channelParticipants` is a single
 * Map keyed by the BARE channel id, populated cross-server — two independent
 * servers can mint the same snowflake channel id, so a naive `.get(id).length`
 * leaks an occupied room on server B into the same-id row on server A. Scope by
 * guild membership instead: guild channels require a participant whose
 * `guild_id` matches the row's guild (loadVoiceStates stamps every guild voice
 * state's guild_id); DM/group-DM rows require a participant with NO guild_id, so
 * a colliding guild channel can't inflate a DM row either.
 */
function hasVoiceOccupancy(
  channelParticipants: Map<string, VoiceState[]>,
  channelId: string,
  guildId: string | null,
): boolean {
  const parts = channelParticipants.get(channelId);
  if (!parts?.length) return false;
  return guildId
    ? parts.some((p) => p.guild_id === guildId)
    : parts.some((p) => !p.guild_id);
}

/**
 * @param mutedGuildKeys guilds the user muted — their channels still render in
 *   Recent but carry no attention signals, so they never enter Needs-you.
 */
export function useUnifiedConversations(mutedGuildKeys: string[] = []): UnifiedConversations {
  const availableChannels = useAvailableChannels();
  const byAccount = useReadStateStore((s) => s.byAccount);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const availableScopes = useAvailableAccountScopes();
  const connectedServersKey = useServerListStore(state => JSON.stringify(state.servers.filter(server => server.connected).map(server => server.id).sort()));
  const guilds = useAvailableGuilds();
  const pinnedKeys = usePinnedStore((s) => s.pinnedKeys);
  const relationships = useRelationshipStore((s) => s.relationships);

  // Verified account changes must refetch even if the server ID stays the same.
  const connectedKey = JSON.stringify([availableScopes.map(accountScopeKey).sort(), connectedServersKey]);

  // Pull each connected server's DMs + read-state. Fire-and-forget: the
  // active-server-first seam keeps the list valid whether only the active server
  // or every server has reported. Re-fires when the connected set changes so
  // late-connecting servers fold into Needs-you / Recent without a remount.
  useEffect(() => {
    void useChannelStore.getState().loadAllDmChannels();
    void useReadStateStore.getState().refreshAll();
  }, [connectedKey]);


  // A new array identity every render would bust the memo; derive a stable key.
  const mutedKey = JSON.stringify(mutedGuildKeys);

  // Incoming friend requests live in their OWN memo, keyed only on `relationships`.
  // Isolating them keeps a friend-request event from re-running the O(channels)
  // conversation build below — and a MESSAGE_CREATE storm from re-deriving requests.
  const requests = useMemo<FriendRequestEntry[]>(() => {
    return relationships
      .filter((r) => r.type === RELATIONSHIP_PENDING_INCOMING)
      .map((r) => ({
        key: `request:${r.user.id}`,
        userId: r.user.id,
        username: r.user.display_name || r.user.username,
        // The relationship id is a snowflake carrying the request time UNLESS it fell
        // back to the composite `${user_id}:${target_id}` form — only decode digits.
        createdMs: /^\d+$/.test(r.id) ? snowflakeToMs(r.id) : null,
      }))
      // Newest first — they are the freshest thing waiting on the user.
      .sort((a, b) => (b.createdMs ?? 0) - (a.createdMs ?? 0));
  }, [relationships]);

  const conversations = useMemo(() => {
    const guildById = new Map(guilds.map(g => [g.key, g]));
    const pinnedSet = new Set(pinnedKeys);
    const mutedSet = new Set<string>(JSON.parse(mutedKey));

    // Convert each server's read-state Record → Map once, on demand, so
    // `computeGuildUnread` (which wants a Map) is reused without re-allocating.
    const readMapCache = new Map<string, Map<string, ReadState>>();
    const readMapFor = (scope: AccountScope): Map<string, ReadState> => {
      const key = accountScopeKey(scope);
      let map = readMapCache.get(key);
      if (!map) {
        map = new Map(Object.entries(byAccount[key] ?? {}));
        readMapCache.set(key, map);
      }
      return map;
    };

    const entries: ConversationEntry[] = [];

    for (const ch of availableChannels) {
      const guildId = ch.guild_id;
      if (!guildId) continue;
      const guild = guildById.get(entityScopeKey(ch.scope, guildId));
      if (!guild) continue;
      const serverId = ch.scope.serverId;
      const readMap = readMapFor(ch.scope);
      const muted = mutedSet.has(guild.key);
      const contextLabel = guild.name;
        const kind = guildChannelKind(ch.type);
        if (!kind) continue; // category
        // Reuse computeGuildUnread's per-channel logic on a single-channel slice.
        const info = muted ? null : computeGuildUnread([ch], readMap);
        const channelUnread = (info?.unreadCount ?? 0) > 0;
        const isThread = kind === 'thread';
        const key = conversationKey(ch.scope, ch.id);
        entries.push({
          key,
          scope: ch.scope,
          serverId,
          channelId: ch.id,
          guildId,
          userId: null,
          avatar: null,
          kind,
          title: ch.name ?? 'unknown',
          contextLabel,
          lastActivityId: ch.last_message_id ?? null,
          unread: !isThread && channelUnread,
          mentionCount: info?.mentionCount ?? 0,
          isDMUnread: false,
          isThreadReply: isThread && channelUnread,
          hasVoiceActivity: !muted && hasVoiceOccupancy(channelParticipants, ch.id, guildId),
          pinned: pinnedSet.has(key),
        });
    }

    for (const ch of availableChannels) {
      if (ch.guild_id) continue;
      const serverId = ch.scope.serverId;
      const readMap = readMapFor(ch.scope);
        const kind: ConversationKind = ch.type === ChannelType.GroupDM ? 'group_dm' : 'dm';
        const info = computeGuildUnread([ch], readMap);
        const key = conversationKey(ch.scope, ch.id);
        entries.push({
          key,
          scope: ch.scope,
          serverId,
          channelId: ch.id,
          guildId: null,
          userId: ch.recipient?.id ?? null,
          avatar: ch.recipient?.avatar_hash ?? null,
          kind,
          title: dmTitle(ch),
          contextLabel: null,
          lastActivityId: ch.last_message_id ?? null,
          unread: false,
          mentionCount: info?.mentionCount ?? 0,
          isDMUnread: (info?.unreadCount ?? 0) > 0,
          isThreadReply: false,
          hasVoiceActivity: hasVoiceOccupancy(channelParticipants, ch.id, null),
          pinned: pinnedSet.has(key),
        });
    }

    // --- Partition: pinned out first, then needs-you, then recent ----------
    const byKey = new Map(entries.map((e) => [e.key, e]));

    const pinned: ConversationEntry[] = [];
    for (const k of pinnedKeys) {
      const e = byKey.get(k);
      if (e) pinned.push(e); // in user pin order
    }
    const pinnedKeySet = new Set(pinned.map((e) => e.key));
    const pool = entries.filter((e) => !pinnedKeySet.has(e.key));

    const now = Date.now();
    const scored = pool
      .filter(hasAttentionSignal)
      .map((e) => ({ e, s: scoreEntry(e, now) }));
    scored.sort((a, b) => b.s - a.s);
    const needsYou = scored.slice(0, NEEDS_YOU_CAP).map((x) => x.e);
    const needsYouOverflowCount = Math.max(0, scored.length - NEEDS_YOU_CAP);

    const needsYouKeys = new Set(needsYou.map((e) => e.key));
    const recent = pool
      .filter((e) => !needsYouKeys.has(e.key))
      .sort((a, b) => lastActivityMs(b) - lastActivityMs(a));

    const spaces: GuildSummary[] = guilds.map((g) => ({
      key: g.key,
      scope: g.scope,
      id: g.id,
      name: g.name,
      // Prefer icon_hash (API field); fall back to legacy `icon` if present.
      icon: g.icon_hash ?? g.icon ?? null,
      serverId: g.scope.serverId,
    }));

    return { needsYou, needsYouOverflowCount, recent, pinned, spaces };
  }, [
    availableChannels,
    byAccount,
    channelParticipants,
    guilds,
    pinnedKeys,
    mutedKey,
  ]);

  // Combine the two isolated memos. Identity is stable whenever neither input
  // changed, so consumers memoized on the returned arrays don't re-render on churn.
  return useMemo<UnifiedConversations>(
    () => ({ ...conversations, requests }),
    [conversations, requests],
  );
}
