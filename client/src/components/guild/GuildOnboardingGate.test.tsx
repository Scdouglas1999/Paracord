import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toast } from '../../stores/toastStore';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach } from 'vitest';
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

  describe('as a page', () => {
    afterEach(() => {
      cleanup();
      document.body.innerHTML = '';
    });

    const configured = (over: Record<string, unknown> = {}, member: Record<string, unknown> = {}) => ({
      data: {
        settings: {
          welcome_title: 'Welcome to QA Guild',
          welcome_body: 'Read the rules and pick roles.',
          rules_text: 'Be respectful.',
          role_prompt: 'Pick what you play',
          role_options: [
            { id: 'o1', role_id: 'r1', label: 'Shooters', description: 'Ranked nights.' },
            { id: 'o2', role_id: 'r2', label: 'Co-op', description: null },
          ],
          ...over,
        },
        member_state: { accepted_rules: false, selected_role_ids: [], completed_at: null, ...member },
      },
    });

    it('is a page, not a dialog: a region with the title, the rules and the roles', async () => {
      mocks.getMyOnboardingState.mockResolvedValueOnce(configured());
      render(<GuildOnboardingGate guildId="guild-1" />);
      const page = await screen.findByRole('region', { name: 'Getting started' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(within(page).getByRole('heading', { level: 1, name: 'Welcome to QA Guild' })).toBeInTheDocument();
      expect(within(page).getByRole('heading', { level: 2, name: 'Server rules' })).toBeInTheDocument();
      expect(within(page).getByRole('heading', { level: 2, name: 'Pick what you play' })).toBeInTheDocument();
      expect(within(page).getByLabelText(/Shooters/)).not.toBeChecked();
    });

    it('holds Complete until the rules are accepted, saves what was chosen, and leaves', async () => {
      mocks.getMyOnboardingState.mockResolvedValueOnce(configured());
      mocks.updateMyOnboardingState.mockResolvedValueOnce({ data: {} });
      render(<GuildOnboardingGate guildId="guild-1" />);
      const page = await screen.findByRole('region', { name: 'Getting started' });
      const complete = within(page).getByRole('button', { name: 'Complete onboarding' });
      expect(complete).toBeDisabled();
      expect(within(page).getByRole('status')).toHaveTextContent('Accept the server rules to continue.');
      fireEvent.click(within(page).getByLabelText('I have read and agree to follow these rules.'));
      fireEvent.click(within(page).getByLabelText(/Shooters/));
      expect(complete).toBeEnabled();
      expect(within(page).getByRole('status')).toHaveTextContent('1 role selected');
      fireEvent.click(complete);
      await waitFor(() =>
        expect(mocks.updateMyOnboardingState).toHaveBeenCalledWith('guild-1', {
          accepted_rules: true,
          selected_role_ids: ['r1'],
          completed: true,
        }),
      );
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument());
      expect(toast.success).toHaveBeenCalledWith('Onboarding complete.');
    });

    it('says why it could not save, on the page, and stays', async () => {
      mocks.getMyOnboardingState.mockResolvedValueOnce(configured());
      mocks.updateMyOnboardingState.mockRejectedValueOnce({ response: { data: { message: 'Rules were edited. Read them again.' } } });
      render(<GuildOnboardingGate guildId="guild-1" />);
      const page = await screen.findByRole('region', { name: 'Getting started' });
      fireEvent.click(within(page).getByLabelText('I have read and agree to follow these rules.'));
      fireEvent.click(within(page).getByRole('button', { name: 'Complete onboarding' }));
      // Whatever the server said, the page says it where the person is looking, and stays.
      expect(await within(page).findByRole('alert')).toHaveTextContent(/\S/);
      expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    });

    it('offers Later, and Esc, when there are no rules to hold it', async () => {
      mocks.getMyOnboardingState.mockResolvedValue(configured({ rules_text: null }));
      const { unmount } = render(<GuildOnboardingGate guildId="guild-1" />);
      await screen.findByRole('region', { name: 'Getting started' });
      fireEvent.click(screen.getByRole('button', { name: 'Later' }));
      expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
      unmount();

      render(<GuildOnboardingGate guildId="guild-1" />);
      await screen.findByRole('region', { name: 'Getting started' });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    });

    it('does not let Esc past a required rules gate', async () => {
      mocks.getMyOnboardingState.mockResolvedValueOnce(configured());
      render(<GuildOnboardingGate guildId="guild-1" />);
      await screen.findByRole('region', { name: 'Getting started' });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    });

    it('shows nothing for a member who has finished', async () => {
      mocks.getMyOnboardingState.mockResolvedValueOnce(configured({}, { completed_at: '2026-10-01T00:00:00Z', accepted_rules: true }));
      render(<GuildOnboardingGate guildId="guild-1" />);
      await waitFor(() => expect(mocks.getMyOnboardingState).toHaveBeenCalled());
      expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    });

    it('goes over the routed page in the frame, keeps what it covers out of reach, and gives it back', async () => {
      document.body.innerHTML = '<div class="ix-main__content"><div id="behind"><button>behind</button></div></div>';
      mocks.getMyOnboardingState.mockResolvedValueOnce(configured());
      mocks.updateMyOnboardingState.mockResolvedValueOnce({ data: {} });
      const host = document.querySelector('.ix-main__content') as HTMLElement;
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      render(<GuildOnboardingGate guildId="guild-1" />, { container: mount });
      const page = await screen.findByRole('region', { name: 'Getting started' });
      // Portaled into the routed page's area, over what is there.
      expect(page.parentElement).toBe(host);
      expect(page).toHaveAttribute('data-covering');
      expect(document.getElementById('behind')!.inert).toBe(true);
      // Focus starts on the page, not on the conversation it covers.
      expect(document.activeElement).toBe(page);
      fireEvent.click(within(page).getByLabelText('I have read and agree to follow these rules.'));
      await act(async () => {
        fireEvent.click(within(page).getByRole('button', { name: 'Complete onboarding' }));
      });
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument());
      expect(document.getElementById('behind')!.inert).toBe(false);
    });
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
