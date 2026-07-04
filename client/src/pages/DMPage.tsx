import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MessageCircleMore, Users } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { MessageList } from '../components/message/MessageList';
import { MessageInput } from '../components/message/MessageInput';
import { useChannelStore } from '../stores/channelStore';
import { useUIStore } from '../stores/uiStore';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import type { Channel, Message } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

/**
 * ChatView body for a direct / group DM (layout-spec §1 — full-width single
 * pane). Message internals (`MessageList` + composer) are reused untouched. The
 * group-DM recipient surface is no longer a docked <aside>: it lives in the
 * shell-owned `ContextPanel` `members` mode (layout-spec §2), toggled from here.
 */
export function DMPage() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const dmChannel = dmChannels.find((c) => c.id === channelId);
  const contextPanelMode = useUIStore((s) => s.contextPanelMode);
  const toggleContextPanelMode = useUIStore((s) => s.toggleContextPanelMode);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);

  const isGroupDM = dmChannel?.channel_type === 3 || dmChannel?.type === 3;
  const recipientName = isGroupDM
    ? (dmChannel?.name || dmChannel?.recipients?.map((r) => r.username).join(', ') || 'Group DM')
    : (dmChannel?.recipient?.username || 'Direct Message');

  // Reset transient chat state and any lingering context panel when the DM changes.
  useEffect(() => {
    setReplyingTo(null);
    setContextPanelMode(null);
  }, [channelId, setContextPanelMode]);

  if (!channelId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg-primary">
        <TopBar isDM recipientName="Direct Messages" />
        <div className="flex flex-1 items-center justify-center overflow-hidden p-6">
          <div className="w-full max-w-md rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
            <EmptyState
              className="px-0 py-0"
              icon={<MessageCircleMore size={20} />}
              title="Pick up a conversation"
              description="Choose a direct message from the left rail to jump back in, or start a fresh one from someone on your friends list."
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => navigate('/app/friends')}>Browse friends</Button>
                  <Button variant="secondary" onClick={() => navigate('/app/friends')}>
                    Start a new DM
                  </Button>
                </div>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <TopBar isDM recipientName={recipientName} dmChannelId={channelId} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isGroupDM && (
          <div className="flex justify-end border-b border-border-subtle px-3 py-2">
            <button
              type="button"
              aria-pressed={contextPanelMode === 'members'}
              className="inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-meta font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)] aria-pressed:bg-accent-tint aria-pressed:text-accent-primary"
              onClick={() => toggleContextPanelMode('members')}
              title="Members"
            >
              <Users size={14} />
              Members
            </button>
          </div>
        )}
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
        <MessageInput channelId={channelId} replyingTo={replyingTo} onCancelReply={() => setReplyingTo(null)} />
      </div>
    </div>
  );
}
