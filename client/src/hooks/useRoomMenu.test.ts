import { describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';

import { menuEventAt } from './useRoomMenu';

function event(clientX: number, clientY: number, box?: DOMRect) {
  return {
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: { getBoundingClientRect: () => box ?? ({ left: 0, bottom: 0 } as DOMRect) },
  } as unknown as MouseEvent<HTMLElement>;
}

describe('where the room menu opens', () => {
  it('uses the pointer for a right-click or a long press', () => {
    const source = event(412, 208);
    expect(menuEventAt(source)).toBe(source);
  });

  it('anchors under the control when the keyboard opened it', () => {
    // Enter and Space on a button report (0, 0), which would drop the menu in
    // the top-left corner of the window instead of beside the room it is about.
    const box = { left: 318, bottom: 264 } as DOMRect;
    const anchored = menuEventAt(event(0, 0, box));
    expect({ x: anchored.clientX, y: anchored.clientY }).toEqual({ x: 318, y: 264 });
  });
});
