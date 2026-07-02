import type { AxiosRequestConfig } from 'axios';
import { apiClient } from './client';
import type {
  Guild,
  Channel,
  Member,
  Role,
  Invite,
  Ban,
  AuditLogEntry,
  ModerationReport,
  CreateGuildRequest,
  CreateChannelRequest,
  CreateRoleRequest,
  CreateInviteRequest,
  UpdateMemberRequest,
  CreateReportRequest,
  ResolveReportRequest,
} from '../types';

export interface OnboardingRoleOption {
  id: string;
  role_id: string;
  label?: string | null;
  description?: string | null;
  position: number;
}

export interface GuildOnboardingSettings {
  guild_id: string;
  welcome_title?: string | null;
  welcome_body?: string | null;
  rules_text?: string | null;
  role_prompt?: string | null;
  progressive_channel_min_messages: number;
  updated_at?: string | null;
  role_options: OnboardingRoleOption[];
}

export interface GuildOnboardingMemberState {
  guild_id: string;
  user_id: string;
  accepted_rules: boolean;
  selected_role_ids: string[];
  completed_at?: string | null;
}

export interface Sticker {
  id: string;
  guild_id: string;
  name: string;
  description?: string | null;
  format_type: number;
  creator_id?: string | null;
  image_url?: string | null;
  created_at: string;
}

export const guildApi = {
  getAll: () => apiClient.get<Guild[]>('/users/@me/guilds'),
  create: (data: CreateGuildRequest) => apiClient.post<Guild>('/guilds', data),
  get: (id: string) => apiClient.get<Guild>(`/guilds/${id}`),
  update: (id: string, data: Partial<Guild>) => apiClient.patch<Guild>(`/guilds/${id}`, data),
  delete: (id: string) => apiClient.delete(`/guilds/${id}`),
  transferOwnership: (id: string, newOwnerId: string) =>
    apiClient.post(`/guilds/${id}/owner`, { new_owner_id: newOwnerId }),

  getChannels: (id: string, config?: AxiosRequestConfig) =>
    apiClient.get<Channel[]>(`/guilds/${id}/channels`, config),
  createChannel: (id: string, data: CreateChannelRequest) =>
    apiClient.post<Channel>(`/guilds/${id}/channels`, data),

  getMembers: (id: string) => apiClient.get<Member[]>(`/guilds/${id}/members`),
  updateMember: (guildId: string, userId: string, data: UpdateMemberRequest) =>
    apiClient.patch<Member>(`/guilds/${guildId}/members/${userId}`, data),
  kickMember: (guildId: string, userId: string) =>
    apiClient.delete(`/guilds/${guildId}/members/${userId}`),
  leaveGuild: (id: string) => apiClient.delete(`/guilds/${id}/members/@me`),

  getRoles: (id: string) => apiClient.get<Role[]>(`/guilds/${id}/roles`),
  createRole: (id: string, data: CreateRoleRequest) =>
    apiClient.post<Role>(`/guilds/${id}/roles`, data),
  updateRole: (guildId: string, roleId: string, data: Partial<Role>) =>
    apiClient.patch<Role>(`/guilds/${guildId}/roles/${roleId}`, data),
  deleteRole: (guildId: string, roleId: string) =>
    apiClient.delete(`/guilds/${guildId}/roles/${roleId}`),

  getBans: (id: string) => apiClient.get<Ban[]>(`/guilds/${id}/bans`),
  banMember: (guildId: string, userId: string, reason?: string) =>
    apiClient.put(`/guilds/${guildId}/bans/${userId}`, { reason }),
  unbanMember: (guildId: string, userId: string) =>
    apiClient.delete(`/guilds/${guildId}/bans/${userId}`),

  getInvites: (id: string) => apiClient.get<Invite[]>(`/guilds/${id}/invites`),
  createInvite: (channelId: string, data?: CreateInviteRequest) =>
    apiClient.post<Invite>(`/channels/${channelId}/invites`, data),

  getAuditLog: (id: string, params?: Record<string, string>) =>
    apiClient.get<{ audit_log_entries: AuditLogEntry[] }>(`/guilds/${id}/audit-logs`, { params }),
  createReport: (guildId: string, data: CreateReportRequest) =>
    apiClient.post<ModerationReport>(`/guilds/${guildId}/reports`, data),
  getReports: (guildId: string, params?: { status?: string }) =>
    apiClient.get<{ reports: ModerationReport[] }>(`/guilds/${guildId}/reports`, { params }),
  resolveReport: (guildId: string, reportId: string, data: ResolveReportRequest) =>
    apiClient.patch<ModerationReport>(`/guilds/${guildId}/reports/${reportId}`, data),

  getVanityUrl: (id: string) =>
    apiClient.get<{ vanity_url_code: string | null }>(`/guilds/${id}/vanity-url`),
  updateVanityUrl: (id: string, code: string | null) =>
    apiClient.patch<{ vanity_url_code: string | null }>(`/guilds/${id}/vanity-url`, { code }),

  getOnboarding: (guildId: string) =>
    apiClient.get<GuildOnboardingSettings>(`/guilds/${guildId}/onboarding`),
  updateOnboarding: (
    guildId: string,
    payload: Omit<Partial<GuildOnboardingSettings>, 'role_options'> & {
      role_options?: Array<{
        role_id: string;
        label?: string | null;
        description?: string | null;
        position?: number;
      }>;
    },
  ) => apiClient.patch<GuildOnboardingSettings>(`/guilds/${guildId}/onboarding`, payload),
  getMyOnboardingState: (guildId: string) =>
    apiClient.get<{ settings: GuildOnboardingSettings; member_state: GuildOnboardingMemberState }>(
      `/guilds/${guildId}/onboarding/me`,
    ),
  updateMyOnboardingState: (
    guildId: string,
    payload: {
      accepted_rules: boolean;
      selected_role_ids: string[];
      completed?: boolean;
    },
  ) =>
    apiClient.put<GuildOnboardingMemberState>(`/guilds/${guildId}/onboarding/me`, payload),

  listStickers: (guildId: string) => apiClient.get<Sticker[]>(`/guilds/${guildId}/stickers`),
  createSticker: (
    guildId: string,
    payload: { name: string; description?: string; file: File },
  ) => {
    const formData = new FormData();
    formData.append('name', payload.name);
    if (payload.description) formData.append('description', payload.description);
    formData.append('image', payload.file);
    return apiClient.post<Sticker>(`/guilds/${guildId}/stickers`, formData);
  },
  deleteSticker: (guildId: string, stickerId: string) =>
    apiClient.delete(`/guilds/${guildId}/stickers/${stickerId}`),
};
