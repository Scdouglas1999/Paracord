import { useRef } from 'react';
import type { RefObject } from 'react';
import { Check, Hash, Inbox, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ReadState } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useReadStateStore } from '../../../stores/readStateStore';
import { channelApi } from '../../../api/channels';
import { TopBarOverlay } from './TopBarOverlay';

interface UnreadItem {
  state: ReadState;
  channelName: string;
}

interface InboxChannel {
  id: string;
  guild_id?: string | null;
  last_message_id?: string | null;
}

interface InboxOverlayProps {
  open: boolean;
  onClose: () => void;
  unreadItems: UnreadItem[];
  allChannels: InboxChannel[];
  error?: string | null;
}

export function InboxOverlay({ open, onClose, unreadItems, allChannels, error }: InboxOverlayProps) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

  const markItemRead = (channelId: string) => {
    const channel = allChannels.find((c) => c.id === channelId);
    const lastId = channel?.last_message_id;
    if (!lastId) return;
    // Optimistic local read; the row drops out as the store recomputes.
    useReadStateStore.getState().markRead(channelId, lastId);
    void channelApi.updateReadState(channelId, lastId).catch(() => undefined);
  };

  return (
    <TopBarOverlay
      open={open}
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-inbox-title"
      title="Inbox"
      icon={Inbox}
      closeLabel="Close inbox"
      panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
      bodyClassName="p-1.5"
    >
      {error ? (
        <div
          role="alert"
          className="m-2.5 rounded-md border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger"
        >
          {error}
        </div>
      ) : unreadItems.length > 0 ? (
        <ul className="space-y-0.5">
          {unreadItems.map(({ state, channelName: unreadChannelName }) => {
            const channel = allChannels.find((c) => c.id === state.channel_id);
            const isGuildChannel = Boolean(channel?.guild_id);
            const goToChannel = () => {
              onClose();
              if (channel?.guild_id) {
                navigate(`/app/guilds/${channel.guild_id}/channels/${state.channel_id}`);
              } else {
                navigate(`/app/dms/${state.channel_id}`);
              }
            };
            return (
              <li
                key={state.channel_id}
                className="group flex items-center gap-3 rounded-sm px-2.5 py-2 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-within:bg-bg-mod-subtle"
              >
                <button
                  type="button"
                  onClick={goToChannel}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                    {isGuildChannel ? <Hash size={16} /> : <MessageSquare size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-label font-semibold text-text-primary">
                        {isGuildChannel ? `#${unreadChannelName}` : unreadChannelName}
                      </span>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary" aria-hidden />
                    </span>
                    <span className="block truncate text-meta text-text-muted">
                      {isGuildChannel ? 'New messages in this channel' : 'New direct messages'}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => markItemRead(state.channel_id)}
                  aria-label={`Mark #${unreadChannelName} as read`}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-[opacity,color,background-color] duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-accent-success focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100"
                >
                  <Check size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-start gap-3.5 px-5 py-8">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <Inbox size={20} />
          </span>
          <div className="min-w-0 pt-0.5">
            <h3 className="text-subhead text-text-primary">You&apos;re all caught up</h3>
            <p className="mt-1 text-label text-text-secondary">
              No unread channels right now. New mentions and activity land here as they arrive.
            </p>
          </div>
        </div>
      )}
    </TopBarOverlay>
  );
}
