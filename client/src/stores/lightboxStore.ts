import { create } from 'zustand';
import { safeClientResourceUrl } from '../lib/security';
import { registerSessionReset } from './sessionReset';

// Only images constructed from the authenticated attachment resolver may use
// object URLs. A blob: string in untrusted message metadata grants no access.
const resolvedObjectImages = new WeakMap<LightboxImage, string>();

export function createResolvedLightboxImage(
  src: string,
  filename: string,
  kind: 'image' | 'video' = 'image',
): LightboxImage {
  const image = Object.freeze({ src, alt: filename, filename, kind });
  if (src.startsWith('blob:')) resolvedObjectImages.set(image, src);
  return image;
}

/**
 * An entry whose bytes are fetched only when the viewer reaches it. The gallery
 * steps through far more files than one message holds; fetching them all on
 * the first click would download every video in the set.
 */
export function createDeferredLightboxImage(
  load: () => Promise<string>,
  filename: string,
  kind: 'image' | 'video' = 'image',
): LightboxImage {
  return Object.freeze({ src: '', alt: filename, filename, kind, load });
}

export function lightboxImageSource(image: LightboxImage): string | null {
  return resolvedObjectImages.get(image) === image.src ? image.src : safeClientResourceUrl(image.src);
}

export interface LightboxImage {
  src: string;
  alt: string;
  filename: string;
  kind?: 'image' | 'video';
  /** Present on deferred entries: resolves the source (a blob: or ticketed URL) on demand. */
  load?: () => Promise<string>;
}

interface LightboxState {
  isOpen: boolean;
  currentIndex: number;
  images: LightboxImage[];
  open: (images: LightboxImage[], index: number) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
}

export const useLightboxStore = create<LightboxState>()((set, get) => ({
  isOpen: false,
  currentIndex: 0,
  images: [],

  open: (images, index) => set({ isOpen: true, images, currentIndex: index }),
  close: () => set({ isOpen: false, images: [], currentIndex: 0 }),
  next: () => {
    const { currentIndex, images } = get();
    if (currentIndex < images.length - 1) {
      set({ currentIndex: currentIndex + 1 });
    }
  },
  prev: () => {
    const { currentIndex } = get();
    if (currentIndex > 0) {
      set({ currentIndex: currentIndex - 1 });
    }
  },
  goTo: (index) => set({ currentIndex: index }),
}));

registerSessionReset('image-lightbox', () => useLightboxStore.getState().close());
