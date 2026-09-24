import type { AxiosInstance } from 'axios';

import { getApi, getServerApi } from './activeClient';
import { extractApiError } from './client';
import { recordClockSample } from '../lib/together/serverClock';
import type {
  ControllerPolicy,
  TogetherActivity,
  TogetherKind,
  TogetherSession,
  TogetherSessionUpdate,
  TogetherSource,
} from '../lib/together/model';

export interface TogetherItemInput {
  source: TogetherSource;
  ref: string;
  /** A video file's still, captured on this device (`data:image/jpeg;base64,…`). */
  thumbnail?: string;
}

export interface GuildTogetherActivities {
  guild_id: string;
  revision: number;
  activities: { channel_id: string; revision: number; activity: TogetherActivity }[];
}

export type PlaybackAction =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'seek'; position_ms: number }
  | { action: 'skip'; item_id?: string }
  | { action: 'ended'; item_id: string };

/**
 * A Together request's error, in words for the sheet or the player. The server
 * prefixes its messages with the status ("bad request: …"); a 403 here only
 * ever means the controls are locked.
 */
export function togetherErrorMessage(error: unknown): string {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 403) return 'Only the person who started this can control it';
  return extractApiError(error).replace(/^(bad request|conflict|service unavailable|not found): /i, '');
}

/**
 * Every call carries the server it belongs to (the call's server, not whichever
 * one is on screen), and every answer that carries `server_time_ms` is a clock
 * sample.
 */
export function createTogetherApi(serverId: string) {
  const api = (): AxiosInstance => getServerApi(serverId);
  const timed = async <T extends { server_time_ms?: number }>(request: () => Promise<{ data: T }>): Promise<T> => {
    const sentAt = Date.now();
    const { data } = await request();
    if (typeof data?.server_time_ms === 'number') recordClockSample(serverId, sentAt, Date.now(), data.server_time_ms);
    return data;
  };
  const base = (channelId: string) => `/channels/${encodeURIComponent(channelId)}/together`;
  return {
    get: (channelId: string) => timed(() => api().get<TogetherSessionUpdate>(base(channelId))),
    start: (channelId: string, body: { kind: TogetherKind; controller_policy: ControllerPolicy; items: TogetherItemInput[] }) =>
      timed(() => api().post<TogetherSession>(base(channelId), body, { timeout: 30_000 })),
    setPolicy: (channelId: string, controller_policy: ControllerPolicy) =>
      timed(() => api().patch<TogetherSession>(base(channelId), { controller_policy })),
    stop: async (channelId: string) => {
      await api().delete(base(channelId));
    },
    playback: (channelId: string, body: PlaybackAction) =>
      timed(() => api().post<TogetherSession>(`${base(channelId)}/playback`, body)),
    addItems: (channelId: string, items: TogetherItemInput[]) =>
      timed(() => api().post<TogetherSession>(`${base(channelId)}/items`, { items }, { timeout: 30_000 })),
    removeItem: (channelId: string, itemId: string) =>
      timed(() => api().delete<TogetherSession>(`${base(channelId)}/items/${encodeURIComponent(itemId)}`)),
    moveItem: (channelId: string, itemId: string, index: number) =>
      timed(() => api().patch<TogetherSession>(`${base(channelId)}/items/${encodeURIComponent(itemId)}`, { index })),
  };
}

export type TogetherApi = ReturnType<typeof createTogetherApi>;

/** What is playing in a server's voice channels (the server on screen). */
export async function fetchGuildTogether(guildId: string): Promise<GuildTogetherActivities> {
  const { data } = await getApi().get<GuildTogetherActivities>(`/guilds/${encodeURIComponent(guildId)}/together`);
  return data;
}
