import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlassStore } from '../../../stores/glassStore';
import { useUIStore } from '../../../stores/uiStore';
import type { GlassLayout } from '../shell/useGlassLayout';
import { Sheets } from './Sheets';
import { closeSheets, openChannelSheet, openReminders, toggleSheet, useSheetPages } from './sheetStore';

/**
 * The sheets slot: which sheet is on screen, and the rules around it. The sheets
 * themselves are stubbed to markers here (each has its own suite); this holds
 * that the slot renders `glassStore.sheet`, answers the older `contextPanelMode`
 * requests, and puts a sheet away when the conversation under it changes.
 */

vi.mock('../../layout/overlays/SearchOverlay', () => ({
  SearchOverlay: (props: { open: boolean; guildId?: string | null; channelId?: string; channelName?: string }) => (
    <div data-testid="search" data-open={String(props.open)} data-guild={props.guildId ?? ''} data-channel={props.channelId ?? ''} data-name={props.channelName ?? ''} />
  ),
}));
vi.mock('./PeopleSheet', () => ({
  PeopleSheet: (props: { open: boolean }) => <div data-testid="people" data-open={String(props.open)} />,
}));
vi.mock('./ChannelSheet', () => ({
  ChannelSheet: (props: { open: boolean }) => {
    const page = useSheetPages((s) => s.channelPage);
    return <div data-testid="channel" data-open={String(props.open)} data-page={page ?? ''} />;
  },
}));
vi.mock('./RemindersSheet', () => ({
  RemindersSheet: (props: { open: boolean }) => <div data-testid="reminders" data-open={String(props.open)} />,
}));
vi.mock('../../../hooks/useChannels', () => ({
  useCurrentChannelStore: (selector: (view: unknown) => unknown) =>
    selector({ channelsById: { c1: { id: 'c1', name: 'General' }, c2: { id: 'c2', name: 'Clips' } } }),
}));

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function Goto({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>go</button>;
}

function renderSheets({
  guildId = 'g1',
  channelId = 'c1',
  layout = 'wide',
  path = '/app/guilds/g1/channels/c1',
  state,
}: { guildId?: string | null; channelId?: string | null; layout?: GlassLayout; path?: string; state?: unknown } = {}) {
  const ui = (g: string | null, c: string | null, l: GlassLayout) => (
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <Sheets guildId={g} channelId={c} layout={l} />
              <Probe />
              <Goto to="/app/guilds/g1/channels/c2" />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>
  );
  const view = render(ui(guildId, channelId, layout));
  return { ...view, again: (g: string | null, c: string | null, l: GlassLayout = layout) => view.rerender(ui(g, c, l)) };
}

const isOpen = (id: string) => screen.queryByTestId(id)?.getAttribute('data-open') === 'true';

beforeEach(() => {
  useGlassStore.getState().reset();
  useSheetPages.getState().reset();
  useUIStore.setState({ contextPanelMode: null, sidebarCollapsed: false });
});

describe('Sheets', () => {
  it('renders nothing while no sheet is open', () => {
    renderSheets();
    expect(screen.queryByTestId('search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('people')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reminders')).not.toBeInTheDocument();
  });

  it('renders the sheet glassStore names, over the channel it is asked about', () => {
    renderSheets();
    act(() => toggleSheet('search'));
    expect(isOpen('search')).toBe(true);
    expect(screen.getByTestId('search')).toHaveAttribute('data-guild', 'g1');
    expect(screen.getByTestId('search')).toHaveAttribute('data-channel', 'c1');
    expect(screen.getByTestId('search')).toHaveAttribute('data-name', 'General');

    act(() => toggleSheet('people'));
    expect(isOpen('people')).toBe(true);
    expect(isOpen('search')).toBe(false);
  });

  it('keeps rendering a sheet for its leave, then drops it', async () => {
    renderSheets();
    act(() => toggleSheet('search'));
    act(() => closeSheets());
    // Still mounted, told it is closed, so it can play its leave.
    expect(isOpen('search')).toBe(false);
    expect(screen.getByTestId('search')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('search')).not.toBeInTheDocument());
  });

  it('shows a page of the channel sheet', () => {
    renderSheets();
    act(() => openChannelSheet('media'));
    expect(isOpen('channel')).toBe(true);
    expect(screen.getByTestId('channel')).toHaveAttribute('data-page', 'media');
  });

  it('shows the account menu\'s one page, Reminders, as a sheet; the menu itself is the menu host\'s', () => {
    renderSheets();
    act(() => useGlassStore.getState().openSheet('account'));
    // Nothing here: the account menu is a popover (components/ix/menus), not a sheet.
    expect(screen.queryByTestId('reminders')).not.toBeInTheDocument();

    act(() => openReminders());
    expect(isOpen('reminders')).toBe(true);
  });
});

describe('a request made the old way', () => {
  it.each([
    ['search', 'search', ''],
    ['recipients', 'people', ''],
    ['pins', 'channel', 'pins'],
    ['threads', 'channel', 'threads'],
    ['media', 'channel', 'media'],
    ['economy', 'channel', 'leaderboard'],
  ] as const)('contextPanelMode %s opens the %s sheet, and clears the request', async (mode, testId, page) => {
    renderSheets();
    act(() => useUIStore.getState().setContextPanelMode(mode));
    await waitFor(() => expect(isOpen(testId)).toBe(true));
    if (page) expect(screen.getByTestId('channel')).toHaveAttribute('data-page', page);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('opens search once the server is in the URL, for the command palette, then drops the flag', async () => {
    renderSheets({ path: '/app/guilds/g1', state: { openSearch: true }, channelId: null });
    await waitFor(() => expect(isOpen('search')).toBe(true));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/g1');
  });

  it('waits for the server id before opening search for the palette', () => {
    renderSheets({ path: '/app', state: { openSearch: true }, guildId: null, channelId: null });
    expect(screen.queryByTestId('search')).not.toBeInTheDocument();
  });
});

describe('the conversation under a sheet', () => {
  it('puts the sheet away when another conversation is picked', () => {
    const view = renderSheets();
    act(() => toggleSheet('search'));
    expect(isOpen('search')).toBe(true);
    view.again('g1', 'c2');
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('keeps a sheet open when the same conversation re-renders', () => {
    const view = renderSheets();
    act(() => toggleSheet('people'));
    view.again('g1', 'c1');
    expect(useGlassStore.getState().sheet).toBe('people');
  });

  it('has nothing to cover on a page with no server or conversation, so it closes', () => {
    renderSheets({ guildId: null, channelId: null, path: '/app' });
    act(() => toggleSheet('search'));
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('still opens the account menu where there is no conversation (Home)', () => {
    renderSheets({ guildId: null, channelId: null, path: '/app' });
    act(() => useGlassStore.getState().openSheet('account'));
    expect(useGlassStore.getState().sheet).toBe('account');
  });
});

describe('the phone', () => {
  it('folds the navigation drawer away, so a full-screen sheet is never under it', () => {
    useUIStore.setState({ sidebarCollapsed: false });
    renderSheets({ layout: 'phone' });
    act(() => toggleSheet('search'));
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('leaves the drawer alone on a wide window', () => {
    renderSheets({ layout: 'wide' });
    act(() => toggleSheet('search'));
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe('focus', () => {
  it('goes back to the control that opened the sheet, when the sheet closes', async () => {
    renderSheets();
    const opener = document.createElement('button');
    opener.className = 'ix-toolbar__title';
    document.body.appendChild(opener);
    act(() => toggleSheet('channel'));
    act(() => closeSheets());
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});
