import { create } from 'zustand';

/**
 * Where the banner strips go while the Index frame is up (docs/index-spec.md
 * §6.8: "a 36px strip across the top of main above the toolbar").
 *
 * The banners are mounted by the app's providers (`BannerStack`), above any
 * page, because they also speak on the pages that have no frame (sign-in,
 * setup). The frame registers a host over main's top; while one is registered
 * `BannerStack` draws its column there and publishes its height as
 * `--ix-banner-inset`, which moves main (and the call surface over it) down,
 * and only main: the sidebar stays where it is. With no host (no frame, or a
 * phone, where main and the sidebar are whole screens) the stack keeps its
 * window-wide place and the shell's `--pc-banner-inset`.
 */

export const IX_BANNER_INSET_PROPERTY = '--ix-banner-inset';

interface BannerHostState {
  host: HTMLElement | null;
  setHost: (host: HTMLElement | null) => void;
}

export const useBannerHostStore = create<BannerHostState>((set) => ({
  host: null,
  setHost: (host) => set({ host }),
}));

/** The frame's banner host right now, or null. */
export function useBannerHost(): HTMLElement | null {
  return useBannerHostStore((state) => state.host);
}
