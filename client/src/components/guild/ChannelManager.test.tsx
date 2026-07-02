import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import { guildApi } from '../../api/guilds';
import { toast } from '../../stores/toastStore';
import { ChannelType, type Channel, type Role } from '../../types';
import { ChannelManager } from './ChannelManager';

vi.mock('../../api/guilds', () => ({
  guildApi: {
    createChannel: vi.fn(),
  },
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    updatePositions: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    getFeatureSettings: vi.fn(),
    updateFeatureSettings: vi.fn(),
    getFollowers: vi.fn(),
    addFollower: vi.fn(),
    removeFollower: vi.fn(),
  },
}));

vi.mock('../../stores/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const roles: Role[] = [
  { id: 'guild-1', name: '@everyone', permissions: '0', color: 0, position: 0, hoist: false, mentionable: false },
] as Role[];

const category: Channel = {
  id: 'cat-1',
  type: ChannelType.Category,
  channel_type: ChannelType.Category,
  guild_id: 'guild-1',
  name: 'Projects',
  position: 0,
  nsfw: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

const textChannel: Channel = {
  id: 'channel-1',
  type: ChannelType.Text,
  channel_type: ChannelType.Text,
  guild_id: 'guild-1',
  name: 'general',
  position: 1,
  nsfw: false,
  rate_limit_per_user: 0,
  parent_id: 'cat-1',
  created_at: '2026-01-01T00:00:00.000Z',
};

const announcementChannel: Channel = {
  id: 'announce-1',
  type: ChannelType.Announcement,
  channel_type: ChannelType.Announcement,
  guild_id: 'guild-1',
  name: 'updates',
  position: 2,
  nsfw: false,
  parent_id: 'cat-1',
  created_at: '2026-01-01T00:00:00.000Z',
};

function renderChannelManager(channels: Channel[] = [category, textChannel]) {
  return render(
    <ChannelManager
      guildId="guild-1"
      channels={channels}
      roles={roles}
      canManageRoles={false}
      onRefresh={vi.fn()}
    />,
  );
}

describe('ChannelManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guildApi.createChannel).mockResolvedValue({ data: textChannel } as never);
    vi.mocked(channelApi.update).mockResolvedValue({ data: textChannel } as never);
    vi.mocked(channelApi.getFollowers).mockResolvedValue({ data: [] } as never);
    vi.mocked(channelApi.addFollower).mockResolvedValue({ data: {} } as never);
    vi.mocked(channelApi.removeFollower).mockResolvedValue({ data: {} } as never);
  });

  it('shows concrete API details when channel creation fails', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.createChannel).mockRejectedValueOnce(
      new Error('Manage Channels permission is required.'),
    );

    renderChannelManager();

    await user.type(screen.getByPlaceholderText('Channel name'), 'ops');
    await user.click(screen.getAllByRole('button', { name: 'Create' })[1]);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to create channel: Manage Channels permission is required.',
    );
  });

  it('shows concrete API details when slowmode updates fail', async () => {
    vi.mocked(channelApi.update).mockRejectedValueOnce(
      new Error('Slowmode must be between 0 and 21600 seconds.'),
    );

    renderChannelManager();

    fireEvent.change(screen.getByDisplayValue('Off'), { target: { value: '5' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to update slowmode: Slowmode must be between 0 and 21600 seconds.',
    );
  });

  it('reports announcement follow failures instead of dropping them', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.addFollower).mockRejectedValueOnce(
      new Error('Manage Webhooks permission is required.'),
    );

    renderChannelManager([category, textChannel, announcementChannel]);

    await user.click(await screen.findByRole('button', { name: 'Follow' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to follow announcement channel: Manage Webhooks permission is required.',
      );
    });
  });
});
