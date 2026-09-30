import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { RoomBackdrop } from '../room';
import { PlacesPanel } from '../places';
import { Stage } from '../stage';
import { Sheets } from '../sheets';
import { useGlassStore, type OpenStageMode } from '../../../stores/glassStore';
import { PlacesOverlay } from './PlacesOverlay';
import { PlacesToggle } from './PlacesToggle';
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
 * The Glass frame (docs/glass-spec.md §3, §6; WP-G7). It owns geometry and
 * nothing else: which panes are on screen, where, and how big. What fills a
 * pane is its slot's business (`./slots.ts`).
 *
 *   nothing on stage   [places 316] [conversation]            (+ [sheet])
 *   side by side       [stage] [conversation 420]
 *     + browse (S)     [places 316] [stage]                    conversation steps aside
 *   theater            stage fills the window; conversation floats 380 on the right
 *     + chat hidden    the conversation slides out
 *     + browse         places floats over the stream's left edge
 *
 * Panes float on the room with 16px from the window and from each other,
 * radius 28, full height (styles/glass-layout.css). The places pane is never
 * flush while the conversation floats: siblings share geometry (§1.6).
 *
 * Below 860px (`compact`) the conversation is alone and places opens as an
 * overlay from the header. The phone frame (< 768px) is the existing phone
 * layout (its navigation drawer, bottom bar and call dock live in AppShell)
 * until WP-G20.
 *
 * The conversation pane is the one `<main>`; it stays mounted across every
 * layout change (a hidden conversation is `inert`, not unmounted) so a draft,
 * a scroll position and a staged reply survive watching and browsing.
 */
export function GlassFrame({ layout, guildId, channelId, children }: GlassFrameProps) {
  const location = useLocation();
  const stage = useGlassStore((s) => s.stage);
  const browseOpen = useGlassStore((s) => s.browseOpen);
  const chatHidden = useGlassStore((s) => s.chatHidden);
  const placesOverlayOpen = useGlassStore((s) => s.placesOverlayOpen);
  const setPlacesOverlayOpen = useGlassStore((s) => s.setPlacesOverlayOpen);
  const setBrowseOpen = useGlassStore((s) => s.setBrowseOpen);

  const stageOpen = stage.mode !== 'none';
  const stageMode = stage.mode === 'none' ? null : (stage.mode as OpenStageMode);
  const stageTarget =
    stageOpen && stage.serverId && stage.guildId && stage.channelId && stage.streamerId
      ? { serverId: stage.serverId, guildId: stage.guildId, channelId: stage.channelId, streamerId: stage.streamerId }
      : null;

  // Picking a channel or a server closes the places overlay and browse, and
  // brings that channel's conversation back (§3, §6.3). The first render is not
  // a pick, so the route that mounted the frame closes nothing.
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    const glass = useGlassStore.getState();
    if (glass.placesOverlayOpen) glass.setPlacesOverlayOpen(false);
    if (glass.browseOpen) glass.setBrowseOpen(false);
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
  const conversationAway =
    (stageMode === 'side' && browseOpen && layout !== 'phone')
    || (stageMode === 'theater' && chatHidden);

  return (
    <>
      <RoomBackdrop guildId={guildId} />
      <div
        className="glass-frame"
        data-native-underlay-clear=""
        data-layout={layout}
        data-stage={stage.mode}
        data-browse={browseOpen ? 'true' : undefined}
        data-chat-hidden={chatHidden ? 'true' : undefined}
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
          </section>
        )}

        <main
          id="main-content"
          data-native-underlay-clear=""
          className="glass-pane glass-pane--glow glass-frame__conversation"
          data-away={conversationAway ? 'true' : undefined}
          inert={conversationAway}
        >
          {/* Compact frame, a page with no conversation header (Home, Friends,
              a server's home, the voice page, settings): the places button
              still has to be one tap away, so the frame gives it a row. A
              conversation header carries its own, and CSS hides this row
              when one is present. */}
          {layout === 'compact' && (
            <div className="glass-frame__pane-bar">
              <PlacesToggle />
            </div>
          )}
          {children}
        </main>

        <Sheets guildId={guildId} channelId={channelId} layout={layout} />
      </div>

      <PlacesOverlay open={showPlacesOverlay} onClose={closeOverlay} browsing={stageOpen && browseOpen} />
    </>
  );
}
