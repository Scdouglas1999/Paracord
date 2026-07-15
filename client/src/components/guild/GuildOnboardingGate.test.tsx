import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GuildOnboardingGate } from './GuildOnboardingGate';

const mocks = vi.hoisted(() => ({
  getMyOnboardingState: vi.fn(),
  updateMyOnboardingState: vi.fn(),
}));

vi.mock('../../api/guilds', () => ({
  guildApi: {
    getMyOnboardingState: mocks.getMyOnboardingState,
    updateMyOnboardingState: mocks.updateMyOnboardingState,
  },
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: {
    getState: () => ({
      fetchChannels: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe('GuildOnboardingGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles malformed onboarding payload without throwing', async () => {
    mocks.getMyOnboardingState.mockResolvedValueOnce({ data: [] });

    render(<GuildOnboardingGate guildId="guild-1" />);

    await waitFor(() => expect(mocks.getMyOnboardingState).toHaveBeenCalledWith('guild-1'));
    expect(screen.queryByRole('heading', { name: /welcome/i })).not.toBeInTheDocument();
  });

  it('renders onboarding UI when server returns configured payload', async () => {
    mocks.getMyOnboardingState.mockResolvedValueOnce({
      data: {
        settings: {
          welcome_title: 'Welcome to QA Guild',
          welcome_body: 'Read the rules and pick roles.',
          rules_text: 'Be respectful.',
          role_prompt: 'Pick roles',
          role_options: [{ id: 'opt-1', role_id: 'r1', label: 'Builder', description: null }],
        },
        member_state: {
          accepted_rules: false,
          selected_role_ids: [],
          completed_at: null,
        },
      },
    });

    render(<GuildOnboardingGate guildId="guild-1" />);

    await screen.findByRole('heading', { name: 'Welcome to QA Guild' });
    expect(screen.getByText('Read the rules and pick roles.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /complete onboarding/i })).toBeInTheDocument();
  });

  it('does not allow dismissing required rules onboarding', async () => {
    mocks.getMyOnboardingState.mockResolvedValueOnce({
      data: {
        settings: {
          welcome_title: 'Welcome',
          rules_text: 'Be respectful.',
          role_options: [],
        },
        member_state: {
          accepted_rules: false,
          selected_role_ids: [],
          completed_at: null,
        },
      },
    });

    render(<GuildOnboardingGate guildId="guild-1" />);

    await screen.findByRole('heading', { name: 'Welcome' });
    expect(screen.queryByRole('button', { name: /dismiss onboarding/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^later$/i })).not.toBeInTheDocument();
  });
});
