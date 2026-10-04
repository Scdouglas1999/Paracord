import type { MouseEvent } from 'react';

import type { AddonModel } from './useAddons';
import { SidebarLabel } from './SidebarLabel';
import { FLIP_ATTRIBUTE } from './useCollapse';
import { SELECTED_ATTRIBUTE } from './useSelectionGlide';
import type { RowFocus } from './useRovingList';

export interface AddonListProps {
  addons: readonly AddonModel[];
  focusOf: (id: string) => RowFocus;
  onOpen: (addon: AddonModel) => void;
}

function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  return !(event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/**
 * Add-ons (docs/index-spec.md §8.3): Sports, Daily word and Game servers as
 * two-line links like channels, with a live line under the name. Each opens its
 * page in main, and the one whose page is open is current (the selection glides
 * to it as it does between channels).
 */
export function AddonList({ addons, focusOf, onOpen }: AddonListProps) {
  if (addons.length === 0) return null;
  return (
    <section aria-labelledby="ix-sb-addons">
      <SidebarLabel id="ix-sb-addons">Add-ons</SidebarLabel>
      <ul className="ix-sb__list">
        {addons.map((addon) => (
          <li key={addon.id}>
            <a
              href={addon.href}
              className="ix-ch"
              data-testid="ix-addon-row"
              data-addon={addon.kind}
              data-place-row=""
              data-row-id={addon.id}
              {...{ [FLIP_ATTRIBUTE]: '', ...(addon.selected ? { [SELECTED_ATTRIBUTE]: '' } : null) }}
              aria-current={addon.selected ? 'page' : undefined}
              {...focusOf(addon.id)}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onOpen(addon);
              }}
            >
              <span className="ix-ch__name">
                <span className="ix-ch__name-text">{addon.name}</span>
              </span>
              <span className="ix-ch__line">{addon.line && <span className="ix-ch__line-text">{addon.line}</span>}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
