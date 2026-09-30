import { useEffect, useMemo, useState } from 'react';
import { Archive, MessageSquare } from 'lucide-react';
import { channelApi } from '../../../api/channels';
import { extractApiError } from '../../../api/client';
import { useChannelActions, useCurrentChannelStore } from '../../../hooks/useChannels';
import type { Channel } from '../../../types';
import { SheetAlert, SheetEmpty, SheetStatus } from './SheetParts';

/**
 * The room's threads, newest first (archived last). A thread is a conversation
 * of its own: picking one pushes it over this list, in the same column, with a
 * back button (`onOpen`); the thread you are already reading is marked and
 * closes the sheet instead of drawing a second copy of itself.
 */

const isThreadChannel = (channel: Channel | undefined): boolean =>
  channel?.type === 6 || channel?.channel_type === 6;

const isThreadableChannel = (channel: Channel | undefined, channelId: string | null | undefined): boolean => {
  if (!channel || !channelId || isThreadChannel(channel)) return false;
  const type = channel.type ?? channel.channel_type ?? 0;
  return type === 0 || type === 5 || type === 7;
};

/**
 * Which room's threads this lists. A threadable room lists its own. Standing
 * inside a thread it lists the room's, the siblings of the thread you are
 * reading, because the thread is the page behind the sheet.
 */
export function threadListParentOf(
  channel: Channel | undefined,
  channelId: string | null | undefined,
): string | null {
  if (isThreadChannel(channel)) return channel?.parent_id ?? null;
  return isThreadableChannel(channel, channelId) ? channelId! : null;
}

function sortThreads(threads: Channel[]): Channel[] {
  return [...threads].sort((a, b) => {
    const aArchived = a.thread_metadata?.archived === true;
    const bArchived = b.thread_metadata?.archived === true;
    if (aArchived !== bArchived) return aArchived ? 1 : -1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export interface ThreadsPageProps {
  /** The channel behind the sheet. */
  channelId: string | null;
  /** Called with the thread to push. */
  onOpen: (threadId: string) => void;
  /** Called when the thread you picked is the one already on screen. */
  onClose: () => void;
}

export function ThreadsPage({ channelId, onOpen, onClose }: ThreadsPageProps) {
  const channelActions = useChannelActions();
  const channelsById = useCurrentChannelStore((s) => s.channelsById);
  const activeChannel = channelId ? channelsById[channelId] : undefined;
  const parentId = threadListParentOf(activeChannel, channelId);
  // What the last load of `parentId` came to; null until it has answered.
  const [result, setResult] = useState<{ parentId: string; error: string | null } | null>(null);

  const threads = useMemo(
    () =>
      sortThreads(
        Object.values(channelsById).filter((channel) => isThreadChannel(channel) && channel.parent_id === parentId),
      ),
    [channelsById, parentId],
  );

  useEffect(() => {
    if (!parentId) return;
    let canceled = false;
    Promise.all([channelApi.getThreads(parentId), channelApi.getArchivedThreads(parentId)])
      .then(([active, archived]) => {
        if (canceled) return;
        for (const thread of [...active.data, ...archived.data]) {
          channelActions.addChannel(thread);
          channelActions.updateChannel(thread);
        }
        setResult({ parentId, error: null });
      })
      .catch((err) => {
        if (!canceled) setResult({ parentId, error: `Failed to load threads: ${extractApiError(err)}` });
      });
    return () => {
      canceled = true;
    };
  }, [parentId, channelActions]);

  const answered = result?.parentId === parentId;
  const error = answered ? result.error : null;

  if (!parentId) {
    return (
      <SheetEmpty icon={<MessageSquare size={20} />} title="No threads here">
        Threads start from a message in a text channel.
      </SheetEmpty>
    );
  }
  if (error) {
    return (
      <>
        <SheetAlert>{error}</SheetAlert>
        <SheetEmpty icon={<MessageSquare size={20} />} title="Threads unavailable" role="alert">
          Try again in a moment.
        </SheetEmpty>
      </>
    );
  }
  if (!answered && threads.length === 0) {
    return <SheetStatus>Loading threads…</SheetStatus>;
  }
  if (threads.length === 0) {
    return (
      <SheetEmpty icon={<MessageSquare size={20} />} title="No threads yet">
        Threaded conversations will appear here.
      </SheetEmpty>
    );
  }

  return (
    <ul className="glass-sheet-list" aria-label="Threads">
      {threads.map((thread) => {
        const archived = thread.thread_metadata?.archived === true;
        // The thread you are reading is one of these rows. Say so, rather than
        // letting the list look like somewhere else.
        const here = thread.id === channelId;
        const count = typeof thread.message_count === 'number' ? thread.message_count : null;
        return (
          <li key={thread.id}>
            <button
              type="button"
              className="glass-sheet-row glass-focusable"
              aria-current={here ? 'true' : undefined}
              onClick={() => (here ? onClose() : onOpen(thread.id))}
            >
              <span className="glass-sheet-row__lead" aria-hidden>
                {archived ? <Archive size={17} /> : <MessageSquare size={17} />}
              </span>
              <span className="glass-sheet-row__text">
                <span className="glass-sheet-row__name">{thread.name || 'Thread'}</span>
                <span className="glass-sheet-row__detail">
                  {[
                    here ? 'You’re here' : null,
                    archived ? 'Archived' : null,
                    count !== null ? `${count} ${count === 1 ? 'message' : 'messages'}` : null,
                  ].filter(Boolean).join(' · ') || 'Thread'}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
