import { useLayoutEffect, useRef, type RefObject } from 'react';

import { playPhoneScreens } from './phoneMotion';
import { takeSettledScreen, usePhoneNavStore, type PhoneScreen } from './phoneNav';

export interface PhoneFrameState {
  /** The screen in front: places or the conversation (a phone shows its conversation until it has chosen). */
  screen: PhoneScreen;
  /** The places screen's element, for the slide and for where focus goes. */
  placesRef: RefObject<HTMLDivElement | null>;
  /** The conversation screen's element, for the slide. */
  conversationRef: RefObject<HTMLDivElement | null>;
  /** The conversation pane (`main`), which takes focus when it comes in. */
  mainRef: RefObject<HTMLElement | null>;
}

/**
 * The phone's navigation state, for the Index frame (`IxFrame`; docs/index-spec.md
 * §9): which of the two screens is in front and the move between them, with
 * where focus goes after it.
 *
 * It is a hook of the one frame, not a frame of its own. The wide and the phone
 * frame used to be two components, so a window resized across the phone
 * breakpoint unmounted the conversation and rebuilt it, and everything it held in
 * local state went with it (an open dialog, a draft, a scroll position). The
 * frame is one tree for every layout (`IxFrame`); this runs in all of them and
 * acts only while `active` (the window is a phone).
 */
export function usePhoneFrame(active: boolean): PhoneFrameState {
  const chosen = usePhoneNavStore((state) => state.screen);
  const screen: PhoneScreen = chosen ?? 'conversation';
  const placesRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  // The move between the screens, and where focus goes after it. Nothing plays
  // until a first screen has been chosen (the frame's first paint) and none plays
  // for the window becoming a phone, and focus only moves for a change, never for
  // the first screen.
  const previous = useRef<PhoneScreen | null>(null);
  const running = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    if (!active || chosen === null) {
      previous.current = null;
      return;
    }
    const before = previous.current;
    previous.current = chosen;
    if (before === null || before === chosen) return;
    for (const animation of running.current) animation.cancel();
    // A swipe already drew this change; otherwise the push (or pop) plays.
    running.current = takeSettledScreen(chosen)
      ? []
      : playPhoneScreens(placesRef.current, conversationRef.current, chosen);
    if (chosen === 'conversation') {
      mainRef.current?.focus({ preventScroll: true });
    } else {
      const row =
        placesRef.current?.querySelector<HTMLElement>('[data-place-row][tabindex="0"]')
        ?? placesRef.current?.querySelector<HTMLElement>('[data-place-row]');
      row?.focus({ preventScroll: true });
    }
  }, [active, chosen]);

  return { screen, placesRef, conversationRef, mainRef };
}
