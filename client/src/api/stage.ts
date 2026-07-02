import { apiClient } from './client';

export interface StageInstance {
  id: string;
  channel_id: string;
  guild_id: string;
  topic: string;
  privacy_level: number;
  created_at: string;
}

export interface CreateStageInstanceRequest {
  channel_id: string;
  topic?: string;
  privacy_level?: number;
}

export interface UpdateStageInstanceRequest {
  topic?: string;
  privacy_level?: number;
}

export const stageApi = {
  getForChannel: (channelId: string) =>
    apiClient.get<StageInstance>(`/channels/${channelId}/stage-instance`),

  create: (data: CreateStageInstanceRequest) =>
    apiClient.post<StageInstance>('/stage-instances', data),

  update: (stageId: string, data: UpdateStageInstanceRequest) =>
    apiClient.patch<StageInstance>(`/stage-instances/${stageId}`, data),

  remove: (stageId: string) => apiClient.delete(`/stage-instances/${stageId}`),

  inviteSpeaker: (stageId: string, userId: string) =>
    apiClient.post(`/stage-instances/${stageId}/speakers/${userId}`),

  removeSpeaker: (stageId: string, userId: string) =>
    apiClient.delete(`/stage-instances/${stageId}/speakers/${userId}`),
};

