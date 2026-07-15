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
  getForChannel: (channelId: string) =>
    getApi().get<StageInstance>(`/channels/${channelId}/stage-instance`),

  create: (data: CreateStageInstanceRequest) =>
    getApi().post<StageInstance>('/stage-instances', data),

  update: (stageId: string, data: UpdateStageInstanceRequest) =>
    getApi().patch<StageInstance>(`/stage-instances/${stageId}`, data),

  remove: (stageId: string) => getApi().delete(`/stage-instances/${stageId}`),

  inviteSpeaker: (stageId: string, userId: string) =>
    getApi().post(`/stage-instances/${stageId}/speakers/${userId}`),

  removeSpeaker: (stageId: string, userId: string) =>
    getApi().delete(`/stage-instances/${stageId}/speakers/${userId}`),

  requestToSpeak: (stageId: string) =>
    getApi().post(`/stage-instances/${stageId}/speaker-requests/@me`),

  cancelSpeakerRequest: (stageId: string) =>
    getApi().delete(`/stage-instances/${stageId}/speaker-requests/@me`),

  dismissSpeakerRequest: (stageId: string, userId: string) =>
    getApi().delete(`/stage-instances/${stageId}/speaker-requests/${userId}`),
};
