import { useEffect, useState } from 'react';
import { MessageList } from '../../components/message/MessageList';
import { MessageInput } from '../../components/message/MessageInput';
import { useUIStore } from '../../stores/uiStore';
import type { Channel, Message } from '../../types';
import { displayName } from '../../lib/displayName';

interface TextChannelViewProps {
  guildId: string | undefined;
  channelId: string;
  channelName: string;
  channel: Channel | undefined;
  channels: Channel[];
}

/**
 * ChatView body for a text/thread channel (layout-spec §1 — full-width single
 * pane). All message internals are reused untouched: `MessageList` + composer.
 *
 * The right-hand surfaces (search / pins / members / economy / threads) are no
 * longer docked here — they live in the shell-owned `ContextPanel`, driven by
 * `uiStore.contextPanelMode` and toggled from `TopBar`. Landing on a *thread*
 * channel routes the active thread into the ContextPanel `threads` mode
 * (layout-spec §2: `ThreadPanel` → ContextPanel) and shows the parent channel as
 * read context in the main pane.
 */
export function TextChannelView({
  guildId,
  channelId,
  channelName,
  channel,
  channels,
}: TextChannelViewProps) {
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);

  // Clear the reply target when switching channels.
  useEffect(() => {
    setReplyingTo(null);
  }, [channelId]);

  const isThread = channel?.type === 6 || channel?.channel_type === 6;
  const parentChannelId = isThread ? channel?.parent_id ?? null : null;
  const parentChannel = parentChannelId ? channels.find((c) => c.id === parentChannelId) : null;
  const showThreadContext = Boolean(isThread && guildId && parentChannel);

  // A thread channel surfaces its conversation in the ContextPanel `threads`
  // mode (the ContextPanel derives the active thread from the current channel);
  // auto-open it on entry so the thread is visible without an extra click.
  useEffect(() => {
    if (showThreadContext) {
      setContextPanelMode('threads');
    }
  }, [showThreadContext, channelId, setContextPanelMode]);

  if (showThreadContext) {
    return (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="panel-divider flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5">
            <span className="text-section uppercase text-text-muted">Parent channel</span>
            <span className="text-label text-text-secondary">#{parentChannel?.name || 'unknown'}</span>
          </div>
          <MessageList channelId={parentChannel!.id} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList
          channelId={channelId}
          onReply={(msg: Message) =>
            setReplyingTo({
              id: msg.id,
              author: displayName(msg.author),
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
    </div>
  );
}
