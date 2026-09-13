import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnifiedSidebar } from './UnifiedSidebar';
import { useAuthStore } from '../../../stores/authStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useUIStore } from '../../../stores/uiStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useBuildingLights } from '../../../hooks/useLights';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import {
  buildingLight,
  personLight,
  textRoomLight,
  voiceRoomLight,
  type RoomLight,
} from '../../../lib/attention/light';
import type { UnifiedConversations } from '../../../hooks/useUnifiedConversations';

/**
 * The sidebar container (docs/lantern-stage-spec.md §7.1).
 *
 * What is asserted here is the wiring the column cannot see: that the buildings
 * come from WP1's light selector, that the counts come from the conversation
 * merge, that Needs-you has left the column for Home, that opening a building
 * activates its account first, and that the mute / mark-read / leave menu the
 * deleted `SpacesList` owned still exists.
 */

vi.mock('../../../hooks/useLights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useLights')>()),
  useBuildingLights: vi.fn(),
}));
vi.mock('../../../hooks/useUnifiedConversations', () => ({
  useUnifiedConversations: vi.fn(),
}));
vi.mock('../../guild/CreateGuildModal', () => ({
  CreateGuildModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="create-guild-modal">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));
// The call dock is WP3's surface (it renders their on-air pill); the column
// only owns the slot it sits in, so it is stubbed out here.
vi.mock('./CallDock', () => ({ CallDock: () => null }));

const SCOPE = { serverId: 'srv', userId: 'user-1' };
const NOW = 1_800_000_000_000;
const MARA = personLight({ userId: '101', name: 'Mara', status: 'online' });

function text(name: string, channelId: string, over: Partial<Parameters<typeof textRoomLight>[0]> = {}): RoomLight {
  return textRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId,
    name,
    candidates: [],
    nowMs: NOW,
    ...over,
  });
}

const LIT_VOICE = voiceRoomLight({
  scope: SCOPE,
  guildId: 'g1',
  channelId: '2002',
  name: 'Shop floor',
  occupants: [{ person: MARA, speaking: true }],
  nowMs: NOW,
});

const KESTREL = buildingLight({
  scope: SCOPE,
  guildId: 'g1',
  name: 'Kestrel Robotics',
  rooms: [LIT_VOICE, text('build-log', '2001')],
  members: [MARA],
  memberCount: 24,
});

function conversations(over: Partial<UnifiedConversations> = {}): UnifiedConversations {
  return {
    needsYou: [],
    needsYouOverflowCount: 0,
    pinned: [],
    recent: [],
    spaces: [],
    requests: [],
    ...over,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderSidebar(initialPath = '/app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<UnifiedSidebar />} />
        <Route path="/app/guilds/:guildId" element={<UnifiedSidebar />} />
        <Route path="*" element={<UnifiedSidebar />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useBuildingLights).mockReturnValue([KESTREL]);
  vi.mocked(useUnifiedConversations).mockReturnValue(conversations());
  usePresenceStore.setState({ presences: new Map(), presenceOrder: new Map() });
  useAuthStore.setState({
    user: { id: 'user-1', username: 'sam.douglas', flags: 0 } as never,
    settings: { status: 'online', custom_status: null } as never,
  });
  useUIStore.setState({ sidebarCollapsed: false });
  useVoiceStore.setState({ connected: false });
  useServerListStore.setState({
    activeServerId: 'srv',
    servers: [
      {
        id: 'srv',
        url: 'https://srv.example',
        name: 'Test',
        token: 'token',
        userId: 'user-1',
        user: { id: 'user-1', username: 'sam.douglas', flags: 0 } as never,
        connected: true,
      },
    ],
  });
});

describe('UnifiedSidebar', () => {
  it('is a 276px buildings column on the street, fed by the light selector', () => {
    renderSidebar();
    const column = screen.getByRole('complementary', { name: 'Navigation' });
    expect(column).toHaveClass('md:w-[calc(var(--w-buildings-column)+var(--gutter)+var(--gutter))]');
    expect(screen.getByRole('listbox', { name: 'Buildings and rooms' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Kestrel Robotics' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Shop floor/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /build-log/ })).toBeInTheDocument();
  });

  it('has no Needs-you section — Home owns the list and keeps the count', () => {
    vi.mocked(useUnifiedConversations).mockReturnValue(
      conversations({ needsYouOverflowCount: 3 }),
    );
    renderSidebar();
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('3 conversations need you')).toHaveTextContent('3');
  });

  it('pins the account plate to the bottom with its light in words', () => {
    renderSidebar();
    expect(
      screen.getByRole('button', { name: /sam\.douglas — Lights on\. Open account menu/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open user settings' })).toBeInTheDocument();
  });

  it('opens a building Lobby, and a room inside it', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('option', { name: /Kestrel Robotics lobby/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1');

    fireEvent.click(screen.getByRole('option', { name: /build-log/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/2001');
  });

  it('keeps the building context menu the old Spaces list owned', () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole('option', { name: /Kestrel Robotics lobby/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Mute building')).toBeInTheDocument();
    expect(within(menu).getByText('Mark as read')).toBeInTheDocument();
    expect(within(menu).getByText('Leave building')).toBeInTheDocument();
  });

  it('offers the create/join flow from the persistent Add a building row', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('option', { name: 'Add a building' }));
    expect(screen.getByTestId('create-guild-modal')).toBeInTheDocument();
  });

  it('keeps the buildings reachable when collapsed to the rail', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();
    const rail = screen.getByRole('complementary', { name: 'Navigation' });
    expect(rail).toHaveAttribute('data-collapsed', 'true');
    const mark = within(rail).getByRole('option', { name: /Kestrel Robotics/ });
    fireEvent.click(mark);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1');
  });
});
