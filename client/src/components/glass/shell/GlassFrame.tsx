import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { CallPill } from '../pill';
import { RoomBackdrop } from '../room';
import { PlacesPanel } from '../places';
import { Stage } from '../stage';
import { useStageAudienceGuard } from '../stage/useStageAudienceGuard';
import { MORPH_OVER_CLASS, MORPH_UNDER_CLASS, useStageTransitions } from '../stage/stageTransition';
import { Sheets } from '../sheets';
import { stageTargetOf, useGlassStore, type OpenStageMode } from '../../../stores/glassStore';
import { PhonePlaces } from './PhonePlaces';
import { PhoneStageChrome } from './PhoneStageChrome';
import { PlacesOverlay } from './PlacesOverlay';
import { PlacesToggle } from './PlacesToggle';
import { usePhoneFrame } from './usePhoneFrame';
import type { GlassLayout } from './useGlassLayout';

export interface GlassFrameProps {
  layout: GlassLayout;
  /** The route's server and channel, handed to the room and sheets slots. */
  guildId: string | null;
  channelId: string | null;
  /** What the conversation pane holds: the routed page. */
  children: ReactNode;
}

/**
 * The Glass frame (docs/glass-spec.md §3, §6, §8; WP-G7, WP-G20). It owns geometry
 * and nothing else: which panes are on screen, where, and how big. What fills a
 * pane is its slot's business (`./slots.ts`).
 *
 *   nothing on stage   [places 316] [conversation]            (+ [sheet])
 *   side by side       [stage] [conversation 420]
 *     + browse (S)     [places 316] [stage]                    conversation steps aside
 *   theater            stage fills the window; conversation floats 380 on the right
 *     + chat hidden    the conversation slides out
 *     + browse         places floats over the stream's left edge; the chat steps out
 *                      of the way until a pick (or H) brings it back
 *
 * The moves between these (650ms, the pill growing into the stage and back)
 * are `stage/stageTransition.ts`'s. It measures the panes around each store
 * change and plays the difference; the two morph layers here hold what it
 * needs outside the panes (the clones of what just left, above the frame; the
 * panes' shadows while their corners move, under it).
 *
 * Panes float on the room with 16px from the window and from each other,
 * radius 28, full height (styles/glass-layout.css). The places pane is never
 * flush while the conversation floats: siblings share geometry (§1.6).
 *
 * Below 860px (`compact`) the conversation is alone and places opens as an
 * overlay from the header. Below 768px (`phone`) places and the conversation are
 * two screens, one in front of the other, the stream is a card above the
 * conversation and full screen is its theater (`usePhoneFrame`, phoneNav.ts).
 *
 * ONE TREE FOR EVERY LAYOUT. The conversation pane (the one `<main>`), the stage
 * and the sheets keep their place in the React tree and their DOM nodes across
 * every layout change, the phone breakpoint included: the frame is the same
 * elements wearing different classes, and only what a layout alone has (the
 * wide places pane, the phone's places screen, the morph layers, the overlay) is
 * mounted and unmounted. So a window resized across 768px keeps whatever the
 * conversation holds in local state: an open dialog, a draft, a staged reply, a
 * scroll position (before, the wide frame and the phone frame were two
 * components and the swap rebuilt the conversation under them). A hidden
 * conversation is `inert`, not unmounted, for the same reason on stage moves.
 *
 *   `.glass-frame`            the frame, every layout
 *   body (wide, compact)      `display: contents`, so places, stage and `main`
 *                             are the frame's own flex items, and the element the
 *                             stage's moves measure (`:scope > .glass-frame__*`)
 *   conversation screen       the same element on a phone: places is a sibling
 *     (phone)                 screen beside it, and the stage card, `main` and
 *                             the sheets are inside it
 */
