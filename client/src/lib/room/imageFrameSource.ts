/**
 * A still as a frame source: a server's banner or icon (docs/glass-spec.md §4,
 * "with nothing live, sample the server's banner (or icon) instead").
 *
 * The image is loaded once, decoded to one `ImageBitmap`, and handed to each
 * subscriber once as its own copy: a still has nothing new to say, so it costs
 * no timer and no further work. `url` must already be loadable by an `<img>`
 * (a data URL, a blob URL from `useAuthenticatedImage`, or a same-origin path).
 */
import type { FrameSource } from './frameSource';

export interface ImageFrameSource extends FrameSource {
  readonly kind: 'image';
  readonly url: string;
  /** Why the still could not be used, once that is known. */
  readonly error: string | null;
  /** Release the decoded still. Subscriptions after this deliver nothing. */
  dispose(): void;
}

export type ImageDecoder = (url: string) => Promise<ImageBitmap>;

/** Load through an `<img>` (it follows the page's own rules for the URL) and decode it. */
export const decodeImageUrl: ImageDecoder = async (url) => {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  return createImageBitmap(image);
};

export function createImageFrameSource(url: string, decode: ImageDecoder = decodeImageUrl): ImageFrameSource {
  let bitmap: ImageBitmap | null = null;
  let error: string | null = null;
  let loading: Promise<ImageBitmap | null> | null = null;
  let disposed = false;

  const load = () => {
    if (!loading) {
      loading = decode(url).then(
        (decoded) => {
          if (disposed) {
            decoded.close();
            return null;
          }
          bitmap = decoded;
          return decoded;
        },
        (reason: unknown) => {
          error = reason instanceof Error ? reason.message : String(reason);
          console.error('[room] the still that lights this room could not be loaded', { url, error });
          return null;
        },
      );
    }
    return loading;
  };

  const copy = async (): Promise<ImageBitmap | null> => {
    const source = await load();
    if (!source || disposed) return null;
    // Disposed while copying: the copy of a closed bitmap is no copy at all.
    return createImageBitmap(source).catch(() => null);
  };

  return {
    kind: 'image',
    url,
    get width() {
      return bitmap?.width ?? 0;
    },
    get height() {
      return bitmap?.height ?? 0;
    },
    get error() {
      return error;
    },
    subscribe(onFrame) {
      let active = true;
      void copy().then((frame) => {
        if (!frame) return;
        if (active) onFrame(frame);
        else frame.close();
      });
      return () => {
        active = false;
      };
    },
    getLatestFrame: copy,
    dispose() {
      disposed = true;
      bitmap?.close();
      bitmap = null;
    },
  };
}
