import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeServersRail, type HomeServerAttention } from './HomeServersRail';
import type { GuildSummary } from '../../hooks/useUnifiedConversations';

const space: GuildSummary = { scope: { serverId: 'local', userId: 'user-1' }, key: JSON.stringify(['local', 'user-1', 'g1']),
  id: 'g1',
  name: 'Emerald HQ',
  icon: null,
  serverId: 'local',
};

describe('HomeServersRail', () => {
  it('surfaces both live and unread status when a space has both', () => {
    const attention = new Map<string, HomeServerAttention>([
      [space.key, { unread: true, live: true, memberCount: 12 }],
    ]);

    render(
      <HomeServersRail
        spaces={[space]}
        attention={attention}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Emerald HQ/ })).toHaveTextContent(
      'Live · Unread · 12 members',
    );
    expect(screen.getByTestId('home-server-attention')).toBeInTheDocument();
  });
  it('keeps same-ID spaces on different servers separate', () => {
    const other = { ...space, key: JSON.stringify(['remote', 'user-2', 'g1']), scope: { serverId: 'remote', userId: 'user-2' }, serverId: 'remote', name: 'Remote space' };
    render(<HomeServersRail spaces={[space, other]} attention={new Map([[other.key, { unread: true, live: false }]])} primaryKey={space.key} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Emerald HQ/ })).not.toHaveTextContent('Unread');
    expect(screen.getByRole('button', { name: /Remote space/ })).toHaveTextContent('Unread');
    expect(screen.getAllByTestId('home-server-attention')).toHaveLength(1);
  });
});
