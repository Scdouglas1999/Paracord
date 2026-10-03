import { useEffect, useLayoutEffect } from 'react';
import { useLocation } from 'react-router';
import { create } from 'zustand';
import { registerSessionReset } from '../../../stores/sessionReset';
import { useUIStore } from '../../../stores/uiStore';

/**
 * Which screen a phone shows (docs/glass-spec.md §8: "the places panel is its
 * own screen"; WP-G20).
 *
 * A phone has no room for two panes, so places and the conversation are two
 * screens, one on top of the other:
 *
 *   places         the server row and this server's channels (or your messages)
 *   conversation   the routed page: a channel, a message, Home, Friends, ...
 *
 * Picking a channel slides the conversation in; the back button and the edge
 * swipe bring places back. Both screens stay mounted (a draft, a
 * scroll position and a stream that is playing survive a trip to the list), the
 * hidden one is `inert` and off to the side.
 *
 * `null` is "not decided yet": the frame has not chosen a first screen. It is
 * what the store holds on every window that is not a phone, so the choice is
 * made once, before the first paint of the phone frame, and nothing animates
 * into it.
 */
export type PhoneScreen = 'places' | 'conversation';

interface PhoneNavState {
  screen: PhoneScreen | null;
  setScreen: (screen: PhoneScreen | null) => void;
  showPlaces: () => void;
  showConversation: () => void;
}

export const usePhoneNavStore = create<PhoneNavState>()((set) => ({
  screen: null,
  setScreen: (screen) => set({ screen }),
  showPlaces: () => set({ screen: 'places' }),
  showConversation: () => set({ screen: 'conversation' }),
}));

registerSessionReset('glass-phone-nav', () => usePhoneNavStore.getState().setScreen(null));

/** The screen to draw: before a first choice is made a phone shows its conversation. */
export function usePhoneScreen(): PhoneScreen {
  return usePhoneNavStore((state) => state.screen) ?? 'conversation';
}

/* ---- Routes ------------------------------------------------------------------ */

/**
 * The messages index repeats the places list. Home has its own welcome and
 * server entries, so it opens on its routed page, including on a phone.
 */
export function isPlacesRoute(pathname: string): boolean {
  return /^\/app\/dms\/?$/.test(pathname);
}

/** A channel or a message: the page draws the conversation pane, with its own header and call pill. */
export function isConversationRoute(pathname: string): boolean {
  return /^\/app\/guilds\/[^/]+\/channels\/[^/]+\/?$/.test(pathname) || /^\/app\/dms\/[^/]+\/?$/.test(pathname);
}

/**
 * Drives the phone's navigation (docs/design/glass-g20-checkpoint.md). Called
 * once by the app shell, with whether the window is a phone.
 *
 *   - The first screen is decided before the first paint: The messages
 *     index opens on places; everything else, including Home and a
 *     deep link, a reload in a channel, opens on its page.
 *   - Arriving on the messages index shows places; Home shows its welcome page.
 *   - The conversation header's old drawer button and Ctrl+B still ask for the
 *     navigation by opening the drawer (`sidebarCollapsed` false). The drawer
 *     is gone; the request is taken here, turned into the places screen, and
 *     the flag is put back, so nothing else ever sees a phone drawer open.
 *
 * Picking something in the list is the list's own business (`PhonePlaces`): it
 * knows which tap was a pick.
 */
export function usePhoneNavigation(enabled: boolean): void {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    if (!enabled) return;
    const { setScreen } = usePhoneNavStore.getState();
    setScreen(isPlacesRoute(pathname) ? 'places' : 'conversation');
    return () => setScreen(null);
    // The first screen is chosen when the window becomes a phone, not on every
    // route change; the route changes are the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (isPlacesRoute(pathname)) usePhoneNavStore.getState().showPlaces();
    else if (/^\/app\/?$/.test(pathname)) usePhoneNavStore.getState().showConversation();
  }, [enabled, pathname]);

  useEffect(() => {
    if (!enabled) return;
    return useUIStore.subscribe((state, previous) => {
      if (!previous.sidebarCollapsed || state.sidebarCollapsed) return;
      // The shell opens the flag itself when the window stops being a phone (a
      // layout effect, which runs before this effect is cleaned up): with no
      // screen chosen there is nobody to ask.
      if (usePhoneNavStore.getState().screen === null) return;
      usePhoneNavStore.getState().showPlaces();
      state.setSidebarCollapsed(true);
    });
  }, [enabled]);
}
