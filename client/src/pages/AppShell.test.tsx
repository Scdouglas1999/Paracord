import { act, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useGlassStore } from '../stores/glassStore';
import { usePhoneNavStore } from '../components/glass/shell';
import { useMobile } from '../hooks/useMobile';
import { useSwipeGesture } from '../hooks/useSwipeGesture';

const fetchRelationshipsMock = vi.hoisted(() => vi.fn());

// Heavy children are stubbed — this suite asserts the frame wiring (which surfaces
// mount, and under which conditions), not the internals of the sidebar/panels.
vi.mock('../components/glass/places', () => ({ PlacesPanel: () => <div data-testid="places-panel" /> }));
// The phone's places screen holds your face (the account menu) above the panel.
vi.mock('../components/glass/conversation/HeaderAvatar', () => ({
  HeaderAvatar: () => <button type="button">Your profile</button>,
}));
// What the phone draws over the stream has its own suite.
vi.mock('../components/glass/shell/PhoneStageChrome', () => ({
  PhoneStageChrome: () => <div data-testid="phone-stage-chrome" />,
}));
// The sheets slot renders through a portal into the conversation pane; what the
// shell owes it is a mount after the pane and the route's ids (its own suite
// holds what it does with them).
vi.mock('../components/glass/sheets', () => ({
  Sheets: ({ guildId, channelId, layout }: { guildId: string | null; channelId: string | null; layout: string }) => (
    <div data-testid="sheets-slot" data-guild={guildId ?? ''} data-channel={channelId ?? ''} data-layout={layout} />
  ),
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
// The stage slot (WP-G14) has its own suite; the shell only has to mount it with the target and mode.
vi.mock('../components/glass/stage', () => ({
  Stage: ({ target, mode }: { target: { streamerId: string }; mode: string }) => (
    <div data-testid="stage-slot" data-mode={mode}>{target.streamerId}</div>
  ),
}));
vi.mock('../components/onboarding/LayoutTour', () => ({ LayoutTour: () => null }));
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

/** The compact frame: under the 860px places breakpoint, above a phone. */
function useCompactWindow() {
  mockedUseMobile.mockImplementation((maxWidth?: number) => maxWidth === 860);
}

/** Which screen the phone frame says is in front. */
const frameScreen = (container: HTMLElement) =>
  container.querySelector('.glass-frame')?.getAttribute('data-screen');

const LOUNGE = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

function renderShell(initialPath = '/app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<div data-testid="outlet-content">home body</div>} />
          <Route path="dms/:channelId" element={<div data-testid="outlet-content">dm body</div>} />
          <Route path="friends" element={<div data-testid="outlet-content">friends body</div>} />
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
  useVoiceStore.setState({ connected: false, channelId: null, callId: null, callPhase: 'idle' });
  useGlassStore.getState().reset();
  usePhoneNavStore.getState().setScreen(null);
  mockedSwipe.mockClear();
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
    // The phone's screens are not part of the wide frame, and places is a pane
    // there, so there is nothing to open it with.
    expect(container.querySelector('.glass-phone__screen')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show places' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to places' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('region', { name: 'Stage' })).toContainElement(screen.getByTestId('stage-slot'));
    expect(screen.getByTestId('stage-slot')).toHaveTextContent('vincent');
    expect(screen.getByTestId('stage-slot')).toHaveAttribute('data-mode', 'side');
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

  it('theater browsing floats places and puts the chat aside; a pick closes it and brings the chat back', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}>
        <Routes>
          <Route path="/app" element={<AppShell />}>
            <Route
              path="guilds/:guildId/channels/:channelId"
              element={<Link to="/app/guilds/g1/channels/c2">open Clips</Link>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    act(() => useGlassStore.getState().openStage(LOUNGE, 'theater'));
    act(() => useGlassStore.getState().toggleChatHidden());
    act(() => useGlassStore.getState().toggleBrowse());
    expect(container.querySelector('.glass-frame__places')).toHaveAttribute('data-presentation', 'browse');
    expect(container.querySelector('#main-content')).toHaveAttribute('data-away', 'true');

    act(() => screen.getByRole('link', { name: 'open Clips' }).click());
    await waitFor(() => expect(useGlassStore.getState().browseOpen).toBe(false));
    expect(useGlassStore.getState().chatHidden).toBe(false);
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    expect(container.querySelector('.glass-frame__places')).toBeNull();
    expect(container.querySelector('#main-content')).not.toHaveAttribute('data-away');
  });

  it('frames the moves: two empty morph layers around the frame, hidden from assistive tech', () => {
    const { container } = renderShell('/app/guilds/g1/channels/c1');
    const layers = container.querySelectorAll('.glass-morph');
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(layer).toHaveAttribute('aria-hidden', 'true');
      expect(layer).toBeEmptyDOMElement();
    }
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

  describe('on a phone', () => {
    beforeEach(usePhoneWindow);

    it('is two screens on the room, not two panes, with no bottom bar and no drawer', () => {
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      const frame = container.querySelector('.glass-frame');
      expect(frame).toHaveAttribute('data-layout', 'phone');
      expect(container.querySelector('.glass-room-backdrop')).not.toBeNull();
      expect(container.querySelector('.glass-phone__screen--places')).toContainElement(screen.getByTestId('places-panel'));
      expect(container.querySelector('.glass-phone__screen--conversation')).toContainElement(screen.getByRole('main'));
      expect(screen.getByRole('main')).toContainElement(screen.getByTestId('outlet-content'));
      // The morph layers are the desktop's: a phone has no moves.
      expect(container.querySelectorAll('.glass-morph')).toHaveLength(0);
      expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
      expect(container.querySelector('.glass-frame__places')).toBeInTheDocument();
    });

    it('opens a deep link on its conversation, with places behind it', () => {
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      expect(frameScreen(container)).toBe('conversation');
      expect(container.querySelector('.glass-phone__screen--places')).toHaveAttribute('inert');
    });

    it('opens Home on places, which is the list of your messages', () => {
      const { container } = renderShell('/app');
      expect(frameScreen(container)).toBe('places');
      expect(container.querySelector('.glass-phone__screen--conversation')).toHaveAttribute('inert');
    });

    it('keeps the old drawer flag collapsed, and turns a request to open it into the places screen', () => {
      useUIStore.setState({ sidebarCollapsed: false });
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
      expect(frameScreen(container)).toBe('conversation');

      // The conversation header's button and Ctrl+B.
      act(() => useUIStore.getState().setSidebarCollapsed(false));
      expect(frameScreen(container)).toBe('places');
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });

    it('gives a page with no conversation header the way back', () => {
      renderShell('/app/friends');
      act(() => usePhoneNavStore.getState().showConversation());
      act(() => screen.getByRole('button', { name: 'Back to places' }).click());
      expect(usePhoneNavStore.getState().screen).toBe('places');
    });

    it('turns the edge swipe on for a conversation, and off for everything that owns the edge', () => {
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
      act(() => useGlassStore.getState().setStageMode('side'));
      expect(enabled()).toBe(true);

      act(() => useUIStore.setState({ userSettingsOpen: true }));
      expect(enabled()).toBe(false);
    });

    it('the swipe goes back to places', () => {
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      const handlers = mockedSwipe.mock.calls.at(-1)?.[0];
      act(() => handlers?.onSwipeRight?.());
      expect(frameScreen(container)).toBe('places');
    });

    it('stacks the stream above the conversation; full screen puts the conversation out of reach', () => {
      const { container } = renderShell('/app/guilds/g1/channels/c1');
      act(() => useGlassStore.getState().openStage(LOUNGE));
      const stage = screen.getByRole('region', { name: 'Stage' });
      expect(stage).toContainElement(screen.getByTestId('stage-slot'));
      expect(stage).toContainElement(screen.getByTestId('phone-stage-chrome'));
      expect(container.querySelector('.glass-phone__screen--conversation')).toContainElement(stage);
      expect(screen.getByRole('main')).not.toHaveAttribute('inert');

      act(() => useGlassStore.getState().setStageMode('theater'));
      expect(screen.getByRole('main')).toHaveAttribute('inert');
    });

    it('shows a call on the places screen, where the old on-air dock was out of reach of the drawer', () => {
      useVoiceStore.setState({ callId: 'call-1', callPhase: 'connected', channelId: 'lounge' });
      const { container } = renderShell('/app');
      expect(container.querySelector('.glass-phone__call')).not.toBeNull();
    });

    it('the skip link brings the conversation in when places is in front', () => {
      renderShell('/app');
      expect(usePhoneNavStore.getState().screen).toBe('places');
      act(() => screen.getByRole('link', { name: 'Skip to content' }).click());
      expect(usePhoneNavStore.getState().screen).toBe('conversation');
    });
  });

  it('never draws the phone\'s call surface on desktop: the places pane and the conversation header carry the call', () => {
    mockedUseMobile.mockReturnValue(false);
    useVoiceStore.setState({ connected: true, channelId: '999', callId: 'call-1', callPhase: 'connected' });

    const { container } = renderShell('/app');

    expect(container.querySelector('.glass-phone__call')).toBeNull();
    expect(container.querySelector('.glass-phone__screen')).toBeNull();
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
