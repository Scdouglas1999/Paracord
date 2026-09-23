import { cn } from '../../lib/utils';

/**
 * Paracord's mark: a hurricane lantern carried on a braided paracord handle.
 * The drawing lives in `client/brand/mark.html`; the files here are rendered
 * from it by `client/brand/render.mjs`. Inside the app it is the bare drawing,
 * trimmed to the lantern and cord: the Slate tile is the OS icon's ground, and
 * on the app's own surfaces it only made the lantern smaller.
 *
 * `size` is its height; the lantern is about half as wide as it is tall. Two
 * drawings, picked by size: at 32 px and below the simplified one (the same
 * silhouette with a bolder cord and no engraving or rivets), which stays
 * legible where the detailed one turns to texture. Both are rendered at twice
 * the largest size they serve.
 */
export const APP_MARK_MAX_SIZE = 64;
/** Width over height of the drawing (the files are 63x128 and 32x64). */
const APP_MARK_ASPECT = 0.5;

export function appMarkSrc(size: number): string {
  if (size > APP_MARK_MAX_SIZE) {
    throw new Error(`AppMark is rendered up to ${APP_MARK_MAX_SIZE} px; ${size} px needs a larger asset from client/brand/render.mjs`);
  }
  return size <= 32 ? '/brand/mark-small-32.webp' : '/brand/mark-64.webp';
}

export function AppMark({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <img
      src={appMarkSrc(size)}
      width={Math.round(size * APP_MARK_ASPECT)}
      height={size}
      alt="Paracord"
      draggable={false}
      className={cn('shrink-0 select-none object-contain', className)}
    />
  );
}
