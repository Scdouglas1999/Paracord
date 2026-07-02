import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../types';
import { dmApi } from '../../api/dms';
import { guildApi } from '../../api/guilds';
import { relationshipApi } from '../../api/relationships';
import { UserProfilePopup } from './UserProfile';

vi.mock('../../api/client', () => ({
  apiClient: {
    get: vi.fn(() => Promise.reject(new Error('profile unavailable'))),
  },
  extractApiError: (err: unknown) => {
    const maybeResponse = err as { response?: { data?: { message?: string; error?: string } } };
    return maybeResponse.response?.data?.message
      ?? maybeResponse.response?.data?.error
      ?? (err instanceof Error ? err.message : 'Request failed');
  },
}));

vi.mock('../../api/dms', () => ({
  dmApi: {
    create: vi.fn(),
  },
}));

vi.mock('../../api/relationships', () => ({
  relationshipApi: {
    addFriend: vi.fn(),
    block: vi.fn(),
  },
}));

vi.mock('../../api/keys', () => ({
  keysApi: {
    getBundle: vi.fn(() => Promise.reject(new Error('no bundle'))),
  },
}));

vi.mock('../../api/guilds', () => ({
  guildApi: {
    createReport: vi.fn(),
  },
}));

vi.mock('../../stores/guildStore', () => ({
  useGuildStore: (selector: (state: { selectedGuildId: string }) => unknown) =>
    selector({ selectedGuildId: 'guild-1' }),
}));

const setDmChannels = vi.fn();
const selectChannel = vi.fn();

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: {
    getState: () => ({
      channelsByGuild: { '': [] },
      setDmChannels,
      selectChannel,
    }),
  },
}));

vi.mock('../../stores/presenceStore', () => ({
  usePresenceStore: (selector: (state: { getPresence: () => null }) => unknown) =>
    selector({ getPresence: () => null }),
}));

vi.mock('../../stores/serverListStore', () => {
  const useServerListStore = (selector: (state: { activeServerId: string }) => unknown) =>
    selector({ activeServerId: 'server-1' });
  // getApi() -> connectionManager.getActiveApiClient() reads getState(); with no
  // registered connection it resolves to the LOCAL-fallback apiClient (mocked).
  (useServerListStore as unknown as { getState: () => { activeServerId: string | null } }).getState =
    () => ({ activeServerId: null });
  return { useServerListStore };
});

vi.mock('../../stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,qr')),
  },
}));

const apiError = (message: string) => ({
  response: {
    data: { message },
  },
});

const targetUser = {
  id: 'user-2',
  username: 'Grace',
  discriminator: 42,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
} as User;

function renderProfile() {
  return render(
    <MemoryRouter>
      <UserProfilePopup
        user={targetUser}
        position={{ x: 400, y: 200 }}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('UserProfilePopup action feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dmApi.create).mockResolvedValue({
      data: { id: 'dm-1', type: 1, channel_type: 1, guild_id: null, name: null, position: 0 },
    } as never);
    vi.mocked(relationshipApi.addFriend).mockResolvedValue({ data: {} } as never);
    vi.mocked(relationshipApi.block).mockResolvedValue({ data: {} } as never);
    vi.mocked(guildApi.createReport).mockResolvedValue({ data: {} } as never);
  });

  it('shows API detail when starting a DM fails', async () => {
    const user = userEvent.setup();
    vi.mocked(dmApi.create).mockRejectedValue(apiError('Direct messages are disabled.'));

    renderProfile();

    await user.click(screen.getByRole('button', { name: 'Message' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not start a DM: Direct messages are disabled.',
    );
  });

  it('shows API detail when sending a friend request fails', async () => {
    const user = userEvent.setup();
    vi.mocked(relationshipApi.addFriend).mockRejectedValue(apiError('Friend requests are blocked.'));

    renderProfile();

    await user.click(screen.getByRole('button', { name: 'Add Grace as a friend' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not send a friend request: Friend requests are blocked.',
    );
  });

  it('shows API detail when blocking a user fails', async () => {
    const user = userEvent.setup();
    vi.mocked(relationshipApi.block).mockRejectedValue(apiError('Cannot block this account.'));

    renderProfile();

    await user.click(screen.getByRole('button', { name: 'Block Grace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not block this user: Cannot block this account.',
    );
  });

  it('shows API detail when report submission fails', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.createReport).mockRejectedValue(apiError('Moderation queue is offline.'));

    renderProfile();

    await user.click(screen.getByRole('button', { name: 'Report Grace' }));
    await user.type(screen.getByPlaceholderText('Explain why this user should be reviewed...'), 'spam');
    await user.click(screen.getByRole('button', { name: 'Submit Report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to submit report: Moderation queue is offline.',
    );
  });
});
