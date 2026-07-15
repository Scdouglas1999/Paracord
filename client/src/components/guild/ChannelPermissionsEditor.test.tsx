import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import type { ChannelOverwrite, Role } from '../../types';
import { ChannelPermissionsEditor } from './ChannelPermissionsEditor';

vi.mock('../../api/channels', () => ({
  channelApi: {
    getOverwrites: vi.fn(),
    upsertOverwrite: vi.fn(),
    deleteOverwrite: vi.fn(),
  },
}));

vi.mock('../../stores/memberStore', () => ({
  useMemberStore: () => ({
    getMembersForGuild: () => [],
    fetchMembers: vi.fn(),
    membersLoaded: { 'guild-1': true },
  }),
}));

const roles: Role[] = [
  { id: 'guild-1', name: '@everyone', permissions: '0', color: 0, position: 0, hoist: false, mentionable: false },
  { id: 'role-mod', name: 'Moderators', permissions: '8', color: 0x5865f2, position: 1, hoist: false, mentionable: false },
] as Role[];

const everyoneOverwrite: ChannelOverwrite = {
  channel_id: 'channel-1',
  target_id: 'guild-1',
  target_type: 0,
  allow_perms: 0,
  deny_perms: 0,
};

function renderEditor() {
  return render(
    <ChannelPermissionsEditor
      channelId="channel-1"
      channelName="general"
      roles={roles}
      guildId="guild-1"
      onClose={vi.fn()}
    />,
  );
}

describe('ChannelPermissionsEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelApi.getOverwrites).mockResolvedValue({ data: [] } as never);
    vi.mocked(channelApi.upsertOverwrite).mockResolvedValue({ data: everyoneOverwrite } as never);
    vi.mocked(channelApi.deleteOverwrite).mockResolvedValue({ data: {} } as never);
  });

  it('shows concrete API details when overwrite loading fails', async () => {
    vi.mocked(channelApi.getOverwrites).mockRejectedValueOnce(
      new Error('Manage Channels permission is required.'),
    );

    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load permission overwrites: Manage Channels permission is required.',
    );
  });

  it('shows concrete API details when overwrite saving fails', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.getOverwrites).mockResolvedValue({ data: [everyoneOverwrite] } as never);
    vi.mocked(channelApi.upsertOverwrite).mockRejectedValueOnce(
      new Error('Cannot deny administrator permissions.'),
    );

    renderEditor();

    await user.click(await screen.findByRole('button', { name: '@everyone' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to save overwrite: Cannot deny administrator permissions.',
    );
  });

  it('explains inherited outcomes and updates the effective preview live', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.getOverwrites).mockResolvedValue({ data: [everyoneOverwrite] } as never);
    renderEditor();

    await user.click(await screen.findByRole('button', { name: '@everyone' }));
    expect(screen.getByText('0 allowed · 15 denied')).toBeInTheDocument();
    expect(screen.getByText('Combines the @everyone base role with this channel override.')).toBeInTheDocument();
    const viewRow = screen.getByTestId('permission-row-VIEW_CHANNEL');
    expect(within(viewRow).getByText('Inherited → denied')).toBeInTheDocument();

    await user.click(within(viewRow).getByRole('button', { name: 'Allow View Channel' }));
    expect(within(viewRow).getByText('Effective → allowed')).toBeInTheDocument();
    expect(screen.getByText('1 allowed · 14 denied')).toBeInTheDocument();
  });

  it('makes administrator bypass explicit in the preview', async () => {
    const user = userEvent.setup();
    const moderatorOverwrite: ChannelOverwrite = {
      ...everyoneOverwrite,
      target_id: 'role-mod',
    };
    vi.mocked(channelApi.getOverwrites).mockResolvedValue({ data: [moderatorOverwrite] } as never);
    renderEditor();

    await user.click(await screen.findByRole('button', { name: 'Moderators' }));
    expect(screen.getByText(/Administrator access bypasses channel overrides/i)).toBeInTheDocument();
    expect(screen.getByText('15 allowed · 0 denied')).toBeInTheDocument();
  });

  it('shows concrete API details when adding a role overwrite fails', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.upsertOverwrite).mockRejectedValueOnce(
      new Error('Role belongs to a different server.'),
    );

    renderEditor();

    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    await user.selectOptions(screen.getByRole('combobox'), 'role-mod');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to add role overwrite: Role belongs to a different server.',
    );
  });
});
