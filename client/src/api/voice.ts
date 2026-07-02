import { apiClient } from './client';

export interface VoiceJoinResponse {
  token: string;
  url: string;
  url_candidates?: string[];
  room_name: string;
  session_id?: string;
  quality_preset?: string;
  /** When true, the server supports native QUIC media and the client should
   *  use the MediaEngine interface instead of LiveKit. */
  native_media?: boolean;
  /** WebTransport / QUIC relay endpoint for native media sessions. */
  media_endpoint?: string;
  /** Candidate endpoints to try for native media (LAN IP first, then public). */
  media_endpoint_candidates?: string[];
  /** Auth token for the native media relay (separate from the LiveKit token). */
  media_token?: string;
  /** When true, LiveKit is available as a fallback if native media fails. */
  livekit_available?: boolean;
  /** TLS certificate hash for QUIC certificate pinning. */
  cert_hash?: string;
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
  joinChannel: (channelId: string, options?: { fallback?: 'livekit' }) =>
    apiClient.post<VoiceJoinResponse>(
      resolveV2VoiceUrl(`/api/v2/voice/${channelId}/join${options?.fallback ? '?fallback=livekit' : ''}`),
      undefined,
      {
        // Voice join may involve a server-side LiveKit CreateRoom API call
        // (up to 10s) plus permission checks. The default 15s client timeout
        // is too tight and causes spurious failures under load.
        timeout: 30_000,
      },
    ),
  joinDmChannel: (channelId: string, options?: { fallback?: 'livekit' }) =>
    apiClient.post<VoiceJoinResponse>(
      `/api/v1/dms/${channelId}/voice/join${options?.fallback ? '?fallback=livekit' : ''}`,
      undefined,
      { timeout: 30_000 },
    ),
  leaveDmChannel: (channelId: string) =>
    apiClient.post(`/api/v1/dms/${channelId}/voice/leave`, undefined, { timeout: 10_000 }),
  leaveChannel: (
    channelId: string,
    options?: {
      sessionId?: string;
      timeoutMs?: number;
    },
  ) => {
    const qs = options?.sessionId
      ? `?session_id=${encodeURIComponent(options.sessionId)}`
      : '';
    return apiClient.post(resolveV2VoiceUrl(`/api/v2/voice/${channelId}/leave${qs}`), undefined, {
      timeout: options?.timeoutMs ?? 10_000,
    });
  },
  startStream: (
    channelId: string,
    options?: { title?: string; quality_preset?: string; fallback?: 'livekit' }
  ) => {
    const qs = options?.fallback ? '?fallback=livekit' : '';
    const { fallback: _fb, ...body } = options ?? {};
    return apiClient.post<VoiceJoinResponse>(
      `/voice/${channelId}/stream${qs}`,
      Object.keys(body).length > 0 ? body : undefined,
      { timeout: 45_000 }
    );
  },
  stopStream: (channelId: string) =>
    apiClient.post(`/voice/${channelId}/stream/stop`, undefined, {
      // Short timeout — the server also detects stream end from the voice
      // leave / disconnect, so this is best-effort. Don't block the user.
      timeout: 5_000,
    }),
};
