import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageList } from '../../components/message/MessageList';
import { MessageInput } from '../../components/message/MessageInput';
import { ThreadPanel } from '../../components/message/ThreadPanel';
import { SearchPanel } from '../../components/message/SearchPanel';
import { GuildEconomyPanel } from '../../components/guild/GuildEconomyPanel';
import { useChannelStore } from '../../stores/channelStore';
import type { Channel, Message } from '../../types';

interface TextChannelViewProps {
  guildId: string | undefined;
  channelId: string;
  channelName: string;
  channel: Channel | undefined;
  channels: Channel[];
  isPhoneLayout: boolean;
  searchPanelOpen: boolean;
}

export function TextChannelView({
  guildId,
  channelId,
  channelName,
  channel,
  channels,
  isPhoneLayout,
  searchPanelOpen,
}: TextChannelViewProps) {
  const navigate = useNavigate();
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);

  // Clear the reply target when switching channels.
  useEffect(() => {
    setReplyingTo(null);
  }, [channelId]);

  const isThread = channel?.type === 6 || channel?.channel_type === 6;
  const parentChannelId = isThread ? channel?.parent_id ?? null : null;
  const parentChannel = parentChannelId ? channels.find((c) => c.id === parentChannelId) : null;
  const showThreadSplit = Boolean(isThread && guildId && parentChannel);

  const closeThread = () => {
    useChannelStore.getState().selectChannel(parentChannel!.id);
    navigate(`/app/guilds/${guildId}/channels/${parentChannel!.id}`);
  };

  return (
    <div className="flex min-h-0 flex-1">
      {showThreadSplit ? (
        isPhoneLayout ? (
          <ThreadPanel
            guildId={guildId!}
            threadChannelId={channelId}
            threadName={channelName}
            parentChannelName={parentChannel?.name || 'unknown'}
            className="w-full border-l-0"
            onClose={closeThread}
          />
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="panel-divider flex shrink-0 items-center gap-2 border-b border-border-subtle/70 px-4 py-2.5 text-xs text-text-muted">
                Parent Channel
                <span className="font-semibold text-text-secondary">#{parentChannel?.name || 'unknown'}</span>
              </div>
              <MessageList channelId={parentChannel!.id} />
            </div>
            <ThreadPanel
              guildId={guildId!}
              threadChannelId={channelId}
              threadName={channelName}
              parentChannelName={parentChannel?.name || 'unknown'}
              className="w-[min(460px,42vw)] max-w-[40rem]"
              onClose={closeThread}
            />
          </>
        )
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageList
            channelId={channelId}
            onReply={(msg: Message) =>
              setReplyingTo({
                id: msg.id,
                author: msg.author.username,
                content: msg.content || '',
              })
            }
          />
          <MessageInput
            channelId={channelId}
            guildId={guildId}
            channelName={channelName}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
          />
        </div>
      )}
      {searchPanelOpen && !showThreadSplit && <SearchPanel />}
      {!searchPanelOpen && !showThreadSplit && guildId && <GuildEconomyPanel guildId={guildId} />}
    </div>
  );
}
