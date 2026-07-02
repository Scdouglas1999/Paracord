import { apiClient } from './client';

export interface ModerationTemplate {
  id: string;
  guild_id: string;
  name: string;
  action_type: number;
  duration_minutes: number | null;
  reason_template: string | null;
  dm_template: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateModerationTemplateRequest {
  name: string;
  action_type: number;
  duration_minutes?: number;
  reason_template?: string;
  dm_template?: string;
}

export interface ApplyModerationTemplateRequest {
  target_user_id: string;
  reason?: string;
  dm_message?: string;
}

export const moderationTemplateApi = {
  list: (guildId: string) =>
    apiClient.get<ModerationTemplate[]>(`/guilds/${guildId}/moderation/templates`),
  create: (guildId: string, data: CreateModerationTemplateRequest) =>
    apiClient.post<ModerationTemplate>(`/guilds/${guildId}/moderation/templates`, data),
  delete: (guildId: string, templateId: string) =>
    apiClient.delete(`/guilds/${guildId}/moderation/templates/${templateId}`),
  apply: (guildId: string, templateId: string, data: ApplyModerationTemplateRequest) =>
    apiClient.post(`/guilds/${guildId}/moderation/templates/${templateId}/apply`, data),
};

export const ACTION_TYPE_LABELS: Record<number, string> = {
  1: 'Warn',
  2: 'Timed Mute',
  3: 'Kick',
  4: 'Ban',
};
