/**
 * The pixels of an icon, read the way a browser reads them: decode the picture,
 * draw it small on a canvas, take the bytes. Kept apart from the color math
 * (`serverColor.ts`) so the math runs, and is tested, without a canvas.
 */

/** Pixels sampled per side; the color of a logo survives being this small. */
export const ICON_SAMPLE = 32;

/**
 * The pixels of an icon at 32x32, or null when the browser cannot read them (a
 * canvas tainted by a cross-origin image, or a picture that does not decode).
 * Stored icons are data URLs, which are same-origin to the canvas.
 */
export function readIconPixels(src: string): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ICON_SAMPLE;
      canvas.height = ICON_SAMPLE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0, ICON_SAMPLE, ICON_SAMPLE);
      try {
        resolve(context.getImageData(0, 0, ICON_SAMPLE, ICON_SAMPLE).data);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

