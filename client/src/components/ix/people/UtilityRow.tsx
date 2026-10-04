import type { MouseEvent } from 'react';

import { SELECTED_ATTRIBUTE } from '../sidebar/useSelectionGlide';
import type { RowFocus } from '../sidebar/useRovingList';
import { usePreviewRoll } from '../sidebar/usePreviewRoll';

export interface UtilityRowProps extends RowFocus {
  /** `friends` or `inbox`: the row's id for the list and the test. */
  id: 'friends' | 'inbox';
  name: string;
  line: string;
  /** A white count under the name's end (requests; mentions). Zero draws none. */
  count: number;
  /** The count in words, for the accessible name ("2 requests"). */
  countWords: string | null;
  href: string;
  selected: boolean;
  leaving: boolean;
  onOpen: () => void;
}

function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  return !(event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/**
 * Friends and Inbox (docs/index-spec.md §6.6): two utility rows styled as channel
 * rows. They open pages in main. A white count says something is waiting for you
 * (requests; mentions), and the row's line says what, in the words a channel's
 * last line uses.
 */
export function UtilityRow({ id, name, line, count, countWords, href, selected, leaving, tabIndex, onFocus, onOpen }: UtilityRowProps) {
  const [lineRef] = usePreviewRoll(line, null, !leaving);
  const waiting = !selected && count > 0;
  return (
    <li>
      <a
        href={href}
        className="ix-ch ix-ch--utility"
        data-testid={`ix-people-${id}`}
        data-place-row=""
        data-row-id={id}
        data-mentions={waiting || undefined}
        {...(selected ? { [SELECTED_ATTRIBUTE]: '' } : null)}
        aria-current={selected ? 'page' : undefined}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="ix-ch__name">
          <span className="ix-ch__name-text">{name}</span>
          {waiting && countWords && <span className="sr-only">, {countWords}</span>}
        </span>
        <span ref={lineRef} className="ix-ch__line">
          <span className="ix-ch__line-text">{line}</span>
        </span>
        {waiting && (
          <span className="ix-ch__mention" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </a>
    </li>
  );
}
