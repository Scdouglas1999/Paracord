import { useRef } from 'react';
import type { RefObject } from 'react';
import { Pin, PinOff } from 'lucide-react';
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
      title="Pinned Messages"
      icon={Pin}
      closeLabel="Close pinned messages"
      panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
    >
      {error && (
        <div
          role="alert"
          className="m-4 rounded-md border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger"
        >
          {error}
        </div>
      )}
      {pins.length > 0 ? (
        <ul className="divide-y divide-border-subtle">
          {pins.map((msg) => {
            const avatarSrc = safeStoredImageDataUrl(msg.author.avatar);
            const pinnedAt = new Date(msg.created_at || msg.timestamp || '');
            return (
              <li
                key={msg.id}
                className="group relative px-5 py-4 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-within:bg-bg-mod-subtle"
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-tertiary text-meta font-semibold text-text-secondary">
                    {avatarSrc ? <img src={avatarSrc} alt="" className="h-full w-full object-cover" /> : msg.author.username[0]}
                  </div>
                  <span className="text-label font-semibold text-text-primary">{msg.author.username}</span>
                  <time className="ml-auto font-code text-meta tabular-nums text-text-muted">
                    {Number.isNaN(pinnedAt.getTime()) ? '' : pinnedAt.toLocaleDateString()}
                  </time>
                </div>
                <p className="mt-1.5 pl-[2.375rem] pr-9 text-body text-text-primary">
                  {msg.content || <span className="italic text-text-muted">Attachment only</span>}
                </p>
                {channelId && (
                  <button
                    type="button"
                    aria-label="Unpin this message"
                    title="Unpin this message"
                    className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-[opacity,color,background-color] duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100"
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
                    <PinOff size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !error && (
          <div className="flex items-start gap-3.5 px-5 py-8">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
              <Pin size={20} />
            </span>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-subhead text-text-primary">No pinned messages yet</h3>
              <p className="mt-1 text-label text-text-secondary">
                Pin a message from its <span className="font-code text-text-primary">⋯</span> menu to keep
                the important stuff one click away for everyone here.
              </p>
            </div>
          </div>
        )
      )}
    </TopBarOverlay>
  );
}
