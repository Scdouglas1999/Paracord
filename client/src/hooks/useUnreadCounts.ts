import { useEffect, useMemo } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { useReadStateStore } from '../stores/readStateStore';
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
    if (channel.last_message_id && channel.last_message_id !== rs.last_message_id) {
      unreadCount++;
    }
    mentionCount += rs.mention_count ?? 0;
  }

  if (unreadCount > 0 || mentionCount > 0) {
    return { unreadCount, mentionCount };
  }
  return null;
}

/**
 * Provides per-guild unread counts and mention counts based on read states.
 * Also exposes per-channel unread status for use in the channel sidebar.
 *
 * Read state is sourced from the shared read-state store, which dispatch and
 * mark-read call sites update directly, so counts stay live without polling.
 */
export function useUnreadCounts(mutedGuildIds: string[]) {
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const readStateRecord = useReadStateStore((s) => s.readStates);

  // Pull an authoritative snapshot once on mount; subsequent updates arrive via
  // the store (dispatch, mark-read, and gateway (re)connect refresh).
  useEffect(() => {
    void useReadStateStore.getState().refresh();
  }, []);

  const readStates = useMemo(() => Object.values(readStateRecord), [readStateRecord]);

  const readStateMap = useMemo(() => {
    const map = new Map<string, ReadState>();
    for (const rs of readStates) {
      map.set(rs.channel_id, rs);
    }
    return map;
  }, [readStates]);

  // A new array identity each render would bust every downstream memo; derive a
  // stable key + Set from the muted-guild ids instead of depending on the array.
  const mutedKey = mutedGuildIds.join(',');
  const mutedSet = useMemo(() => new Set(mutedKey ? mutedKey.split(',') : []), [mutedKey]);

  const guildUnreads = useMemo(() => {
    const result = new Map<string, GuildUnreadInfo>();
    for (const [guildId, channels] of Object.entries(channelsByGuild)) {
      if (!guildId || mutedSet.has(guildId)) continue;
      const info = computeGuildUnread(channels, readStateMap);
      if (info) result.set(guildId, info);
    }
    return result;
  }, [channelsByGuild, readStateMap, mutedSet]);

  const isChannelUnread = useMemo(() => {
    const set = new Set<string>();
    for (const channels of Object.values(channelsByGuild)) {
      for (const channel of channels) {
        if (channel.type === 4) continue;
        const rs = readStateMap.get(channel.id);
        if (!rs) {
          if (channel.last_message_id) set.add(channel.id);
          continue;
        }
        if (channel.last_message_id && channel.last_message_id !== rs.last_message_id) {
          set.add(channel.id);
        }
      }
    }
    return set;
  }, [channelsByGuild, readStateMap]);

  const channelMentionCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const rs of readStates) {
      if (rs.mention_count > 0) {
        map.set(rs.channel_id, rs.mention_count);
      }
    }
    return map;
  }, [readStates]);

  return { guildUnreads, isChannelUnread, channelMentionCounts, readStates };
}
