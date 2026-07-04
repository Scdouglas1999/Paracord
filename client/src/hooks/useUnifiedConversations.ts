import { useEffect, useMemo } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { usePinnedStore } from '../stores/pinnedStore';
import { LOCAL_SERVER_ID } from '../lib/connectionManager';
import { computeGuildUnread } from './useUnreadCounts';
import { scoreEntry } from '../lib/attention/scoreConversation';
import {
  conversationKey,
  snowflakeToMs,
  type ConversationEntry,
  type ConversationKind,
} from '../lib/attention/conversationModel';
import { buildServerUrlMap, resolveServerIdForGuild } from '../lib/attention/serverResolve';
import { ChannelType, type Channel, type Guild, type ReadState } from '../types';

/**
 * The single cross-server unified-conversation selector (layout-spec §3.2, §3.3).
 *
 * ONE memoized hook builds the merged `{ needsYou, recent, pinned, spaces }` list
 * across every connected server from the DATA-1/2/3 primitives. It is O(channels):
 * iterate `channelsByGuild` + the per-server DM index, resolve each guild's owning
 * server (`serverResolve`), attach unread/mention by REUSING `computeGuildUnread`
 * per channel (never forked), attach voice membership from `channelParticipants`,
 * then partition — pinned pulled out first, needs-you scored + capped, the rest by
 * recency.
 *
 * Invalidation = the memo deps only (§3.2). No polling and no new gateway events:
 * `MESSAGE_CREATE` already bumps `last_message_id` + `mention_count`,
 * `VOICE_STATE_UPDATE` already updates `channelParticipants`. On mount we
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
  id: string;
  name: string;
  icon: string | null;
  /** Resolved owning server, so `SpacesList` can route without re-resolving. */
  serverId: string;
}

export interface UnifiedConversations {
  needsYou: ConversationEntry[];
  recent: ConversationEntry[];
  pinned: ConversationEntry[];
  spaces: GuildSummary[];
}

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
  if (ch.recipient?.username) return ch.recipient.username;
  if (ch.recipients?.length) return ch.recipients.map((r) => r.username).join(', ');
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
 * @param mutedGuildIds guilds the user muted — their channels still render in
 *   Recent but carry no attention signals, so they never enter Needs-you.
 */
export function useUnifiedConversations(mutedGuildIds: string[] = []): UnifiedConversations {
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const dmChannelsByServer = useChannelStore((s) => s.dmChannelsByServer);
  const byServer = useReadStateStore((s) => s.byServer);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const servers = useServerListStore((s) => s.servers);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const guilds = useGuildStore((s) => s.guilds);
  const pinnedKeys = usePinnedStore((s) => s.pinnedKeys);

  // Pull background servers' DMs + read-state once on mount; subsequent updates
  // arrive through the stores. Fire-and-forget: the active-server-first seam keeps
  // the list valid whether only the active server or every server has reported.
  useEffect(() => {
    void useChannelStore.getState().loadAllDmChannels();
    void useReadStateStore.getState().refresh();
  }, []);

  const activeId = activeServerId ?? LOCAL_SERVER_ID;

  // A new array identity every render would bust the memo; derive a stable key.
  const mutedKey = mutedGuildIds.join(',');

  return useMemo<UnifiedConversations>(() => {
    const urlMap = buildServerUrlMap(servers);
    const guildById = new Map<string, Guild>(guilds.map((g) => [g.id, g]));
    const pinnedSet = new Set(pinnedKeys);
    const mutedSet = new Set(mutedKey ? mutedKey.split(',') : []);

    // Convert each server's read-state Record → Map once, on demand, so
    // `computeGuildUnread` (which wants a Map) is reused without re-allocating.
    const readMapCache = new Map<string, Map<string, ReadState>>();
    const readMapFor = (serverId: string): Map<string, ReadState> => {
      let map = readMapCache.get(serverId);
      if (!map) {
        map = new Map(Object.entries(byServer[serverId] ?? {}));
        readMapCache.set(serverId, map);
      }
      return map;
    };

    const entries: ConversationEntry[] = [];

    // --- Guild channels (merged across all connected servers) --------------
    for (const [guildId, channels] of Object.entries(channelsByGuild)) {
      if (!guildId) continue; // '' = active-server DM mirror, handled below.
      const guild = guildById.get(guildId);
      const serverId = guild ? resolveServerIdForGuild(guild, urlMap, activeId) : activeId;
      const readMap = readMapFor(serverId);
      const muted = mutedSet.has(guildId);
      const contextLabel = guild?.name ?? null;

      for (const ch of channels) {
        const kind = guildChannelKind(ch.type);
        if (!kind) continue; // category
        // Reuse computeGuildUnread's per-channel logic on a single-channel slice.
        const info = muted ? null : computeGuildUnread([ch], readMap);
        const channelUnread = (info?.unreadCount ?? 0) > 0;
        const isThread = kind === 'thread';
        const key = conversationKey(serverId, ch.id);
        entries.push({
          key,
          serverId,
          channelId: ch.id,
          guildId,
          userId: null,
          kind,
          title: ch.name ?? 'unknown',
          contextLabel,
          lastActivityId: ch.last_message_id ?? null,
          unread: !isThread && channelUnread,
          mentionCount: info?.mentionCount ?? 0,
          isDMUnread: false,
          isThreadReply: isThread && channelUnread,
          hasVoiceActivity: !muted && (channelParticipants.get(ch.id)?.length ?? 0) > 0,
          pinned: pinnedSet.has(key),
        });
      }
    }

    // --- DMs (per-server index; active server falls back to the '' mirror) --
    const dmByServer: Record<string, Channel[]> = { ...dmChannelsByServer };
    if (!(activeId in dmByServer) && (channelsByGuild[''] ?? []).length > 0) {
      dmByServer[activeId] = channelsByGuild[''];
    }
    for (const [serverId, dms] of Object.entries(dmByServer)) {
      const readMap = readMapFor(serverId);
      for (const ch of dms) {
        const kind: ConversationKind = ch.type === ChannelType.GroupDM ? 'group_dm' : 'dm';
        const info = computeGuildUnread([ch], readMap);
        const key = conversationKey(serverId, ch.id);
        entries.push({
          key,
          serverId,
          channelId: ch.id,
          guildId: null,
          userId: ch.recipient?.id ?? null,
          kind,
          title: dmTitle(ch),
          contextLabel: null,
          lastActivityId: ch.last_message_id ?? null,
          unread: false,
          mentionCount: info?.mentionCount ?? 0,
          isDMUnread: (info?.unreadCount ?? 0) > 0,
          isThreadReply: false,
          hasVoiceActivity: (channelParticipants.get(ch.id)?.length ?? 0) > 0,
          pinned: pinnedSet.has(key),
        });
      }
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

    const needsYouKeys = new Set(needsYou.map((e) => e.key));
    const recent = pool
      .filter((e) => !needsYouKeys.has(e.key))
      .sort((a, b) => lastActivityMs(b) - lastActivityMs(a));

    const spaces: GuildSummary[] = guilds.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ?? null,
      serverId: resolveServerIdForGuild(g, urlMap, activeId),
    }));

    return { needsYou, recent, pinned, spaces };
  }, [
    channelsByGuild,
    dmChannelsByServer,
    byServer,
    channelParticipants,
    servers,
    activeId,
    guilds,
    pinnedKeys,
    mutedKey,
  ]);
}
