import { getApi } from './activeClient';

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
  getForChannel: async (channelId: string) =>
    getApi().get<StageInstance>(`/channels/${channelId}/stage-instance`),

  create: async (data: CreateStageInstanceRequest) =>
    getApi().post<StageInstance>('/stage-instances', data),

  update: async (stageId: string, data: UpdateStageInstanceRequest) =>
    getApi().patch<StageInstance>(`/stage-instances/${stageId}`, data),

  remove: async (stageId: string) => getApi().delete(`/stage-instances/${stageId}`),

  inviteSpeaker: async (stageId: string, userId: string) =>
    getApi().post(`/stage-instances/${stageId}/speakers/${userId}`),

  removeSpeaker: async (stageId: string, userId: string) =>
    getApi().delete(`/stage-instances/${stageId}/speakers/${userId}`),

  requestToSpeak: async (stageId: string) =>
    getApi().post(`/stage-instances/${stageId}/speaker-requests/@me`),

  cancelSpeakerRequest: async (stageId: string) =>
    getApi().delete(`/stage-instances/${stageId}/speaker-requests/@me`),

  dismissSpeakerRequest: async (stageId: string, userId: string) =>
    getApi().delete(`/stage-instances/${stageId}/speaker-requests/${userId}`),
};
