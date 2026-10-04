import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { activateConversation } from '../../../lib/attention/conversationNavigation';
import { PEOPLE_HUE } from '../../../lib/identityHue';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { ErrorBoundary } from '../../ErrorBoundary';
import { useMinuteClock } from '../../glass/places/usePlacesData';
import { CardSlot } from '../card';
import { IxGlyph } from '../glyphs';
import { Avatar } from '../identity';
import { openDmPicker, openPeopleMenu, useMenuHostStore } from '../menus';
import { PEOPLE_PLACE } from '../shell';
import { SidebarLabel } from '../sidebar/SidebarLabel';
import { rovingKeyDown, useRovingList } from '../sidebar/useRovingList';
import { SELECTED_ATTRIBUTE, useSelectionGlide } from '../sidebar/useSelectionGlide';
import { DmRow } from './DmRow';
import { friendsLine, requestsWords } from './peopleModel';
import { InboxRow } from './InboxRow';
import { UtilityRow } from './UtilityRow';
import { usePeopleSidebar } from './usePeopleSidebar';

/**
 * The People sidebar (docs/index-spec.md §3.1, §4.1, §6.6): your avatar, "People",
 * "Friends and direct messages" and "…" (the People menu); the search field ("Search
 * people" opens the quick switcher, which scopes itself to people here); the card slot
 * (your direct call, or an incoming one); two utility rows, Friends and Inbox, styled as
 * channel rows; and Messages: every direct message and group as a two-line row with a
 * 38px face, the time of its last message, its line and an unread dot.
 *
 * It reads its place from the pane's props (`leaving`), never the route's: a pane that
 * is sliding out keeps the row it had and plays nothing. Keyboard: the header, "…" and
 * the search field are ordinary stops; the rows are one stop, reached with the arrow
 * keys, as in a server.
 */

export interface PeopleSidebarProps {
  /** The pane is sliding out: nothing plays and nothing moves. */
  leaving?: boolean;
}

export function PeopleSidebar({ leaving = false }: PeopleSidebarProps) {
  return (
    <ErrorBoundary variant="section" label="People">
      <PeoplePane leaving={leaving} />
    </ErrorBoundary>
  );
}

const FRIENDS_HREF = '/app/friends';
const INBOX_HREF = '/app/inbox';

/** Which row the route selects: Friends, Inbox, or a conversation. */
function selectedRow(pathname: string): { kind: 'friends' } | { kind: 'inbox' } | { kind: 'dm'; channelId: string } | null {
  if (pathname === FRIENDS_HREF) return { kind: 'friends' };
  if (pathname === INBOX_HREF) return { kind: 'inbox' };
  const dm = /^\/app\/dms\/([^/]+)/.exec(pathname);
  return dm ? { kind: 'dm', channelId: decodeURIComponent(dm[1]) } : null;
}

/** Has this account's conversation list arrived, failed, or not yet? */
function useDmListStatus() {
  const scope = useCurrentAccountScope();
  const key = scope ? entityScopeKey(scope, '') : null;
  const loaded = useChannelStore((state) => (key ? state.guildChannelsLoaded[key] === true : false));
  const error = useChannelStore((state) => (key ? (state.errors[key] ?? null) : null));
  const retry = useCallback(() => {
    if (scope) void useChannelStore.getState().fetchDmChannels(scope);
  }, [scope]);
  return { status: loaded ? ('ready' as const) : error ? ('error' as const) : ('loading' as const), error, retry };
}

