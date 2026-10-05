import { IX_REDUCED_MS, IX_SPRING, canAnimate, ixReduced } from './curves';

/**
 * What main shows changes (docs/index-spec.md §5.1 "Main", §5.2): the new
 * title and the new feed come in, each on its own beat, from the direction the
 * selection moved in the sidebar.
 *
 *   title   from translateY(dir × 14 + 4px), opacity 0, 125ms spring
 *   feed    from translateY(dir × 22px),     opacity 0, 145ms spring
 *
 * `dir` is the sign of the row index change in the sidebar (+1: the new row is
 * below the old one, so the new content comes up from below). A jump from
 * elsewhere (the switcher, a link, another place) is 0: the title rises 4px and
 * the feed only fades, which is how the prototype plays a server switch (its
 * `drawMain(true)` passes no direction while the sidebar slides across).
 *
 * Reduced motion: both fade in place, 65ms.
 *
 * Nothing fills forwards: each element rests at its own CSS state the moment
 * its animation ends, so `document.getAnimations()` is empty at rest.
 */

export const MAIN_TITLE_IN_MS = 125;
export const MAIN_FEED_IN_MS = 145;
export const MAIN_TITLE_SHIFT = 14;
export const MAIN_TITLE_LIFT = 4;
export const MAIN_FEED_SHIFT = 22;

export type EntranceDirection = -1 | 0 | 1;
export type EntrancePart = 'title' | 'feed';

export function entranceKeyframes(part: EntrancePart, dir: EntranceDirection, reduced = false): Keyframe[] {
  if (reduced) return [{ opacity: 0 }, { opacity: 1 }];
  const from = part === 'title' ? dir * MAIN_TITLE_SHIFT + MAIN_TITLE_LIFT : dir * MAIN_FEED_SHIFT;
  return [
    { transform: `translateY(${from}px)`, opacity: 0 },
    { transform: 'none', opacity: 1 },
  ];
}

/** Play one part's entrance on one element. Null when nothing can play. */
export function playEntrance(
  element: Element | null | undefined,
  part: EntrancePart,
  dir: EntranceDirection,
  { reduced = ixReduced() }: { reduced?: boolean } = {},
): Animation | null {
  if (!canAnimate(element)) return null;
  const animation = element.animate(entranceKeyframes(part, dir, reduced), {
    duration: reduced ? IX_REDUCED_MS : part === 'title' ? MAIN_TITLE_IN_MS : MAIN_FEED_IN_MS,
    easing: reduced ? 'ease-out' : IX_SPRING,
    fill: 'backwards',
  });
  animation.id = `ix-main:${part}`;
  return animation;
}

/**
 * The parts of a page in main, by the Index page contract:
 *
 *   title  the large title block (`LargeTitle`'s `.ix-large-title`), in a
 *          conversation's timeline header or a `LargeTitlePage`'s column
 *   feed   a conversation's timeline content (or its welcome, its loading
 *          skeleton, its error) and a page's body
 */
export const MAIN_TITLE_SELECTOR = '.ix-large-title';
export const MAIN_FEED_SELECTOR = '.ix-timeline__scroller > :not(.ix-timeline__header), .ix-page__body';

export function entranceParts(root: ParentNode): Array<{ element: HTMLElement; part: EntrancePart }> {
  const parts: Array<{ element: HTMLElement; part: EntrancePart }> = [];
  const title = root.querySelector<HTMLElement>(MAIN_TITLE_SELECTOR);
  if (title) parts.push({ element: title, part: 'title' });
  for (const element of root.querySelectorAll<HTMLElement>(MAIN_FEED_SELECTOR)) parts.push({ element, part: 'feed' });
  return parts;
}

/**
 * The direction the selection moved: the sign of the change in index of the
 * two routes among the sidebar's rows (`[data-place-row]` links in the pane that
 * is not leaving). 0 when either route has no row (a page, the switcher's jump
 * to a row's sub-page, People's index).
 */
export function rowDirection(sidebar: ParentNode | null | undefined, fromPath: string, toPath: string): EntranceDirection {
  if (!sidebar) return 0;
  const pane = sidebar.querySelector('.ix-pane:not([data-leaving])') ?? sidebar;
  const paths = [...pane.querySelectorAll<HTMLElement>('[data-place-row][href]')].map((row) => pathOf(row.getAttribute('href')));
  const from = paths.indexOf(fromPath);
  const to = paths.indexOf(toPath);
  if (from < 0 || to < 0 || from === to) return 0;
  return to > from ? 1 : -1;
}

function pathOf(href: string | null): string {
  if (!href) return '';
  try {
    return new URL(href, 'http://x').pathname;
  } catch {
    return href;
  }
}
