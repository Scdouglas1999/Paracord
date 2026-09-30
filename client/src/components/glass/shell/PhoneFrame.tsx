import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { usePresence } from '../../../lib/motion';
import type { OpenStageMode, StageTarget } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { CallPill } from '../pill';
import { RoomBackdrop } from '../room';
import { Sheets } from '../sheets';
import { Stage } from '../stage';
import { PhonePlaces } from './PhonePlaces';
import { PhoneStageChrome } from './PhoneStageChrome';
import { PlacesToggle } from './PlacesToggle';
import { playPhoneScreens } from './phoneMotion';
import { isConversationRoute, usePhoneNavStore, type PhoneScreen } from './phoneNav';

/** Whether this client holds a call (joining, listening or joined): the pill's own test. */
function useHoldsCall(): boolean {
  const callId = useVoiceStore((state) => state.callId);
  const callPhase = useVoiceStore((state) => state.callPhase);
  const channelId = useVoiceStore((state) => state.channelId);
  if (!callId || !channelId) return false;
  return callPhase !== 'closed' && callPhase !== 'closing' && callPhase !== 'idle' && callPhase !== 'failed';
}

export interface PhoneFrameProps {
  guildId: string | null;
  channelId: string | null;
  /** The stream on stage, if one is (glassStore). */
  stageTarget: StageTarget | null;
  stageMode: OpenStageMode | null;
  /** What the conversation screen holds: the routed page. */
  children: ReactNode;
}

/**
 * The phone frame (docs/glass-spec.md §8; WP-G20). No server rail, no bottom
 * bar, no fake status bar: two screens on the room, one in front of the other.
 *
 *   places         its own screen: your face, the call pill while you are in a
 *                  call, and the places panel, full width
 *   conversation   the stream card (while watching), then the routed page, which
 *                  for a channel is the pill, the header, the messages and the
 *                  message box, sitting straight on the room
 *
 * Picking a channel slides the conversation in; the back button and the edge
 * swipe bring places back (`phoneNav.ts`). Both screens stay mounted; the one
 * behind is `inert` and off to the side. Watching is the stacked stream (no side by
 * side), and full screen is the phone's theater.
 *
 * Insets: the frame draws to the window's edges and pads itself with the
 * device's safe areas (`--safe-top`, `--safe-bottom`), so nothing sits under a
 * notch or a home indicator, and nothing pretends to be the status bar.
 */
export function PhoneFrame({ guildId, channelId, stageTarget, stageMode, children }: PhoneFrameProps) {
  const location = useLocation();
  const chosen = usePhoneNavStore((state) => state.screen);
  const screen: PhoneScreen = chosen ?? 'conversation';
  const holdsCall = useHoldsCall();
  // The call pill on places is only drawn while places is in front (and for the
  // length of its leave, so it does not vanish mid-slide): the conversation has
  // its own, and two of them on the page would be two of everything.
  const callOnPlaces = usePresence(holdsCall && screen === 'places').mounted && holdsCall;
  const placesRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  const fullScreen = stageMode === 'theater';
  // A page that draws its own pill (a channel or a message) shows the call
  // there; any other page (Home, Friends, a server's overview) shows it in a bar
  // under the back button, so the call never goes out of reach.
  const callBar = holdsCall && !isConversationRoute(location.pathname);

  // The move between the screens, and where focus goes after it. Nothing plays
  // until a first screen has been chosen (the frame's first paint), and focus
  // only moves for a change, never for the first screen.
  const previous = useRef<PhoneScreen | null>(null);
  const running = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    if (chosen === null) return;
    const before = previous.current;
    previous.current = chosen;
    if (before === null || before === chosen) return;
    for (const animation of running.current) animation.cancel();
    running.current = playPhoneScreens(placesRef.current, conversationRef.current, chosen);
    if (chosen === 'conversation') {
      mainRef.current?.focus({ preventScroll: true });
    } else {
      const row =
        placesRef.current?.querySelector<HTMLElement>('[data-place-row][tabindex="0"]')
        ?? placesRef.current?.querySelector<HTMLElement>('[data-place-row]');
      row?.focus({ preventScroll: true });
    }
  }, [chosen]);

  return (
    <>
      <RoomBackdrop guildId={guildId} />
      <div className="glass-phone__scrim" data-native-underlay-clear="" aria-hidden="true" />
      <div
        className="glass-frame"
        data-native-underlay-clear=""
        data-layout="phone"
        data-screen={screen}
        data-stage={stageMode ?? 'none'}
      >
        <div
          ref={placesRef}
          className="glass-phone__screen glass-phone__screen--places"
          data-active={screen === 'places' ? 'true' : undefined}
          inert={screen !== 'places'}
        >
          <PhonePlaces guildId={guildId} holdsCall={callOnPlaces} />
        </div>

        <div
          ref={conversationRef}
          className="glass-phone__screen glass-phone__screen--conversation"
          data-active={screen === 'conversation' ? 'true' : undefined}
          inert={screen !== 'conversation'}
        >
          {stageTarget && stageMode && (
            <section
              aria-label="Stage"
              data-native-underlay-clear=""
              className="glass-pane glass-pane--deep glass-frame__stage"
            >
              <Stage target={stageTarget} mode={stageMode} />
              <PhoneStageChrome target={stageTarget} mode={stageMode} />
            </section>
          )}

          <main
            ref={mainRef}
            id="main-content"
            tabIndex={-1}
            data-native-underlay-clear=""
            className="glass-pane glass-pane--glow glass-frame__conversation"
            inert={fullScreen}
          >
            {/* A page with no conversation header (Home, Friends, a server's
                overview) still needs the way back, so the frame gives it a row;
                CSS hides the row when a header is present. */}
            <div className="glass-frame__pane-bar">
              <PlacesToggle />
              {callBar && <CallPill guildId={guildId} layout="stacked" />}
            </div>
            {children}
          </main>

          <Sheets guildId={guildId} channelId={channelId} layout="phone" />
        </div>
      </div>
    </>
  );
}
