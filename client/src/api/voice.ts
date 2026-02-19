import { apiClient } from './client';

export interface VoiceJoinResponse {
  token: string;
  url: string;
  url_candidates?: string[];
  room_name: string;
  session_id?: string;
  quality_preset?: string;
}

function resolveV2VoiceUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const baseURL = apiClient.defaults.baseURL;

  if (typeof baseURL === 'string' && /^https?:\/\//i.test(baseURL)) {
    return new URL(normalized, baseURL).toString();
  }

  if (typeof window !== 'undefined') {
    return new URL(normalized, window.location.origin).toString();
  }

  return normalized;
}

export const voiceApi = {
  joinChannel: (channelId: string) =>
    apiClient.post<VoiceJoinResponse>(resolveV2VoiceUrl(`/api/v2/voice/${channelId}/join`), undefined, {
      // Voice join involves a server-side LiveKit CreateRoom API call (up to
      // 10s) plus permission checks.  The default 15s client timeout is too
      // tight and causes spurious failures under load.
      timeout: 30_000,
    }),
  leaveChannel: (channelId: string) =>
    apiClient.post(resolveV2VoiceUrl(`/api/v2/voice/${channelId}/leave`), undefined, {
      timeout: 30_000,
    }),
  startStream: (
    channelId: string,
    options?: { title?: string; quality_preset?: string }
  ) => apiClient.post<VoiceJoinResponse>(`/voice/${channelId}/stream`, options),
  stopStream: (channelId: string) =>
    apiClient.post(`/voice/${channelId}/stream/stop`),
};
