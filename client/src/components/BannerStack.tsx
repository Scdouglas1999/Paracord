import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { IX_BANNER_INSET_PROPERTY, useBannerHost } from './ix/shell/bannerHost';

/**
 * The custom property the app shell reserves the banners' height with.
 * Exported so the shell names the same thing this sets.
 */
export const BANNER_INSET_PROPERTY = '--pc-banner-inset';

/**
 * What takes the Glass incoming-call capsule (`.glass-callbanner`) out of the
 * column's flow, as {@link BannerStack} explains. The classes are spelled out
 * whole so Tailwind finds each one.
 */
const FLOATING_NOTICE = [
  '[&>.glass-callbanner]:absolute',
  '[&>.glass-callbanner]:inset-x-0',
  '[&>.glass-callbanner]:top-full',
  '[&>.glass-callbanner]:pointer-events-none',
  '[&>.glass-callbanner>*]:pointer-events-auto',
].join(' ');

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
 *
 * One kind of notice does not take part: the Glass incoming-call capsule
 * (`.glass-callbanner`, `IncomingCallBanner`). It is a floating object like the
 * call pill, a capsule with its own air over the panes, not a bar across the
 * top, so it is taken out of the column's flow. It is laid just under whatever
 * banners are in flow, over the app, and reserves nothing: the panes stay where
 * they are while a call rings instead of dropping 62px and coming back up. Only
 * the capsule takes the pointer; the strip around it reaches the app.
 */
export function BannerStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // The Index frame's host over main (index-spec §6.8): there, the column sits
  // over main alone and main is what moves down (`--ix-banner-inset`).
  const host = useBannerHost();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const root = document.documentElement;
    const property = host ? IX_BANNER_INSET_PROPERTY : BANNER_INSET_PROPERTY;

    const apply = () => {
      const height = Math.round(node.getBoundingClientRect().height);
      root.style.setProperty(property, `${height}px`);
    };
    apply();

    // A banner arrives, leaves, or wraps to two lines on a phone; the reserved
    // height follows it. jsdom has no ResizeObserver, and a test that renders
    // the stack does not need one.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(property);
    };
  }, [host]);

  if (host) {
    return createPortal(
      <div ref={ref} data-banner-stack="" data-host="main" className={`relative flex flex-col ${FLOATING_NOTICE}`}>
        {children}
      </div>,
      host,
    );
  }
  return (
    <div
      ref={ref}
      data-banner-stack=""
      className={`fixed inset-x-0 top-0 z-[9999] flex flex-col ${FLOATING_NOTICE}`}
    >
      {children}
    </div>
  );
}
