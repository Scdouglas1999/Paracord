import { useState } from 'react';
import { Hash, MessageSquare, X } from 'lucide-react';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import type { Message } from '../../types';
import { useChannelStore } from '../../stores/channelStore';
import { channelApi } from '../../api/channels';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';

interface ThreadPanelProps {
  guildId: string;
  threadChannelId: string;
  threadName: string;
  parentChannelName: string;
  onClose: () => void;
  className?: string;
}

export function ThreadPanel({
  guildId,
  threadChannelId,
  threadName,
  parentChannelName,
  onClose,
  className = '',
}: ThreadPanelProps) {
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const threadChannel = Object.values(channelsByGuild).flat().find((channel) => channel.id === threadChannelId);
  const isArchived = Boolean(threadChannel?.thread_metadata?.archived);

  const restoreThread = async () => {
    if (!threadChannel?.parent_id || restoring) return;
    setRestoring(true);
    try {
      const { data: updated } = await channelApi.updateThread(threadChannel.parent_id, threadChannelId, { archived: false });
      useChannelStore.getState().updateChannel(updated);
    } catch {
      toast.error('Failed to restore thread.');
    } finally {
      setRestoring(false);
    }
  };

  const deleteThread = async () => {
    if (!threadChannel?.parent_id || deleting) return;
    if (!(await confirm({ title: 'Delete this thread?', description: 'This cannot be undone.', confirmLabel: 'Delete', variant: 'danger' }))) return;
    setDeleting(true);
    try {
      await channelApi.deleteThread(threadChannel.parent_id, threadChannelId);
      if (guildId) {
        useChannelStore.getState().removeChannel(guildId, threadChannelId);
      }
      onClose();
    } catch {
      toast.error('Failed to delete thread.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col border-l border-border-subtle bg-bg-secondary/40 ${className}`}>
      <div className="panel-divider flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle/70 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <MessageSquare size={15} />
            <span className="truncate">{threadName || 'Thread'}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
            <Hash size={11} />
            <span className="truncate">{parentChannelName || 'parent channel'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isArchived && (
            <button
              type="button"
              onClick={() => void restoreThread()}
              disabled={restoring}
              className="rounded-lg border border-border-subtle/70 bg-bg-mod-subtle/70 px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
            >
              Restore
            </button>
          )}
          <button
            type="button"
            onClick={() => void deleteThread()}
            disabled={deleting}
            className="rounded-lg border border-border-subtle/70 bg-bg-mod-subtle/70 px-2.5 py-1.5 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/10 disabled:opacity-60"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
          <button
            onClick={onClose}
            className="command-icon-btn h-8 w-8 rounded-lg border border-border-subtle/70 bg-bg-mod-subtle/70 text-text-secondary hover:text-text-primary"
            aria-label="Close thread"
            title="Close thread"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {isArchived && (
          <div className="mx-4 mt-3 rounded-lg border border-border-subtle bg-bg-mod-subtle/40 px-3 py-2 text-xs text-text-muted">
            This thread is archived. Restore it to send new messages.
          </div>
        )}
        <MessageList
          channelId={threadChannelId}
          onReply={(msg: Message) =>
            setReplyingTo({
              id: msg.id,
              author: msg.author.username,
              content: msg.content || '',
            })
          }
        />
        {!isArchived && (
          <MessageInput
            channelId={threadChannelId}
            guildId={guildId}
            channelName={threadName}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
          />
        )}
      </div>
    </div>
  );
}
