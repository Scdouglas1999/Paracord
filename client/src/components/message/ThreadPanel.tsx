import { useCurrentChannelStore, useChannelActions } from '../../hooks/useChannels';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { CornerUpLeft } from 'lucide-react';
import { useNavigate } from 'react-router';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import type { Message } from '../../types';
import { displayName } from '../../lib/displayName';
import { channelApi } from '../../api/channels';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { usePermissions } from '../../hooks/usePermissions';
import { hasPermission, Permissions } from '../../types';
import { ErrorBoundary } from '../ErrorBoundary';
import { GlassButton } from '../glass/primitives';
import { cn } from '../../lib/utils';

interface ThreadPanelProps {
  guildId: string;
  threadChannelId: string;
  threadName: string;
  parentChannelName: string;
  onClose: () => void;
  /**
   * Called after the thread is deleted, in place of `onClose`: a thread pushed
   * over a list goes back to the list rather than closing the whole sheet.
   */
  onDeleted?: () => void;
  className?: string;
}

/** Below this the message box asks for a short invitation (a phone, a side chat). */
const NARROW_BELOW = 560;

/** The element's width, or 0 until it has been laid out. */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(node.getBoundingClientRect().width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
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
  onDeleted,
  className = '',
}: ThreadPanelProps) {
  const navigate = useNavigate();
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  // Zero means "not laid out" (a detached tree), never "wide".
  const narrow = width < NARROW_BELOW;
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const channelActions = useChannelActions();
  const threadChannel = useCurrentChannelStore((s) => s.channelsById[threadChannelId]);
  const isArchived = Boolean(threadChannel?.thread_metadata?.archived);
  const currentUserId = useCurrentUser()?.id;
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
    channelActions.selectChannel(parentId);
    onClose();
    navigate(`/app/guilds/${guildId}/channels/${parentId}`);
  };

  const restoreThread = async () => {
    if (!threadChannel?.parent_id || restoring) return;
    setRestoring(true);
    try {
      const { data: updated } = await channelApi.updateThread(threadChannel.parent_id, threadChannelId, { archived: false });
      channelActions.updateChannel(updated);
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
        channelActions.removeChannel(guildId, threadChannelId);
      }
      (onDeleted ?? onClose)();
    } catch (err: unknown) {
      toast.error(threadPanelError('Failed to delete thread', err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={cn('glass-sheet-thread', className)}
      data-testid="thread-page"
      data-thread={threadChannelId}
    >
      <div className="glass-sheet-thread__bar">
        <button
          type="button"
          onClick={openParentChannel}
          disabled={!threadChannel?.parent_id}
          className="glass-sheet-thread__parent glass-focusable"
          aria-label={`Open parent channel ${parentChannelName || 'parent channel'}`}
        >
          <CornerUpLeft size={14} className="shrink-0" aria-hidden />
          <span className="truncate">{parentChannelName || 'parent channel'}</span>
        </button>
        <div className="glass-sheet-thread__actions">
          {isArchived && canRestoreThread && (
            <GlassButton variant="text" onClick={() => void restoreThread()} disabled={restoring}>
              Restore
            </GlassButton>
          )}
          {canManageThread && (
            <GlassButton variant="text" onClick={() => void deleteThread()} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </GlassButton>
          )}
        </div>
      </div>

      {isArchived && (
        <p className="glass-sheet-thread__notice">
          {canRestoreThread
            ? 'This thread is archived. Restore it to send new messages.'
            : 'This thread is archived. Its owner or a moderator can restore it.'}
        </p>
      )}
      <div className="glass-sheet-thread__timeline">
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
      </div>
      {!isArchived && (
        <div className="glass-sheet-thread__composer" data-narrow={narrow ? 'true' : 'false'}>
          <MessageInput
            channelId={threadChannelId}
            guildId={guildId}
            channelName={threadName}
            // A pane too narrow for a sentence (a phone, the side-by-side chat)
            // asks for a short invitation: the thread's name is the title of the
            // sheet already.
            narrow={narrow}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
          />
        </div>
      )}
    </div>
  );
}
