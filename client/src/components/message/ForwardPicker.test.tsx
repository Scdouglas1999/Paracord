import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAccountStore } from '../../stores/accountStore';
import type { Message } from '../../types';
import { ForwardPicker } from './ForwardPicker';

const scope = { serverId: 'home', userId: 'me' };
const sendMessage = vi.fn();

vi.mock('../../hooks/useGuilds', () => ({ useAvailableGuilds: () => [] }));
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
    useAccountStore.setState({ isUnlocked: false });
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
