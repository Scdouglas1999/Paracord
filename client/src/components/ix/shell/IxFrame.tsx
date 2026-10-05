import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLocation, useNavigationType } from 'react-router';

import { stageFillsWindow, useGlassStore } from '../../../stores/glassStore';
import { isPlacesRoute, usePhoneNavStore } from '../../glass/shell/phoneNav';
import { usePhoneFrame } from '../../glass/shell/usePhoneFrame';
import { useStageAudienceGuard } from '../../glass/stage/useStageAudienceGuard';
import { IxAnnouncer } from '../a11y';
import { CallSlot } from '../call';
import { CardSlot } from '../card';
import { DockSlot } from '../dock';
import { useMainEntrance } from '../motion';
import { SheetSlot } from '../sheets';
import { IxShellProvider, type IxShellValue } from './IxShellContext';
import { CallStrip } from './phone/CallStrip';
import { PhoneShade } from './phone/PhoneParts';
import { usePhoneRoot } from './phone/usePhoneRoot';
import { SidebarPanes } from './SidebarPanes';
import { TintLayers } from './TintLayers';
import { useBannerHostStore } from './bannerHost';
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
 *                                     window in theater; the whole window, edge to
 *                                     edge, with a stream in theater or full screen
 *                                     (`data-call-fill`, §7.7)
 *
 * ONE TREE FOR EVERY LAYOUT. The sidebar, main and the call host are the same
 * elements at every width, so crossing a breakpoint never remounts the page (a
 * draft, a scroll position, an open dialog survive). On a phone (§9) the same
 * two columns become two screens: the sidebar is the root, main is pushed over
 * it (the Glass phone navigation store and slide, `phoneNav`/`phoneMotion`,
 * reused; IX-16 owns the phone's finish: `./phone/`, the call strip under the
 * toolbar, a dim layer in each screen, the document-wide phone marks).
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
  // §7.2 theater / §7.7 full screen with a stream in focus: the call fills the window.
  const callFills = useGlassStore((state) => stageFillsWindow(state.stage));
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
  const setBannerHost = useBannerHostStore((state) => state.setHost);

  // §5.1 / §5.2: the new page's title and feed come in from the direction the
  // selection moved (a place switch: from where they stand). Not on a phone,
  // where the pushed screen is the move.
  const { pathname } = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  useMainEntrance({ content: contentRef, sidebar: placesRef, pathname, placeKey: placeKey(place), enabled: !phone });
  // IX-16: the phone's document-wide marks (`data-ix-layout`, the keyboard inset).
  usePhoneRoot(phone);

  const stageOpen = stageMode !== 'none';
  const theater = stageMode === 'theater';
  const fill = callFills && !phone;
  const sideInert = phone ? screen !== 'places' || stageOpen : theater || fill;
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
        data-call-fill={fill ? 'true' : undefined}
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
          {phone && <PhoneShade />}
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
          {phone && <CallStrip />}
          <div ref={contentRef} className="ix-main__content">{children}</div>
          <div id={IX_SHEET_HOST_ID} className="ix-sheet-host" data-sheet={sheet ?? undefined} />
          <SheetSlot />
          {phone && <PhoneShade />}
        </main>

        {/* §6.8: the banner strips sit over main only (BannerStack portals here
            and moves main down by their height); a phone keeps them across the window. */}
        {!phone && <div ref={setBannerHost} className="ix-banner-host" data-testid="ix-banner-host" />}

        <div id={IX_CALL_HOST_ID} className="ix-call-host" data-native-underlay-clear="">
          <CallSlot />
        </div>

        {/* §10: the one polite live region (joins, a server going live, a share). */}
        <IxAnnouncer place={place} />
      </div>
    </IxShellProvider>
  );
}

/**
 * Phone: picking something in the sidebar pushes main (§9). A navigation that
 * stays in the same place is a pick (a channel, a DM, Friends), including a tap
 * on the row that is already open (the same path, a new history entry: IX-16);
 * only a push counts (a redirect replaces, the browser's back pops);
 * one that moves to another place is the dock, which keeps the root screen and
 * shows the new place's sidebar. The messages index (`/app/dms`) is the root's
 * own route.
 */
function usePhonePush(phone: boolean, placeId: string) {
  const { pathname, key } = useLocation();
  // A pick is a push; a redirect (replace) or the browser's back (pop) is not.
  const kind = useNavigationType();
  const last = useRef({ key, placeId });
  useEffect(() => {
    const before = last.current;
    last.current = { key, placeId };
    if (!phone || before.key === key || kind !== 'PUSH') return;
    if (before.placeId !== placeId || isPlacesRoute(pathname)) return;
    usePhoneNavStore.getState().showConversation();
  }, [phone, pathname, key, kind, placeId]);
}
