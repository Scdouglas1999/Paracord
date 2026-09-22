/** Cover-and-pan math for the banner crop. The frame and the saved image share a 3:1 frame. */

export interface CropView {
  /** Multiplier on the cover scale. 1 means the image just covers the frame. */
  zoom: number;
  /** Shift in frame pixels. Positive moves the image right or down. */
  panX: number;
  panY: number;
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export const MIN_BANNER_ZOOM = 1;
export const MAX_BANNER_ZOOM = 3;

export function coverScale(
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
): number {
  if (imageWidth <= 0 || imageHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) return 1;
  return Math.max(frameWidth / imageWidth, frameHeight / imageHeight);
}

export function clampPan(
  panX: number,
  panY: number,
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
  zoom: number,
): Pick<CropView, 'panX' | 'panY'> {
  const scale = coverScale(imageWidth, imageHeight, frameWidth, frameHeight) * zoom;
  const maxX = Math.max(0, (imageWidth * scale - frameWidth) / 2);
  const maxY = Math.max(0, (imageHeight * scale - frameHeight) / 2);
  return {
    panX: Math.min(maxX, Math.max(-maxX, panX)),
    panY: Math.min(maxY, Math.max(-maxY, panY)),
  };
}

/** The source rectangle, in image pixels, that fills the frame at this view. */
export function sourceRect(
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
  view: CropView,
): SourceRect {
  const scale = coverScale(imageWidth, imageHeight, frameWidth, frameHeight) * view.zoom;
  const sw = frameWidth / scale;
  const sh = frameHeight / scale;
  const cx = imageWidth / 2 - view.panX / scale;
  const cy = imageHeight / 2 - view.panY / scale;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

/** CSS `#rrggbb` for a stored `0xRRGGBB` accent, or null when it is not a colour. */
export function accentCssColor(color: number | null | undefined): string | null {
  if (color == null || !Number.isInteger(color) || color < 0 || color > 0xffffff) return null;
  return `#${color.toString(16).padStart(6, '0')}`;
}
