import { useRef } from 'react';
import type { RefObject } from 'react';
import { Inbox, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ReadState } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { TopBarOverlay } from './TopBarOverlay';

interface UnreadItem {
  state: ReadState;
  channelName: string;
}

interface InboxOverlayProps {
  open: boolean;
  onClose: () => void;
  unreadItems: UnreadItem[];
  allChannels: Array<{ id: string; guild_id?: string | null }>;
  error?: string | null;
}

export function InboxOverlay({ open, onClose, unreadItems, allChannels, error }: InboxOverlayProps) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

  return (
    <TopBarOverlay
      open={open}
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-inbox-title"
      panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
    >
      <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
        <div id="topbar-inbox-title" className="font-bold text-text-primary">Inbox</div>
        <button className="command-icon-btn" onClick={onClose} aria-label="Close inbox"><X size={16} /></button>
      </div>
      <div className="max-h-[min(67dvh,31rem)] overflow-y-auto bg-bg-primary p-0 scrollbar-thin">
        {error ? (
          <div
            role="alert"
            className="m-4 rounded-xl border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger"
          >
            {error}
          </div>
        ) : unreadItems.length > 0 ? (
          unreadItems.map(({ state, channelName: unreadChannelName }) => {
            const channel = allChannels.find((c) => c.id === state.channel_id);
            return (
              <button
                key={state.channel_id}
                className="flex w-full flex-col border-b border-border-subtle p-4.5 text-left transition-colors hover:bg-bg-mod-subtle"
                onClick={() => {
                  onClose();
                  if (channel?.guild_id) {
                    navigate(`/app/guilds/${channel.guild_id}/channels/${state.channel_id}`);
                  } else {
                    navigate(`/app/dms/${state.channel_id}`);
                  }
                }}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-primary">#{unreadChannelName}</span>
                  <span className="h-2 w-2 rounded-full bg-accent-primary"></span>
                </div>
                <div className="text-sm text-text-muted">Unread messages</div>
              </button>
            );
          })
        ) : (
          <div className="px-8 py-12 text-center text-text-muted">
            <Inbox size={48} className="mx-auto mb-4 opacity-20" />
            You're all caught up! No unread messages.
          </div>
        )}
      </div>
    </TopBarOverlay>
  );
}