export function GlassFrame({ layout, guildId, channelId, children }: GlassFrameProps) {
  const location = useLocation();
  const phone = layout === 'phone';
  // A stage channel's audience publishes nothing, wherever you are in the app.
  useStageAudienceGuard();
  const stage = useGlassStore((s) => s.stage);
  const browseOpen = useGlassStore((s) => s.browseOpen);
  const chatHidden = useGlassStore((s) => s.chatHidden);
  const placesOverlayOpen = useGlassStore((s) => s.placesOverlayOpen);
  const setPlacesOverlayOpen = useGlassStore((s) => s.setPlacesOverlayOpen);
  const setBrowseOpen = useGlassStore((s) => s.setBrowseOpen);
  const morphOverRef = useRef<HTMLDivElement | null>(null);
  const morphUnderRef = useRef<HTMLDivElement | null>(null);
  // The stage's moves measure the wide frame's panes, which are the body's
  // children; a phone has no such moves, so nothing is handed to them there.
  const moveFrameRef = useRef<HTMLElement | null>(null);
  useStageTransitions(moveFrameRef, morphOverRef, morphUnderRef, {
    mode: stage.mode,
    browse: browseOpen,
    chatHidden,
  });
  const phoneFrame = usePhoneFrame(phone);
  const { screen, placesRef, conversationRef, mainRef } = phoneFrame;
  // One element, two jobs: the wide frame's body for the stage's moves, the
  // phone's conversation screen for the slide between screens.
  const setBody = useCallback(
    (element: HTMLDivElement | null) => {
      moveFrameRef.current = phone ? null : element;
      conversationRef.current = phone ? element : null;
    },
    [phone, conversationRef],
  );

  const stageOpen = stage.mode !== 'none';
  const stageMode = stage.mode === 'none' ? null : (stage.mode as OpenStageMode);
  const stageTarget = useMemo(
    () => stageTargetOf(stage),
    [stage],
  );

  // Picking a channel or a server closes the places overlay and browse, and
  // brings that channel's conversation back (§3, §6.3). The first render is not
  // a pick, so the route that mounted the frame closes nothing.
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    const glass = useGlassStore.getState();
    if (glass.placesOverlayOpen) glass.setPlacesOverlayOpen(false);
    if (glass.browseOpen) {
      glass.setBrowseOpen(false);
      // In theater, a pick brings that conversation back beside the stream.
      if (glass.stage.mode === 'theater' && glass.chatHidden) glass.setChatHidden(false);
    }
  }, [location.pathname]);

  // The overlay belongs to the compact frame; growing the window past 860px
  // (or shrinking to a phone) must not leave it open behind the new frame.
  useEffect(() => {
    if (layout !== 'compact' && useGlassStore.getState().placesOverlayOpen) setPlacesOverlayOpen(false);
  }, [layout, setPlacesOverlayOpen]);

  const closeOverlay = useCallback(() => {
    setPlacesOverlayOpen(false);
    setBrowseOpen(false);
  }, [setPlacesOverlayOpen, setBrowseOpen]);
  const closeBrowse = useCallback(() => setBrowseOpen(false), [setBrowseOpen]);

  const showPlacesPane = layout === 'wide' && (!stageOpen || browseOpen);
  // On the compact frame there is no room for a places pane beside a stage;
  // browse opens the same overlay the header does.
  const showPlacesOverlay = layout === 'compact' && (placesOverlayOpen || (stageOpen && browseOpen));
  // Theater browsing floats places over the stream's left edge and puts the chat
  // out of the way (the prototype's layout), so the stream is what is left.
  const conversationAway =
    !phone
    && ((stageMode === 'side' && browseOpen)
      || (stageMode === 'theater' && (chatHidden || (browseOpen && layout === 'wide'))));
  // Full screen is the phone's theater: the conversation is out of reach under it.
  const fullScreen = phone && stageMode === 'theater';

  return (
    <>
      <RoomBackdrop guildId={guildId} />
      {phone ? (
        <div className="glass-phone__scrim" data-native-underlay-clear="" aria-hidden="true" />
      ) : (
        <div ref={morphUnderRef} className={MORPH_UNDER_CLASS} aria-hidden="true" />
      )}
      <div
        className="glass-frame"
        data-native-underlay-clear=""
        data-layout={layout}
        data-screen={phone ? screen : undefined}
        data-stage={stage.mode}
        data-browse={!phone && browseOpen ? 'true' : undefined}
        data-chat-hidden={!phone && chatHidden ? 'true' : undefined}
      >
        {phone && (
          <div
            ref={placesRef}
            className="glass-phone__screen glass-phone__screen--places"
            data-active={screen === 'places' ? 'true' : undefined}
            inert={screen !== 'places'}
          >
            <PhonePlaces guildId={guildId} holdsCall={phoneFrame.callOnPlaces} />
          </div>
        )}

        <div
          ref={setBody}
          className={phone ? 'glass-phone__screen glass-phone__screen--conversation' : 'glass-frame__body'}
          style={phone ? undefined : { display: 'contents' }}
          data-active={phone && screen === 'conversation' ? 'true' : undefined}
          inert={phone ? screen !== 'conversation' : undefined}
        >
          {showPlacesPane && (
            <div
              className="glass-pane glass-pane--glow glass-frame__places"
              data-presentation={stageOpen ? 'browse' : 'pane'}
            >
              <PlacesPanel
                presentation={stageOpen ? 'browse' : 'pane'}
                onClose={stageOpen ? closeBrowse : undefined}
              />
            </div>
          )}

          {stageTarget && stageMode && (
            <section
              aria-label="Stage"
              data-native-underlay-clear=""
              className="glass-pane glass-pane--deep glass-frame__stage"
            >
              <Stage target={stageTarget} mode={stageMode} />
              {phone && <PhoneStageChrome target={stageTarget} mode={stageMode} />}
            </section>
          )}

          <main
            ref={mainRef}
            id="main-content"
            tabIndex={phone ? -1 : undefined}
            data-native-underlay-clear=""
            className="glass-pane glass-pane--glow glass-frame__conversation"
            data-away={conversationAway ? 'true' : undefined}
            inert={phone ? fullScreen : conversationAway}
          >
            {/* A page with no conversation header (Home, Friends, a server's
                home, the voice page, settings) still needs the way to places
                one tap away, so the frame gives it a row: on the compact frame
                the places button, on a phone the way back and, while you are in
                a call, the pill (a conversation draws its own). A conversation
                header carries its own, and CSS hides this row when one is
                present. */}
            {(layout === 'compact' || phone) && (
              <div className="glass-frame__pane-bar">
                <PlacesToggle />
                {phoneFrame.callBar && <CallPill guildId={guildId} layout="stacked" />}
              </div>
            )}
            {children}
          </main>

          <Sheets guildId={guildId} channelId={channelId} layout={layout} />
        </div>
      </div>
      {!phone && <div ref={morphOverRef} className={MORPH_OVER_CLASS} aria-hidden="true" />}

      {!phone && <PlacesOverlay open={showPlacesOverlay} onClose={closeOverlay} browsing={stageOpen && browseOpen} />}
    </>
  );
}
