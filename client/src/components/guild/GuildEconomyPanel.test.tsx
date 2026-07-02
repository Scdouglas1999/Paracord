import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { economyApi } from '../../api/economy';
import { useAuthStore } from '../../stores/authStore';
import { GuildEconomyPanel } from './GuildEconomyPanel';

vi.mock('../../api/economy', () => ({
  economyApi: {
    getLeaderboard: vi.fn(),
    getMyProgress: vi.fn(),
  },
}));

const currentUser = {
  id: 'user-1',
  username: 'Ada',
  discriminator: 1,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-05-17T00:00:00Z',
};

describe('GuildEconomyPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: currentUser });
    vi.mocked(economyApi.getLeaderboard).mockResolvedValue({
      data: {
        guild_id: 'guild-1',
        limit: 8,
        entries: [
          {
            rank: 1,
            user: { id: 'user-2', username: 'Grace', discriminator: 2 },
            xp: 480,
            level: 2,
            streak_days: 5,
            last_xp_at: '2026-05-17T00:00:00Z',
          },
          {
            rank: 2,
            user: { id: 'user-1', username: 'Ada', discriminator: 1 },
            xp: 240,
            level: 1,
            streak_days: 3,
            last_xp_at: '2026-05-17T00:00:00Z',
          },
        ],
      },
    } as never);
    vi.mocked(economyApi.getMyProgress).mockResolvedValue({
      data: {
        guild_id: 'guild-1',
        user_id: 'user-1',
        xp: 240,
        level: 1,
        rank: 2,
        progress: {
          current_level_floor: 100,
          next_level_at: 300,
          xp_into_level: 140,
          xp_required_this_level: 200,
        },
        streak: { days: 3, longest_days: 4 },
        achievements: [{ key: 'first_message', awarded_at: '2026-05-17T00:00:00Z' }],
      },
    } as never);
  });

  it('renders current progress, achievements, and leaderboard entries', async () => {
    render(<GuildEconomyPanel guildId="guild-1" />);

    expect(await screen.findByText('Your Progress')).toBeInTheDocument();
    expect(economyApi.getLeaderboard).toHaveBeenCalledWith('guild-1', 8);
    expect(economyApi.getMyProgress).toHaveBeenCalledWith('guild-1');
    expect(screen.getByText('Rank #2')).toBeInTheDocument();
    expect(screen.getByText('Level 1')).toBeInTheDocument();
    expect(screen.getByText('240 XP')).toBeInTheDocument();
    expect(screen.getByText('140/200 XP this level')).toBeInTheDocument();
    expect(screen.getByText('first_message')).toBeInTheDocument();
    expect(screen.getByText('#1 Grace')).toBeInTheDocument();
    expect(screen.getByText('#2 Ada')).toBeInTheDocument();
  });

  it('shows a user-visible error when economy data fails to load', async () => {
    vi.mocked(economyApi.getLeaderboard).mockRejectedValue(new Error('Economy disabled.'));

    render(<GuildEconomyPanel guildId="guild-1" />);

    expect(await screen.findByText('Economy disabled.')).toBeInTheDocument();
  });
});
