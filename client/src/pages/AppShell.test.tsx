import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useMobile } from '../hooks/useMobile';

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

const mockedUseMobile = vi.mocked(useMobile);

function renderShell(initialPath = '/app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<div data-testid="outlet-content">home body</div>} />
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
  });

  it('renders the ContextPanel only when contextPanelMode is set', () => {
    const { rerender } = renderShell();
    expect(screen.queryByTestId('context-panel')).not.toBeInTheDocument();

    act(() => useUIStore.setState({ contextPanelMode: 'members' }));
    rerender(
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route path="/app" element={<AppShell />}>
            <Route index element={<div data-testid="outlet-content">home body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('context-panel')).toBeInTheDocument();
  });

  it('mounts the mobile MiniVoiceBar dock when mobile + connected off the voice channel page', () => {
    mockedUseMobile.mockReturnValue(true);
    useUIStore.setState({ sidebarCollapsed: true });
    useVoiceStore.setState({ connected: true, channelId: '999' });

    renderShell('/app');

    expect(screen.getByTestId('mini-voice-bar')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bottom-nav')).toBeInTheDocument();
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
