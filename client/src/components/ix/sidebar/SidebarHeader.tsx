import type { MouseEvent, RefObject } from 'react';

import { IxGlyph } from '../glyphs';
import { ServerMark } from '../identity';

export interface SidebarHeaderProps {
  guildId: string;
  name: string;
  /** The stored icon (`icon_hash ?? icon`); an uploaded picture wins over the monogram. */
  icon: string | null;
  /** The server's own hue (`guild.hue`), null for the id's. */
  hue: number | null;
  /** "2 members · 2 here now". */
  line: string;
  /** The route is this server's Overview page. */
  current: boolean;
  menuRef: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onOpenOverview: () => void;
  onOpenMenu: () => void;
  /** Right-click anywhere on the header opens the same menu. */
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

/**
 * The sidebar header (docs/index-spec.md §4.1): the server's mark, its name and a
 * line of who is here, and "…". The mark and name are one button that opens the
 * server's Overview in main; "…" (and a right-click anywhere on the header) opens
 * the server menu. No chevron.
 */
export function SidebarHeader({
  guildId,
  name,
  icon,
  hue,
  line,
  current,
  menuRef,
  menuOpen,
  onOpenOverview,
  onOpenMenu,
  onContextMenu,
}: SidebarHeaderProps) {
  return (
    <div className="ix-sh" data-testid="ix-sidebar-header" onContextMenu={onContextMenu}>
      <button
        type="button"
        className="ix-sh__main"
        aria-label={`${name} overview, ${line}`}
        aria-current={current ? 'page' : undefined}
        onClick={onOpenOverview}
      >
        <ServerMark guildId={guildId} name={name} icon={icon} hue={hue} size={40} />
        <span className="ix-sh__text">
          <span className="ix-sh__name">{name}</span>
          <span className="ix-sh__line">{line}</span>
        </span>
      </button>
      <button
        ref={menuRef}
        type="button"
        className="ix-sh__more"
        aria-label="Server options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onOpenMenu}
      >
        <IxGlyph name="dots" size={16} />
      </button>
    </div>
  );
}
