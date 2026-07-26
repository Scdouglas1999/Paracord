import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useMobile } from '../hooks/useMobile';

const fetchRelationshipsMock = vi.hoisted(() => vi.fn());

// Heavy children are stubbed — this suite asserts the frame wiring (which surfaces
// mount, and under which conditions), not the internals of the sidebar/panels.
vi.mock('../components/layout/sidebar/UnifiedSidebar', () => ({
  UnifiedSidebar: () => <div data-testid="unified-sidebar" />,
}));
vi.mock('../components/layout/ContextPanel', () => ({
  ContextPanel: () => <div data-testid="context-panel" />,
}));
vi.mock('../components/voice/MiniVoiceBar', () => ({
  MiniVoiceBar: () => <div data-testid="mini-voice-bar" />,
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
});

describe('AppShell', () => {
  it('renders the Unified Sidebar and the routed page body in the Outlet', () => {
    renderShell();
    expect(screen.getByTestId('unified-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('outlet-content')).toHaveTextContent('home body');
    // Persistent chrome is always mounted.
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('interaction-modal-host')).toBeInTheDocument();
  });

  it('renders the ContextPanel only when contextPanelMode is set', () => {
    const { rerender } = renderShell('/app/guilds/g1/channels/c1');
    expect(screen.queryByTestId('context-panel')).not.toBeInTheDocument();

    act(() => useUIStore.setState({ contextPanelMode: 'members' }));
    rerender(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}>
        <Routes>
          <Route path="/app" element={<AppShell />}>
            <Route
              path="guilds/:guildId/channels/:channelId"
              element={<div data-testid="outlet-content">chat body</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('context-panel')).toBeInTheDocument();
  });

  it('clears an incompatible context panel mode instead of showing an empty panel', async () => {
    useUIStore.setState({ contextPanelMode: 'economy' });

    renderShell('/app/dms/dm-1');

    expect(screen.queryByTestId('context-panel')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(useUIStore.getState().contextPanelMode).toBeNull();
    });
  });

  it('collapses the mobile sidebar overlay after route entry', async () => {
    mockedUseMobile.mockReturnValue(true);
    useUIStore.setState({ sidebarCollapsed: false });

    renderShell('/app/guilds/g1/channels/c1');

    await waitFor(() => {
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });
  });

  it('mounts the mobile MiniVoiceBar dock when mobile + connected off the voice channel page', () => {
    mockedUseMobile.mockReturnValue(true);
    useUIStore.setState({ sidebarCollapsed: true });
    useVoiceStore.setState({ connected: true, channelId: '999' });

    renderShell('/app');

    expect(screen.getByTestId('mini-voice-bar')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bottom-nav')).toBeInTheDocument();
  });

  it('never mounts the AppShell MiniVoiceBar dock on desktop (the sidebar CallDock is the sole persistent call surface)', () => {
    // CHAT-4 invariant: on desktop the persistent call dock lives in the
    // UnifiedSidebar footer (CallDock). The AppShell-level MiniVoiceBar is a
    // MOBILE-only dock, so it must stay unmounted on desktop even while
    // connected — otherwise two persistent voice bars would show at once.
    mockedUseMobile.mockReturnValue(false);
    useVoiceStore.setState({ connected: true, channelId: '999' });

    renderShell('/app');

    expect(screen.queryByTestId('mini-voice-bar')).not.toBeInTheDocument();
  });

  it('does not mount the mobile MiniVoiceBar dock while viewing the active voice channel page', () => {
    mockedUseMobile.mockReturnValue(true);
    useUIStore.setState({ sidebarCollapsed: true });
    useVoiceStore.setState({ connected: true, channelId: 'c1' });

    renderShell('/app/guilds/g1/channels/c1');

    expect(screen.queryByTestId('mini-voice-bar')).not.toBeInTheDocument();
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
