import { useEffect, useMemo } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useServerListStore } from '../stores/serverListStore';
import { LOCAL_SERVER_ID } from '../lib/connectionManager';
import type { Channel, ReadState } from '../types';

interface GuildUnreadInfo {
  unreadCount: number;
  mentionCount: number;
}

/**
 * Compute a single guild's unread/mention totals from its channels and the
 * read-state cache. Exported (and pure) so the incremental unread logic can be
 * unit-tested without rendering the hook. Returns null when the guild has no
 * unread channels and no mentions.
 */
export function computeGuildUnread(
  channels: Channel[],
  readStateMap: Map<string, ReadState>,
): GuildUnreadInfo | null {
  let unreadCount = 0;
  let mentionCount = 0;

  for (const channel of channels) {
    // Skip categories.
    if (channel.type === 4) continue;
    const rs = readStateMap.get(channel.id);
    if (!rs) {
      // No read state = never opened = unread if there are messages.
      if (channel.last_message_id) unreadCount++;
      continue;
    }
    if (isMessageUnread(channel.last_message_id, rs.last_message_id)) {
      unreadCount++;
    }
    mentionCount += rs.mention_count ?? 0;
  }

  if (unreadCount > 0 || mentionCount > 0) {
    return { unreadCount, mentionCount };
  }
  return null;
}

const NUMERIC_ID_RE = /^\d+$/;

/**
 * Message ids are Snowflakes, so unread is an ordered comparison: a channel is
 * unread only when its latest message is newer than the saved read cursor.
 *
 * This intentionally treats a read cursor that is ahead of stale channel
 * metadata as read. That can happen after the message list has loaded a newer
 * page and persisted the cursor before the sidebar/inbox channel snapshot has
 * caught up. A strict string inequality would make the channel flip back to
 * unread every time a refresh or navigation re-read the stale channel object.
 */
export function isMessageUnread(
  latestMessageId: string | number | null | undefined,
  readMessageId: string | number | null | undefined,
): boolean {
  if (latestMessageId === null || latestMessageId === undefined || latestMessageId === '') {
    return false;
  }

  const latest = String(latestMessageId);
  if (latest === '0') return false;

  if (readMessageId === null || readMessageId === undefined || readMessageId === '') {
    return true;
  }

  const read = String(readMessageId);
  if (latest === read) return false;

  if (NUMERIC_ID_RE.test(latest) && NUMERIC_ID_RE.test(read)) {
    return BigInt(latest) > BigInt(read);
  }

  // Non-snowflake test fixtures / legacy ids have no ordering guarantee.
  return latest !== read;
}

function recordToMap(record: Record<string, ReadState>): Map<string, ReadState> {
  return new Map(Object.entries(record));
}

/**
 * Provides per-guild unread counts and mention counts based on read states.
 * Also exposes per-channel unread status for use in the channel sidebar.
 *
 * Read state is the serverId-scoped `byServer` cache. Each guild resolves to its
 * originating server via `guild.server_url → serverId` so the cross-server merge
 * reads the right per-server bucket; `computeGuildUnread` stays pure and is fed a
 * per-server map. Updates arrive via the store (dispatch, mark-read, gateway
 * (re)connect refresh) so counts stay live without polling.
 */
export function useUnreadCounts(mutedGuildIds: string[]) {
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const byServer = useReadStateStore((s) => s.byServer);
  const guilds = useGuildStore((s) => s.guilds);
  const servers = useServerListStore((s) => s.servers);
  const activeServerId = useServerListStore((s) => s.activeServerId);

  // Pull authoritative snapshots once on mount; subsequent updates arrive via
  // the store (dispatch, mark-read, and gateway (re)connect refresh).
  useEffect(() => {
    void useReadStateStore.getState().refresh();
  }, []);

  const activeId = activeServerId ?? LOCAL_SERVER_ID;

  // guildId → serverId: which server's read-state bucket holds this guild's
  // channels. Built once from guild.server_url so the merge reads the right
  // bucket; falls back to the active server (covers guilds without a resolvable
  // server_url — see layout-spec §9 flag 3). `servers` is a dep so the map
  // recomputes when connections/attribution change.
  const serverIdByGuild = useMemo(() => {
    const map = new Map<string, string>();
    const getServerByUrl = useServerListStore.getState().getServerByUrl;
    for (const guild of guilds) {
      // Prefer the authoritative origin tag (§9 flag 3 fix); fall back to the
      // server_url map, then the active server, for guilds predating the tag.
      const resolved =
        guild.originServerId
        ?? (guild.server_url ? getServerByUrl(guild.server_url)?.id : undefined);
      map.set(guild.id, resolved ?? activeId);
    }
    return map;
  }, [guilds, servers, activeId]);

  const serverIdForGuild = (guildId: string): string =>
    guildId ? (serverIdByGuild.get(guildId) ?? activeId) : activeId;

  // A new array identity each render would bust every downstream memo; derive a
  // stable key + Set from the muted-guild ids instead of depending on the array.
  const mutedKey = mutedGuildIds.join(',');
  const mutedSet = useMemo(() => new Set(mutedKey ? mutedKey.split(',') : []), [mutedKey]);

  const guildUnreads = useMemo(() => {
    const result = new Map<string, GuildUnreadInfo>();
    for (const [guildId, channels] of Object.entries(channelsByGuild)) {
      if (!guildId || mutedSet.has(guildId)) continue;
      const map = recordToMap(byServer[serverIdForGuild(guildId)] ?? {});
      const info = computeGuildUnread(channels, map);
      if (info) result.set(guildId, info);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsByGuild, byServer, serverIdByGuild, mutedSet, activeId]);

  const isChannelUnread = useMemo(() => {
    const set = new Set<string>();
    for (const [guildId, channels] of Object.entries(channelsByGuild)) {
      const record = byServer[serverIdForGuild(guildId)] ?? {};
      for (const channel of channels) {
        if (channel.type === 4) continue;
        const rs = record[channel.id];
        if (!rs) {
          if (channel.last_message_id) set.add(channel.id);
          continue;
        }
        if (isMessageUnread(channel.last_message_id, rs.last_message_id)) {
          set.add(channel.id);
        }
      }
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsByGuild, byServer, serverIdByGuild, activeId]);

  const channelMentionCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [guildId, channels] of Object.entries(channelsByGuild)) {
      const record = byServer[serverIdForGuild(guildId)] ?? {};
      for (const channel of channels) {
        const rs = record[channel.id];
        if (rs && rs.mention_count > 0) {
          map.set(channel.id, rs.mention_count);
        }
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsByGuild, byServer, serverIdByGuild, activeId]);

  // Retained for call-site shape stability; reflects the active server's record.
  const readStates = useMemo(() => Object.values(byServer[activeId] ?? {}), [byServer, activeId]);

  return { guildUnreads, isChannelUnread, channelMentionCounts, readStates };
}
