import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpacesList } from './SpacesList';
import { useServerListStore } from '../../../stores/serverListStore';
import type { GuildSummary } from '../../../hooks/useUnifiedConversations';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

function space(over: Partial<GuildSummary> & { id: string; name: string }): GuildSummary {
  return { icon: null, serverId: 'srv-a', ...over };
}

beforeEach(() => {
  navigate.mockReset();
  // Two connected servers — Spaces MERGES guilds across them (layout-spec §1).
  useServerListStore.setState({ activeServerId: 'srv-a' });
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
    expect(options).toHaveLength(2);
    expect(screen.getByText('Emerald HQ')).toBeInTheDocument();
    expect(screen.getByText('Weekend Crew')).toBeInTheDocument();
    // Two-letter initials chip (kill-list clean — tokens/text, not a gradient tile).
    expect(screen.getByText('EH')).toBeInTheDocument();
    expect(screen.getByText('WC')).toBeInTheDocument();
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

  it('assigns flat roving-tabindex ordinals from navIndexStart', () => {
    const spaces = [space({ id: 'g1', name: 'Emerald HQ' }), space({ id: 'g2', name: 'Weekend Crew' })];
    render(<SpacesList spaces={spaces} navIndexStart={7} />);

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('data-nav-index', '7');
    expect(options[1]).toHaveAttribute('data-nav-index', '8');
  });

  it('renders nothing when the viewer has joined no spaces', () => {
    const { container } = render(<SpacesList spaces={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
