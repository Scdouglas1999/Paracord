import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { economyApi } from '../../api/economy';
import type { Role } from '../../types';
import { toast } from '../../stores/toastStore';
import { EconomySettingsSection } from './EconomySettingsSection';

vi.mock('../../api/economy', () => ({
  economyApi: {
    getLevelRoles: vi.fn(),
    updateLevelRoles: vi.fn(),
  },
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: vi.fn(),
  },
}));

const roles: Role[] = [
  { id: 'guild-1', name: '@everyone', permissions: '0', color: 0, position: 0, hoist: false, mentionable: false },
  { id: 'role-mod', name: 'Moderator', permissions: '8', color: 0, position: 1, hoist: false, mentionable: false },
  { id: 'role-vip', name: 'VIP', permissions: '0', color: 0, position: 2, hoist: false, mentionable: false },
] as Role[];

describe('EconomySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(economyApi.getLevelRoles).mockResolvedValue({
      data: {
        guild_id: 'guild-1',
        mappings: [{ level: 3, role_id: 'role-mod' }],
      },
    } as never);
    vi.mocked(economyApi.updateLevelRoles).mockResolvedValue({
      data: {
        guild_id: 'guild-1',
        mappings: [],
      },
    } as never);
  });

  it('loads level-role mappings, edits them locally, and saves', async () => {
    const user = userEvent.setup();

    render(<EconomySettingsSection guildId="guild-1" roles={roles} />);

    expect(await screen.findByText('LVL 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove level 3 reward for Moderator' })).toBeInTheDocument();
    expect(screen.queryByText('@everyone')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Level'), '5');
    await user.selectOptions(screen.getByLabelText('Role'), 'role-vip');
    await user.click(screen.getByRole('button', { name: 'Add reward' }));

    expect(screen.getByText('LVL 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove level 5 reward for VIP' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove level 3 reward for Moderator' }));
    expect(screen.queryByText('LVL 3')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(economyApi.updateLevelRoles).toHaveBeenCalledWith('guild-1', [
        { level: 5, role_id: 'role-vip' },
      ]);
    });
    expect(toast.success).toHaveBeenCalledWith('Economy settings saved.');
  });

  it('shows a user-visible error when level-role mappings fail to load', async () => {
    vi.mocked(economyApi.getLevelRoles).mockRejectedValue(new Error('Economy settings unavailable.'));

    render(<EconomySettingsSection guildId="guild-1" roles={roles} />);

    expect(await screen.findByText('Economy settings unavailable.')).toBeInTheDocument();
  });
});
