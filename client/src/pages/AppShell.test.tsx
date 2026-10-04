import { act, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useGlassStore } from '../stores/glassStore';
import { usePhoneNavStore } from '../components/glass/shell';
import { useIxPlaceStore } from '../components/ix/shell';
import { useMobile } from '../hooks/useMobile';
import { useSwipeGesture } from '../hooks/useSwipeGesture';

const fetchRelationshipsMock = vi.hoisted(() => vi.fn());
const toggleSheetMock = vi.hoisted(() => vi.fn());

// The slots have their own suites; this one asserts the frame wiring: which
// hosts exist, where each slot mounts, with what, and what is inert when.
vi.mock('../components/ix/sidebar', () => ({
  SidebarSlot: ({ place, leaving }: { place: { kind: string; guildId?: string }; leaving?: boolean }) => (
    <div data-testid="sidebar-slot" data-place={place.kind === 'people' ? 'people' : place.guildId} data-leaving={String(Boolean(leaving))} />
  ),
}));
vi.mock('../components/ix/dock', () => ({ DockSlot: () => <div data-testid="dock-slot" /> }));
vi.mock('../components/ix/card', () => ({
  CardSlot: ({ position, place }: { position: string; place: { kind: string; guildId?: string } }) => (
    <div data-testid={`card-slot-${position}`} data-place={place.kind === 'people' ? 'people' : place.guildId} />
  ),
}));
// The sheets slot mounts the Glass sheets until IX-9; the toolbar opens them through sheetStore.
vi.mock('../components/glass/sheets', () => ({
  Sheets: ({ guildId, channelId, layout }: { guildId: string | null; channelId: string | null; layout: string }) => (
    <div data-testid="sheets-slot" data-guild={guildId ?? ''} data-channel={channelId ?? ''} data-layout={layout} />
  ),
  toggleSheet: toggleSheetMock,
}));
// The call slot mounts the Glass stage until IX-13.
vi.mock('../components/glass/stage', () => ({
  Stage: ({ target, mode }: { target: { streamerId: string }; mode: string }) => (
    <div data-testid="stage-slot" data-mode={mode}>{target.streamerId}</div>
  ),
}));
vi.mock('../components/glass/shell/PhoneStageChrome', () => ({
  PhoneStageChrome: () => <div data-testid="phone-stage-chrome" />,
}));
vi.mock('../components/layout/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}));
vi.mock('../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: () => <div data-testid="confirm-dialog" />,
}));
vi.mock('../components/message/InteractionModal', () => ({
  InteractionModal: () => <div data-testid="interaction-modal-host" />,
}));
vi.mock('./SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));
vi.mock('./GuildSettingsPage', () => ({
  GuildSettingsPage: () => <div data-testid="guild-settings-page" />,
}));
vi.mock('../components/motion/MotionDirector', () => ({ MotionDirector: () => null }));
vi.mock('../components/voice/together/TogetherHost', () => ({ TogetherHost: () => null }));

// Side-effectful hooks that touch window/DOM — no-op them so the frame renders.
vi.mock('../hooks/useKeyboardNavigation', () => ({ useKeyboardNavigation: () => {} }));
vi.mock('../hooks/useSwipeGesture', () => ({ useSwipeGesture: vi.fn() }));
vi.mock('../hooks/useFocusTrap', () => ({ useFocusTrap: () => {} }));
vi.mock('../hooks/useMobile', () => ({
  useMobile: vi.fn(() => false),
  DEFAULT_MOBILE_MAX_WIDTH: 768,
}));
vi.mock('../stores/relationshipStore', () => ({
  useRelationshipStore: Object.assign(
    (selector: (state: { fetchRelationships: typeof fetchRelationshipsMock }) => unknown) =>
      selector({ fetchRelationships: fetchRelationshipsMock }),
    { getState: () => ({ fetchRelationships: fetchRelationshipsMock }) },
  ),
}));

const mockedUseMobile = vi.mocked(useMobile);
const mockedSwipe = vi.mocked(useSwipeGesture);

/** A phone: under the 768px breakpoint. */
function usePhoneWindow() {
  mockedUseMobile.mockReturnValue(true);
}

/** 768-1023: the sidebar narrows to 280; there is no overlay and no third mode. */
function useNarrowWindow() {
  mockedUseMobile.mockImplementation((maxWidth?: number) => maxWidth === 1024 || maxWidth === 860);
}

const frameOf = (container: HTMLElement) => container.querySelector('.ix-frame');
const frameScreen = (container: HTMLElement) => frameOf(container)?.getAttribute('data-screen');
const sidebarOf = () => screen.getByTestId('ix-sidebar');

const LOUNGE = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

function shellRoutes() {
  return (
    <Routes>
      <Route path="/app" element={<AppShell />}>
        <Route index element={<div data-testid="outlet-content">home body</div>} />
        <Route path="dms" element={<div data-testid="outlet-content">messages</div>} />
        <Route path="dms/:channelId" element={<div data-testid="outlet-content">dm body</div>} />
        <Route path="friends" element={<div data-testid="outlet-content">friends body</div>} />
        <Route path="admin" element={<div data-testid="outlet-content">admin body</div>} />
        <Route
          path="guilds/:guildId/channels/:channelId"
          element={
            <div data-testid="outlet-content">
              chat body <Link to="/app/guilds/g1/channels/c2">open clips</Link>{' '}
              <Link to="/app/guilds/g2/channels/c9">go to g2</Link> <Link to="/app/admin">open admin</Link>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}

function renderShell(initialPath = '/app') {
  return render(<MemoryRouter initialEntries={[initialPath]}>{shellRoutes()}</MemoryRouter>);
}

beforeEach(() => {
  fetchRelationshipsMock.mockReset();
  fetchRelationshipsMock.mockResolvedValue(undefined);
  toggleSheetMock.mockReset();
  mockedUseMobile.mockReset();
  mockedUseMobile.mockReturnValue(false);
  useUIStore.setState({
    contextPanelMode: null,
    sidebarCollapsed: false,
    userSettingsOpen: false,
    guildSettingsId: null,
  });
  useVoiceStore.setState({ connected: false, channelId: null, callId: null, callPhase: 'idle' });
  useGlassStore.getState().reset();
  usePhoneNavStore.getState().setScreen(null);
  useIxPlaceStore.setState({ last: { kind: 'people' } });
  mockedSwipe.mockClear();
});

describe('AppShell', () => {
  it('is two flush columns: the sidebar with its pinned card, panes and dock, and main with the toolbar and the page', () => {
    const { container } = renderShell('/app/guilds/g1/channels/c1');
    const frame = frameOf(container);
    expect(frame).toHaveAttribute('data-layout', 'wide');
    expect(frame).toHaveAttribute('data-stage', 'none');
    // The native underlay contract: the shell root and the frame clear for the video.
    expect(container.firstElementChild).toHaveAttribute('data-native-underlay-clear');
    expect(frame).toHaveAttribute('data-native-underlay-clear');

    const sidebar = sidebarOf();
    expect(sidebar.tagName).toBe('NAV');
    expect(sidebar.querySelector('.ix-side__pinned')).toContainElement(screen.getByTestId('card-slot-pinned'));
    expect(screen.getByTestId('card-slot-pinned')).toHaveAttribute('data-place', 'g1');
    // One pane, for the route's server.
    const panes = sidebar.querySelectorAll('.ix-pane');
    expect(panes).toHaveLength(1);
    expect(panes[0]).toContainElement(screen.getByTestId('sidebar-slot'));
    expect(screen.getByTestId('sidebar-slot')).toHaveAttribute('data-place', 'g1');
    expect(sidebar.querySelector('.ix-side__dock')).toContainElement(screen.getByTestId('dock-slot'));
    // The window tint: one layer behind each column, at rest.
    expect(sidebar.querySelectorAll('[data-ix-tint="side"]')).toHaveLength(1);

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toContainElement(screen.getByTestId('ix-toolbar'));
    expect(main).toContainElement(screen.getByTestId('outlet-content'));
    expect(main.querySelectorAll('[data-ix-tint="main"]')).toHaveLength(1);
    // Today's pages do not register with the toolbar: they start below it.
    expect(main).toHaveAttribute('data-page', 'legacy');
    expect(main).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('inert');

    // Persistent chrome is always mounted.
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main-content');
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('interaction-modal-host')).toBeInTheDocument();
  });

  it('retires room light, the Glass panes and the compact overlay', () => {
    const { container } = renderShell('/app/guilds/g1/channels/c1');
    expect(container.querySelector('.glass-room-backdrop')).toBeNull();
    expect(container.querySelector('.glass-frame')).toBeNull();
    expect(container.querySelector('.glass-morph')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show places' })).not.toBeInTheDocument();
  });

  it('under 1024px narrows the sidebar and keeps it a column: no overlay, no third mode', () => {
    useNarrowWindow();
    const { container } = renderShell('/app/guilds/g1/channels/c1');
    expect(frameOf(container)).toHaveAttribute('data-layout', 'narrow');
    expect(sidebarOf()).toContainElement(screen.getByTestId('sidebar-slot'));
    expect(screen.queryByRole('dialog', { name: 'Places' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show places' })).not.toBeInTheDocument();
  });

  it('shows the route\'s place, and keeps the last one on a route that belongs to none', () => {
    renderShell('/app/guilds/g1/channels/c1');
    expect(screen.getByTestId('sidebar-slot')).toHaveAttribute('data-place', 'g1');

    act(() => screen.getByRole('link', { name: 'open admin' }).click());
    expect(screen.getByTestId('outlet-content')).toHaveTextContent('admin body');
    expect(screen.getByTestId('sidebar-slot')).toHaveAttribute('data-place', 'g1');
  });

  it('DMs and Friends are the People place', () => {
    renderShell('/app/dms/d1');
    expect(screen.getByTestId('sidebar-slot')).toHaveAttribute('data-place', 'people');
    expect(sidebarOf()).toHaveAttribute('aria-label', 'People');
  });

  it('switching place replaces the pane (the slide itself is SidebarPanes\' suite); a channel in the same place keeps it', () => {
    renderShell('/app/guilds/g1/channels/c1');
    const pane = sidebarOf().querySelector('.ix-pane');
    act(() => screen.getByRole('link', { name: 'open clips' }).click());
    expect(sidebarOf().querySelector('.ix-pane')).toBe(pane);

    act(() => screen.getByRole('link', { name: 'go to g2' }).click());
    // jsdom plays no animation, so the slide settles at once: one pane, the new place.
    const panes = sidebarOf().querySelectorAll('.ix-pane');
    expect(panes).toHaveLength(1);
    expect(panes[0]).toHaveAttribute('data-place', 'g2');
    expect(screen.getByTestId('card-slot-pinned')).toHaveAttribute('data-place', 'g2');
  });

  it('mounts the sheets slot inside main with the route it is over, beside the sheet host', () => {
    renderShell('/app/guilds/g1/channels/c1');
    const main = screen.getByRole('main');
    const slot = screen.getByTestId('sheets-slot');
    expect(main).toContainElement(slot);
    expect(slot).toHaveAttribute('data-guild', 'g1');
    expect(slot).toHaveAttribute('data-channel', 'c1');
    expect(slot).toHaveAttribute('data-layout', 'wide');
    const host = main.querySelector('#ix-sheet-host');
    expect(host).toHaveClass('ix-sheet-host');
    expect(host).not.toHaveAttribute('data-sheet');
    act(() => useGlassStore.getState().openSheet('search'));
    expect(host).toHaveAttribute('data-sheet', 'search');
  });

  it('the toolbar opens message search, the people sheet and the account menu', () => {
    renderShell('/app/guilds/g1/channels/c1');
    const toolbar = screen.getByTestId('ix-toolbar');
    act(() => (toolbar.querySelector('[aria-label="Search messages"]') as HTMLButtonElement).click());
    expect(toggleSheetMock).toHaveBeenLastCalledWith('search');
    act(() => (toolbar.querySelector('[aria-label="Members"]') as HTMLButtonElement).click());
    expect(toggleSheetMock).toHaveBeenLastCalledWith('people');
  });

  it('puts the call over main at inset 10 and makes main inert; theater covers the sidebar too', () => {
    const { container } = renderShell('/app/guilds/g1/channels/c1');
    const host = container.querySelector('#ix-call-host');
    expect(host).toBeEmptyDOMElement();

    act(() => useGlassStore.getState().openStage(LOUNGE));
    expect(frameOf(container)).toHaveAttribute('data-stage', 'side');
    const surface = screen.getByRole('region', { name: 'Call' });
    expect(host).toContainElement(surface);
    expect(surface).toHaveClass('ix-inset-surface');
    expect(surface).toContainElement(screen.getByTestId('stage-slot'));
    expect(screen.getByTestId('stage-slot')).toHaveTextContent('vincent');
    expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('inert');
    expect(sidebarOf()).not.toHaveAttribute('inert');
    // Still mounted under it: a draft or a scroll position survives the call view.
    expect(screen.getByTestId('outlet-content')).toBeInTheDocument();

    act(() => useGlassStore.getState().setStageMode('theater'));
    expect(frameOf(container)).toHaveAttribute('data-stage', 'theater');
    expect(sidebarOf()).toHaveAttribute('inert');

    act(() => useGlassStore.getState().closeStage());
    expect(host).toBeEmptyDOMElement();
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    expect(sidebarOf()).not.toHaveAttribute('inert');
  });

  describe('on a phone', () => {
    beforeEach(usePhoneWindow);

    it('is two screens: the sidebar is the root, main is pushed over it', () => {
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      const frame = frameOf(container);
      expect(frame).toHaveAttribute('data-layout', 'phone');
      // A deep link opens on its page, with the sidebar behind it.
      expect(frameScreen(container)).toBe('conversation');
      expect(screen.getByRole('main')).toHaveAttribute('data-active', 'true');
      expect(sidebarOf()).toHaveAttribute('inert');
      expect(sidebarOf()).not.toHaveAttribute('data-active');
      expect(sidebarOf()).toContainElement(screen.getByTestId('dock-slot'));
      expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
    });

    it('opens the messages index on the root', () => {
      const { container } = renderShell('/app/dms');
      expect(frameScreen(container)).toBe('places');
      expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('inert');
    });

    it('a pick in the same place pushes main; a move to another place stays on the root', () => {
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      act(() => usePhoneNavStore.getState().showPlaces());
      act(() => screen.getByRole('link', { name: 'open clips', hidden: true }).click());
      expect(frameScreen(container)).toBe('conversation');

      act(() => usePhoneNavStore.getState().showPlaces());
      act(() => screen.getByRole('link', { name: 'go to g2', hidden: true }).click());
      expect(frameScreen(container)).toBe('places');
      expect(screen.getByTestId('sidebar-slot')).toHaveAttribute('data-place', 'g2');
    });

    it('the toolbar\'s back goes to the root', () => {
      const { container } = renderShell('/app/friends');
      act(() => usePhoneNavStore.getState().showConversation());
      act(() => screen.getByRole('button', { name: 'Back to the sidebar' }).click());
      expect(frameScreen(container)).toBe('places');
    });

    it('keeps the old drawer flag collapsed, and turns a request to open it into the root screen', () => {
      useUIStore.setState({ sidebarCollapsed: false });
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
      expect(frameScreen(container)).toBe('conversation');

      act(() => useUIStore.getState().setSidebarCollapsed(false));
      expect(frameScreen(container)).toBe('places');
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });

    it('turns the edge swipe on for a pushed page, and off for everything that owns the edge', () => {
      renderShell('/app/guilds/g1/channels/c1');
      const enabled = () => mockedSwipe.mock.calls.at(-1)?.[1];
      expect(enabled()).toBe(true);

      act(() => usePhoneNavStore.getState().showPlaces());
      expect(enabled()).toBe(false);
      act(() => usePhoneNavStore.getState().showConversation());
      expect(enabled()).toBe(true);

      act(() => useGlassStore.getState().openSheet('search'));
      expect(enabled()).toBe(false);
      act(() => useGlassStore.getState().closeSheet());
      expect(enabled()).toBe(true);

      act(() => useGlassStore.getState().openStage(LOUNGE, 'theater'));
      expect(enabled()).toBe(false);
      act(() => useGlassStore.getState().closeStage());
      expect(enabled()).toBe(true);

      act(() => useUIStore.setState({ userSettingsOpen: true }));
      expect(enabled()).toBe(false);
    });

    it('the swipe goes back to the root', () => {
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      const handlers = mockedSwipe.mock.calls.at(-1)?.[0];
      act(() => handlers?.onSwipeRight?.());
      expect(frameScreen(container)).toBe('places');
    });

    it('draws the call over the whole screen with the phone\'s chrome; both screens go inert under it', () => {
      renderShell('/app/guilds/g1/channels/c1');
      act(() => useGlassStore.getState().openStage(LOUNGE));
      const surface = screen.getByRole('region', { name: 'Call' });
      expect(surface).toContainElement(screen.getByTestId('stage-slot'));
      expect(surface).toContainElement(screen.getByTestId('phone-stage-chrome'));
      expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('inert');
      expect(sidebarOf()).toHaveAttribute('inert');
    });

    it('the skip link brings main in when the root is in front', () => {
      renderShell('/app/dms');
      expect(usePhoneNavStore.getState().screen).toBe('places');
      act(() => screen.getByRole('link', { name: 'Skip to content' }).click());
      expect(usePhoneNavStore.getState().screen).toBe('conversation');
    });
  });

  it('opens the user and guild settings overlays from uiStore flags', () => {
    useUIStore.setState({ userSettingsOpen: true });
    const { rerender } = renderShell();
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();

    act(() => useUIStore.setState({ userSettingsOpen: false, guildSettingsId: 'g1' }));
    rerender(<MemoryRouter initialEntries={['/app']}>{shellRoutes()}</MemoryRouter>);
    expect(screen.getByTestId('guild-settings-page')).toBeInTheDocument();
  });
});
