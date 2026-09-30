import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import { guildApi } from '../../api/guilds';
import { voiceApi } from '../../api/voice';
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

vi.mock('../../api/voice', () => ({
  voiceApi: {
    getListenIn: vi.fn(),
    setListenIn: vi.fn(),
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

const voiceChannel: Channel = {
  id: 'voice-1',
  type: ChannelType.Voice,
  channel_type: ChannelType.Voice,
  guild_id: 'guild-1',
  name: 'Lounge',
  position: 3,
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
    vi.mocked(channelApi.getFeatureSettings).mockResolvedValue({
      data: {
        channel_id: 'channel-1',
        disappearing_seconds: 0,
        anonymous_posting_enabled: false,
        slowmode_exempt_role_ids: [],
        adaptive_slowmode_enabled: false,
        adaptive_slowmode_window_seconds: 60,
        adaptive_slowmode_threshold: 5,
        adaptive_slowmode_step_seconds: 5,
        thread_rate_limit_per_user: 0,
      },
    } as never);
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

  it('makes advanced channel features explicit and explains their scope', async () => {
    const user = userEvent.setup();
    renderChannelManager();

    const features = screen.getByRole('button', { name: 'Show advanced features for general' });
    expect(features).toHaveTextContent('Features');
    await user.click(features);

    expect(await screen.findByText('Channel features')).toBeInTheDocument();
    expect(screen.getByText('Automation and privacy controls that apply only to #general.')).toBeInTheDocument();
    expect(channelApi.getFeatureSettings).toHaveBeenCalledWith('channel-1');
  });

  it('reads and turns off listening in for a voice channel', async () => {
    vi.mocked(voiceApi.getListenIn).mockResolvedValue(true);
    vi.mocked(voiceApi.setListenIn).mockResolvedValue(false);
    renderChannelManager([category, voiceChannel]);
    const toggle = await screen.findByRole('switch', { name: /listen in to Lounge/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(voiceApi.setListenIn).toHaveBeenCalledWith('voice-1', false);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('keeps the switch honest when the server refuses the change', async () => {
    vi.mocked(voiceApi.getListenIn).mockResolvedValue(true);
    vi.mocked(voiceApi.setListenIn).mockRejectedValue(new Error('Missing Manage Channels'));
    renderChannelManager([category, voiceChannel]);
    const toggle = await screen.findByRole('switch', { name: /listen in to Lounge/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await userEvent.click(toggle);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('leaves the switch disabled when the setting cannot be read', async () => {
    vi.mocked(voiceApi.getListenIn).mockRejectedValue(new Error('offline'));
    renderChannelManager([category, voiceChannel]);
    expect(await screen.findByText('Listening in (could not load)')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /listen in to Lounge/i })).toBeDisabled();
  });
});
