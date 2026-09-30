import { act, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useGlassStore } from '../stores/glassStore';
import { useMobile } from '../hooks/useMobile';

const fetchRelationshipsMock = vi.hoisted(() => vi.fn());

// Heavy children are stubbed — this suite asserts the frame wiring (which surfaces
// mount, and under which conditions), not the internals of the sidebar/panels.
vi.mock('../components/glass/places', () => ({ PlacesPanel: () => <div data-testid="places-panel" /> }));
vi.mock('../components/layout/sidebar/UnifiedSidebar', () => ({
  UnifiedSidebar: () => <div data-testid="unified-sidebar" />,
}));
// The sheets slot renders through a portal into the conversation pane; what the
// shell owes it is a mount after the pane and the route's ids (its own suite
// holds what it does with them).
vi.mock('../components/glass/sheets', () => ({
  Sheets: ({ guildId, channelId, layout }: { guildId: string | null; channelId: string | null; layout: string }) => (
    <div data-testid="sheets-slot" data-guild={guildId ?? ''} data-channel={channelId ?? ''} data-layout={layout} />
  ),
}));
vi.mock('../components/voice/OnAirDock', () => ({
  OnAirDock: () => <div data-testid="on-air-dock" />,
}));
vi.mock('../components/layout/MobileBottomNav', () => ({
  MobileBottomNav: () => <div data-testid="mobile-bottom-nav" />,
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
vi.mock('../components/voice/StreamViewer', () => ({
  StreamViewer: ({ streamerId }: { streamerId: string }) => <div data-testid="stream-viewer">{streamerId}</div>,
}));
vi.mock('../components/onboarding/LayoutTour', () => ({ LayoutTour: () => null }));
vi.mock('../components/motion/MotionDirector', () => ({ MotionDirector: () => null }));
vi.mock('../components/voice/together/TogetherHost', () => ({ TogetherHost: () => null }));

// Side-effectful hooks that touch window/DOM — no-op them so the frame renders.
vi.mock('../hooks/useKeyboardNavigation', () => ({ useKeyboardNavigation: () => {} }));
vi.mock('../hooks/useSwipeGesture', () => ({ useSwipeGesture: () => {} }));
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

/** The compact frame: under the 860px places breakpoint, above a phone. */
function useCompactWindow() {
  mockedUseMobile.mockImplementation((maxWidth?: number) => maxWidth === 860);
}

const LOUNGE = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

function renderShell(initialPath = '/app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<div data-testid="outlet-content">home body</div>} />
          <Route path="dms/:channelId" element={<div data-testid="outlet-content">dm body</div>} />
          <Route
            path="guilds/:guildId/channels/:channelId"
            element={<div data-testid="outlet-content">chat body</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchRelationshipsMock.mockReset();
  fetchRelationshipsMock.mockResolvedValue(undefined);
  mockedUseMobile.mockReturnValue(false);
  useUIStore.setState({
    contextPanelMode: null,
    sidebarCollapsed: false,
    userSettingsOpen: false,
    guildSettingsId: null,
  });
  useVoiceStore.setState({ connected: false, channelId: null });
  useGlassStore.getState().reset();
});

describe('AppShell', () => {
  it('floats the places pane and the conversation pane on the room, with the page in the conversation', () => {
    const { container } = renderShell();
    expect(container.querySelector('.glass-room-backdrop')).not.toBeNull();

    const frame = container.querySelector('.glass-frame');
    expect(frame).toHaveAttribute('data-layout', 'wide');
    expect(frame).toHaveAttribute('data-stage', 'none');

    const places = container.querySelector('.glass-frame__places');
    expect(places).toHaveClass('glass-pane');
    expect(places).toContainElement(screen.getByTestId('places-panel'));

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveClass('glass-pane', 'glass-frame__conversation');
    expect(main).toContainElement(screen.getByTestId('outlet-content'));
    expect(screen.getByTestId('outlet-content')).toHaveTextContent('home body');

    // Persistent chrome is always mounted.
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main-content');
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('interaction-modal-host')).toBeInTheDocument();
    // The phone's bar and drawer are not part of the wide frame, and places
    // is a pane there, so there is nothing to open it with.
    expect(screen.queryByTestId('mobile-bottom-nav')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show places' })).not.toBeInTheDocument();
  });

  it('keeps places out of the compact frame and opens it as an overlay that a route change closes', async () => {
    useCompactWindow();
    const { container } = render(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}>
        <Routes>
          <Route path="/app" element={<AppShell />}>
            <Route path="dms/:channelId" element={<div data-testid="outlet-content">dm body</div>} />
            <Route
              path="guilds/:guildId/channels/:channelId"
              element={<Link to="/app/dms/d1">open a DM</Link>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(container.querySelector('.glass-frame')).toHaveAttribute('data-layout', 'compact');
    expect(container.querySelector('.glass-frame__places')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Places' })).not.toBeInTheDocument();

    // A page without a conversation header still gets the places button.
    act(() => screen.getByRole('button', { name: 'Show places' }).click());
    expect(useGlassStore.getState().placesOverlayOpen).toBe(true);
    const overlay = screen.getByRole('dialog', { name: 'Places' });
    expect(overlay).toContainElement(screen.getByTestId('places-panel'));

    // Picking somewhere to go closes the overlay.
    act(() => screen.getByRole('link', { name: 'open a DM' }).click());
    expect(screen.getByTestId('outlet-content')).toHaveTextContent('dm body');
    await waitFor(() => expect(useGlassStore.getState().placesOverlayOpen).toBe(false));
  });

  it('closes the places overlay when the window grows past the compact frame', async () => {
    useCompactWindow();
    const view = renderShell();
    act(() => useGlassStore.getState().setPlacesOverlayOpen(true));
    expect(useGlassStore.getState().placesOverlayOpen).toBe(true);

    mockedUseMobile.mockImplementation(() => false);
    view.rerender(
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route path="/app" element={<AppShell />}>
            <Route index element={<div data-testid="outlet-content">home body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(useGlassStore.getState().placesOverlayOpen).toBe(false));
  });

  it('puts the stage beside the conversation, and steps the conversation aside while browsing', () => {
    const { container } = renderShell('/app/guilds/g1/channels/c1');
    act(() => useGlassStore.getState().openStage(LOUNGE));

    const frame = container.querySelector('.glass-frame');
    expect(frame).toHaveAttribute('data-stage', 'side');
    expect(screen.getByRole('region', { name: 'Stage' })).toContainElement(screen.getByTestId('stream-viewer'));
    expect(screen.getByTestId('stream-viewer')).toHaveTextContent('vincent');
    // Side by side: no places pane, the conversation stays and keeps working.
    expect(container.querySelector('.glass-frame__places')).toBeNull();
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');

    act(() => useGlassStore.getState().toggleBrowse());
    expect(container.querySelector('.glass-frame__places')).toHaveAttribute('data-presentation', 'browse');
    const main = container.querySelector('#main-content');
    expect(main).toHaveAttribute('data-away', 'true');
    expect(main).toHaveAttribute('inert');
    // Still mounted: a draft or a scroll position survives browsing.
    expect(screen.getByTestId('outlet-content')).toBeInTheDocument();

    act(() => useGlassStore.getState().closeStage());
    expect(screen.queryByRole('region', { name: 'Stage' })).not.toBeInTheDocument();
    expect(container.querySelector('.glass-frame__places')).toHaveAttribute('data-presentation', 'pane');
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  });

  it('hides the conversation in theater only when the chat is hidden', () => {
    const { container } = renderShell('/app/guilds/g1/channels/c1');
    act(() => useGlassStore.getState().openStage(LOUNGE, 'theater'));
    expect(container.querySelector('.glass-frame')).toHaveAttribute('data-stage', 'theater');
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');

    act(() => useGlassStore.getState().toggleChatHidden());
    expect(container.querySelector('#main-content')).toHaveAttribute('inert');
    expect(container.querySelector('.glass-frame')).toHaveAttribute('data-chat-hidden', 'true');
  });

  it('mounts the sheets slot after the conversation pane, with the route it is over', () => {
    const { container } = renderShell('/app/guilds/g1/channels/c1');

    const slot = screen.getByTestId('sheets-slot');
    expect(slot).toHaveAttribute('data-guild', 'g1');
    expect(slot).toHaveAttribute('data-channel', 'c1');
    expect(slot).toHaveAttribute('data-layout', 'wide');
    // A sibling after the pane, not inside it: the slot portals into the pane itself.
    expect(container.querySelector('#main-content')).not.toContainElement(slot);
    expect(container.querySelector('#main-content')?.compareDocumentPosition(slot)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('collapses the mobile sidebar overlay after route entry', async () => {
    mockedUseMobile.mockReturnValue(true);
    useUIStore.setState({ sidebarCollapsed: false });

    renderShell('/app/guilds/g1/channels/c1');

    await waitFor(() => {
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });
  });

  it('mounts the mobile on-air dock when mobile + connected off the voice channel page', () => {
    mockedUseMobile.mockReturnValue(true);
    useUIStore.setState({ sidebarCollapsed: true });
    useVoiceStore.setState({ connected: true, channelId: '999' });

    renderShell('/app');

    expect(screen.getByTestId('on-air-dock')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bottom-nav')).toBeInTheDocument();
  });

  it('never mounts the AppShell on-air dock on desktop (the sidebar CallDock is the sole persistent call surface)', () => {
    // CHAT-4 invariant: on desktop the persistent call dock lives in the
    // UnifiedSidebar footer (CallDock). The AppShell-level on-air dock is a
    // MOBILE-only dock, so it must stay unmounted on desktop even while
    // connected — otherwise two persistent on-air pills would show at once.
    mockedUseMobile.mockReturnValue(false);
    useVoiceStore.setState({ connected: true, channelId: '999' });

    renderShell('/app');

    expect(screen.queryByTestId('on-air-dock')).not.toBeInTheDocument();
  });

  it('does not mount the mobile on-air dock while viewing the active voice channel page', () => {
    mockedUseMobile.mockReturnValue(true);
    useUIStore.setState({ sidebarCollapsed: true });
    useVoiceStore.setState({ connected: true, channelId: 'c1' });

    renderShell('/app/guilds/g1/channels/c1');

    expect(screen.queryByTestId('on-air-dock')).not.toBeInTheDocument();
  });

  it('opens the user and guild settings overlays from uiStore flags', () => {
    useUIStore.setState({ userSettingsOpen: true });
    const { rerender } = renderShell();
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();

    act(() => useUIStore.setState({ userSettingsOpen: false, guildSettingsId: 'g1' }));
    rerender(
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route path="/app" element={<AppShell />}>
            <Route index element={<div data-testid="outlet-content">home body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('guild-settings-page')).toBeInTheDocument();
  });
});
