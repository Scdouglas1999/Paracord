import { useRef } from 'react';
import type { RefObject } from 'react';
import { Pin, PinOff } from 'lucide-react';
import { extractApiError } from '../../../api/client';
import { channelApi } from '../../../api/channels';
import { useCurrentMessageStore } from '../../../hooks/useMessageStore';
import type { Message } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { displayName } from '../../../lib/displayName';
import { SheetAlert, SheetEmpty } from '../../glass/sheets/SheetParts';
import { whenLabel } from '../../glass/sheets/whenLabel';
import { Avatar } from '../../ix/identity';
import { TopBarOverlay } from './TopBarOverlay';

interface PinnedMessagesOverlayProps {
  open: boolean;
  onClose: () => void;
  channelId?: string;
  pins: Message[];
  onPinsChange: (pins: Message[]) => void;
  error?: string | null;
  onErrorChange?: (error: string | null) => void;
  /**
   * `panel`: the page inside the channel sheet, which supplies the frame, the
   * title and the close button. `overlay`: a dialog of its own.
   */
  presentation?: 'overlay' | 'panel';
  panelRef?: RefObject<HTMLElement | null>;
}

/**
 * Pinned messages, as cards (the action card's wash and hairline, docs/index-spec.md
 * §3.1): who, when and what, one press to jump to the message, and (for people
 * who may) a quiet unpin on hover and focus. The page inside the channel sheet.
 */
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
  const unpinMessage = useCurrentMessageStore((s) => s.unpinMessage);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open && presentation === 'overlay', onClose);

  const content = (
    <>
      {error && <SheetAlert>{error}</SheetAlert>}
      {pins.length > 0 ? (
        <ul className="glass-sheet-cards">
          {pins.map((msg) => {
            const name = displayName(msg.author);
            return (
              <li key={msg.id} className="glass-pin">
                <button
                  type="button"
                  className="glass-sheet-card glass-pin__card glass-focusable"
                  onClick={() => {
                    window.location.hash = `msg-${msg.id}`;
                    onClose();
                  }}
                  aria-label={`Jump to pinned message from ${name}`}
                >
                  <span className="glass-sheet-card__head">
                    <Avatar
                      userId={msg.author.id}
                      name={name}
                      avatar={msg.author.avatar_hash ?? msg.author.avatar ?? null}
                      size={28}
                    />
                    <span className="glass-sheet-card__author">{name}</span>
                    <time className="glass-sheet-card__when glass-instrument">
                      {whenLabel(msg.created_at || msg.timestamp)}
                    </time>
                  </span>
                  <span className={msg.content ? 'glass-sheet-card__body' : 'glass-sheet-card__body glass-sheet-card__body--muted'}>
                    {msg.content || 'Attachment only'}
                  </span>
                </button>
                {channelId && (
                  <button
                    type="button"
                    aria-label="Unpin this message"
                    title="Unpin this message"
                    className="glass-sheet-row__action glass-pin__unpin glass-focusable"
                    data-tone="danger"
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
                    <PinOff size={16} aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !error && (
          <SheetEmpty icon={<Pin size={20} />} title="No pinned messages yet">
            Pin a message from its more menu to keep the important stuff one press away for everyone here.
          </SheetEmpty>
        )
      )}
    </>
  );

  if (!open) return null;
  if (presentation === 'panel') {
    return (
      <div
        ref={panelRef as RefObject<HTMLDivElement | null> | undefined}
        data-testid="pins-page"
        data-mode="pins"
      >
        {content}
      </div>
    );
  }

  return (
    <TopBarOverlay
      open
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-pins-title"
      title="Pinned messages"
      icon={Pin}
      closeLabel="Close pinned messages"
      panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
    >
      {content}
    </TopBarOverlay>
  );
}
