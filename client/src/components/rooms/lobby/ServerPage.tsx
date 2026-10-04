import type { CSSProperties } from 'react';

import { LargeTitlePage, type LargeTitlePageProps } from '../../ix/page';
import { serverPlace, usePlaceHue } from '../../ix/shell';
import { cn } from '../../../lib/utils';

export interface ServerPageProps extends LargeTitlePageProps {
  /** The server the page belongs to: its hue tints the page's own accents (§2.2). */
  guildId: string;
}

/**
 * A page in main that belongs to a server (docs/index-spec.md §6.1): the Overview,
 * Events, Sports, Daily word, Game servers. It is `LargeTitlePage` (the large title,
 * the toolbar's folded title, the column) with the server's hue in scope.
 *
 * The window's tint is two layers behind the page (`TintLayers`); a number does not
 * reach down to the page's own accents (an event's weekday, a glyph tile) from
 * there, so the page sets `--ix-hue` itself. `display: contents` keeps the wrapper
 * out of the layout: the scroller is still main's one flex child.
 */
export function ServerPage({ guildId, className, children, ...page }: ServerPageProps) {
  const hue = usePlaceHue(serverPlace(guildId));
  return (
    <div className="ix-hued" style={{ '--ix-hue': hue } as CSSProperties}>
      <LargeTitlePage className={cn('ix-sp', className)} {...page}>
        {children}
      </LargeTitlePage>
    </div>
  );
}
