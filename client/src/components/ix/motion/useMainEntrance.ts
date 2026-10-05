import { useLayoutEffect, useRef, type RefObject } from 'react';

import { commit } from './onSettle';
import { entranceParts, playEntrance, rowDirection, type EntranceDirection } from './mainEntrance';

/** How long after a switch a part that arrives late (history loading in) still enters. */
const LATE_PART_MS = 600;

export interface MainEntranceInput {
  /** The routed page's host (`.ix-main__content`). */
  content: RefObject<HTMLElement | null>;
  /** The sidebar (`nav.ix-side`): where the rows that give the direction are. */
  sidebar: RefObject<HTMLElement | null>;
  pathname: string;
  /** The place's key (`people` or a server id): a change is a place switch. */
  placeKey: string;
  /** No entrance on a phone: the pushed screen is the move there (§9). */
  enabled: boolean;
}

/**
 * Main's entrance on a channel or place switch (docs/index-spec.md §5.1, §5.2):
 * the title and the feed of the page the route now shows come in from the
 * direction the selection moved (`mainEntrance.ts`). The first page of a
 * session does not play. A newer switch commits a running entrance (no
 * queueing). A part the page mounts a moment later (the timeline replacing its
 * loading skeleton, a lazy page) still enters, for {@link LATE_PART_MS}.
 */
export function useMainEntrance({ content, sidebar, pathname, placeKey, enabled }: MainEntranceInput): void {
  const last = useRef<{ pathname: string; placeKey: string } | null>(null);
  const running = useRef<Animation[]>([]);
  const stopWatching = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const before = last.current;
    last.current = { pathname, placeKey };
    if (!before || before.pathname === pathname || !enabled) return;
    const host = content.current;
    if (!host) return;

    commit(running.current);
    running.current = [];
    stopWatching.current();

    const dir: EntranceDirection = before.placeKey !== placeKey ? 0 : rowDirection(sidebar.current, before.pathname, pathname);
    const played = new WeakSet<Element>();
    const play = () => {
      for (const { element, part } of entranceParts(host)) {
        if (played.has(element)) continue;
        played.add(element);
        const animation = playEntrance(element, part, dir);
        if (animation) running.current.push(animation);
      }
    };
    play();

    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(play);
    observer.observe(host, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), LATE_PART_MS);
    stopWatching.current = () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [content, sidebar, pathname, placeKey, enabled]);

  useLayoutEffect(
    () => () => {
      stopWatching.current();
    },
    [],
  );
}
