import { MessageSquare, X } from 'lucide-react';
import { MessageList } from '../../components/message/MessageList';
import { MessageInput } from '../../components/message/MessageInput';
import type { Message } from '../../types';

type ReplyTarget = { id: string; author: string; content: string } | null;

interface VoiceChatSidebarProps {
  isMobile: boolean;
  isStage: boolean;
  channelId: string;
  guildId: string | undefined;
  channelName: string;
  replyingTo: ReplyTarget;
  onReply: (target: ReplyTarget) => void;
  onClose: () => void;
}

export function VoiceChatSidebar({
  isMobile,
  isStage,
  channelId,
  guildId,
  channelName,
  replyingTo,
  onReply,
  onClose,
}: VoiceChatSidebarProps) {
  const header = (
    <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
      <div className="flex items-center gap-2 text-label font-semibold text-text-primary">
        <MessageSquare size={16} className="text-text-muted" />
        {isStage ? 'Stage chat' : 'Voice channel chat'}
      </div>
      <button
        onClick={onClose}
        className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
        aria-label="Close voice chat"
        title="Close voice chat"
      >
        <X size={18} />
      </button>
    </div>
  );

  const body = (
    <>
      {header}
      <MessageList
        channelId={channelId}
        onReply={(msg: Message) => onReply({ id: msg.id, author: msg.author.username, content: msg.content || '' })}
      />
      <MessageInput
        channelId={channelId}
        guildId={guildId}
        channelName={channelName}
        replyingTo={replyingTo}
        onCancelReply={() => onReply(null)}
      />
    </>
  );

  if (isMobile) {
    return <div className="absolute inset-0 z-50 flex flex-col bg-bg-primary">{body}</div>;
  }

  return (
    <div className="flex w-[min(460px,42vw)] max-w-[40rem] shrink-0 flex-col border-l border-border-subtle bg-bg-primary shadow-[-8px_0_32px_rgba(0,0,0,0.5)] z-40 relative">
      {body}
    </div>
  );
}
