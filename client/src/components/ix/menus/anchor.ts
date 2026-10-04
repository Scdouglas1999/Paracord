/**
 * Where a menu or card opens (docs/index-spec.md §6.2-6.5, §6.9).
 *
 * - `element`: under the element that opened it (the "..." button, the toolbar
 *   avatar, the large title), `align` picking which edge lines up: `end` hangs
 *   the menu from the element's right edge (a button at a column's right side),
 *   `start` from its left. Re-measured when the window resizes or scrolls.
 * - `point`: at the pointer (a right click, a long press), clamped to the window.
 */
export type MenuAnchor =
  | { element: HTMLElement; align?: 'start' | 'end'; gap?: number }
  | { x: number; y: number };

export function isElementAnchor(anchor: MenuAnchor): anchor is { element: HTMLElement; align?: 'start' | 'end'; gap?: number } {
  return 'element' in anchor;
}

/** An anchor at a mouse event's point. A keyboard activation reports (0, 0): anchor under the element instead. */
export function anchorFromEvent(event: {
  clientX: number;
  clientY: number;
  currentTarget: EventTarget | null;
}, align: 'start' | 'end' = 'start'): MenuAnchor {
  const target = event.currentTarget;
  if (event.clientX === 0 && event.clientY === 0 && target instanceof HTMLElement) {
    return { element: target, align };
  }
  return { x: event.clientX, y: event.clientY };
}
