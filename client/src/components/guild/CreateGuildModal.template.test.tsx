import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/client';
import { inviteApi } from '../../api/invites';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { CreateGuildModal } from './CreateGuildModal';

const navigate = vi.fn();
const createGuild = vi.fn();
const addGuild = vi.fn();
const fetchChannels = vi.fn();
const selectGuild = vi.fn();
const selectChannel = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

vi.mock('../../api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
  extractApiError: vi.fn((err: { response?: { data?: { error?: string; message?: string } }; message?: string }) =>
    err?.response?.data?.message || err?.response?.data?.error || err?.message || 'request failed',
  ),
}));

vi.mock('../../api/invites', () => ({
  inviteApi: {
    accept: vi.fn(),
  },
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'user-1', username: 'Ada' } }),
}));

vi.mock('../../stores/guildStore', () => ({
  useGuildStore: {
    getState: vi.fn(),
  },
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: {
    getState: vi.fn(),
  },
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: {
    getState: () => ({
      setGuildSettingsId: vi.fn(),
    }),
  },
}));

vi.mock('../../lib/security', () => ({
  isAllowedImageMimeType: vi.fn(() => true),
}));

const template = {
  id: 'tpl-1',
  name: 'Ops Template',
  description: 'Incident response and release coordination channels.',
  creator_id: 'user-1',
  source_guild_id: 'guild-source',
  usage_count: 2,
  created_at: '2026-05-17T00:00:00Z',
  template_data: {
    channels: [
      { name: 'operations', type: 4, position: 0, parent_name: null },
      { name: 'incidents', type: 0, position: 1, parent_name: 'operations' },
      { name: 'war-room', type: 2, position: 2, parent_name: 'operations' },
    ],
    roles: [
      { name: 'Responder', permissions: '8', color: 0xff5500, position: 1 },
    ],
  },
};

describe('CreateGuildModal template tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue({ data: [template] } as never);
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'guild-new', name: 'Launch HQ' } } as never);
    vi.mocked(inviteApi.accept).mockResolvedValue({ data: { guild: { id: 'guild-joined', name: 'Joined Guild' } } } as never);
    createGuild.mockResolvedValue({ id: 'guild-created', name: 'Ada HQ' });
    addGuild.mockReturnValue(undefined);
    fetchChannels.mockResolvedValue(undefined);
    selectGuild.mockReturnValue(undefined);
    selectChannel.mockReturnValue(undefined);
    vi.mocked(useGuildStore.getState).mockReturnValue({
      createGuild,
      addGuild,
    } as never);
    vi.mocked(useChannelStore.getState).mockReturnValue({
      fetchChannels,
      channelsByGuild: {
        'guild-new': [
          { id: 'channel-1', name: 'incidents', type: 0, channel_type: 0 },
        ],
        'guild-created': [
          { id: 'channel-created', name: 'general', type: 0, channel_type: 0 },
        ],
        'guild-joined': [
          { id: 'channel-joined', name: 'welcome', type: 0, channel_type: 0 },
        ],
      },
      selectGuild,
      selectChannel,
    } as never);
  });

  it('creates a server from the create tab and navigates to its first channel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<CreateGuildModal onClose={onClose} />);

    await user.clear(screen.getByLabelText('Space name'));
    await user.type(screen.getByLabelText('Space name'), 'Ada HQ');
    await user.click(screen.getAllByRole('button', { name: 'Create' }).at(-1)!);

    await waitFor(() => {
      expect(createGuild).toHaveBeenCalledWith('Ada HQ', undefined);
    });
    expect(fetchChannels).toHaveBeenCalledWith('guild-created');
    expect(selectGuild).toHaveBeenCalledWith('guild-created');
    expect(selectChannel).toHaveBeenCalledWith('channel-created');
    expect(navigate).toHaveBeenCalledWith('/app/guilds/guild-created/channels/channel-created');
    expect(onClose).toHaveBeenCalled();
  });

  it('accepts an invite from the join tab and navigates to the joined guild', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<CreateGuildModal onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Join' }));
    await user.type(screen.getByLabelText('Invite Link'), 'https://paracord.gg/launch');
    await user.click(screen.getByRole('button', { name: 'Join space' }));

    await waitFor(() => {
      expect(inviteApi.accept).toHaveBeenCalledWith('launch');
    });
    expect(addGuild).toHaveBeenCalledWith({ id: 'guild-joined', name: 'Joined Guild' });
    expect(fetchChannels).toHaveBeenCalledWith('guild-joined');
    expect(selectGuild).toHaveBeenCalledWith('guild-joined');
    expect(selectChannel).toHaveBeenCalledWith('channel-joined');
    expect(navigate).toHaveBeenCalledWith('/app/guilds/guild-joined/channels/channel-joined');
    expect(onClose).toHaveBeenCalled();
  });

  it('loads templates, previews details, and creates a server from a template', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<CreateGuildModal onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Template' }));

    expect(await screen.findByRole('button', { name: 'Use template Ops Template' })).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/templates');

    await user.click(screen.getByRole('button', { name: 'Use template Ops Template' }));

    expect(screen.getByText('Incident response and release coordination channels.')).toBeInTheDocument();
    expect(screen.getByText('incidents')).toBeInTheDocument();
    expect(screen.getByText('war-room')).toBeInTheDocument();
    expect(screen.getByText('Responder')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Template space name'));
    await user.type(screen.getByLabelText('Template space name'), 'Launch HQ');
    await user.click(screen.getByRole('button', { name: 'Create from Template' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/templates/tpl-1/apply', { name: 'Launch HQ' });
    });
    expect(useGuildStore.getState().addGuild).toHaveBeenCalledWith({ id: 'guild-new', name: 'Launch HQ' });
    expect(useChannelStore.getState().fetchChannels).toHaveBeenCalledWith('guild-new');
    expect(useChannelStore.getState().selectGuild).toHaveBeenCalledWith('guild-new');
    expect(useChannelStore.getState().selectChannel).toHaveBeenCalledWith('channel-1');
    expect(navigate).toHaveBeenCalledWith('/app/guilds/guild-new/channels/channel-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error when template loading fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockRejectedValue({
      response: { data: { message: 'Template service is offline.' } },
    });

    render(<CreateGuildModal onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Template' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load templates: Template service is offline.',
    );
  });
});
