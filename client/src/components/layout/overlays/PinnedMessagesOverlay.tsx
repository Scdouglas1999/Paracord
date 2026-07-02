import { useRef } from 'react';
import type { RefObject } from 'react';
import { Pin, X } from 'lucide-react';
import { extractApiError } from '../../../api/client';
import { channelApi } from '../../../api/channels';
import { useMessageStore } from '../../../stores/messageStore';
import type { Message } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { safeStoredImageDataUrl } from '../../../lib/security';
import { TopBarOverlay } from './TopBarOverlay';

interface PinnedMessagesOverlayProps {
  open: boolean;
  onClose: () => void;
  channelId?: string;
  pins: Message[];
  onPinsChange: (pins: Message[]) => void;
  error?: string | null;
  onErrorChange?: (error: string | null) => void;
}

export function PinnedMessagesOverlay({
  open,
  onClose,
  channelId,
  pins,
  onPinsChange,
  error,
  onErrorChange,
}: PinnedMessagesOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const unpinMessage = useMessageStore((s) => s.unpinMessage);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

  return (
    <TopBarOverlay
      open={open}
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-pins-title"
      panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
    >
      <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
        <div id="topbar-pins-title" className="font-bold text-text-primary">Pinned Messages</div>
        <button className="command-icon-btn" onClick={onClose} aria-label="Close pinned messages"><X size={16} /></button>
      </div>
      <div className="max-h-[min(67dvh,31rem)] space-y-4 overflow-y-auto bg-bg-primary p-4 sm:p-5 scrollbar-thin">
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger"
          >
            {error}
          </div>
        )}
        {pins.map((msg) => {
          const avatarSrc = safeStoredImageDataUrl(msg.author.avatar);
          return (
            <div key={msg.id} className="rounded-xl border border-border-subtle bg-bg-mod-subtle p-3.5">
              <div className="mb-2 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-bg-tertiary text-[10px] text-text-muted">
                  {avatarSrc ? <img src={avatarSrc} alt="" className="h-full w-full object-cover" /> : msg.author.username[0]}
                </div>
                <span className="text-sm font-semibold text-text-primary">{msg.author.username}</span>
                <span className="ml-auto text-xs text-text-muted">{new Date(msg.created_at || msg.timestamp || '').toLocaleDateString()}</span>
              </div>
              <div className="mb-2 text-sm text-text-primary">{msg.content || '(attachment only)'}</div>
              {channelId && (
                <button
                  type="button"
                  className="inline-flex h-9 items-center rounded-lg border border-transparent px-3 text-sm font-semibold text-accent-danger transition-colors hover:border-accent-danger/35 hover:bg-accent-danger/12"
                  onClick={async () => {
                    onErrorChange?.(null);
                    try {
                      await unpinMessage(channelId, msg.id);
                      const { data } = await channelApi.getPins(channelId);
                      onPinsChange(data);
                    } catch (err) {
                      onErrorChange?.(`Failed to unpin message: ${extractApiError(err)}`);
                    }
                  }}
                >
                  Unpin this message
                </button>
              )}
            </div>
          );
        })}
        {pins.length === 0 && (
          <div className="py-8 text-center text-text-muted">
            <Pin size={48} className="mx-auto mb-4 opacity-20" />
            No pinned messages in this channel yet.
          </div>
        )}
      </div>
    </TopBarOverlay>
  );
}
