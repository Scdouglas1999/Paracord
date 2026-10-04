import type { MouseEvent } from 'react';

import type { SidebarChannel } from '../../glass/places/rows';
import { IxGlyph } from '../glyphs';
import type { RowFocus } from './useRovingList';
import { usePreviewRoll } from './usePreviewRoll';
import { FLIP_ATTRIBUTE, GROUP_ATTRIBUTE } from './useCollapse';
import { SELECTED_ATTRIBUTE } from './useSelectionGlide';
import { pointEvent, useLongPress } from './useLongPress';

export interface ChannelRowProps extends RowFocus {
  row: SidebarChannel;
  href: string;
  /** The group this row belongs to (what closing it hides). */
  group: string;
  /** Stays visible while its group is closed: unread, mentioned, or the one that is open. */
  keep: boolean;
  /** The pane is sliding out: nothing plays. */
  leaving: boolean;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

/** Is a plain primary click (a modifier click or a middle click is the browser's)? */
function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  return !(event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/**
 * A channel (docs/index-spec.md §4.5, §3.1 "Channel row"): a two-line row of fixed
 * height. The name (no `#`), the time of the last message, the last line ("Jeremy:
 * who's up for a run tonight?", a topic, "No messages yet", "Encrypted" with a
 * lock). Unread: a white dot, the ink name, the brighter line. Mentions: a white
 * count under the time. Muted: the quiet name, no dot. An announcement channel
 * carries a megaphone after its name.
 *
 * A row is a link: it has an address, opens with Enter, and a modifier click is
 * left to the browser. State is in the accessible name ("clips, unread, 2
 * mentions"); the dot and the chip are only the picture of it.
 */
export function ChannelRow({ row, href, group, keep, leaving, tabIndex, onFocus, onOpen, onContextMenu }: ChannelRowProps) {
  const lineText = row.encrypted ? 'Encrypted' : row.line;
  const [lineRef, timeRef] = usePreviewRoll(lineText, row.time, !leaving);
  const press = useLongPress((point) => onContextMenu(pointEvent(point)));
  return (
    <li>
      <a
        href={href}
        className="ix-ch"
        data-testid="ix-channel-row"
        data-channel-id={row.channelId}
        data-place-row=""
        data-row-id={row.id}
        data-unread={row.unread || undefined}
        data-muted={row.muted || undefined}
        data-mentions={row.mentions > 0 || undefined}
        data-keep={keep || undefined}
        {...{ [FLIP_ATTRIBUTE]: '', [GROUP_ATTRIBUTE]: group, ...(row.selected ? { [SELECTED_ATTRIBUTE]: '' } : null) }}
        aria-current={row.selected ? 'page' : undefined}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onContextMenu={onContextMenu}
        {...press}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="ix-ch__dot" aria-hidden="true" />
        <span className="ix-ch__name">
          <span className="ix-ch__name-text">{row.name}</span>
          {row.kind === 'announcement' && <IxGlyph name="megaphone" size={12} className="ix-ch__kind" />}
          {row.state.length > 0 && <span className="sr-only">, {row.state.join(', ')}</span>}
        </span>
        {row.time && (
          <time ref={timeRef} className="ix-ch__time" dateTime={row.timeIso ?? undefined}>
            {row.time}
          </time>
        )}
        <span ref={lineRef} className="ix-ch__line">
          {row.encrypted && <IxGlyph name="lock" size={12} />}
          {lineText && <span className="ix-ch__line-text">{lineText}</span>}
        </span>
        {row.mentions > 0 && (
          <span className="ix-ch__mention" aria-hidden="true">
            {row.mentions > 99 ? '99+' : row.mentions}
          </span>
        )}
      </a>
    </li>
  );
}
