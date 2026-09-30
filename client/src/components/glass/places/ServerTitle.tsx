import type { RefObject } from 'react';

import { PlaceGlyph } from './Lead';

/**
 * The title under the server row (docs/glass-spec.md §3.1): the server's name at
 * 28 / 600 in the narrow cut, a chevron, and one line under it ("8 online, 3 in
 * Lounge"). It opens the server menu. Home has a title too, with nothing to open.
 */
export interface ServerTitleProps {
  name: string;
  line: string;
  /** Omit for a title that opens nothing (Home). */
  onOpenMenu?: () => void;
  menuOpen?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

export function ServerTitle({ name, line, onOpenMenu, menuOpen = false, buttonRef }: ServerTitleProps) {
  const content = (
    <>
      <span className="glass-title-server glass-server-title__name">
        <span className="glass-server-title__text">{name}</span>
        {onOpenMenu && <PlaceGlyph name="chevron" size={16} strokeWidth={2.2} />}
      </span>
      <span className="glass-server-title__line">{line}</span>
    </>
  );
  if (!onOpenMenu) return <div className="glass-server-title glass-server-title--static">{content}</div>;
  return (
    <button
      ref={buttonRef}
      type="button"
      className="glass-server-title glass-focusable"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label={`${name} menu. ${line}`}
      onClick={onOpenMenu}
    >
      {content}
    </button>
  );
}
