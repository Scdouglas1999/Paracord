import { useEffect, useState } from 'react';
import { Hash, MessageSquare, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import type { Message } from '../../types';
import { displayName } from '../../lib/displayName';
import { useChannelStore } from '../../stores/channelStore';
import { channelApi } from '../../api/channels';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { useAuthStore } from '../../stores/authStore';
import { usePermissions } from '../../hooks/usePermissions';
import { hasPermission, Permissions } from '../../types';
import { ErrorBoundary } from '../ErrorBoundary';

interface ThreadPanelProps {
  guildId: string;
  threadChannelId: string;
  threadName: string;
  parentChannelName: string;
  onClose: () => void;
  className?: string;
}

function threadPanelError(action: string, err: unknown): string {
  const detail = extractApiError(err);
  return detail ? `${action}: ${detail}` : action;
}

export function ThreadPanel({
  guildId,
  threadChannelId,
  threadName,
  parentChannelName,
  onClose,
  className = '',
}: ThreadPanelProps) {
  const navigate = useNavigate();
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const threadChannel = useChannelStore((s) => s.channelsById[threadChannelId]);
  const isArchived = Boolean(threadChannel?.thread_metadata?.archived);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const { permissions, isAdmin } = usePermissions(guildId);
  const canManageThread = isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS);
  const isThreadOwner = Boolean(currentUserId && threadChannel?.owner_id === currentUserId);
  const canRestoreThread = isThreadOwner || canManageThread;

  // Context panel reuses this component across threads — never leak reply target.
  useEffect(() => {
    setReplyingTo(null);
  }, [threadChannelId]);

  const openParentChannel = () => {
    const parentId = threadChannel?.parent_id;
    if (!parentId) return;
    useChannelStore.getState().selectChannel(parentId);
    onClose();
    navigate(`/app/guilds/${guildId}/channels/${parentId}`);
  };

  const restoreThread = async () => {
    if (!threadChannel?.parent_id || restoring) return;
    setRestoring(true);
    try {
      const { data: updated } = await channelApi.updateThread(threadChannel.parent_id, threadChannelId, { archived: false });
      useChannelStore.getState().updateChannel(updated);
    } catch (err: unknown) {
      toast.error(threadPanelError('Failed to restore thread', err));
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
    } catch (err: unknown) {
      toast.error(threadPanelError('Failed to delete thread', err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col border-l border-border-subtle bg-bg-secondary/40 ${className}`}>
      <div className="panel-divider flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-label font-semibold text-text-primary">
            <MessageSquare size={15} className="text-accent-primary" />
            <span className="truncate">{threadName || 'Thread'}</span>
          </div>
          <button
            type="button"
            onClick={openParentChannel}
            disabled={!threadChannel?.parent_id}
            className="mt-0.5 flex max-w-full items-center gap-1.5 rounded-xs text-meta text-text-muted outline-none transition-colors hover:text-accent-primary focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none"
            aria-label={`Open parent channel ${parentChannelName || 'parent channel'}`}
          >
            <Hash size={12} className="shrink-0" />
            <span className="truncate">{parentChannelName || 'parent channel'}</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {isArchived && canRestoreThread && (
            <button
              type="button"
              onClick={() => void restoreThread()}
              disabled={restoring}
              className="rounded-sm border border-border-subtle bg-bg-mod-subtle px-3 py-1.5 text-label font-semibold text-text-secondary shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
            >
              Restore
            </button>
          )}
          {canManageThread && (
            <button
              type="button"
              onClick={() => void deleteThread()}
              disabled={deleting}
              className="rounded-sm border border-border-subtle bg-bg-mod-subtle px-3 py-1.5 text-label font-semibold text-accent-danger shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-tint focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          )}
          <button
            onClick={onClose}
            className="command-icon-btn h-9 w-9 rounded-sm border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            aria-label="Close thread"
            title="Close thread"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {isArchived && (
          <div className="mx-4 mt-3 flex items-start gap-2 rounded-sm border-l-2 border-accent-warning bg-warning-tint px-3 py-2 text-meta text-text-secondary">
            {canRestoreThread
              ? 'This thread is archived. Restore it to send new messages.'
              : 'This thread is archived. Its owner or a moderator can restore it.'}
          </div>
        )}
        <ErrorBoundary variant="section" label="this thread">
          <MessageList
            channelId={threadChannelId}
            onReply={(msg: Message) =>
              setReplyingTo({
                id: msg.id,
                author: displayName(msg.author),
                content: msg.content || '',
              })
            }
          />
        </ErrorBoundary>
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
