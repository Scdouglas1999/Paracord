import { useMemo } from 'react';

import { ResourceImage } from '../../ui/ResourceImage';
import { coverRecipe, coverStyle } from './serverCoverModel';
import { useIconTone } from './useIconTone';

export interface ServerCoverProps {
  guildId: string;
  /** The uploaded banner, already resolved for `<img>`; null when there is none. */
  bannerUrl: string | null;
  /** The server icon (a data URL or a server path); its color seeds the made cover. */
  iconSrc: string | null;
}

/**
 * The top of a server's Overview: the server's banner, or — for a server without
 * one — a cover made from its icon's color and its id (`serverCoverModel.ts`).
 * Either way it fades into the pane at the bottom (a mask, so the pane shows
 * through and nothing is painted over it), and the head sits over the fade. The
 * banner is also what lights the room when nothing is live (docs/glass-spec.md §4),
 * so the header and the room around it are the same color.
 */
export function ServerCover({ guildId, bannerUrl, iconSrc }: ServerCoverProps) {
  const tone = useIconTone(guildId, bannerUrl ? null : iconSrc);
  const style = useMemo(() => (tone ? coverStyle(coverRecipe(guildId, tone)) : null), [guildId, tone]);

  return (
    <div aria-hidden data-cover={bannerUrl ? 'banner' : 'made'} className="glass-ov__cover">
      {bannerUrl ? (
        <ResourceImage src={bannerUrl} alt="" draggable={false} />
      ) : (
        style && <div className="glass-ov__cover-made" style={style} />
      )}
    </div>
  );
}
