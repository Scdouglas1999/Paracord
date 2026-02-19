import { useEffect, useMemo, useState } from 'react';
import { authApi } from '../api/auth';
import { useChannelStore } from '../stores/channelStore';
import type { ReadState } from '../types';

interface GuildUnreadInfo {
  unreadCount: number;
  mentionCount: number;
}

/**
 * Provides per-guild unread counts and mention counts based on read states.
 * Also exposes per-channel unread status for use in the channel sidebar.
 */
export function useUnreadCounts(mutedGuildIds: string[]) {
  const [readStates, setReadStates] = useState<ReadState[]>([]);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);

  useEffect(() => {
    let disposed = false;

    const refresh = async () => {
      try {
        const { data } = await authApi.getReadStates();
        if (!disposed) setReadStates(data);
      } catch {
        // keep existing snapshot on failure
      }
    };

    void refresh();
    const interval = window.setInterval(refresh, 30_000);

    const onReadStateUpdated = () => void refresh();
    window.addEventListener('paracord:read-state-updated', onReadStateUpdated);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener('paracord:read-state-updated', onReadStateUpdated);
    };
  }, []);

  const readStateMap = useMemo(() => {
    const map = new Map<string, ReadState>();
    for (const rs of readStates) {
      map.set(rs.channel_id, rs);
    }
    return map;
  }, [readStates]);

  const guildUnreads = useMemo(() => {
    const result = new Map<string, GuildUnreadInfo>();
    const mutedSet = new Set(mutedGuildIds);

    for (const [guildId, channels] of Object.entries(channelsByGuild)) {
      if (!guildId || mutedSet.has(guildId)) continue;

      let unreadCount = 0;
      let mentionCount = 0;

      for (const channel of channels) {
        // Skip categories
        if (channel.type === 4) continue;
        const rs = readStateMap.get(channel.id);
        if (!rs) {
          // No read state = never opened = unread if there are messages
          if (channel.last_message_id) {
            unreadCount++;
          }
          continue;
        }
        if (channel.last_message_id && channel.last_message_id !== rs.last_message_id) {
          unreadCount++;
        }
        mentionCount += rs.mention_count ?? 0;
      }

      if (unreadCount > 0 || mentionCount > 0) {
        result.set(guildId, { unreadCount, mentionCount });
      }
    }

    return result;
  }, [channelsByGuild, readStateMap, mutedGuildIds]);

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
