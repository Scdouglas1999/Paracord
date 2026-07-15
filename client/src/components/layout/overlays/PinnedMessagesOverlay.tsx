import { useRef } from 'react';
import type { RefObject } from 'react';
import { Pin, PinOff, X } from 'lucide-react';
import { extractApiError } from '../../../api/client';
import { channelApi } from '../../../api/channels';
import { useMessageStore } from '../../../stores/messageStore';
import type { Message } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { safeStoredImageDataUrl } from '../../../lib/security';
import { displayName } from '../../../lib/displayName';
import { TopBarOverlay } from './TopBarOverlay';

interface PinnedMessagesOverlayProps {
  open: boolean;
  onClose: () => void;
  channelId?: string;
  pins: Message[];
  onPinsChange: (pins: Message[]) => void;
  error?: string | null;
  onErrorChange?: (error: string | null) => void;
  presentation?: 'overlay' | 'panel';
  panelRef?: RefObject<HTMLElement | null>;
}

export function PinnedMessagesOverlay({
  open,
  onClose,
  channelId,
  pins,
  onPinsChange,
  error,
  onErrorChange,
  presentation = 'overlay',
  panelRef,
}: PinnedMessagesOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const unpinMessage = useMessageStore((s) => s.unpinMessage);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open && presentation === 'overlay', onClose);

  const content = (
    <>
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
                <button
                  type="button"
                  className="w-full rounded-sm text-left outline-none focus-visible:shadow-[var(--focus-ring)]"
                  onClick={() => {
                    window.location.hash = `msg-${msg.id}`;
                    onClose();
                  }}
                  aria-label={`Jump to pinned message from ${displayName(msg.author)}`}
                >
                  <div className="flex items-center gap-2.5 pr-9">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-tertiary text-meta font-semibold text-text-secondary">
                      {avatarSrc ? <img src={avatarSrc} alt="" className="h-full w-full object-cover" /> : displayName(msg.author)[0]}
                    </div>
                    <span className="text-label font-semibold text-text-primary">{displayName(msg.author)}</span>
                    <time className="ml-auto font-code text-meta tabular-nums text-text-muted">
                      {Number.isNaN(pinnedAt.getTime()) ? '' : pinnedAt.toLocaleDateString()}
                    </time>
                  </div>
                  <p className="mt-1.5 pl-[2.375rem] pr-9 text-body text-text-primary">
                    {msg.content || <span className="italic text-text-muted">Attachment only</span>}
                  </p>
                </button>
                {channelId && (
                  <button
                    type="button"
                    aria-label="Unpin this message"
                    title="Unpin this message"
                    className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-[opacity,color,background-color] duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100"
                    onClick={async (e) => {
                      e.stopPropagation();
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
    </>
  );

  if (!open) return null;
  if (presentation === 'panel') {
    return (
      <aside
        ref={panelRef}
        role="complementary"
        aria-label="Pinned messages"
        tabIndex={-1}
        data-testid="context-panel"
        data-mode="pins"
        className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-bg-secondary shadow-sm outline-none"
        style={{ width: 'var(--member-list-width)' }}
      >
        <header className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          <Pin size={18} className="shrink-0 text-text-secondary" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-subhead text-text-primary">Pinned messages</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Pinned messages panel"
            className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-text-muted outline-none hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{content}</div>
      </aside>
    );
  }

  return (
    <TopBarOverlay
      open
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-pins-title"
      title="Pinned Messages"
      icon={Pin}
      closeLabel="Close pinned messages"
      panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
    >
      {content}
    </TopBarOverlay>
  );
}
