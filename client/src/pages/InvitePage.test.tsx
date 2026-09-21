import { guildLandingPath } from '../lib/guildNavigation';
vi.mock('../lib/guildNavigation', () => ({ guildLandingPath: vi.fn() }));
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvitePage } from './InvitePage';

const mockAuthState = vi.hoisted(() => ({
  token: 'auth-token' as string | null,
  user: { id: 'user-1', username: 'User' },
}));

const mockInviteApi = vi.hoisted(() => ({
  get: vi.fn(),
  accept: vi.fn(),
}));

const mockGuildState = vi.hoisted(() => ({
  acceptInvite: vi.fn(),
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
  connectionStatus: 'connected' as string,
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

const mockHistory = vi.hoisted(() => ({ known: true }));
vi.mock('../lib/databaseHistory', () => ({
  subscribeDatabaseHistory: () => () => {},
  getDatabaseHistoryEpoch: () => (mockHistory.known ? 'epoch' : null),
}));

vi.mock('../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (state: typeof mockUIState) => unknown) => selector(mockUIState),
    { getState: vi.fn(() => mockUIState) },
  ),
}));

const invitePreview = {
  code: 'abc123',
  guild: {
    id: 'guild-1',
    name: 'Launch Guild',
    member_count: 42,
    default_channel_id: null,
  },
  join_gate: null as null | { require_ack: boolean; questions: string[] },
};

function renderInvitePage(entry = '/invite/abc123') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route path="/login" element={<div>Login page</div>} />
        <Route path="/register" element={<div>Register page</div>} />
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<div>Guild channel</div>} />
        <Route path="/app" element={<div>App shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockUIState.connectionStatus = 'connected';
    mockHistory.known = true;
    mockAuthState.token = 'auth-token';
    mockInviteApi.get.mockResolvedValue({ data: invitePreview });
    mockGuildState.acceptInvite.mockResolvedValue({ ...invitePreview.guild, scope: { serverId: '__local__', userId: 'user-1' } });
    vi.mocked(guildLandingPath).mockResolvedValue('/app/guilds/guild-1/channels/channel-1');
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

  it('offers somebody with no account a way to make one, and keeps the sign-in path', async () => {
    const user = userEvent.setup();
    mockAuthState.token = null;

    renderInvitePage();

    expect(await screen.findByText('Launch Guild')).toBeInTheDocument();
    // An ordinary server asks a newcomer for nothing at all.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create an account to join' }));
    expect(await screen.findByText('Register page')).toBeInTheDocument();
    expect(sessionStorage.getItem('paracord:pending-invite')).toBe('abc123');
    expect(mockInviteApi.accept).not.toHaveBeenCalled();
  });

  it('sends somebody who already has an account to sign in', async () => {
    const user = userEvent.setup();
    mockAuthState.token = null;

    renderInvitePage();

    await user.click(await screen.findByRole('button', { name: 'I already have an account' }));
    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('joins an ungated server with one press and nothing to fill in', async () => {
    const user = userEvent.setup();

    renderInvitePage();

    expect(await screen.findByText('Launch Guild')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));

    await waitFor(() =>
      expect(mockGuildState.acceptInvite).toHaveBeenCalledWith(
        'abc123',
        { serverId: '__local__', userId: 'user-1' },
        { verification_ack: undefined, verification_answers: undefined },
      ),
    );
    expect(await screen.findByText('Guild channel')).toBeInTheDocument();
  });

  it('joins without another press when they came back from making an account', async () => {
    renderInvitePage('/invite/abc123?joining=1');

    await waitFor(() => expect(mockGuildState.acceptInvite).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Guild channel')).toBeInTheDocument();
  });

  it('waits until it knows which history it is talking to, not just for the stream to open', async () => {
    mockHistory.known = false;
    renderInvitePage('/invite/abc123?joining=1');

    expect(await screen.findByText('Launch Guild')).toBeInTheDocument();
    expect(mockGuildState.acceptInvite).not.toHaveBeenCalled();
  });

  it('waits for the connection before joining on its own', async () => {
    mockUIState.connectionStatus = 'connecting';
    renderInvitePage('/invite/abc123?joining=1');

    expect(await screen.findByText('Launch Guild')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeDisabled();
    expect(mockGuildState.acceptInvite).not.toHaveBeenCalled();
  });

  describe('a server whose owner turned the join gate on', () => {
    beforeEach(() => {
      mockInviteApi.get.mockResolvedValue({
        data: {
          ...invitePreview,
          join_gate: { require_ack: true, questions: ['Who invited you?', 'Are you over 13?'] },
        },
      });
    });

    it('shows the actual questions and will not accept until they and the rules are answered', async () => {
      const user = userEvent.setup();

      renderInvitePage('/invite/abc123?joining=1');

      // The box arrives empty, and Accept waits for it — and coming back from
      // sign-up must not skip a gate the server will enforce anyway.
      expect(await screen.findByLabelText(/Who invited you\?/)).toBeInTheDocument();
      expect(screen.getByRole('checkbox')).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Accept invite' })).toBeDisabled();
      expect(mockGuildState.acceptInvite).not.toHaveBeenCalled();

      await user.type(screen.getByLabelText(/Who invited you\?/), 'Ada');
      await user.type(screen.getByLabelText(/Are you over 13\?/), 'yes');
      expect(screen.getByRole('button', { name: 'Accept invite' })).toBeDisabled();
      await user.click(screen.getByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Accept invite' }));

      await waitFor(() =>
        expect(mockGuildState.acceptInvite).toHaveBeenCalledWith(
          'abc123',
          { serverId: '__local__', userId: 'user-1' },
          { verification_ack: true, verification_answers: ['Ada', 'yes'] },
        ),
      );
      expect(guildLandingPath).toHaveBeenCalledWith(expect.objectContaining({ id: 'guild-1' }));
    });
  });
});

vi.mock('../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChannels')>('../hooks/useChannels');
  const { useChannelStore } = await import('../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore(state => state.channelsByGuild[id] ?? []),
  };
});
