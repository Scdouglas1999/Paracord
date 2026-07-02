import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildApi } from '../../api/guilds';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { useToastStore } from '../../stores/toastStore';
import { ChannelType, type Channel, type Guild, type User } from '../../types';
import { writeClipboardText } from '../../lib/clipboard';
import { GuildChannelList } from './GuildChannelList';

vi.mock('../../api/guilds', () => ({
  guildApi: {
    createChannel: vi.fn(),
    leaveGuild: vi.fn(),
  },
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    getVisibleChannels: vi.fn(),
  },
}));

vi.mock('../../lib/clipboard', () => ({
  writeClipboardText: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: 0n,
    isOwner: true,
    isAdmin: true,
    isLoading: false,
  }),
}));

vi.mock('../../hooks/useUnreadCounts', () => ({
  useUnreadCounts: () => ({
    isChannelUnread: new Set(),
    channelMentionCounts: new Map(),
  }),
}));

vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    connected: false,
    channelId: null,
    joinChannel: vi.fn(),
    selfMute: false,
    selfDeaf: false,
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
  }),
}));

vi.mock('./ConnectionStatusBar', () => ({
  ConnectionStatusBar: () => null,
}));

vi.mock('../voice/VoiceControls', () => ({
  VoiceControls: () => null,
}));

vi.mock('./VoiceParticipants', () => ({
  VoiceParticipants: () => null,
}));

vi.mock('./UserPanel', () => ({
  UserPanel: () => null,
}));

const user: User = {
  id: 'user-1',
  username: 'Owner',
  discriminator: '0001',
  bot: false,
  system: false,
  flags: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

const guild: Guild = {
  id: 'guild-1',
  name: 'Test Guild',
  icon_hash: null,
  owner_id: user.id,
  member_count: 1,
  features: [],
  created_at: '2026-01-01T00:00:00.000Z',
};

const category: Channel = {
  id: 'cat-1',
  type: ChannelType.Category,
  channel_type: ChannelType.Category,
  guild_id: guild.id,
  name: 'Projects',
  position: 0,
  nsfw: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

const textChannel: Channel = {
  id: 'channel-existing',
  type: ChannelType.Text,
  channel_type: ChannelType.Text,
  guild_id: guild.id,
  name: 'general',
  position: 1,
  nsfw: false,
  parent_id: category.id,
  created_at: '2026-01-01T00:00:00.000Z',
};

function resetStores(guildOverride: Partial<Guild> = {}) {
  const activeGuild = { ...guild, ...guildOverride };
  useAuthStore.setState({ user, token: 'token' });
  useGuildStore.setState({ guilds: [activeGuild], selectedGuildId: activeGuild.id, isLoading: false });
  useChannelStore.setState({
    channelsByGuild: { [activeGuild.id]: [category, textChannel] },
    channelsById: { [category.id]: category, [textChannel.id]: textChannel },
    channels: [category, textChannel],
    guildChannelsLoaded: { [activeGuild.id]: true },
    selectedChannelId: null,
    selectedGuildId: activeGuild.id,
    isLoading: false,
  });
  useToastStore.setState({ toasts: [] });
}

function renderGuildChannelList() {
  render(
    <MemoryRouter>
      <GuildChannelList guildId={guild.id} />
    </MemoryRouter>,
  );
}

describe('GuildChannelList inline channel creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetStores();
    vi.mocked(writeClipboardText).mockResolvedValue(undefined);
  });

  it('shows accessible controls for inline channel creation', async () => {
    const userEventApi = userEvent.setup();
    renderGuildChannelList();

    await userEventApi.click(screen.getByRole('button', { name: 'Create channel in Projects' }));

    expect(screen.getByLabelText('Channel name')).toHaveFocus();
    expect(screen.getByLabelText('Channel type')).toHaveValue('text');
  });

  it('adds the created channel to the visible channel list', async () => {
    const userEventApi = userEvent.setup();
    vi.mocked(guildApi.createChannel).mockResolvedValue({
      data: {
        id: 'channel-1',
        type: ChannelType.Text,
        channel_type: ChannelType.Text,
        guild_id: guild.id,
        name: 'planning',
        position: 1,
        nsfw: false,
        parent_id: category.id,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never);
    renderGuildChannelList();

    await userEventApi.click(screen.getByRole('button', { name: 'Create channel in Projects' }));
    await userEventApi.type(screen.getByLabelText('Channel name'), ' planning ');
    await userEventApi.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(guildApi.createChannel).toHaveBeenCalledWith(guild.id, {
      name: 'planning',
      channel_type: ChannelType.Text,
      parent_id: category.id,
    }));
    expect(await screen.findByText('planning')).toBeInTheDocument();
  });

  it('shows a toast when inline channel creation fails', async () => {
    const userEventApi = userEvent.setup();
    vi.mocked(guildApi.createChannel).mockRejectedValue(new Error('Manage Channels is required.'));
    renderGuildChannelList();

    await userEventApi.click(screen.getByRole('button', { name: 'Create channel in Projects' }));
    await userEventApi.type(screen.getByLabelText('Channel name'), 'ops');
    await userEventApi.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Failed to create channel: Manage Channels is required.',
          }),
        ]),
      );
    });
    expect(screen.getByLabelText('Channel name')).toHaveValue('ops');
  });

  it('shows a toast when leaving a server fails', async () => {
    const userEventApi = userEvent.setup();
    resetStores({ owner_id: 'other-user' });
    vi.mocked(guildApi.leaveGuild).mockRejectedValue(new Error('Transfer ownership before leaving.'));
    renderGuildChannelList();

    await userEventApi.click(screen.getByRole('button', { name: 'Open server menu' }));
    await userEventApi.click(screen.getByRole('button', { name: 'Leave Server' }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Failed to leave server: Transfer ownership before leaving.',
          }),
        ]),
      );
    });
  });

  it('shows a toast when copying a server ID fails', async () => {
    const userEventApi = userEvent.setup();
    vi.mocked(writeClipboardText).mockRejectedValue(new Error('Clipboard permission denied.'));
    renderGuildChannelList();

    await userEventApi.click(screen.getByRole('button', { name: 'Open server menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy ID' }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(guild.id);
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Failed to copy server ID: Clipboard permission denied.',
          }),
        ]),
      );
    });
  });

  it('shows a toast when copying a channel ID fails', async () => {
    const userEventApi = userEvent.setup();
    vi.mocked(writeClipboardText).mockRejectedValue(new Error('Clipboard permission denied.'));
    renderGuildChannelList();

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /general/i }));
    await userEventApi.click(screen.getByRole('menuitem', { name: 'Copy ID' }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(textChannel.id);
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Failed to copy channel ID: Clipboard permission denied.',
          }),
        ]),
      );
    });
  });
});
