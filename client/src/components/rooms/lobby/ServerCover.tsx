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
  height: number;
}

/**
 * The top of the server home page: the server's banner, or — for a server
 * without one — a cover made from its icon's color and its id
 * (`serverCover.ts`). Either way it fades into the plate at the bottom, so the
 * head can overlap it.
 */
export function ServerCover({ guildId, bannerUrl, iconSrc, height }: ServerCoverProps) {
  const tone = useIconTone(guildId, bannerUrl ? null : iconSrc);
  const style = useMemo(() => (tone ? coverStyle(coverRecipe(guildId, tone)) : null), [guildId, tone]);

  return (
    <div
      aria-hidden
      data-cover={bannerUrl ? 'banner' : 'made'}
      className="pc-home-cover shrink-0"
      style={{ height }}
    >
      {bannerUrl ? (
        <ResourceImage src={bannerUrl} alt="" draggable={false} />
      ) : (
        style && <div className="pc-home-cover-made" style={style} />
      )}
    </div>
  );
}
