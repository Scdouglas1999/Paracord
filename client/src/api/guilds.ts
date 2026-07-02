import type { AxiosRequestConfig } from 'axios';
import { getApi } from './activeClient';
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
  getAll: () => getApi().get<Guild[]>('/users/@me/guilds'),
  create: (data: CreateGuildRequest) => getApi().post<Guild>('/guilds', data),
  get: (id: string) => getApi().get<Guild>(`/guilds/${id}`),
  update: (id: string, data: Partial<Guild>) => getApi().patch<Guild>(`/guilds/${id}`, data),
  delete: (id: string) => getApi().delete(`/guilds/${id}`),
  transferOwnership: (id: string, newOwnerId: string) =>
    getApi().post(`/guilds/${id}/owner`, { new_owner_id: newOwnerId }),

  getChannels: (id: string, config?: AxiosRequestConfig) =>
    getApi().get<Channel[]>(`/guilds/${id}/channels`, config),
  createChannel: (id: string, data: CreateChannelRequest) =>
    getApi().post<Channel>(`/guilds/${id}/channels`, data),

  getMembers: (id: string) => getApi().get<Member[]>(`/guilds/${id}/members`),
  updateMember: (guildId: string, userId: string, data: UpdateMemberRequest) =>
    getApi().patch<Member>(`/guilds/${guildId}/members/${userId}`, data),
  kickMember: (guildId: string, userId: string) =>
    getApi().delete(`/guilds/${guildId}/members/${userId}`),
  leaveGuild: (id: string) => getApi().delete(`/guilds/${id}/members/@me`),

  getRoles: (id: string) => getApi().get<Role[]>(`/guilds/${id}/roles`),
  createRole: (id: string, data: CreateRoleRequest) =>
    getApi().post<Role>(`/guilds/${id}/roles`, data),
  updateRole: (guildId: string, roleId: string, data: Partial<Role>) =>
    getApi().patch<Role>(`/guilds/${guildId}/roles/${roleId}`, data),
  deleteRole: (guildId: string, roleId: string) =>
    getApi().delete(`/guilds/${guildId}/roles/${roleId}`),

  getBans: (id: string) => getApi().get<Ban[]>(`/guilds/${id}/bans`),
  banMember: (guildId: string, userId: string, reason?: string) =>
    getApi().put(`/guilds/${guildId}/bans/${userId}`, { reason }),
  unbanMember: (guildId: string, userId: string) =>
    getApi().delete(`/guilds/${guildId}/bans/${userId}`),

  getInvites: (id: string) => getApi().get<Invite[]>(`/guilds/${id}/invites`),
  createInvite: (channelId: string, data?: CreateInviteRequest) =>
    getApi().post<Invite>(`/channels/${channelId}/invites`, data),

  getAuditLog: (id: string, params?: Record<string, string>) =>
    getApi().get<{ audit_log_entries: AuditLogEntry[] }>(`/guilds/${id}/audit-logs`, { params }),
  createReport: (guildId: string, data: CreateReportRequest) =>
    getApi().post<ModerationReport>(`/guilds/${guildId}/reports`, data),
  getReports: (guildId: string, params?: { status?: string }) =>
    getApi().get<{ reports: ModerationReport[] }>(`/guilds/${guildId}/reports`, { params }),
  resolveReport: (guildId: string, reportId: string, data: ResolveReportRequest) =>
    getApi().patch<ModerationReport>(`/guilds/${guildId}/reports/${reportId}`, data),

  getVanityUrl: (id: string) =>
    getApi().get<{ vanity_url_code: string | null }>(`/guilds/${id}/vanity-url`),
  updateVanityUrl: (id: string, code: string | null) =>
    getApi().patch<{ vanity_url_code: string | null }>(`/guilds/${id}/vanity-url`, { code }),

  getOnboarding: (guildId: string) =>
    getApi().get<GuildOnboardingSettings>(`/guilds/${guildId}/onboarding`),
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
  ) => getApi().patch<GuildOnboardingSettings>(`/guilds/${guildId}/onboarding`, payload),
  getMyOnboardingState: (guildId: string) =>
    getApi().get<{ settings: GuildOnboardingSettings; member_state: GuildOnboardingMemberState }>(
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
    getApi().put<GuildOnboardingMemberState>(`/guilds/${guildId}/onboarding/me`, payload),

  listStickers: (guildId: string) => getApi().get<Sticker[]>(`/guilds/${guildId}/stickers`),
  createSticker: (
    guildId: string,
    payload: { name: string; description?: string; file: File },
  ) => {
    const formData = new FormData();
    formData.append('name', payload.name);
    if (payload.description) formData.append('description', payload.description);
    formData.append('image', payload.file);
    return getApi().post<Sticker>(`/guilds/${guildId}/stickers`, formData);
  },
  deleteSticker: (guildId: string, stickerId: string) =>
    getApi().delete(`/guilds/${guildId}/stickers/${stickerId}`),
};
