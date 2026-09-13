import { getApi } from './activeClient';
import type { OperationContext } from '../lib/operationContext';

export interface VoiceJoinResponse {
  token: string;
  url: string;
  url_candidates?: string[];
  room_name: string;
  session_id?: string;
  /** Stage audience members are subscriber-only until a moderator promotes them. */
  suppress?: boolean;
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
  const baseURL = getApi().defaults.baseURL;

  if (typeof baseURL === 'string' && /^https?:\/\//i.test(baseURL)) {
    return new URL(normalized, baseURL).toString();
  }

  if (typeof window !== 'undefined') {
    return new URL(normalized, window.location.origin).toString();
  }

  return normalized;
}

export const voiceApi = {
  joinChannel: async (channelId: string, options?: { fallback?: 'livekit' }) =>
    getApi().post<VoiceJoinResponse>(
      resolveV2VoiceUrl(`/api/v2/voice/${channelId}/join${options?.fallback ? '?fallback=livekit' : ''}`),
      undefined,
      {
        // Voice join may involve a server-side LiveKit CreateRoom API call
        // (up to 10s) plus permission checks. The default 15s client timeout
        // is too tight and causes spurious failures under load.
        timeout: 30_000,
      },
    ),
  joinDmChannel: async (channelId: string, options?: { fallback?: 'livekit' }) =>
    getApi().post<VoiceJoinResponse>(
      `/api/v1/dms/${channelId}/voice/join${options?.fallback ? '?fallback=livekit' : ''}`,
      undefined,
      { timeout: 30_000 },
    ),
  leaveDmChannel: async (channelId: string) =>
    getApi().post(`/api/v1/dms/${channelId}/voice/leave`, undefined, { timeout: 10_000 }),
  leaveChannel: async (
    channelId: string,
    options?: {
      sessionId?: string;
      timeoutMs?: number;
    },
  ) => {
    const qs = options?.sessionId
      ? `?session_id=${encodeURIComponent(options.sessionId)}`
      : '';
    return getApi().post(resolveV2VoiceUrl(`/api/v2/voice/${channelId}/leave${qs}`), undefined, {
      timeout: options?.timeoutMs ?? 10_000,
    });
  },
  startStream: async (
    channelId: string,
    options?: { title?: string; quality_preset?: string; fallback?: 'livekit' }
  ) => {
    const qs = options?.fallback ? '?fallback=livekit' : '';
    const { fallback: _fb, ...body } = options ?? {};
    return getApi().post<VoiceJoinResponse>(
      `/voice/${channelId}/stream${qs}`,
      Object.keys(body).length > 0 ? body : undefined,
      { timeout: 45_000 }
    );
  },
  stopStream: async (channelId: string) =>
    getApi().post(`/voice/${channelId}/stream/stop`, undefined, {
      // Short timeout — the server also detects stream end from the voice
      // leave / disconnect, so this is best-effort. Don't block the user.
      timeout: 5_000,
    }),
};

/** Every request made by a call retains its captured server/account. */
export function createCallVoiceApi(context: OperationContext, membership?: () => string | null) {
  const streamReceipt = () => {
    const sessionId = membership?.();
    if (!sessionId) throw new Error("Voice membership is not confirmed. Rejoin before sharing a stream.");
    return `session_id=${encodeURIComponent(sessionId)}`;
  };
  const post = <T = unknown>(url: string, data?: unknown, timeout = 10_000) =>
    context.requestRoot<T>({ method: 'POST', url, data, timeout });
  return {
    join: (channelId: string, dm: boolean, fallback?: 'livekit') => post<VoiceJoinResponse>(
      `/api/${dm ? `v1/dms/${encodeURIComponent(channelId)}/voice` : `v2/voice/${encodeURIComponent(channelId)}`}/join${fallback ? '?fallback=livekit' : ''}`,
      undefined, 30_000,
    ),
    leave: (channelId: string, dm: boolean, sessionId: string) => post(
      `/api/${dm ? `v1/dms/${encodeURIComponent(channelId)}/voice` : `v2/voice/${encodeURIComponent(channelId)}`}/leave?session_id=${encodeURIComponent(sessionId)}`,
    ),
    startStream: (channelId: string, options?: { title?: string; quality_preset?: string; fallback?: 'livekit' }) => {
      const { fallback, ...body } = options ?? {};
      return post<VoiceJoinResponse>(`/api/v1/voice/${encodeURIComponent(channelId)}/stream?${streamReceipt()}${fallback ? '&fallback=livekit' : ''}`, body, 45_000);
    },
    stopStream: (channelId: string) => post(`/api/v1/voice/${encodeURIComponent(channelId)}/stream/stop?${streamReceipt()}`, undefined, 5_000),
    /**
     * Re-read the media certificate pin the server publishes right now.
     *
     * The pin is not stable for the life of a server. Browsers accept a
     * WebTransport `serverCertificateHashes` pin only for a certificate valid
     * at most 14 days, so the server issues a short-lived one and rotates it;
     * a pin cached across a reconnect can name a certificate the media port no
     * longer presents, and the handshake is then refused in milliseconds with
     * an error indistinguishable from a blocked UDP port.
     *
     * This route is authenticated and side-effect free: it joins nothing,
     * creates no voice state and issues no media token.
     */
    mediaCertificatePin: async (): Promise<string | undefined> => {
      const { data } = await context.requestRoot<{ certificate_pin_sha256?: string | null }>({
        method: 'GET',
        url: '/api/v1/voice/transport-diagnostics',
        timeout: 10_000,
      });
      const pin = data?.certificate_pin_sha256;
      return typeof pin === 'string' && pin.length > 0 ? pin : undefined;
    },
  };
}
