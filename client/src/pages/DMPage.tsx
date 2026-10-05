import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router';

import { IxConversation, type ConversationSubject } from '../components/ix/conversation';
import { useCurrentChannelStore } from '../hooks/useChannels';
import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { dmTitleFor } from '../lib/dmTitle';
import { LOCAL_SERVER_ID } from '../lib/connectionManager';
import { getServerAccountScope } from '../lib/serverIdentity';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Channel } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

/**
 * A direct message or a group as an Index conversation (docs/index-spec.md §4.11,
 * §6.6, §8.6): `/app/dms/:channelId`. `IxConversation` draws the person's (or the
 * group's) name as the large title, the toolbar's call button, the timeline, the
 * new-message welcome and the message box; this page finds the conversation.
 *
 * `/app/dms` with no conversation is not a page (it opens the last People item or
 * the most recent DM: `components/ix/people/LastPlaceRedirect`), and the list of
 * every conversation is People's sidebar.
 */
export function DMPage() {
  const scope = useCurrentAccountScope();
  const { channelId } = useParams();
  return <OwnedDMPage key={JSON.stringify([scope?.serverId, scope?.userId, channelId])} />;
}

function OwnedDMPage() {
  const { channelId } = useParams();
  const dmChannels = useCurrentChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const activeServerId = useServerListStore((s) => s.activeServerId);

  const dmChannelInfo = useMemo(() => {
    if (!channelId) return null;
    const activeId = activeServerId ?? LOCAL_SERVER_ID;
    const activeChannel = dmChannels.find((c) => c.id === channelId);
    if (activeChannel) return { channel: activeChannel, serverId: activeId };
    return null;
  }, [activeServerId, channelId, dmChannels]);
  const dmChannel = dmChannelInfo?.channel;
  const isGroupDM = dmChannel?.channel_type === 3 || dmChannel?.type === 3;
  const title = dmTitleFor(
    dmChannel,
    dmChannelInfo ? getServerAccountScope(dmChannelInfo.serverId)?.userId : null,
    isGroupDM ? 'Just you' : 'Direct message',
  );

  // Reuse the sidebar's cross-server DM fetch path (no new endpoint) so past and
  // present conversations across every connected server land in the list.
  useEffect(() => {
    if (channelId && dmChannel) return;
    void useChannelStore.getState().loadAllDmChannels();
  }, [channelId, dmChannel]);

  useEffect(() => {
    if (
      !dmChannelInfo
      || dmChannelInfo.serverId === LOCAL_SERVER_ID
      || activeServerId === dmChannelInfo.serverId
    ) {
      return;
    }
    useServerListStore.getState().setActive(dmChannelInfo.serverId);
  }, [activeServerId, dmChannelInfo]);

  const subject = useMemo<ConversationSubject | null>(() => {
    if (!channelId) return null;
    const recipient = isGroupDM ? undefined : dmChannel?.recipient;
    return {
      kind: 'dm',
      channelId,
      title,
      isGroup: isGroupDM,
      recipient: recipient
        ? {
            id: recipient.id,
            username: recipient.username,
            // The DM's recipient carries the display name the person chose (not on the channel type).
            display_name: (recipient as { display_name?: string | null }).display_name ?? null,
            avatar_hash: recipient.avatar_hash ?? null,
          }
        : null,
      participants: isGroupDM ? dmChannel?.recipients?.length : undefined,
    };
  }, [channelId, title, isGroupDM, dmChannel]);

  if (!subject) return null;
  return <IxConversation subject={subject} />;
}
