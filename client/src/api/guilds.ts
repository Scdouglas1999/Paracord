import type { RestClient } from './restClient';
import type { AxiosRequestConfig } from 'axios';
import { getApi as getActiveApi } from './activeClient';
import { hasListField, responseContract } from './responseContracts';
import { isGuildDetail, isGuildInvite, isGuildInviteList, isGuildSummaryList, isOwnershipTransferResponse } from './contractValidators';
import type { UpdateGuildRequest } from './generated/UpdateGuildRequest';
import type { CreateInviteRequest } from './generated/CreateInviteRequest';
import type { GuildSearchParams } from '../lib/search/query';
import type {
  Channel,
  Member,
  Message,
  Role,
  Ban,
  AuditLogEntry,
  ModerationReport,
  CreateGuildRequest,
  CreateChannelRequest,
  CreateRoleRequest,
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
  tags?: string[];
  format_type: number;
  creator_id?: string | null;
  image_url?: string | null;
  created_at: string;
}

export interface GuildMessageSearchHit {
  message: Message;
  channel_id: string;
  channel_name: string;
  thread_parent_id?: string | null;
}

export interface GuildMessageSearchResponse {
  total: number;
  messages: GuildMessageSearchHit[];
}

/** `GET /guilds/{id}/messages/search`: the typed filters plus a page. */
export interface GuildMessageSearchParams extends GuildSearchParams {
  limit?: number;
  offset?: number;
}

function guildMessageSearchQuery(params: GuildMessageSearchParams): string {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.author_id) query.set('author_id', params.author_id);
  if (params.channel_id) query.set('channel_id', params.channel_id);
  for (const value of params.has ?? []) query.append('has', value);
  if (params.mentions) query.set('mentions', params.mentions);
  if (params.pinned != null) query.set('pinned', params.pinned ? 'true' : 'false');
  if (params.before) query.set('before', params.before);
  if (params.after) query.set('after', params.after);
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  return query.toString();
}

