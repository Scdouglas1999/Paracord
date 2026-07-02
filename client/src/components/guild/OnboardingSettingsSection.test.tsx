import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildApi } from '../../api/guilds';
import type { Role } from '../../types';
import { toast } from '../../stores/toastStore';
import { OnboardingSettingsSection } from './OnboardingSettingsSection';

vi.mock('../../api/guilds', () => ({
  guildApi: {
    getOnboarding: vi.fn(),
    updateOnboarding: vi.fn(),
  },
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: vi.fn(),
  },
}));

const roles: Role[] = [
  { id: 'guild-1', name: '@everyone', permissions: '0', color: 0, position: 0, hoist: false, mentionable: false },
  { id: 'role-high', name: 'Admin', permissions: '8', color: 0, position: 3, hoist: false, mentionable: false },
  { id: 'role-low', name: 'Contributor', permissions: '0', color: 0, position: 1, hoist: false, mentionable: false },
] as Role[];

describe('OnboardingSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guildApi.getOnboarding).mockResolvedValue({
      data: {
        welcome_title: 'Welcome aboard',
        welcome_body: 'Start here.',
        rules_text: 'Be kind.',
        role_prompt: 'Choose your path',
        progressive_channel_min_messages: 2,
        role_options: [{ id: 'opt-1', role_id: 'role-low', label: 'Contributor', description: null, position: 0 }],
      },
    } as never);
    vi.mocked(guildApi.updateOnboarding).mockResolvedValue({ data: {} } as never);
  });

  it('loads settings, edits role options, clamps message threshold, and saves', async () => {
    const user = userEvent.setup();

    render(<OnboardingSettingsSection guildId="guild-1" roles={roles} />);

    expect(await screen.findByDisplayValue('Welcome aboard')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Start here.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Be kind.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Choose your path')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Contributor' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Admin' })).not.toBeChecked();
    expect(screen.queryByText('@everyone')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Welcome Title'));
    await user.type(screen.getByLabelText('Welcome Title'), 'Launch Guide');
    fireEvent.change(screen.getByLabelText('Progressive Channel Minimum Messages'), {
      target: { value: '-5', valueAsNumber: -5 },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Contributor' }));
    await user.click(screen.getByRole('checkbox', { name: 'Admin' }));
    await user.click(screen.getByRole('button', { name: 'Save Onboarding Settings' }));

    await waitFor(() => {
      expect(guildApi.updateOnboarding).toHaveBeenCalledWith('guild-1', {
        welcome_title: 'Launch Guide',
        welcome_body: 'Start here.',
        rules_text: 'Be kind.',
        role_prompt: 'Choose your path',
        progressive_channel_min_messages: 0,
        role_options: [
          {
            role_id: 'role-high',
            label: 'Admin',
            description: undefined,
            position: 0,
          },
        ],
      });
    });
    expect(toast.success).toHaveBeenCalledWith('Onboarding settings saved.');
  });

  it('shows a user-visible error when settings fail to load', async () => {
    vi.mocked(guildApi.getOnboarding).mockRejectedValue(new Error('Onboarding unavailable.'));

    render(<OnboardingSettingsSection guildId="guild-1" roles={roles} />);

    expect(await screen.findByText('Onboarding unavailable.')).toBeInTheDocument();
  });
});
