import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useLingering } from '../../../lib/motion';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useGlassStore, type GlassSheet } from '../../../stores/glassStore';
import { useUIStore } from '../../../stores/uiStore';
import { SearchOverlay } from '../../layout/overlays/SearchOverlay';
import type { SheetsProps } from '../shell/slots';
import { ChannelSheet } from './ChannelSheet';
import { PeopleSheet } from './PeopleSheet';
import { RemindersSheet } from './RemindersSheet';
import { closeSheets, openForContextMode, restoreSheetTrigger, useSheetPages } from './sheetStore';

/**
 * The sheets (docs/index-spec.md §6.1; WP IX-9; formerly glass-spec §3, §5, WP-G18).
 * `SheetSlot` (components/ix/sheets) mounts it inside main, and it renders
 * whichever sheet `glassStore.sheet` names in the sheet host on main's right:
 *
 *   search    the message search
 *   people    a server's members, a group's recipients, or the two of a message
 *   channel   catch up, pins, threads (a thread is pushed over the list), media,
 *             follows, the leaderboard and this channel's notifications, with a
 *             segmented control at the top to move between them
 *   account   the account menu is a popover (components/ix/menus, mounted by
 *             `MenuHost`); its Reminders row opens the reminders sheet
 *   server    (the server menu is a popover of its own)
 *
 * Headers, the channel menu, the server menu and the command palette ask for a
 * sheet through `glassStore.openSheet` (or `sheetStore`'s helpers, for a page).
 * A few older callers still set `uiStore.contextPanelMode`; this slot turns that
 * request into a sheet and clears it, so nothing that asked for a panel breaks.
 *
 * Only one sheet is open at a time. Escape closes it, focus goes into it and
 * comes back to what opened it, and it closes when you move to another
 * conversation (the page under it changes, so a sheet left over it would stay
 * about the old one). On a phone the sheet is the whole screen.
 */

type Shown = 'search' | 'people' | 'channel' | 'reminders' | null;

function shownFor(sheet: GlassSheet | null, accountPage: string | null): Shown {
  if (sheet === 'search' || sheet === 'people' || sheet === 'channel') return sheet;
  if (sheet === 'account' && accountPage === 'reminders') return 'reminders';
  return null;
}

export function Sheets({ guildId, channelId, layout }: SheetsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const sheet = useGlassStore((s) => s.sheet);
  const accountPage = useSheetPages((s) => s.accountPage);
  const contextPanelMode = useUIStore((s) => s.contextPanelMode);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const activeChannel = useCurrentChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));
  const isPhone = layout === 'phone';

  // Older callers (the command palette, Mod+F, the server home's Media and
  // Leaderboard buttons) still ask for a panel through uiStore. Turn the request
  // into a sheet and clear it, so it is a request and never state.
  useEffect(() => {
    if (contextPanelMode === null) return;
    openForContextMode(contextPanelMode);
    setContextPanelMode(null);
  }, [contextPanelMode, setContextPanelMode]);

  // Moving to another conversation puts the sheet away: the pane under it has
  // changed, and a sheet left over it would hide the very thing that was picked.
  // (Declared before the palette hand-off below, so a request wins over it.)
  const lastChannel = useRef(channelId);
  useEffect(() => {
    if (lastChannel.current === channelId) return;
    lastChannel.current = channelId;
    if (useGlassStore.getState().sheet !== null) closeSheets();
  }, [channelId]);

  // The command palette asks for search before the server route has mounted.
  // Open it once the server id is in the URL, then drop the flag.
  useEffect(() => {
    const state = location.state as { openSearch?: boolean } | null;
    if (!state?.openSearch || !guildId) return;
    openForContextMode('search');
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [location.state, location.pathname, location.search, location.hash, guildId, navigate]);

  // A sheet needs something to be about: drop it when the route has nothing
  // (Home, Friends), where an open sheet would have no conversation to cover.
  const hasSubject = Boolean(guildId || channelId);
  useEffect(() => {
    if (sheet !== null && sheet !== 'account' && !hasSubject) closeSheets();
  }, [sheet, hasSubject]);

  // Phone: the navigation drawer and a full-screen sheet cannot both be open.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  useEffect(() => {
    if (isPhone && sheet !== null && !sidebarCollapsed) setSidebarCollapsed(true);
  }, [isPhone, sheet, sidebarCollapsed, setSidebarCollapsed]);

  // When a sheet closes, put focus back on what opened it (a frame later, so
  // the focus trap's own restore has run and this only fills a gap).
  const lastSheet = useRef<GlassSheet | null>(sheet);
  useEffect(() => {
    const previous = lastSheet.current;
    lastSheet.current = sheet;
    if (previous === null || sheet !== null) return;
    const frame = requestAnimationFrame(() => restoreSheetTrigger(previous));
    return () => cancelAnimationFrame(frame);
  }, [sheet]);

  const active = shownFor(sheet, accountPage);
  // A sheet keeps rendering the page it was showing while it plays its leave.
  const shown = useLingering(active).value;
  const close = useCallback(() => closeSheets(), []);

  return (
    <>
      {shown === 'search' && (
        <SearchOverlay
          open={active === 'search'}
          onClose={close}
          guildId={guildId}
          channelId={channelId ?? undefined}
          channelName={activeChannel?.name ?? undefined}
        />
      )}
      {shown === 'people' && (
        <PeopleSheet open={active === 'people'} onClose={close} guildId={guildId} channelId={channelId} />
      )}
      {shown === 'channel' && (
        <ChannelSheet open={active === 'channel'} onClose={close} guildId={guildId} channelId={channelId} />
      )}
      {shown === 'reminders' && <RemindersSheet open={active === 'reminders'} onClose={close} />}
    </>
  );
}
