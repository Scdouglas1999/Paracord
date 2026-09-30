import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entityScopeKey } from '../../../lib/serverScope';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import type { Channel } from '../../../types';
import { NotificationsPage } from './NotificationsPage';

/**
 * Notifications for a channel: four choices, one of them in force and said so as
 * a checked radio, and the server's own mute switch beneath.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
const state = vi.hoisted(() => ({
  level: null as 0 | 1 | 2 | null,
  busy: false,
  setLevel: vi.fn(),
  toggleMute: vi.fn(),
  muted: [] as string[],
  saving: {} as Record<string, boolean>,
}));

vi.mock('../../../hooks/useRoomNotifications', () => ({
  useRoomNotifications: () => ({
    levelOf: () => state.level,
    savingRoom: () => state.busy,
    setLevel: state.setLevel,
  }),
}));
vi.mock('../../../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildKeys: state.muted, toggleMute: state.toggleMute, saving: state.saving }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.level = null;
  state.busy = false;
  state.muted = [];
  state.saving = {};
  useAuthStore.setState({ token: 'token', user: { id: 'me', username: 'sean' } as never });
  useChannelStore.getState().reset();
  useChannelStore.getState().setChannels(
    'g1',
    [{ id: 'c1', guild_id: 'g1', name: 'General', type: 0, channel_type: 0, position: 0, created_at: '2026-10-01T00:00:00.000Z' } as unknown as Channel],
    SCOPE,
  );
});

describe('NotificationsPage', () => {
  it('offers the four choices, and checks the one in force', () => {
    state.level = 1;
    render(<NotificationsPage channelId="c1" guildId="g1" />);
    const group = screen.getByRole('radiogroup', { name: 'Notifications for this channel' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Every message/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Only when you’re mentioned/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Nothing from this channel/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Follow the server/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('follows the server when the channel holds no opinion of its own', () => {
    render(<NotificationsPage channelId="c1" guildId="g1" />);
    expect(screen.getByRole('radio', { name: /Follow the server/ })).toHaveAttribute('aria-checked', 'true');
  });

  it.each([
    [/Every message/, 0],
    [/Only when you’re mentioned/, 1],
    [/Nothing from this channel/, 2],
    [/Follow the server/, null],
  ] as const)('choosing %s sets the channel to %s', async (name, level) => {
    const user = userEvent.setup();
    state.level = level === 0 ? 2 : 0;
    render(<NotificationsPage channelId="c1" guildId="g1" />);
    await user.click(screen.getByRole('radio', { name }));
    expect(state.setLevel).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', name: 'General' }), level);
  });

  it('cannot be changed twice while a change is being saved', () => {
    state.busy = true;
    render(<NotificationsPage channelId="c1" guildId="g1" />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('shows and flips the server\'s mute, in words', async () => {
    const user = userEvent.setup();
    render(<NotificationsPage channelId="c1" guildId="g1" />);
    const mute = screen.getByRole('switch', { name: /Mute this server/ });
    expect(mute).toHaveAttribute('aria-checked', 'false');
    await user.click(mute);
    expect(state.toggleMute).toHaveBeenCalledWith({ id: 'g1', scope: SCOPE });
  });

  it('says a muted server is muted', () => {
    state.muted = [entityScopeKey(SCOPE, 'g1')];
    render(<NotificationsPage channelId="c1" guildId="g1" />);
    expect(screen.getByRole('switch', { name: /Mute this server/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Muted: this server does not notify you.')).toBeInTheDocument();
  });

  it('has no server section without a server, and no choices without a channel', () => {
    const { rerender } = render(<NotificationsPage channelId="c1" guildId={null} />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    rerender(<NotificationsPage channelId={null} guildId="g1" />);
    expect(screen.getByText('No channel selected')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
