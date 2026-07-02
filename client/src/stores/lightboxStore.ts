import { create } from 'zustand';

export interface LightboxImage {
  src: string;
  alt: string;
  filename: string;
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
