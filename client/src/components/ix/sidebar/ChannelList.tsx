import type { MouseEvent } from 'react';

import type { SidebarGroup } from '../../glass/places/rows';
import { IxGlyph } from '../glyphs';
import { ChannelRow } from './ChannelRow';
import { SidebarLabel } from './SidebarLabel';
import type { RowFocus } from './useRovingList';

export interface ChannelListProps {
  groups: readonly SidebarGroup[];
  /** The ids of the groups that are closed. */
  collapsed: ReadonlySet<string>;
  /** `/app/guilds/<g>/channels/<c>`. */
  hrefOf: (channelId: string) => string;
  focusOf: (id: string) => RowFocus;
  leaving: boolean;
  /** The person may create channels: the label shows its "+". */
  canCreate: boolean;
  onToggle: (groupId: string) => void;
  /** The category's id, or null for the uncategorized group. */
  onCreate: (categoryId: string | null) => void;
  onOpen: (channelId: string) => void;
  onMenu: (event: MouseEvent<HTMLElement>, channelId: string) => void;
}

/** What a closed group still shows: whatever needs you, and the channel you are in. */
export const keepsVisible = (row: { unread: boolean; mentions: number; selected: boolean }) =>
  row.unread || row.mentions > 0 || row.selected;

/**
 * The channels, by category (docs/index-spec.md §4.5): the uncategorized ones
 * under "Channels", then each category under its own sentence-case label. A
 * category label is a button: it closes the group (the chevron shows on hover or
 * focus), and a closed group still shows its unread rows and the open one. "+" at
 * a label's right (Manage Channels) opens Create channel with that category chosen.
 *
 * Only the first group is the "Channels" label of the prototype: with no
 * categories at all it is the only one, and it does not collapse.
 */
export function ChannelList({
  groups,
  collapsed,
  hrefOf,
  focusOf,
  leaving,
  canCreate,
  onToggle,
  onCreate,
  onOpen,
  onMenu,
}: ChannelListProps) {
  return (
    <>
      {groups.map((group) => {
        const foldable = group.categoryId !== null;
        const closed = foldable && collapsed.has(group.id);
        const rows = closed ? group.channels.filter(keepsVisible) : group.channels;
        const headingId = `ix-sb-${group.id}`;
        return (
          <section key={group.id} aria-labelledby={headingId}>
            <SidebarLabel
              id={headingId}
              action={
                canCreate ? (
                  <button type="button" className="ix-sb__add" aria-label={`Create a channel in ${group.label}`} onClick={() => onCreate(group.categoryId)}>
                    <IxGlyph name="plus" size={14} />
                  </button>
                ) : null
              }
            >
              {foldable ? (
                <button
                  type="button"
                  className="ix-sb__fold"
                  data-place-row=""
                  data-row-id={group.id}
                  aria-expanded={!closed}
                  {...focusOf(group.id)}
                  onClick={() => onToggle(group.id)}
                  onKeyDown={(event) => {
                    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                    if (event.key === 'ArrowLeft' && !closed) {
                      event.preventDefault();
                      onToggle(group.id);
                    } else if (event.key === 'ArrowRight' && closed) {
                      event.preventDefault();
                      onToggle(group.id);
                    }
                  }}
                >
                  {group.label}
                  <IxGlyph name="chevron" size={12} className="ix-sb__chev" />
                </button>
              ) : (
                group.label
              )}
            </SidebarLabel>
            <ul className="ix-sb__list">
              {rows.map((row) => (
                <ChannelRow
                  key={row.id}
                  row={row}
                  href={hrefOf(row.channelId)}
                  group={group.id}
                  keep={keepsVisible(row)}
                  leaving={leaving}
                  onOpen={() => onOpen(row.channelId)}
                  onContextMenu={(event) => onMenu(event, row.channelId)}
                  {...focusOf(row.id)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
