import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeServersRail, type HomeServerAttention } from './HomeServersRail';
import type { GuildSummary } from '../../hooks/useUnifiedConversations';

const space: GuildSummary = {
  id: 'g1',
  name: 'Emerald HQ',
  icon: null,
  serverId: 'local',
};

describe('HomeServersRail', () => {
  it('surfaces both live and unread status when a space has both', () => {
    const attention = new Map<string, HomeServerAttention>([
      ['g1', { unread: true, live: true, memberCount: 12 }],
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
});
