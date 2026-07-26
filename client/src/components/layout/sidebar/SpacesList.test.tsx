import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpacesList } from './SpacesList';
import { useServerListStore } from '../../../stores/serverListStore';
import { useAuthStore } from '../../../stores/authStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useUIStore } from '../../../stores/uiStore';
import type { GuildSummary } from '../../../hooks/useUnifiedConversations';

const navigate = vi.fn();
const canAccessSync = vi.hoisted(() => vi.fn<(guildId: string) => boolean>(() => false));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../../../lib/guildSettingsAccess', () => ({
  canAccessGuildSettingsSync: (guildId: string) => canAccessSync(guildId),
}));

function space(over: Partial<GuildSummary> & { id: string; name: string }): GuildSummary {
  return { icon: null, serverId: 'srv-a', ...over };
}

beforeEach(() => {
  navigate.mockReset();
  canAccessSync.mockReset();
  canAccessSync.mockReturnValue(false);
  // Two connected servers — Spaces MERGES guilds across them (layout-spec §1).
  useServerListStore.setState({ activeServerId: 'srv-a' });
  useAuthStore.setState({ user: { id: 'user-1' } as never });
  useGuildStore.setState({
    guilds: [
      { id: 'g1', name: 'Emerald HQ', owner_id: 'user-1' },
      { id: 'g2', name: 'Weekend Crew', owner_id: 'other' },
    ] as never,
  });
  useUIStore.setState({ guildSettingsId: null });
});

describe('SpacesList', () => {
  it('lists joined guilds merged across servers as option rows with initials chips', () => {
    const spaces = [
      space({ id: 'g1', name: 'Emerald HQ', serverId: 'srv-a' }),
      space({ id: 'g2', name: 'Weekend Crew', serverId: 'srv-b' }),
    ];
    render(<SpacesList spaces={spaces} />);

    expect(screen.getByRole('heading', { name: 'Spaces' })).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    // Two joined guilds + the persistent "Add a space" row.
    expect(options).toHaveLength(3);
    expect(screen.getByText('Emerald HQ')).toBeInTheDocument();
    expect(screen.getByText('Weekend Crew')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Add a space' })).toBeInTheDocument();
    // Two-letter initials chip (kill-list clean — tokens/text, not a gradient tile).
    expect(screen.getByText('EH')).toBeInTheDocument();
    expect(screen.getByText('WC')).toBeInTheDocument();
  });

  it('renders a space icon image when icon data is present', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    render(
      <SpacesList spaces={[space({ id: 'g1', name: 'Emerald HQ', icon })]} />,
    );
    const img = screen.getByRole('option', { name: /Emerald HQ/ }).querySelector('img');
    expect(img).toHaveAttribute('src', icon);
    expect(screen.queryByText('EH')).not.toBeInTheDocument();
  });

  it('marks the active guild row and leaves the others unselected', () => {
    const spaces = [
      space({ id: 'g1', name: 'Emerald HQ' }),
      space({ id: 'g2', name: 'Weekend Crew' }),
    ];
    render(<SpacesList spaces={spaces} activeGuildId="g2" />);

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-current', 'page');
  });

  it('shows attention dots in the expanded list but not on the active space', () => {
    const spaces = [
      space({ id: 'g1', name: 'Emerald HQ' }),
      space({ id: 'g2', name: 'Weekend Crew' }),
    ];
    render(
      <SpacesList
        spaces={spaces}
        activeGuildId="g2"
        attentionGuildIds={new Set(['g1', 'g2'])}
      />,
    );

    expect(screen.getAllByTestId('expanded-space-attention-dot')).toHaveLength(1);
  });

  it('opens the guild home on click without switching servers when already active', () => {
    render(<SpacesList spaces={[space({ id: 'g1', name: 'Emerald HQ', serverId: 'srv-a' })]} />);

    fireEvent.click(screen.getByRole('option', { name: /Emerald HQ/ }));

    expect(navigate).toHaveBeenCalledWith('/app/guilds/g1');
    expect(useServerListStore.getState().activeServerId).toBe('srv-a');
  });

  it('flips the active server first when opening a background-server guild', () => {
    render(<SpacesList spaces={[space({ id: 'g2', name: 'Weekend Crew', serverId: 'srv-b' })]} />);

    fireEvent.click(screen.getByRole('option', { name: /Weekend Crew/ }));

    // Active server switches to the guild's owning server before navigation.
    expect(useServerListStore.getState().activeServerId).toBe('srv-b');
    expect(navigate).toHaveBeenCalledWith('/app/guilds/g2');
  });

  it('assigns flat roving-tabindex ordinals from navIndexStart, ending on the Add-a-space row', () => {
    const spaces = [space({ id: 'g1', name: 'Emerald HQ' }), space({ id: 'g2', name: 'Weekend Crew' })];
    render(<SpacesList spaces={spaces} navIndexStart={7} />);

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('data-nav-index', '7');
    expect(options[1]).toHaveAttribute('data-nav-index', '8');
    // The "Add a space" row is the last roving ordinal in the section.
    expect(screen.getByRole('option', { name: 'Add a space' })).toHaveAttribute('data-nav-index', '9');
  });

  it('keeps the persistent Add-a-space row even when the viewer has joined no spaces', () => {
    const onAddSpace = vi.fn();
    render(<SpacesList spaces={[]} onAddSpace={onAddSpace} />);
    // The old guild-rail "+" is restored: create/join stays reachable at zero spaces.
    expect(screen.getByRole('heading', { name: 'Spaces' })).toBeInTheDocument();
    const addRow = screen.getByRole('option', { name: 'Add a space' });
    expect(addRow).toBeInTheDocument();
    fireEvent.click(addRow);
    expect(onAddSpace).toHaveBeenCalledTimes(1);
  });

  it('omits Space settings from the context menu without manage access', () => {
    canAccessSync.mockReturnValue(false);
    render(<SpacesList spaces={[space({ id: 'g1', name: 'Emerald HQ' })]} />);

    fireEvent.contextMenu(screen.getByRole('option', { name: /Emerald HQ/ }));
    expect(screen.queryByRole('menuitem', { name: 'Space settings' })).not.toBeInTheDocument();
  });

  it('offers Space settings in the context menu when the viewer can manage the space', () => {
    canAccessSync.mockImplementation((id: string) => id === 'g1');
    render(<SpacesList spaces={[space({ id: 'g1', name: 'Emerald HQ' })]} />);

    fireEvent.contextMenu(screen.getByRole('option', { name: /Emerald HQ/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Space settings' }));
    expect(useUIStore.getState().guildSettingsId).toBe('g1');
  });
});
