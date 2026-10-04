import { useLayoutEffect, useRef, useState } from 'react';

import { SidebarSlot } from '../sidebar';
import { onSettle, slidePanes } from '../motion';
import { placeDirection, placeKey, type Place } from './place';

/**
 * The sidebar's panes (docs/index-spec.md §3.1 "Sidebar pane", §5.1).
 *
 * One pane per place, each a `SidebarSlot` in its own scroller. Switching place
 * mounts the new pane beside the old one and slides them (the old one out to
 * `-dir`, the new one in from `dir`, `dir` = the sign of the dock index change);
 * when the slide settles the old pane is removed. Both are mounted for that
 * moment only. A newer switch mid-slide commits the running one first (the
 * leaving pane goes at once) and slides from where the current pane is.
 *
 * The leaving pane is `inert` and hidden from assistive tech, and gets
 * `leaving` so it can skip side effects. The new pane starts at the top.
 */

interface Pane {
  key: string;
  place: Place;
  leaving: boolean;
  /** Direction of the slide that brought this pane in (0 for the first pane). */
  dir: -1 | 0 | 1;
}

export interface SidebarPanesProps {
  place: Place;
  /** The dock order (`usePlaceOrder()`): the slide direction comes from it. */
  order: readonly string[];
}

export function SidebarPanes({ place, order }: SidebarPanesProps) {
  const key = placeKey(place);
  const [panes, setPanes] = useState<Pane[]>(() => [{ key, place, leaving: false, dir: 0 }]);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const running = useRef<Animation[]>([]);
  const dispose = useRef<() => void>(() => {});

  // A new place: the current pane starts leaving and the new one comes in (render),
  // then the slide (layout effect). Any pane still leaving from before is dropped.
  const current = panes.find((pane) => !pane.leaving) ?? panes[panes.length - 1];
  if (current.key !== key) {
    const dir = placeDirection(order, current.place, place);
    setPanes([{ ...current, leaving: true }, { key, place, leaving: false, dir }]);
  } else if (current.place !== place) {
    // Same place, a new object (the route re-derived it): keep the pane, refresh its prop.
    setPanes((all) => all.map((pane) => (pane.key === key && !pane.leaving ? { ...pane, place } : pane)));
  }

  const entering = panes.find((pane) => !pane.leaving) ?? null;
  const leaving = panes.find((pane) => pane.leaving) ?? null;
  const enteringKey = entering?.key ?? null;
  useLayoutEffect(() => {
    if (!entering || !leaving) return;
    // Cut short a slide still running: its leaving pane is already gone from state,
    // and canceling puts the pane that was coming in at rest (canceling, not
    // finishing: the outgoing animation fills forwards, and the pane it ran on
    // may be the one coming back).
    dispose.current();
    for (const animation of running.current) animation.cancel();
    const incoming = elements.current.get(entering.key) ?? null;
    const outgoing = elements.current.get(leaving.key) ?? null;
    if (incoming) incoming.scrollTop = 0;
    const { outgoing: out, incoming: into } = slidePanes(outgoing, incoming, entering.dir);
    running.current = [out, into].filter((animation): animation is Animation => animation !== null);
    const leavingKey = leaving.key;
    dispose.current = onSettle(running.current, () => {
      running.current = [];
      out?.cancel();
      setPanes((all) => all.filter((pane) => pane.key !== leavingKey));
    });
    // A new entering pane is what starts a slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enteringKey]);

  useLayoutEffect(
    () => () => {
      dispose.current();
      for (const animation of running.current) animation.cancel();
    },
    [],
  );

  return (
    <div className="ix-panes">
      {panes.map((pane) => (
        <div
          key={pane.key}
          ref={(element) => {
            if (element) elements.current.set(pane.key, element);
            else elements.current.delete(pane.key);
          }}
          className="ix-pane"
          data-place={pane.key}
          data-leaving={pane.leaving ? 'true' : undefined}
          aria-hidden={pane.leaving ? true : undefined}
          inert={pane.leaving}
        >
          <SidebarSlot place={pane.place} leaving={pane.leaving} />
        </div>
      ))}
    </div>
  );
}
