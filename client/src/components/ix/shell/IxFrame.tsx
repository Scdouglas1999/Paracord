import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { useGlassStore } from '../../../stores/glassStore';
import { isPlacesRoute, usePhoneNavStore } from '../../glass/shell/phoneNav';
import { usePhoneFrame } from '../../glass/shell/usePhoneFrame';
import { useStageAudienceGuard } from '../../glass/stage/useStageAudienceGuard';
import { CallSlot } from '../call';
import { CardSlot } from '../card';
import { DockSlot } from '../dock';
import { SheetSlot } from '../sheets';
import { IxShellProvider, type IxShellValue } from './IxShellContext';
import { SidebarPanes } from './SidebarPanes';
import { TintLayers } from './TintLayers';
import { Toolbar } from './Toolbar';
import { placeKey } from './place';
import { IX_CALL_HOST_ID, IX_SHEET_HOST_ID } from './slots';
import { useToolbarStore } from './toolbarStore';
import { useIxLayout } from './useIxLayout';
import { useCurrentPlace, usePlaceHue, usePlaceName, usePlaceOrder } from './usePlace';

export interface IxFrameProps {
  /** The route's server and channel (AppShell reads them from the route). */
  guildId: string | null;
  channelId: string | null;
  /** What main holds: the routed page. */
  children: ReactNode;
}

/**
 * The Index frame (docs/index-spec.md §3, §5.1, §5.9, §9; IX-4). It owns
 * geometry and nothing else; what fills each host is a slot (`./slots.ts`).
 *
 *   .ix-frame                         two flush columns on --ix-ground, no gutters
 *     nav.ix-side   (ix-sidebar)      316 (280 under 1024px), right hairline
 *       tint layers                   the place's hue, crossfaded on change
 *       .ix-side__pinned              CardSlot position="pinned" (never slides)
 *       .ix-panes > .ix-pane*         SidebarSlot per place, sliding on change
 *       .ix-side__dock                DockSlot
 *     main#main-content.ix-main       1fr
 *       tint layers                   main's glow
 *       Toolbar (ix-toolbar)          58, over the page's scroller
 *       .ix-main__content             the routed page
 *       #ix-sheet-host                SheetSlot's geometry; SheetSlot after it
 *     #ix-call-host                   CallSlot: over main at inset 10, or over the
 *                                     window in theater
 *
 * ONE TREE FOR EVERY LAYOUT. The sidebar, main and the call host are the same
 * elements at every width, so crossing a breakpoint never remounts the page (a
 * draft, a scroll position, an open dialog survive). On a phone (§9) the same
 * two columns become two screens: the sidebar is the root, main is pushed over
 * it (the Glass phone navigation store and slide, `phoneNav`/`phoneMotion`,
 * reused; IX-16 owns the phone's finish).
 *
 * `inert`: main while the call covers it; the sidebar too in theater (it dims
 * to .4 beneath, §5.9); on a phone, whichever screen is behind.
 *
 * Room light is gone: no backdrop, no ambient view (index-spec §12). The compact
 * overlay is gone: there is no third mode.
 */
export function IxFrame({ guildId, channelId, children }: IxFrameProps) {
  const layout = useIxLayout();
  const phone = layout === 'phone';
  // A stage channel's audience publishes nothing, wherever you are in the app.
  useStageAudienceGuard();

  const place = useCurrentPlace();
  const order = usePlaceOrder();
  const hue = usePlaceHue(place);
  const placeName = usePlaceName(place);
  const stageMode = useGlassStore((state) => state.stage.mode);
  const sheet = useGlassStore((state) => state.sheet);
  const indexPage = useToolbarStore((state) => state.page !== null);

  const phoneFrame = usePhoneFrame(phone);
  const { screen, placesRef, conversationRef, mainRef } = phoneFrame;
  const setSide = useCallback(
    (element: HTMLElement | null) => {
      placesRef.current = element as HTMLDivElement | null;
    },
    [placesRef],
  );
  const setMain = useCallback(
    (element: HTMLElement | null) => {
      mainRef.current = element;
      conversationRef.current = element as HTMLDivElement | null;
    },
    [mainRef, conversationRef],
  );

  usePhonePush(phone, placeKey(place));

  const stageOpen = stageMode !== 'none';
  const theater = stageMode === 'theater';
  const sideInert = phone ? screen !== 'places' || stageOpen : theater;
  const mainInert = phone ? screen !== 'conversation' || stageOpen : stageOpen;

  const shell = useMemo<IxShellValue>(
    () => ({ layout, place, guildId, channelId }),
    [layout, place, guildId, channelId],
  );

  return (
    <IxShellProvider value={shell}>
      <div
        className="ix-frame"
        data-native-underlay-clear=""
        data-layout={layout}
        data-stage={stageMode}
        data-screen={phone ? screen : undefined}
      >
        <nav
          ref={setSide}
          className="ix-side"
          data-testid="ix-sidebar"
          aria-label={placeName || 'Sidebar'}
          data-native-underlay-clear=""
          data-active={phone && screen === 'places' ? 'true' : undefined}
          inert={sideInert}
        >
          <TintLayers hue={hue} kind="side" />
          <div className="ix-side__pinned">
            <CardSlot place={place} position="pinned" />
          </div>
          <SidebarPanes place={place} order={order} />
          <div className="ix-side__dock">
            <DockSlot />
          </div>
        </nav>

        <main
          ref={setMain}
          id="main-content"
          tabIndex={phone ? -1 : undefined}
          className="ix-main"
          data-native-underlay-clear=""
          data-page={indexPage ? 'index' : 'legacy'}
          data-active={phone && screen === 'conversation' ? 'true' : undefined}
          inert={mainInert}
        >
          <TintLayers hue={hue} kind="main" />
          <Toolbar />
          <div className="ix-main__content">{children}</div>
          <div id={IX_SHEET_HOST_ID} className="ix-sheet-host" data-sheet={sheet ?? undefined} />
          <SheetSlot />
        </main>

        <div id={IX_CALL_HOST_ID} className="ix-call-host" data-native-underlay-clear="">
          <CallSlot />
        </div>
      </div>
    </IxShellProvider>
  );
}

/**
 * Phone: picking something in the sidebar pushes main (§9). A route change that
 * stays in the same place is a pick (a channel, a DM, Friends); one that moves
 * to another place is the dock, which keeps the root screen and shows the new
 * place's sidebar. The messages index (`/app/dms`) is the root's own route.
 */
function usePhonePush(phone: boolean, placeId: string) {
  const { pathname } = useLocation();
  const last = useRef({ pathname, placeId });
  useEffect(() => {
    const before = last.current;
    last.current = { pathname, placeId };
    if (!phone || before.pathname === pathname) return;
    if (before.placeId !== placeId || isPlacesRoute(pathname)) return;
    usePhoneNavStore.getState().showConversation();
  }, [phone, pathname, placeId]);
}
