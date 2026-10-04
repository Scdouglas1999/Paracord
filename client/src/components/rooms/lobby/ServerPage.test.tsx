import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { paletteHue } from '../../../lib/identityHue';
import { LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { useAuthStore } from '../../../stores/authStore';
import { scopeGuild, useGuildStore } from '../../../stores/guildStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useToolbarStore } from '../../ix/shell/toolbarStore';
import { ServerPage } from './ServerPage';

const SCOPE = { serverId: LOCAL_SERVER_ID, userId: 'viewer' };

function seed(hue: number | null) {
  useAuthStore.setState({ user: { id: 'viewer', username: 'viewer' } as never, token: 'token' });
  useServerListStore.setState({ servers: [], activeServerId: null });
  useGuildStore.setState({
    guilds: [scopeGuild({ id: '310030000000000000', name: 'Fuel', owner_id: 'viewer', member_count: 1, created_at: '', hue } as never, SCOPE)],
  });
}

beforeEach(() => {
  useToolbarStore.setState({ page: null, owner: null });
});
afterEach(cleanup);

describe('ServerPage', () => {
  it('is a large-title page with the server’s own color in reach', () => {
    seed(195);
    const { container } = render(
      <ServerPage guildId="310030000000000000" title="Events" subtitle="Fuel" data-testid="page">
        <p>body</p>
      </ServerPage>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Events' })).toBeInTheDocument();
    expect(screen.getByText('Fuel')).toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--ix-hue')).toBe('195');
    expect(screen.getByTestId('page')).toHaveClass('ix-page', 'ix-sp');
    // It told the toolbar its folded title.
    expect(useToolbarStore.getState().page?.title).toBe('Events');
  });

  it('falls back to the id’s hue until an admin picks one (automatic)', () => {
    seed(null);
    const { container } = render(<ServerPage guildId="310030000000000000" title="Events" />);
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--ix-hue')).toBe(String(paletteHue('310030000000000000')));
  });

  it('is a pushed page when it is given a way back', () => {
    seed(null);
    render(<ServerPage guildId="310030000000000000" title="Cubs at Brewers" onBack={() => {}} backLabel="Back to Sports" />);
    expect(useToolbarStore.getState().page).toMatchObject({ title: 'Cubs at Brewers', backLabel: 'Back to Sports' });
  });
});
