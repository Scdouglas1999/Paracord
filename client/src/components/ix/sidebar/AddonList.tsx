import { useRef, useState, type MouseEvent, type RefObject } from 'react';

import { CopyAddressButton } from '../../gameServers/GameServerParts';
import { connectUrl, summaryLine } from '../../gameServers/gameServerModel';
import { Popover } from '../../ui/Popover';
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
 * two-line rows like channels, with a live line under the name. They open their
 * pages in main; Game servers have no page yet and open a small list of their
 * servers (name, status, Connect, copy the address) from the row.
 */
export function AddonList({ addons, focusOf, onOpen }: AddonListProps) {
  if (addons.length === 0) return null;
  return (
    <section aria-labelledby="ix-sb-addons">
      <SidebarLabel id="ix-sb-addons">Add-ons</SidebarLabel>
      <ul className="ix-sb__list">
        {addons.map((addon) =>
          addon.href ? (
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
          ) : (
            <GameServersRow key={addon.id} addon={addon} focus={focusOf(addon.id)} />
          ),
        )}
      </ul>
    </section>
  );
}

/** A row that opens a popover (no page to go to): a button with the same look as a link row. */
function GameServersRow({ addon, focus }: { addon: AddonModel; focus: RowFocus }) {
  const [open, setOpen] = useState(false);
  // A stable ref: the popover measures its anchor in a layout effect of the same commit that opens it.
  const anchor = useRef<HTMLLIElement | null>(null);
  const servers = addon.servers ?? [];
  return (
    <li ref={anchor}>
      <button
        type="button"
        className="ix-ch"
        data-testid="ix-addon-row"
        data-addon={addon.kind}
        data-place-row=""
        data-row-id={addon.id}
        {...{ [FLIP_ATTRIBUTE]: '' }}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...focus}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="ix-ch__name">
          <span className="ix-ch__name-text">{addon.name}</span>
        </span>
        <span className="ix-ch__line">{addon.line && <span className="ix-ch__line-text">{addon.line}</span>}</span>
      </button>
      <Popover
        anchor={anchor as RefObject<HTMLElement | null>}
        open={open}
        onClose={() => setOpen(false)}
        role="dialog"
        label="Game servers"
        side="right"
        align="start"
        className="ix-sb__pop"
      >
        <h2 className="ix-sb__pop-title">Game servers</h2>
        <ul className="ix-sb__pop-list">
          {servers.map((server) => {
            const connect = connectUrl(server);
            return (
              <li key={server.id} className="ix-sb__pop-item">
                <span className="ix-sb__pop-text">
                  <span className="ix-sb__pop-name">{server.name}</span>
                  <span className="ix-sb__pop-line">{summaryLine(server.status)}</span>
                </span>
                {connect && (
                  <a href={connect} className="ix-sb__retry">
                    Connect
                  </a>
                )}
                <CopyAddressButton address={server.address} name={server.name} />
              </li>
            );
          })}
        </ul>
      </Popover>
    </li>
  );
}
