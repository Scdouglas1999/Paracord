import { apiClient } from './client';

export interface EconomyLeaderboardEntry {
  rank: number;
  user: {
    id: string;
    username: string;
    discriminator: number;
    avatar?: string | null;
  };
  xp: number;
  level: number;
  streak_days: number;
  last_xp_at: string;
}

export interface EconomyLeaderboardResponse {
  guild_id: string;
  entries: EconomyLeaderboardEntry[];
  limit: number;
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
  getMyProgress: (guildId: string) =>
    apiClient.get<EconomyProgressResponse>(`/guilds/${guildId}/economy/me`),

  getLeaderboard: (guildId: string, limit = 20) =>
    apiClient.get<EconomyLeaderboardResponse>(`/guilds/${guildId}/economy/leaderboard`, {
      params: { limit },
    }),

  getLevelRoles: (guildId: string) =>
    apiClient.get<LevelRolesResponse>(`/guilds/${guildId}/economy/level-roles`),

  updateLevelRoles: (guildId: string, mappings: LevelRoleMapping[]) =>
    apiClient.put<LevelRolesResponse>(`/guilds/${guildId}/economy/level-roles`, {
      mappings,
    }),
};
