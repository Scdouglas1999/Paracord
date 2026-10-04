import { useMemo } from 'react';

import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { displayName } from '../../../lib/displayName';
import { useVoiceStore } from '../../../stores/voiceStore';
import { dockAttention, liveGuildIds, PEOPLE_KEY, type DockEntry } from './dockModel';

/** People and then every server, each with what the dock says about it (§4.8). */
export interface DockData {
  entries: DockEntry[];
  /** Your own face, for People's mark. */
  me: { id: string; name: string; avatar: string | null } | null;
}

/**
 * Reads the stores the dock draws from and nothing else, memoized on them:
 * the servers (`useAvailableGuilds`, in the client's own order), who is in a
 * voice channel (`channelParticipants`), and the conversation model's unread
 * and mention signals (which already leave out a muted server and a muted
 * channel) with the pending friend requests.
 */
export function useDockEntries(): DockData {
  const guilds = useAvailableGuilds();
  const user = useCurrentUser();
  const { mutedGuildKeys } = useMutedGuilds();
  const conversations = useUnifiedConversations(mutedGuildKeys);
  const channelParticipants = useVoiceStore((state) => state.channelParticipants);

  const live = useMemo(() => liveGuildIds(channelParticipants), [channelParticipants]);
  const attention = useMemo(() => {
    const all = [...conversations.pinned, ...conversations.needsYou, ...conversations.recent];
    return dockAttention(all, conversations.requests.length);
  }, [conversations.pinned, conversations.needsYou, conversations.recent, conversations.requests]);

  const me = useMemo(
    () => (user ? { id: user.id, name: displayName(user), avatar: user.avatar_hash ?? null } : null),
    [user],
  );

  const entries = useMemo<DockEntry[]>(() => {
    const list: DockEntry[] = [];
    if (me) {
      list.push({
        key: PEOPLE_KEY,
        kind: 'people',
        name: 'People',
        live: false,
        icon: null,
        hue: null,
        unread: attention.people.unread,
        mentions: attention.people.mentions,
        requests: attention.people.requests,
        dmMentions: attention.people.dmMentions,
      });
    }
    for (const guild of guilds) {
      const say = attention.guilds.get(guild.id);
      list.push({
        key: guild.id,
        kind: 'server',
        name: guild.name,
        live: live.has(guild.id),
        icon: guild.icon_hash ?? guild.icon ?? null,
        hue: guild.hue ?? null,
        unread: say?.unread ?? false,
        mentions: say?.mentions ?? 0,
        requests: 0,
        dmMentions: 0,
      });
    }
    return list;
  }, [me, guilds, live, attention]);

  return { entries, me };
}
