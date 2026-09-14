import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The custom property the app shell reserves the banners' height with.
 * Exported so the shell names the same thing this sets.
 */
export const BANNER_INSET_PROPERTY = '--pc-banner-inset';

/**
 * Where the app's banners live, and the room they take.
 *
 * Each banner used to position itself: `fixed; inset-x-0; top-0`, full width,
 * with nothing pushed down for it. Two of them at once landed on top of each
 * other, and any one of them landed on top of the app's own top row — the
 * command-palette search field, the sidebar's collapse button, and the whole
 * conversation header with its call, search and pin buttons. A ringing DM call
 * therefore blinded the header it appeared over for as long as it rang.
 *
 * So the banners stack here instead, in one fixed column in source order, and
 * this measures the column and publishes its height as
 * [`BANNER_INSET_PROPERTY`]. The shell reserves exactly that much at its top,
 * so a banner arriving moves the app down rather than covering it, and the app
 * comes back up when the banner leaves.
 */
export function BannerStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const root = document.documentElement;

    const apply = () => {
      const height = Math.round(node.getBoundingClientRect().height);
      root.style.setProperty(BANNER_INSET_PROPERTY, `${height}px`);
    };
    apply();

    // A banner arrives, leaves, or wraps to two lines on a phone; the reserved
    // height follows it. jsdom has no ResizeObserver, and a test that renders
    // the stack does not need one.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(BANNER_INSET_PROPERTY);
    };
  }, []);

  return (
    <div
      ref={ref}
      data-banner-stack=""
      className="fixed inset-x-0 top-0 z-[9999] flex flex-col"
    >
      {children}
    </div>
  );
}
