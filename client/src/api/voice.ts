import { apiClient } from './client';

export interface VoiceJoinResponse {
  token: string;
  url: string;
  room_name: string;
  session_id?: string;
  quality_preset?: string;
}

export const voiceApi = {
  joinChannel: (channelId: string) =>
    apiClient.get<VoiceJoinResponse>(`/voice/${channelId}/join`),
  leaveChannel: (channelId: string) =>
    apiClient.post(`/voice/${channelId}/leave`),
  startStream: (
    channelId: string,
    options?: { title?: string; quality_preset?: string }
  ) => apiClient.post<VoiceJoinResponse>(`/voice/${channelId}/stream`, options),
};
