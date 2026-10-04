import { Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * The one picker (docs/index-spec.md §6.11; WP IX-12): Emoji, GIF and Stickers
 * in one popover with a segmented control, 360x420, radius 16, near-solid,
 * anchored above the message box's emoji button. The emoji button opens it on
 * Emoji, the GIF chip on GIF.
 *
 * The three pickers inside are the existing ones (`EmojiPicker`, `GifPicker`,
 * `StickerPicker`, restyled in IX-17); this host gives them one surface, and
 * `ix-composer.css` takes their own floating chrome off while they sit in it.
 * Each picker closes on Escape and on a press outside itself; the host's own
 * controls carry `data-composer-picker-toggle` and stop the press, so moving
 * between tabs never closes it.
 */

export type ComposerPickerTab = 'emoji' | 'gif' | 'sticker';

const EmojiPicker = lazy(() => import('../ui/EmojiPicker').then((m) => ({ default: m.EmojiPicker })));
const GifPicker = lazy(() => import('./GifPicker').then((m) => ({ default: m.GifPicker })));
const StickerPicker = lazy(() => import('./StickerPicker').then((m) => ({ default: m.StickerPicker })));

const TAB_LABELS: Record<ComposerPickerTab, string> = { emoji: 'Emoji', gif: 'GIF', sticker: 'Stickers' };

export interface ComposerPickerHostProps {
  tab: ComposerPickerTab;
  /** Playing its exit: out of the tab order and the accessibility tree. */
  leaving: boolean;
  guildId?: string;
  onTab: (tab: ComposerPickerTab) => void;
  onClose: () => void;
  onEmoji: (emoji: string) => void;
  onGif: (url: string) => void;
  onSticker: (stickerId: string) => void;
}

export function ComposerPickerHost({ tab, leaving, guildId, onTab, onClose, onEmoji, onGif, onSticker }: ComposerPickerHostProps) {
  const tabs: ComposerPickerTab[] = guildId ? ['emoji', 'gif', 'sticker'] : ['emoji', 'gif'];
  const current = tabs.includes(tab) ? tab : 'emoji';
  const tabRefs = useRef<Partial<Record<ComposerPickerTab, HTMLButtonElement | null>>>({});

  // A tab that is not offered here (Stickers in a DM) is never shown.
  useEffect(() => {
    if (current !== tab) onTab(current);
  }, [current, tab, onTab]);

  let body: ReactNode;
  if (current === 'emoji') {
    body = <EmojiPicker leaving={false} guildId={guildId} onClose={onClose} onSelect={onEmoji} />;
  } else if (current === 'gif') {
    body = <GifPicker leaving={false} onClose={onClose} onSelect={onGif} />;
  } else {
    body = guildId ? <StickerPicker leaving={false} guildId={guildId} onClose={onClose} onSelect={onSticker} /> : null;
  }

  const moveTab = (step: number) => {
    const next = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length];
    onTab(next);
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  };

  return (
    <div
      className={cn('ix-picker', leaving && 'is-leaving')}
      role="dialog"
      aria-label={TAB_LABELS[current]}
      data-composer-picker-toggle=""
      {...(leaving ? { 'aria-hidden': true as const, inert: true as const } : null)}
      // A press inside the host is never "outside" the picker in it.
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="ix-picker__tabs" role="tablist" aria-label="Picker">
        {tabs.map((value) => (
          <button
            key={value}
            ref={(node) => {
              tabRefs.current[value] = node;
            }}
            type="button"
            role="tab"
            aria-selected={value === current}
            tabIndex={value === current ? 0 : -1}
            className="ix-picker__tab"
            data-composer-picker-toggle=""
            onClick={() => onTab(value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveTab(1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveTab(-1);
              }
            }}
          >
            {TAB_LABELS[value]}
          </button>
        ))}
      </div>
      <div className="ix-picker__body" role="tabpanel" aria-label={TAB_LABELS[current]}>
        <Suspense fallback={<div className="ix-picker__loading" aria-busy="true" />}>{body}</Suspense>
      </div>
    </div>
  );
}
