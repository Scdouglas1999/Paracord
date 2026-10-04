import { useState } from 'react';

import { displayName } from '../../../lib/displayName';
import type { Message } from '../../../types';
import { ErrorBoundary } from '../../ErrorBoundary';
import { StageChannelPanel } from '../../glass/stage/StageChannelPanel';
import { MessageInput } from '../../message/MessageInput';
import { MessageList } from '../../message/MessageList';

/**
 * H: the call's own conversation as a 360px column at the content's right
 * (docs/index-spec.md §7.2): a voice channel's own text chat, or the DM in a
 * direct call. An inner panel (`rgba(255,255,255,.03)`, radius 20) with the
 * same timeline and a narrow message box; the conversation components are
 * imported, never edited. A stage channel puts its session (topic, hands,
 * speakers; `StageChannelPanel`) at the column's head.
 */
export interface ChatColumnProps {
  channelId: string;
  /** The server, or null in a direct call. */
  guildId: string | null;
  channelName: string;
  stageChannel: boolean;
}

export function ChatColumn({ channelId, guildId, channelName, stageChannel }: ChatColumnProps) {
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  // The view is keyed by its call, so a reply target never outlives its channel.

  return (
    <aside className="ix-call-chat" aria-label={`Chat in ${channelName}`}>
      <div className="ix-call-chat__panel">
        {stageChannel && guildId && (
          <div className="ix-call-chat__head">
            <ErrorBoundary variant="section" label="the stage">
              <StageChannelPanel guildId={guildId} channelId={channelId} channelName={channelName} />
            </ErrorBoundary>
          </div>
        )}
        <div className="ix-call-chat__feed">
          <ErrorBoundary variant="section" label="the message feed">
            <MessageList
              channelId={channelId}
              onReply={(message: Message) =>
                setReplyingTo({ id: message.id, author: displayName(message.author), content: message.content || '' })
              }
            />
          </ErrorBoundary>
        </div>
        <div className="ix-call-chat__box">
          <MessageInput
            channelId={channelId}
            guildId={guildId ?? undefined}
            channelName={channelName}
            conversationKind={guildId ? 'channel' : 'person'}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            narrow
          />
        </div>
      </div>
    </aside>
  );
}
