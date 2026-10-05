import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAccountStore } from '../../stores/accountStore';
import { useChannelStore } from '../../stores/channelStore';
import type { Message } from '../../types';
import { ForwardPicker } from './ForwardPicker';

const scope = { serverId: 'home', userId: 'me' };
const sendMessage = vi.fn();

const guilds = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../hooks/useGuilds', () => ({ useAvailableGuilds: () => guilds.list }));
vi.mock('../../hooks/useChannels', () => ({
  useAvailableChannels: () => [
    { id: 'dm-1', type: 1, channel_type: 1, guild_id: null, scope, recipient: { id: 'u2', username: 'grace' }, last_message_id: '5' },
  ],
}));
vi.mock('../../stores/messageStore', () => ({
  getMessageStore: () => ({ getState: () => ({ sendMessage }) }),
}));

const message = {
  id: 'm1',
  channel_id: 'c1',
  author: { id: 'u1', username: 'ada', discriminator: '0' },
  content: 'server words',
  attachments: [],
  reactions: [],
} as unknown as Message;

describe('ForwardPicker', () => {
  beforeEach(() => {
    sendMessage.mockReset();
    guilds.list = [];
    useChannelStore.setState({ channelsByGuild: {} });
    useAccountStore.setState({ isUnlocked: false });
  });

  it('is a 440 card dialog; Send is its one cream button and stays off until something is chosen', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForwardPicker message={message} scope={scope} sourceEncrypted={false} open onClose={vi.fn()} />
      </MemoryRouter>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Forward' });
    expect(dialog).toHaveClass('max-w-[440px]');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send.className).toContain('bg-accent-primary');
    await user.click(screen.getByText('grace'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove grace' })).toBeInTheDocument();
  });

  it('draws a person as an avatar and a server channel as the server’s mark, never a glyph in a circle', () => {
    guilds.list = [{ id: 'g1', name: 'Game Night', icon_hash: null, hue: 195, scope }];
    useChannelStore.setState({
      channelsByGuild: { [JSON.stringify([scope.serverId, scope.userId, 'g1'])]: [{ id: 'c9', name: 'lounge', type: 0, channel_type: 0, guild_id: 'g1', last_message_id: '9', scope }] },
    } as never);
    render(
      <MemoryRouter>
        <ForwardPicker message={message} scope={scope} sourceEncrypted={false} open onClose={vi.fn()} />
      </MemoryRouter>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Forward' });
    expect(dialog.querySelectorAll('.ix-av')).toHaveLength(1);
    expect(screen.getByText('grace').closest('button')?.querySelector('.ix-av')).not.toBeNull();
    expect(screen.getByText('Direct message')).toBeInTheDocument();
    // The channel row wears its server's mark: a rounded square with the server's letter.
    const row = screen.getByText('#lounge').closest('button')!;
    expect(row.querySelector('.ix-sq')).toHaveTextContent('G');
    expect(screen.getByText('Game Night')).toBeInTheDocument();
  });

  it('asks to unlock encryption before forwarding into a direct message, and sends nothing', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForwardPicker message={message} scope={scope} sourceEncrypted={false} open onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await user.click(screen.getByText('grace'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Unlock encryption on this device');
    expect(screen.getByRole('link', { name: 'Unlock encryption' })).toHaveAttribute('href', expect.stringContaining('/unlock?returnTo='));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