export function createGuildApi(getApi: () => RestClient) {
  return {
    joinPublic: async (id: string) => responseContract(
      getApi().put(`/guilds/${id}/members/@me`), isGuildDetail, 'GuildDetail'),
    getAll: async () => responseContract(
      getApi().get('/users/@me/guilds'), isGuildSummaryList, 'GuildSummaryList'),
    create: async (data: CreateGuildRequest) => responseContract(
      getApi().post('/guilds', data), isGuildDetail, 'GuildDetail'),
    get: async (id: string) => responseContract(
      getApi().get(`/guilds/${id}`), isGuildDetail, 'GuildDetail'),
    update: async (id: string, data: UpdateGuildRequest) => responseContract(
      getApi().patch(`/guilds/${id}`, data), isGuildDetail, 'GuildDetail'),
    delete: async (id: string) => getApi().delete(`/guilds/${id}`),
    transferOwnership: async (id: string, newOwnerId: string) =>
      responseContract(getApi().post(`/guilds/${id}/owner`, { new_owner_id: newOwnerId }),
        isOwnershipTransferResponse, 'OwnershipTransferResponse'),

    getChannels: async (id: string, config?: AxiosRequestConfig) =>
      getApi().get<Channel[]>(`/guilds/${id}/channels`, config),
    createChannel: async (id: string, data: CreateChannelRequest) =>
      getApi().post<Channel>(`/guilds/${id}/channels`, data),

    getMembers: async (id: string) => getApi().get<Member[]>(`/guilds/${id}/members`),
    updateMember: async (guildId: string, userId: string, data: UpdateMemberRequest) =>
      getApi().patch<Member>(`/guilds/${guildId}/members/${userId}`, data),
    kickMember: async (guildId: string, userId: string) =>
      getApi().delete(`/guilds/${guildId}/members/${userId}`),
    leaveGuild: async (id: string) => getApi().delete(`/guilds/${id}/members/@me`),

    getRoles: async (id: string) => getApi().get<Role[]>(`/guilds/${id}/roles`),
    createRole: async (id: string, data: CreateRoleRequest) =>
      getApi().post<Role>(`/guilds/${id}/roles`, data),
    updateRole: async (guildId: string, roleId: string, data: Partial<Role>) =>
      getApi().patch<Role>(`/guilds/${guildId}/roles/${roleId}`, data),
    deleteRole: async (guildId: string, roleId: string) =>
      getApi().delete(`/guilds/${guildId}/roles/${roleId}`),

    getBans: async (id: string) => getApi().get<Ban[]>(`/guilds/${id}/bans`),
    banMember: async (guildId: string, userId: string, reason?: string) =>
      getApi().put(`/guilds/${guildId}/bans/${userId}`, { reason }),
    unbanMember: async (guildId: string, userId: string) =>
      getApi().delete(`/guilds/${guildId}/bans/${userId}`),

    getInvites: async (id: string) =>
      responseContract(
        getApi().get(`/guilds/${id}/invites`),
        isGuildInviteList,
        'GuildInviteList',
      ),
    createInvite: async (channelId: string, data?: CreateInviteRequest) =>
      responseContract(
        getApi().post(`/channels/${channelId}/invites`, data),
        isGuildInvite,
        'GuildInvite',
      ),

    getAuditLog: async (id: string, params?: Record<string, string>) =>
      getApi().get<{ audit_log_entries: AuditLogEntry[] }>(`/guilds/${id}/audit-logs`, { params }),
    createReport: async (guildId: string, data: CreateReportRequest) =>
      getApi().post<ModerationReport>(`/guilds/${guildId}/reports`, data),
    getReports: async (guildId: string, params?: { status?: string }) =>
      getApi().get<{ reports: ModerationReport[] }>(`/guilds/${guildId}/reports`, { params }),
    resolveReport: async (guildId: string, reportId: string, data: ResolveReportRequest) =>
      getApi().patch<ModerationReport>(`/guilds/${guildId}/reports/${reportId}`, data),

    getVanityUrl: async (id: string) =>
      getApi().get<{ vanity_url_code: string | null }>(`/guilds/${id}/vanity-url`),
    updateVanityUrl: async (id: string, code: string | null) =>
      getApi().patch<{ vanity_url_code: string | null }>(`/guilds/${id}/vanity-url`, { code }),

    getOnboarding: async (guildId: string) =>
      getApi().get<GuildOnboardingSettings>(`/guilds/${guildId}/onboarding`),
    updateOnboarding: async (
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
    getMyOnboardingState: async (guildId: string) =>
      getApi().get<{ settings: GuildOnboardingSettings; member_state: GuildOnboardingMemberState }>(
        `/guilds/${guildId}/onboarding/me`,
      ),
    updateMyOnboardingState: async (
      guildId: string,
      payload: {
        accepted_rules: boolean;
        selected_role_ids: string[];
        completed?: boolean;
      },
    ) =>
      getApi().put<GuildOnboardingMemberState>(`/guilds/${guildId}/onboarding/me`, payload),

    listStickers: async (guildId: string) => getApi().get<Sticker[]>(`/guilds/${guildId}/stickers`),
    createSticker: async (
      guildId: string,
      payload: { name: string; description?: string; tags?: string; file: File },
    ) => {
      const formData = new FormData();
      formData.append('name', payload.name);
      if (payload.description) formData.append('description', payload.description);
      if (payload.tags) formData.append('tags', payload.tags);
      formData.append('image', payload.file);
      // Without an explicit multipart content type axios re-encodes the
      // FormData as JSON (the client's declared default), which loses the
      // image and 400s. See the same note on emoji creation.
      return getApi().post<Sticker>(`/guilds/${guildId}/stickers`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
    deleteSticker: async (guildId: string, stickerId: string) =>
      getApi().delete(`/guilds/${guildId}/stickers/${stickerId}`),

    searchMessages: async (guildId: string, params: GuildMessageSearchParams) =>
      responseContract(
        getApi().get<unknown>(`/guilds/${guildId}/messages/search?${guildMessageSearchQuery(params)}`),
        hasListField<GuildMessageSearchResponse>('messages'),
        'message search',
      ),
    updateSticker: async (
      guildId: string,
      stickerId: string,
      payload: { name?: string; tags?: string[] },
    ) => getApi().patch<Sticker>(`/guilds/${guildId}/stickers/${stickerId}`, payload),
    uploadBanner: async (guildId: string, file: File) => {
      const formData = new FormData();
      formData.append('banner', file);
      return getApi().post<{ banner_hash?: string | null }>(`/guilds/${guildId}/banner`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
    deleteBanner: async (guildId: string) => getApi().delete(`/guilds/${guildId}/banner`),
  };
}

export const guildApi = createGuildApi(getActiveApi);
