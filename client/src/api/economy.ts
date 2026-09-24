import { getApi } from './activeClient';

export interface EconomyLeaderboardEntry {
  rank: number;
  user: {
    id: string;
    username: string;
    display_name?: string | null;
    discriminator: number;
    avatar?: string | null;
  };
  xp: number;
  level: number;
  streak_days: number;
  last_xp_at: string;
}

export type EconomyLeaderboardWindow = 'all_time' | 'weekly';

export interface EconomyLeaderboardResponse {
  guild_id: string;
  entries: EconomyLeaderboardEntry[];
  limit: number;
  /** Which window `entries` was ranked on; absent on servers older than 3.2. */
  window?: EconomyLeaderboardWindow;
}

export interface EconomyAchievement {
  key: string;
  awarded_at: string;
}

export interface EconomyProgressResponse {
  guild_id: string;
  user_id: string;
  xp: number;
  level: number;
  rank: number | null;
  last_xp_at?: string | null;
  progress: {
    current_level_floor: number;
    next_level_at: number;
    xp_into_level: number;
    xp_required_this_level: number;
  };
  streak: {
    days: number;
    longest_days: number;
    last_active_date?: string | null;
  };
  achievements: EconomyAchievement[];
}

export interface LevelRoleMapping {
  level: number;
  role_id: string;
  created_at?: string;
}

export interface LevelRolesResponse {
  guild_id: string;
  mappings: LevelRoleMapping[];
}

export const economyApi = {
  getMyProgress: async (guildId: string) =>
    getApi().get<EconomyProgressResponse>(`/guilds/${guildId}/economy/me`),

  getLeaderboard: async (guildId: string, limit = 20, window?: EconomyLeaderboardWindow) =>
    getApi().get<EconomyLeaderboardResponse>(`/guilds/${guildId}/economy/leaderboard`, {
      params: { limit, window },
    }),

  getLevelRoles: async (guildId: string) =>
    getApi().get<LevelRolesResponse>(`/guilds/${guildId}/economy/level-roles`),

  updateLevelRoles: async (guildId: string, mappings: LevelRoleMapping[]) =>
    getApi().put<LevelRolesResponse>(`/guilds/${guildId}/economy/level-roles`, {
      mappings,
    }),
};
