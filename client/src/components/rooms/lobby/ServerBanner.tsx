import { ResourceImage } from '../../ui/ResourceImage';

export interface ServerBannerProps {
  /** The uploaded banner, already resolved for `<img>`. */
  bannerUrl: string;
}

/**
 * A server's uploaded banner, across the top of its Overview (Server settings →
 * Overview → Server banner, a 1920 by 640 picture). It is the admin's own
 * picture, so it stays; a server without one has none (the window's hue is
 * the server's color now, §2.2, and no cover is made up for it).
 */
export function ServerBanner({ bannerUrl }: ServerBannerProps) {
  return (
    <div aria-hidden className="ix-banner" data-testid="ix-banner">
      <ResourceImage src={bannerUrl} alt="" draggable={false} />
    </div>
  );
}
