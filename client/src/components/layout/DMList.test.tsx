import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../../api/dms';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { DMList } from './DMList';

vi.mock('../../api/dms', () => ({
  dmApi: {
    list: vi.fn(),
    create: vi.fn(),
    createGroup: vi.fn(),
  },
}));

vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    selfMute: false,
    selfDeaf: false,
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
  }),
}));

vi.mock('./UserPanel', () => ({
  UserPanel: () => null,
}));

const friend = {
  id: 'friend-1',
  username: 'Ada',
  discriminator: 1,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('DMList error states', () => {
  beforeEach(() => {
    vi.mocked(dmApi.list).mockResolvedValue({ data: [] } as never);
    vi.mocked(dmApi.create).mockReset();
    vi.mocked(dmApi.createGroup).mockReset();
    useAuthStore.setState({
      user: {
        id: 'me',
        username: 'Self',
        discriminator: 1,
        flags: 0,
        bot: false,
        system: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    });
    useChannelStore.setState({
      channelsByGuild: { '': [] },
      channelsById: {},
      channels: [],
      selectedChannelId: null,
      selectedGuildId: null,
    });
    useRelationshipStore.setState({
      relationships: [{ id: 'rel-1', type: 1, user: friend }],
      fetchRelationships: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('shows an inline alert when single-DM creation fails', async () => {
    const user = userEvent.setup();
    vi.mocked(dmApi.create).mockRejectedValue(new Error('Direct message creation denied.'));

    render(
      <MemoryRouter>
        <DMList />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Create direct message' }));
    await user.click(screen.getByRole('button', { name: /Ada/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Direct message creation denied.');
  });

  it('shows an inline alert when group-DM creation fails', async () => {
    const user = userEvent.setup();
    vi.mocked(dmApi.createGroup).mockRejectedValue(new Error('Group creation denied.'));

    render(
      <MemoryRouter>
        <DMList />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Create direct message' }));
    await user.click(screen.getByRole('button', { name: 'Group DM' }));
    await user.click(screen.getByRole('button', { name: /Ada/ }));
    await user.click(screen.getByRole('button', { name: /Create Group DM/ }));

    await waitFor(() => expect(dmApi.createGroup).toHaveBeenCalledWith(['friend-1'], undefined));
    expect(await screen.findByRole('alert')).toHaveTextContent('Group creation denied.');
  });
});
