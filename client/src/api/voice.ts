import { getApi } from './activeClient';
import type { OperationContext } from '../lib/operationContext';
import type { VoiceMode } from '../types/voice.types';
import type { VoiceModeResponse } from './generated/VoiceModeResponse';
import type { VoiceViewKind, VoiceViewSession } from './generated/VoiceViewSession';
import type { VoiceWatchers } from './generated/VoiceWatchers';

export type { VoiceModeResponse, VoiceViewKind, VoiceViewSession, VoiceWatchers };

export { LISTEN_IN_DISABLED, voiceErrorCode, voiceErrorMessage } from '../stores/voice/errors';

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
  /** The mode the server admitted this membership in (absent: `joined`). */
  mode?: VoiceMode;
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
  /**
   * Whether this voice channel admits listeners (its `listen_in_enabled`
   * feature setting; on unless a moderator turned it off).
   */
  getListenIn: async (channelId: string): Promise<boolean> => {
    const { data } = await getApi().get<{ listen_in_enabled?: boolean }>(`/channels/${channelId}/features`);
    if (typeof data?.listen_in_enabled !== 'boolean') {
      throw new Error('This server does not report whether listening in is allowed here.');
    }
    return data.listen_in_enabled;
  },
  /** Turn listening in on or off for a voice channel (Manage Channels). */
  setListenIn: async (channelId: string, enabled: boolean): Promise<boolean> => {
    const { data } = await getApi().patch<{ listen_in_enabled?: boolean }>(
      `/channels/${channelId}/features`,
      { listen_in_enabled: enabled },
    );
    if (typeof data?.listen_in_enabled !== 'boolean') {
      throw new Error('This server did not confirm the listening-in setting.');
    }
    return data.listen_in_enabled;
  },
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
    /**
     * Join a call. Every guild join names its mode, `joined` included, so the
     * server never has to guess (G5: absent means joined, but a client that
     * relies on that cannot be read at a glance). A DM call has no listen mode.
     */
    join: (channelId: string, dm: boolean, fallback?: 'livekit', mode: VoiceMode = 'joined') => {
      if (dm && mode !== 'joined') throw new Error('Listening in is only for server voice channels.');
      const query = new URLSearchParams();
      if (!dm) query.set('mode', mode);
      if (fallback) query.set('fallback', fallback);
      const qs = query.toString();
      return post<VoiceJoinResponse>(
        `/api/${dm ? `v1/dms/${encodeURIComponent(channelId)}/voice` : `v2/voice/${encodeURIComponent(channelId)}`}/join${qs ? `?${qs}` : ''}`,
        undefined, 30_000,
      );
    },
    /**
     * Switch a running call between listening and joined, in place: same
     * receipt, same media connection (`POST /api/v2/voice/{id}/mode`).
     */
    setMode: (channelId: string, mode: VoiceMode, sessionId: string) => post<VoiceModeResponse>(
      `/api/v2/voice/${encodeURIComponent(channelId)}/mode`,
      { mode, session_id: sessionId },
    ),
    /**
     * Watch a stream without joining (`watch`), or light the room with it
     * (`ambient`). A caller in this channel's call gets `via_membership` and no
     * media; anyone else gets a separate view session to connect.
     */
    startView: (channelId: string, kind: VoiceViewKind, streamerId: string) => post<VoiceViewSession>(
      `/api/v2/voice/${encodeURIComponent(channelId)}/view`,
      { kind, user_id: streamerId },
      15_000,
    ),
    /**
     * Stop viewing. Always scoped to one receipt: a view session's own, or the
     * call's when the watch rides the call. Unscoped, the server would end a
     * view session *and* a watch through the call at once.
     */
    stopView: (channelId: string, sessionId: string) => context.requestRoot({
      method: 'DELETE',
      url: `/api/v2/voice/${encodeURIComponent(channelId)}/view?session_id=${encodeURIComponent(sessionId)}`,
      timeout: 10_000,
    }),
    /** The channel's watcher counts now (then follow `VOICE_WATCHERS_UPDATE`). */
    watchers: (channelId: string) => context.requestRoot<VoiceWatchers>({
      method: 'GET',
      url: `/api/v2/voice/${encodeURIComponent(channelId)}/watchers`,
      timeout: 10_000,
    }),
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
