import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../api/dms';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import type { Channel } from '../types';
import { DMPage } from './DMPage';

vi.mock('../api/dms', () => ({
  dmApi: {
    addRecipient: vi.fn(),
    removeRecipient: vi.fn(),
    listRecipients: vi.fn(),
  },
}));

vi.mock('../components/layout/TopBar', () => ({
  TopBar: () => <div data-testid="topbar" />,
}));

vi.mock('../components/message/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock('../components/message/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));

const currentUser = {
  id: 'me',
  username: 'Self',
  discriminator: 1,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

const bob = {
  id: 'bob',
  username: 'Bob',
  discriminator: 2,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

const ada = {
  id: 'ada',
  username: 'Ada',
  discriminator: 3,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

function groupDm(recipients = [currentUser, bob]): Channel {
  return {
    id: 'dm-1',
    name: 'Launch group',
    type: 3,
    channel_type: 3,
    guild_id: null,
    owner_id: 'me',
    recipients,
    position: 0,
    permission_overwrites: [],
    created_at: '2026-01-01T00:00:00.000Z',
  } as unknown as Channel;
}

function renderDmPage() {
  return render(
    <MemoryRouter initialEntries={['/app/dms/dm-1']}>
      <Routes>
        <Route path="/app/dms/:channelId" element={<DMPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DMPage group-member states', () => {
  beforeEach(() => {
    vi.mocked(dmApi.addRecipient).mockReset();
    vi.mocked(dmApi.removeRecipient).mockReset();
    vi.mocked(dmApi.listRecipients).mockReset();
    useAuthStore.setState({ user: currentUser });
    useChannelStore.setState({
      channelsByGuild: { '': [groupDm()] },
      channelsById: { 'dm-1': groupDm() },
      channels: [groupDm()],
      selectedChannelId: 'dm-1',
      selectedGuildId: null,
    });
    useRelationshipStore.setState({
      relationships: [{ id: 'rel-ada', type: 1, user: ada }],
      fetchRelationships: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('shows an inline alert when adding a group-DM member fails', async () => {
    const user = userEvent.setup();
    vi.mocked(dmApi.addRecipient).mockRejectedValue(new Error('Ada cannot be added.'));

    renderDmPage();

    await user.click(screen.getByRole('button', { name: 'Show Members' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Ada' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ada cannot be added.');
  });

  it('shows an inline alert when removing a group-DM member fails', async () => {
    const user = userEvent.setup();
    vi.mocked(dmApi.removeRecipient).mockRejectedValue(new Error('Bob cannot be removed.'));

    renderDmPage();

    await user.click(screen.getByRole('button', { name: 'Show Members' }));
    await user.click(screen.getByRole('button', { name: 'Remove Bob from group DM' }));

    await waitFor(() => expect(dmApi.removeRecipient).toHaveBeenCalledWith('dm-1', 'bob'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bob cannot be removed.');
  });

  it('shows an empty add-list state when there are no eligible friends', async () => {
    const user = userEvent.setup();
    useRelationshipStore.setState({
      relationships: [{ id: 'rel-bob', type: 1, user: bob }],
      fetchRelationships: vi.fn().mockResolvedValue(undefined),
    });

    renderDmPage();

    await user.click(screen.getByRole('button', { name: 'Show Members' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(
      screen.getByText('Everyone on your friends list is already in this conversation.'),
    ).toBeInTheDocument();
  });
});
