import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../types';
import { dmApi } from '../../api/dms';
import { guildApi } from '../../api/guilds';
import { relationshipApi } from '../../api/relationships';
import { writeClipboardText } from '../../lib/clipboard';
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

// An avatar subscribes to the download ticket, which mints one over the network.
vi.mock('../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

vi.mock('../../lib/clipboard', () => ({ writeClipboardText: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../../api/dms', () => ({
  dmApi: {
    create: vi.fn(),
  },
}));

vi.mock('../../api/relationships', () => ({
  relationshipApi: {
    addFriend: vi.fn(),
    block: vi.fn(),
    accept: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(() => Promise.resolve({ data: [] })),
  },
}));

vi.mock('../../stores/relationshipStore', () => {
  const state = {
    relationships: [] as Array<{ id: string; type: number; user: { id: string; username: string } }>,
    fetchRelationships: vi.fn(async () => undefined),
    addFriend: vi.fn(async () => undefined),
    acceptFriend: vi.fn(async () => undefined),
    removeFriend: vi.fn(async () => undefined),
  };
  const useRelationshipStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useRelationshipStore };
});

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
  useGuildStore: (selector: (state: { selectedGuild: { id: string; scope: { serverId: string; userId: string } } }) => unknown) =>
    selector({ selectedGuild: { id: 'guild-1', scope: { serverId: 'server-1', userId: 'self' } } }),
}));

const setDmChannels = vi.fn();
const selectChannel = vi.fn();

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: {
    getState: () => ({
      channelsByGuild: { '': [] },
      createDm: async (id: string) => (await dmApi.create(id)).data,
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
  const useServerListStore = (selector: (state: { activeServerId: string; servers: unknown[] }) => unknown) =>
    selector({ activeServerId: 'server-1', servers: [{ id: 'server-1', token: 'token', userId: 'self', user: { id: 'self' } }] });
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

  it('is a dialog on the window (portaled out of main), 340 wide, inside the viewport', () => {
    const { container } = renderProfile();

    // Portaled: main is a layout container, which would place and clip a fixed card.
    expect(container.querySelector('[data-testid="ix-profile-card"]')).toBeNull();
    const card = screen.getByRole('dialog', { name: /Grace, profile/ });
    expect(card.parentElement).toBe(document.body);
    expect(card).toHaveClass('ix-profile');
    const left = Number.parseFloat(card.style.left);
    // Opened at x 400 with room to its left: the card sits left of the point.
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 340).toBeLessThanOrEqual(window.innerWidth - 8 + 0.5);
  });

  it('draws their avatar (a letter, no picture) and says how they are here, in words and as ink', () => {
    renderProfile();

    // The Index avatar: one letter on their hue, 76px. Offline draws no dot, and the
    // words say it: the state is never only a mark (§10).
    const avatar = document.querySelector('.ix-profile__avatar .ix-av');
    expect(avatar).toHaveTextContent('G');
    expect(avatar).toHaveStyle({ width: '76px', height: '76px' });
    expect(document.querySelector('.ix-profile__avatar .ix-presence')).toBeNull();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(document.querySelector('[title="Status: Offline"]')).not.toBeNull();
  });

  // The card's own height cap used to be an absolute `100dvh - 1rem`, which
  // ignores where the card starts: a profile taller than the layout estimate
  // (every enrolled account's, once the identity fingerprint section renders)
  // hung past the bottom of the window with Block and Report unreachable.
  it('caps its height by the room left below where it opens', () => {
    render(
      <MemoryRouter>
        <UserProfilePopup user={targetUser} position={{ x: 400, y: 500 }} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    const card = screen.getByRole('dialog', { name: /Grace, profile/ });
    const top = Number.parseFloat(card.style.top);
    expect(card.style.maxHeight).toBe(`calc(100dvh - ${Math.round(top) + 8}px)`);
  });

  // The click-away catcher is `fixed inset-0` and swallows every pointer event
  // under it, so a card opened from the keyboard could not be put down again.
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <UserProfilePopup user={targetUser} position={{ x: 400, y: 100 }} onClose={onClose} />
      </MemoryRouter>,
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('has Message as the one cream action, with Add friend, Call and More actions beside it', () => {
    renderProfile();
    const message = screen.getByRole('button', { name: 'Message' });
    expect(message).toHaveClass('ix-cream');
    expect(screen.getByRole('button', { name: 'Add Grace as a friend' })).toHaveClass('ix-ctl--wide');
    expect(screen.getByRole('button', { name: 'Call Grace' })).toHaveClass('ix-ctl');
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-haspopup', 'menu');
    // Exactly one cream button on the surface.
    expect(document.querySelectorAll('.ix-profile .ix-cream')).toHaveLength(1);
  });

  it('keeps Block, Report, Verify and Copy user ID in the more-actions menu', async () => {
    const user = userEvent.setup();
    renderProfile();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'Grace actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Copy user ID' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Block' })).toHaveAttribute('data-danger');
    expect(within(menu).getByRole('menuitem', { name: 'Report' })).toHaveAttribute('data-danger');
    // No fingerprint is known for this account, so there is nothing to verify.
    expect(within(menu).queryByRole('menuitem', { name: 'Verify keys' })).not.toBeInTheDocument();
  });

  it('copies the user id from the menu', async () => {
    const user = userEvent.setup();
    renderProfile();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy user ID' }));
    expect(writeClipboardText).toHaveBeenCalledWith('user-2');
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
    const { useRelationshipStore } = await import('../../stores/relationshipStore');
    vi.mocked(useRelationshipStore.getState().addFriend).mockRejectedValue(
      apiError('Friend requests are blocked.'),
    );

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

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Block' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not block this user: Cannot block this account.',
    );
  });

  it('shows API detail when report submission fails', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.createReport).mockRejectedValue(apiError('Moderation queue is offline.'));

    renderProfile();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Report' }));
    await user.type(screen.getByPlaceholderText('Explain why this user should be reviewed...'), 'spam');
    await user.click(screen.getByRole('button', { name: 'Submit report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to submit report: Moderation queue is offline.',
    );
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