function PeoplePane({ leaving }: { leaving: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const nowMs = useMinuteClock();
  const data = usePeopleSidebar();
  const dmList = useDmListStatus();

  // The row open in People: the route's while this is the current pane, frozen at what it was when
  // the pane started to slide out.
  const [frozen, setFrozen] = useState(pathname);
  if (!leaving && frozen !== pathname) setFrozen(pathname);
  const open = selectedRow(leaving ? frozen : pathname);

  const rowsRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const selection = useSelectionGlide(rowsRef, leaving);
  const menuOpen = useMenuHostStore((state) => state.menu?.kind === 'people');

  const friendsText = friendsLine({ friends: data.friends.total, online: data.friends.online, requests: data.friends.requests });
  const requests = data.friends.requests;

  /* ---- Focus: one stop in the list ------------------------------------------- */
  const ids = useMemo(() => ['friends', 'inbox', ...data.dms.map((entry) => `dm:${entry.key}`)], [data.dms]);
  const selectedId = open?.kind === 'friends' ? 'friends' : open?.kind === 'inbox' ? 'inbox' : open?.kind === 'dm' ? `dm:${data.dms.find((entry) => entry.channelId === open.channelId)?.key}` : null;
  const roving = useRovingList(ids, selectedId);

  // The open row stays in view (the pane is the scroller). Not while sliding out.
  useEffect(() => {
    if (leaving) return;
    const container = rowsRef.current;
    const row = container?.querySelector<HTMLElement>(`[${SELECTED_ATTRIBUTE}]`);
    const pane = container?.closest<HTMLElement>('.ix-pane');
    if (!row || !pane) return;
    const top = row.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    const bottom = top + row.offsetHeight;
    if (top < pane.scrollTop) pane.scrollTop = Math.max(0, top - 8);
    else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight + 8;
  }, [pathname, leaving]);

  /* ---- Actions ----------------------------------------------------------------- */
  const openConversation = useCallback(
    (entry: ConversationEntry) => {
      try {
        navigate(activateConversation(entry));
      } catch (error) {
        toast.error(`Failed to open ${entry.title}: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );
  const openMenu = useCallback(() => {
    if (menuButton.current) openPeopleMenu({ element: menuButton.current, align: 'end' });
  }, []);

  const paneStyle = { '--ix-hue': PEOPLE_HUE } as CSSProperties;

  return (
    <div className="ix-sb ix-sb--people" style={paneStyle} data-ix-sidebar-pane="people">
      <div
        className="ix-sh"
        data-testid="ix-sidebar-header"
        onContextMenu={(event) => {
          event.preventDefault();
          openPeopleMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <div className="ix-ph__who">
          {data.me ? (
            <Avatar userId={data.me.id} name={data.me.name} avatar={data.me.avatar} size={40} />
          ) : (
            <span className="ix-ph__blank" aria-hidden="true" />
          )}
          <span className="ix-sh__text">
            <span className="ix-sh__name">People</span>
            <span className="ix-sh__line">Friends and direct messages</span>
          </span>
        </div>
        <button
          ref={menuButton}
          type="button"
          className="ix-sh__more"
          aria-label="People options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={openMenu}
        >
          <IxGlyph name="dots" size={16} />
        </button>
      </div>
      <button
        type="button"
        className="ix-search ix-search--plain"
        data-testid="ix-search-field"
        aria-haspopup="dialog"
        onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
      >
        <span className="ix-search__text">Search people</span>
      </button>
      <CardSlot place={PEOPLE_PLACE} position="inline" />
      <div ref={rowsRef} className="ix-sb__rows" onKeyDown={(event) => rovingKeyDown(rowsRef.current, event)}>
        <span ref={selection} className="ix-sel ix-hue-selected" data-on="false" aria-hidden="true" />
        <ul className="ix-sb__list ix-sb__list--utility" aria-label="Friends and inbox">
          <UtilityRow
            id="friends"
            name="Friends"
            line={friendsText}
            count={requests}
            countWords={requests > 0 ? requestsWords(requests) : null}
            href={FRIENDS_HREF}
            selected={open?.kind === 'friends'}
            leaving={leaving}
            onOpen={() => navigate(FRIENDS_HREF)}
            {...roving.focusOf('friends')}
          />
          <InboxRow
            summary={data.inbox}
            href={INBOX_HREF}
            selected={open?.kind === 'inbox'}
            leaving={leaving}
            onOpen={() => navigate(INBOX_HREF)}
            {...roving.focusOf('inbox')}
          />
        </ul>
        <section aria-labelledby="ix-sb-messages">
          <SidebarLabel
            id="ix-sb-messages"
            action={
              <button type="button" className="ix-sb__add" aria-label="New message" onClick={() => openDmPicker()}>
                <IxGlyph name="plus" size={14} />
              </button>
            }
          >
            Messages
          </SidebarLabel>
          {dmList.status === 'error' && data.dms.length === 0 && (
            <>
              <p className="ix-sb__note" role="alert">
                {`Could not load your conversations. ${dmList.error ?? ''}`.trim()}
              </p>
              <button type="button" className="ix-sb__retry" onClick={dmList.retry}>
                Try again
              </button>
            </>
          )}
          {dmList.status === 'loading' && data.dms.length === 0 && (
            <p className="ix-sb__note" role="status">
              Loading conversations…
            </p>
          )}
          {dmList.status === 'ready' && data.dms.length === 0 && (
            <>
              <p className="ix-sb__note">No conversations yet.</p>
              <button type="button" className="ix-sb__retry" onClick={() => openDmPicker()}>
                New message
              </button>
            </>
          )}
          {data.dms.length > 0 && (
            <ul className="ix-sb__list">
              {data.dms.map((entry) => (
                <DmRow
                  key={entry.key}
                  entry={entry}
                  href={`/app/dms/${entry.channelId}`}
                  selected={open?.kind === 'dm' && open.channelId === entry.channelId}
                  leaving={leaving}
                  nowMs={nowMs}
                  onOpen={() => openConversation(entry)}
                  {...roving.focusOf(`dm:${entry.key}`)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
