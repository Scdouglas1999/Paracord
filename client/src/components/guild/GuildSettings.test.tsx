import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildApi } from '../../api/guilds';
import { confirm } from '../../stores/confirmStore';
import type { Guild, Member } from '../../types';
import { GuildSettings } from './GuildSettings';

const GUILD_ID = 'guild-1';
const OWNER_ID = 'owner-1';
const CANDIDATE_ID = 'user-2';

const guild: Guild = {
  id: GUILD_ID,
  name: 'Test Guild',
  owner_id: OWNER_ID,
  member_count: 2,
  features: [],
  created_at: '2026-01-01T00:00:00.000Z',
};

const makeMember = (id: string, username: string): Member => ({
  user: { id, username, discriminator: 1, bot: false, system: false, flags: 0, created_at: '2026-01-01T00:00:00.000Z' },
  roles: [],
  joined_at: '2026-01-01T00:00:00.000Z',
  deaf: false,
  mute: false,
});

const removeGuild = vi.fn();
const leaveGuild = vi.fn();

vi.mock('../../api/guilds', () => ({
  guildApi: {
    get: vi.fn(),
    getRoles: vi.fn(),
    getMembers: vi.fn(),
    getChannels: vi.fn(),
    getInvites: vi.fn(),
    getBans: vi.fn(),
    getAuditLog: vi.fn(),
    getReports: vi.fn(),
    delete: vi.fn(),
    transferOwnership: vi.fn(),
  },
}));

vi.mock('../../api/invites', () => ({ inviteApi: { revoke: vi.fn() } }));
vi.mock('../../api/webhooks', () => ({ webhookApi: { listGuild: vi.fn(), listChannel: vi.fn() } }));
vi.mock('../../api/bots', () => ({ botApi: { listGuildBots: vi.fn(), list: vi.fn() } }));
vi.mock('../../api/emojis', () => ({ emojiApi: { listGuild: vi.fn() } }));
vi.mock('../../api/moderationTemplates', () => ({
  moderationTemplateApi: { list: vi.fn() },
  ACTION_TYPE_LABELS: {},
}));

vi.mock('../../stores/confirmStore', () => ({ confirm: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../stores/guildStore', () => ({
  useGuildStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ leaveGuild, removeGuild }),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: OWNER_ID, username: 'Owner' } }),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: false }),
  invalidateGuildPermissionCache: vi.fn(),
}));

vi.mock('../../hooks/useMobile', () => ({ useMobile: () => false }));

// Heavy section components render only on their own (non-overview) sections.
vi.mock('./EventList', () => ({ EventList: () => null }));
vi.mock('./ChannelManager', () => ({ ChannelManager: () => null }));
vi.mock('./FileStorageSection', () => ({ FileStorageSection: () => null }));
vi.mock('./ServerHubSettings', () => ({ ServerHubSettings: () => null }));
vi.mock('./BotStoreSection', () => ({ BotStoreSection: () => null }));
vi.mock('./OnboardingSettingsSection', () => ({ OnboardingSettingsSection: () => null }));
vi.mock('./EconomySettingsSection', () => ({ EconomySettingsSection: () => null }));

const renderSettings = (onClose = vi.fn()) =>
  render(
    <MemoryRouter>
      <GuildSettings guildId={GUILD_ID} guildName="Test Guild" onClose={onClose} />
    </MemoryRouter>,
  );

// Wait for the owner-only Danger Zone (rendered after refreshAll resolves the guild).
const findTransferButton = () => screen.findByRole('button', { name: 'Transfer' });

describe('GuildSettings destructive flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guildApi.get).mockResolvedValue({ data: guild } as never);
    vi.mocked(guildApi.getRoles).mockResolvedValue({ data: [] } as never);
    vi.mocked(guildApi.getMembers).mockResolvedValue({
      data: [makeMember(OWNER_ID, 'Owner'), makeMember(CANDIDATE_ID, 'Grace')],
    } as never);
    vi.mocked(guildApi.getChannels).mockResolvedValue({ data: [] } as never);
    vi.mocked(guildApi.getInvites).mockResolvedValue({ data: [] } as never);
    vi.mocked(guildApi.getBans).mockResolvedValue({ data: [] } as never);
    vi.mocked(guildApi.getAuditLog).mockResolvedValue({ data: { audit_log_entries: [] } } as never);
    vi.mocked(guildApi.delete).mockResolvedValue({ data: {} } as never);
    vi.mocked(guildApi.transferOwnership).mockResolvedValue({ data: {} } as never);
  });

  it('does not transfer ownership when the confirm dialog is cancelled', async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(false);
    renderSettings();

    await user.click(await findTransferButton());

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(guildApi.transferOwnership).not.toHaveBeenCalled();
  });

  it('transfers ownership to the selected member when confirmed', async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(true);
    renderSettings();

    await user.click(await findTransferButton());

    await waitFor(() =>
      expect(guildApi.transferOwnership).toHaveBeenCalledWith(GUILD_ID, CANDIDATE_ID),
    );
  });

  it('gates guild deletion until the confirmation name matches, then deletes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSettings(onClose);

    await user.click(await screen.findByRole('button', { name: 'Delete space' }));

    const input = await screen.findByPlaceholderText('Test Guild');
    const confirmBtn = screen.getByRole('button', { name: 'Delete Server' });

    // Wrong name keeps the confirm button disabled and blocks the API.
    await user.type(input, 'Wrong');
    expect(confirmBtn).toBeDisabled();
    expect(guildApi.delete).not.toHaveBeenCalled();

    // Exact match unlocks deletion.
    await user.clear(input);
    await user.type(input, 'Test Guild');
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);

    await waitFor(() => expect(guildApi.delete).toHaveBeenCalledWith(GUILD_ID));
    expect(removeGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancelling the delete dialog issues no delete request', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: 'Delete space' }));
    const input = await screen.findByPlaceholderText('Test Guild');
    await user.type(input, 'Test Guild');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByPlaceholderText('Test Guild')).not.toBeInTheDocument();
    expect(guildApi.delete).not.toHaveBeenCalled();
  });
});
