import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ContextPanel } from '../../../layout/ContextPanel';
import { useCurrentChannelStore } from '../../../../hooks/useChannels';
import { useFocusTrap } from '../../../../hooks/useFocusTrap';
import { useContentSwap, useLingering, usePresence } from '../../../../lib/motion';
import { cn } from '../../../../lib/utils';
import { useUIStore } from '../../../../stores/uiStore';
import type { SheetsProps } from '../slots';

/**
 * STUB (WP-G7) for `components/glass/sheets` — WP-G18 replaces it with the
 * sheets and menus over the conversation column (search, people, account,
 * channel, server), driven by `glassStore.sheet`.
 *
 * Until then this hosts today's `ContextPanel` (search, pins, threads, media,
 * economy, group-DM recipients), driven as before by `uiStore.contextPanelMode`
 * and toggled from the header:
 *
 *   wide, compact  a third floating pane after the conversation (16px gutter,
 *                  radius 28, full height): the panel's own plate, with its
 *                  own gutter zeroed so the frame's gap is the only one.
 *   phone          today's overlay: a full sheet for search, a drawer for the
 *                  rest, focus-trapped, closed by Escape or the backdrop.
 *
 * The mode is cleared when the route cannot show it (economy on a DM, …), and
 * the command palette's "search this server" hand-off (router state
 * `openSearch`) is honored once the server id is in the URL.
 */
export function Sheets({ guildId, channelId, layout }: SheetsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const contextPanelMode = useUIStore((s) => s.contextPanelMode);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const activeChannel = useCurrentChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));
  const isPhone = layout === 'phone';

  const isDmConversationRoute = /^\/app\/dms\/[^/]+$/.test(location.pathname);
  const isGroupDmContext =
    isDmConversationRoute && (activeChannel?.type === 3 || activeChannel?.channel_type === 3);
  const routeValid =
    contextPanelMode === null
    || (contextPanelMode === 'search' && Boolean(guildId || channelId))
    || (contextPanelMode === 'pins' && Boolean(channelId))
    || (contextPanelMode === 'threads' && Boolean(guildId && channelId))
    || (contextPanelMode === 'economy' && Boolean(guildId))
    || (contextPanelMode === 'media' && Boolean(guildId || channelId))
    || (contextPanelMode === 'recipients' && isGroupDmContext);

  useEffect(() => {
    if (contextPanelMode !== null && !routeValid) setContextPanelMode(null);
  }, [contextPanelMode, routeValid, setContextPanelMode]);

  // The command palette asks for search before the server route has mounted
  // the panel. Open it once the server id is in the URL, then drop the flag.
  useEffect(() => {
    const state = location.state as { openSearch?: boolean } | null;
    if (!state?.openSearch || !guildId) return;
    setContextPanelMode('search');
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [location.state, location.pathname, location.search, location.hash, guildId, navigate, setContextPanelMode]);

  const show = contextPanelMode !== null && routeValid;

  // Phone: the navigation drawer and this overlay are both z-[80]; opening one
  // dismisses the other so a covered one is never left stuck open underneath.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  useEffect(() => {
    if (isPhone && show && !sidebarCollapsed) setSidebarCollapsed(true);
  }, [isPhone, show, sidebarCollapsed, setSidebarCollapsed]);

  const overlayRef = useRef<HTMLDivElement>(null);
  const closePanel = useCallback(() => setContextPanelMode(null), [setContextPanelMode]);
  useFocusTrap(overlayRef, isPhone && show, closePanel);

  const panePresence = usePresence(!isPhone && show);
  const overlayPresence = usePresence(isPhone && show);
  // Members -> search -> threads: the pane stays, its content crossfades.
  const paneContentRef = useContentSwap<HTMLDivElement>(contextPanelMode);
  // The phone overlay's shape (a full sheet for search, a drawer for the rest)
  // follows the mode, and closing clears the mode on the same commit the leave
  // starts, so the leave keeps the mode it was opened with.
  const lingeringMode = useLingering(contextPanelMode);
  const overlayMode = contextPanelMode ?? lingeringMode.value;

  if (!isPhone) {
    if (!panePresence.mounted) return null;
    return (
      <div
        ref={paneContentRef}
        className={cn(
          'glass-frame__sheet glass-stub-sheet',
          panePresence.exiting ? 'pc-drawer-out-right' : 'pc-drawer-in-right',
        )}
        {...panePresence.scenery}
      >
        <ContextPanel guildId={guildId} channelId={channelId} manageFocus />
      </div>
    );
  }

  if (!overlayPresence.mounted) return null;
  return (
    <div
      className={cn(
        'fixed inset-0 z-[80] flex modal-backdrop',
        overlayMode !== 'search' && 'justify-end',
        overlayPresence.exiting ? 'pc-fade-out' : 'pc-fade-in',
      )}
      onClick={closePanel}
    >
      <div
        ref={overlayRef}
        role="dialog"
        aria-modal="true"
        aria-label={overlayMode === 'search' ? 'Search messages' : 'Details'}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'context-panel-overlay h-full overflow-hidden shadow-[var(--shadow-plate)] outline-none',
          overlayMode === 'search' ? 'w-full' : 'w-[var(--w-context-panel)] max-w-[88vw]',
          overlayMode === 'search'
            ? (overlayPresence.exiting ? 'pc-sheet-out' : 'pc-search-sheet-in')
            : (overlayPresence.exiting ? 'pc-drawer-out-right' : 'pc-drawer-in-right'),
        )}
        {...overlayPresence.scenery}
      >
        <ContextPanel guildId={guildId} channelId={channelId} />
      </div>
    </div>
  );
}
