import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The title fold (docs/index-spec.md §5.14): scroll-linked, no timer.
 *
 *   t = min(1, scrollTop / 60)
 *   large title  scale(1 − .1t), opacity 1 − .9t, transform-origin 0 50% (CSS)
 *   folded       scrollTop > 40: the toolbar's folded title and fill appear
 *
 * The title's transform and opacity are written straight to its style on
 * `scroll`, at most once per animation frame; React re-renders only when
 * `folded` flips. Reduced motion keeps it: it is the person's own scroll, not an
 * animation.
 *
 * The scroller can be anyone's: a `LargeTitlePage`'s own, or the message list's
 * (IX-15 puts the large title in `MessageList`'s `header`, the first item of the
 * scroller, which only exists once the start of the channel is loaded). The
 * title is assumed to sit at the top of the scroller's content; while it is not
 * mounted (history above it not loaded yet, or virtualized away) the title
 * counts as folded.
 *
 *   const [scroller, setScroller] = useState<HTMLElement | null>(null);
 *   const { folded, titleRef } = useTitleFold(scroller);
 *   <div ref={setScroller}> <header ref={titleRef}>…</header> … </div>
 *   useToolbar({ title, folded, … });
 */

/** Scroll distance over which the title shrinks and fades (§5.14). */
export const FOLD_RANGE = 60;
/** Past this scroll distance the toolbar shows the folded title and its fill (§4.9). */
export const FOLD_AT = 40;

export function foldProgress(scrollTop: number): number {
  return Math.max(0, Math.min(1, scrollTop / FOLD_RANGE));
}

function applyFold(title: HTMLElement, scrollTop: number): void {
  const t = foldProgress(scrollTop);
  title.style.transform = t === 0 ? '' : `scale(${(1 - 0.1 * t).toFixed(4)})`;
  title.style.opacity = t === 0 ? '' : (1 - 0.9 * t).toFixed(4);
}

export interface TitleFold {
  /** True once the title has scrolled more than 40px away (or is not mounted). */
  folded: boolean;
  /** Put on the element that folds (the large title block). A callback ref: it may remount. */
  titleRef: (element: HTMLElement | null) => void;
}

export function useTitleFold(scroller: HTMLElement | null): TitleFold {
  const [folded, setFolded] = useState(false);
  const title = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    scrollerRef.current = scroller;
  }, [scroller]);

  const update = useCallback(() => {
    const element = scrollerRef.current;
    const scrollTop = element ? element.scrollTop : 0;
    const node = title.current;
    if (node && node.isConnected) applyFold(node, scrollTop);
    setFolded(node && node.isConnected ? scrollTop > FOLD_AT : Boolean(element));
  }, []);

  const titleRef = useCallback(
    (element: HTMLElement | null) => {
      title.current = element;
      // A (re)mounted title takes the current fold at once, not on the next scroll.
      if (element) applyFold(element, scrollerRef.current?.scrollTop ?? 0);
      update();
    },
    [update],
  );

  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, update]);

  return { folded, titleRef };
}
