import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvitePage } from './InvitePage';

const mockAuthState = vi.hoisted(() => ({
  token: 'auth-token' as string | null,
}));

const mockInviteApi = vi.hoisted(() => ({
  get: vi.fn(),
  accept: vi.fn(),
}));

const mockGuildState = vi.hoisted(() => ({
  addGuild: vi.fn(),
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {
    'guild-1': [{ id: 'channel-1', guild_id: 'guild-1', type: 0, name: 'general' }],
  },
  fetchChannels: vi.fn(),
  selectGuild: vi.fn(),
  selectChannel: vi.fn(),
}));

const mockUIState = vi.hoisted(() => ({
  setGuildSettingsId: vi.fn(),
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (state: typeof mockAuthState) => unknown) =>
    selector(mockAuthState),
}));

vi.mock('../api/invites', () => ({
  inviteApi: mockInviteApi,
}));

vi.mock('../api/client', () => ({
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Request failed'),
}));

vi.mock('../stores/guildStore', () => ({
  useGuildStore: {
    getState: vi.fn(() => mockGuildState),
  },
}));

vi.mock('../stores/channelStore', () => ({
  useChannelStore: {
    getState: vi.fn(() => mockChannelState),
  },
}));

vi.mock('../stores/uiStore', () => ({
  useUIStore: {
    getState: vi.fn(() => mockUIState),
  },
}));

const invitePreview = {
  code: 'abc123',
  guild: {
    id: 'guild-1',
    name: 'Launch Guild',
    member_count: 42,
    default_channel_id: null,
  },
};

function renderInvitePage() {
  render(
    <MemoryRouter initialEntries={['/invite/abc123']}>
      <Routes>
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route path="/login" element={<div>Login page</div>} />
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<div>Guild channel</div>} />
        <Route path="/app" element={<div>App shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.token = 'auth-token';
    mockInviteApi.get.mockResolvedValue({ data: invitePreview });
    mockInviteApi.accept.mockResolvedValue({ data: { guild: invitePreview.guild } });
    mockChannelState.channelsByGuild = {
      'guild-1': [{ id: 'channel-1', guild_id: 'guild-1', type: 0, name: 'general' }],
    };
    mockChannelState.fetchChannels.mockResolvedValue(undefined);
  });

  it('shows preview load failures and keeps accept disabled without invite data', async () => {
    mockInviteApi.get.mockRejectedValue(new Error('Invite expired'));

    renderInvitePage();

    expect(await screen.findByText('Failed to load invite: Invite expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeDisabled();
    expect(mockInviteApi.accept).not.toHaveBeenCalled();
  });

  it('sends unauthenticated users to login after invite preview loads', async () => {
    const user = userEvent.setup();
    mockAuthState.token = null;

    renderInvitePage();

    expect(await screen.findByText('Launch Guild')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));

    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(mockInviteApi.accept).not.toHaveBeenCalled();
  });

  it('accepts an invite with verification payload and selects the first text channel', async () => {
    const user = userEvent.setup();

    renderInvitePage();

    expect(await screen.findByText('Launch Guild')).toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText(/Verification answers/),
      'I accept the rules\nI am over 13',
    );
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));

    await waitFor(() =>
      expect(mockInviteApi.accept).toHaveBeenCalledWith('abc123', {
        verification_ack: true,
        verification_answers: ['I accept the rules', 'I am over 13'],
      }),
    );
    expect(mockGuildState.addGuild).toHaveBeenCalledWith(invitePreview.guild);
    expect(mockChannelState.fetchChannels).toHaveBeenCalledWith('guild-1');
    expect(mockChannelState.selectGuild).toHaveBeenCalledWith('guild-1');
    expect(mockChannelState.selectChannel).toHaveBeenCalledWith('channel-1');
    expect(await screen.findByText('Guild channel')).toBeInTheDocument();
  });
});
