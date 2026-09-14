vi.mock('../../lib/guildNavigation', () => ({ guildLandingPath: vi.fn() }));
import { guildLandingPath } from '../../lib/guildNavigation';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/client';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { CreateGuildModal } from './CreateGuildModal';

const navigate = vi.fn();
const createGuild = vi.fn();
const addGuild = vi.fn();
const acceptInvite = vi.fn();
const applyTemplate = vi.fn();
const scope = { serverId: '__local__', userId: 'user-1' };
const fetchChannels = vi.fn();
const selectGuild = vi.fn();
const selectChannel = vi.fn();

vi.mock('react-router', () => ({
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
    acceptInvite.mockResolvedValue({ id: 'guild-joined', name: 'Joined Guild', scope });
    applyTemplate.mockResolvedValue({ id: 'guild-new', name: 'Launch HQ', scope });
    vi.mocked(guildLandingPath).mockImplementation(async guild => `/app/guilds/${guild.id}/channels/${guild.id === 'guild-created' ? 'channel-created' : guild.id === 'guild-joined' ? 'channel-joined' : 'channel-1'}`);
    createGuild.mockResolvedValue({ id: 'guild-created', name: 'Ada HQ', scope });
    addGuild.mockReturnValue(undefined);
    fetchChannels.mockResolvedValue(undefined);
    selectGuild.mockReturnValue(undefined);
    selectChannel.mockReturnValue(undefined);
    vi.mocked(useGuildStore.getState).mockReturnValue({
      createGuild,
      acceptInvite,
      applyTemplate,
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

    await user.clear(screen.getByLabelText('Server name'));
    await user.type(screen.getByLabelText('Server name'), 'Ada HQ');
    await user.click(screen.getAllByRole('button', { name: 'Create' }).at(-1)!);

    await waitFor(() => {
      expect(createGuild).toHaveBeenCalledWith('Ada HQ', scope, undefined);
    });
    expect(guildLandingPath).toHaveBeenCalledWith(expect.objectContaining({ id: 'guild-created', scope }));
    expect(navigate).toHaveBeenCalledWith('/app/guilds/guild-created/channels/channel-created');
    expect(onClose).toHaveBeenCalled();
  });

  it('accepts an invite from the join tab and navigates to the joined guild', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<CreateGuildModal onClose={onClose} />);

    await user.click(screen.getByRole('tab', { name: 'Join' }));
    await user.type(screen.getByLabelText('Invite link'), 'https://paracord.gg/launch');
    await user.click(screen.getByRole('button', { name: 'Join server' }));

    await waitFor(() => {
      expect(acceptInvite).toHaveBeenCalledWith('launch', scope);
    });
    expect(navigate).toHaveBeenCalledWith('/app/guilds/guild-joined/channels/channel-joined');
    expect(onClose).toHaveBeenCalled();
  });

  it('loads templates, previews details, and creates a server from a template', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<CreateGuildModal onClose={onClose} />);

    await user.click(screen.getByRole('tab', { name: 'Template' }));

    expect(await screen.findByRole('button', { name: 'Use template Ops Template' })).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/templates', { signal: expect.any(AbortSignal) });

    await user.click(screen.getByRole('button', { name: 'Use template Ops Template' }));

    expect(screen.getByText('Incident response and release coordination channels.')).toBeInTheDocument();
    expect(screen.getByText('incidents')).toBeInTheDocument();
    expect(screen.getByText('war-room')).toBeInTheDocument();
    expect(screen.getByText('Responder')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Template server name'));
    await user.type(screen.getByLabelText('Template server name'), 'Launch HQ');
    await user.click(screen.getByRole('button', { name: 'Create from Template' }));

    await waitFor(() => {
      expect(applyTemplate).toHaveBeenCalledWith('tpl-1', 'Launch HQ', scope);
    });
    expect(navigate).toHaveBeenCalledWith('/app/guilds/guild-new/channels/channel-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error when template loading fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockRejectedValue({
      response: { data: { message: 'Template service is offline.' } },
    });

    render(<CreateGuildModal onClose={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Template' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load templates: Template service is offline.',
    );
  });

  it('aborts template loading when the picker closes', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    const { unmount } = render(<CreateGuildModal onClose={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'Template' }));
    const signal = vi.mocked(apiClient.get).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

vi.mock('../../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useChannels')>('../../hooks/useChannels');
  const { useChannelStore } = await import('../../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore(state => state.channelsByGuild[id] ?? []),
  };
});
