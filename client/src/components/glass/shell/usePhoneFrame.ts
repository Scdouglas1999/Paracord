import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router';

import { usePresence } from '../../../lib/motion';
import { useVoiceStore } from '../../../stores/voiceStore';
import { playPhoneScreens } from './phoneMotion';
import { isConversationRoute, takeSettledScreen, usePhoneNavStore, type PhoneScreen } from './phoneNav';

/** Whether this client holds a call (joining, listening or joined): the pill's own test. */
function useHoldsCall(): boolean {
  const callId = useVoiceStore((state) => state.callId);
  const callPhase = useVoiceStore((state) => state.callPhase);
  const channelId = useVoiceStore((state) => state.channelId);
  if (!callId || !channelId) return false;
  return callPhase !== 'closed' && callPhase !== 'closing' && callPhase !== 'idle' && callPhase !== 'failed';
}

export interface PhoneFrameState {
  /** The screen in front: places or the conversation (a phone shows its conversation until it has chosen). */
  screen: PhoneScreen;
  /** The places screen's element, for the slide and for where focus goes. */
  placesRef: RefObject<HTMLDivElement | null>;
  /** The conversation screen's element, for the slide. */
  conversationRef: RefObject<HTMLDivElement | null>;
  /** The conversation pane (`main`), which takes focus when it comes in. */
  mainRef: RefObject<HTMLElement | null>;
  /**
   * Glass only (GlassFrame, retired by IX-19; Index has no pill).
   * The call pill on places: only drawn while places is in front (and for the
   * length of its leave, so it does not vanish mid-slide). The conversation has
   * its own, and two of them on the page would be two of everything.
   */
  callOnPlaces: boolean;
  /**
   * Glass only (see above).
   * A page that draws its own pill (a channel or a message) shows the call
   * there; any other page (Home, Friends, a server's overview) shows it in a bar
   * under the back button, so the call never goes out of reach.
   */
  callBar: boolean;
}

/**
 * The phone's navigation state, for the Index frame (`IxFrame`; docs/index-spec.md
 * §9, IX-16) and, until IX-19 deletes it, `GlassFrame` (docs/glass-spec.md §8; WP-G20):
 * which of the two screens is in front, the call's place on each, and the move
 * between them, with where focus goes after it.
 *
 * It is a hook of the one frame, not a frame of its own. The wide and the phone
 * frame used to be two components, so a window resized across the phone
 * breakpoint unmounted the conversation and rebuilt it, and everything it held in
 * local state went with it (an open dialog, a draft, a scroll position). The
 * frame is one tree for every layout now (`GlassFrame`); this runs in all of
 * them and acts only while `active` (the window is a phone).
 */
export function usePhoneFrame(active: boolean): PhoneFrameState {
  const { pathname } = useLocation();
  const chosen = usePhoneNavStore((state) => state.screen);
  const screen: PhoneScreen = chosen ?? 'conversation';
  const holdsCall = useHoldsCall();
  const callOnPlaces = usePresence(active && holdsCall && screen === 'places').mounted && active && holdsCall;
  const placesRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const callBar = active && holdsCall && !isConversationRoute(pathname);

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

  return { screen, placesRef, conversationRef, mainRef, callOnPlaces, callBar };
}
