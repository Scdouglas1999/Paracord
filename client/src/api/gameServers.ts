import { getApi as getActiveApi } from './activeClient';
import { extractApiError } from './client';
import type { RestClient } from './restClient';

/** Which protocol a game server speaks. */
export type GameServerKind = 'minecraft_java' | 'minecraft_bedrock' | 'source' | 'tcp';

export const GAME_SERVER_KINDS: readonly GameServerKind[] = [
  'minecraft_java',
  'minecraft_bedrock',
  'source',
  'tcp',
];

/** `checking` until the first probe finishes. */
export type GameServerState = 'up' | 'down' | 'checking';

export interface GameServerStatus {
  state: GameServerState;
  players_online?: number | null;
  players_max?: number | null;
  /** Null when the game does not say who is on. */
  player_names?: string[] | null;
  server_name?: string | null;
  map?: string | null;
  version?: string | null;
  /** Plain text; lines separated by `\n`. */
  motd?: string | null;
  latency_ms?: number | null;
  last_checked_at?: string | null;
  last_seen_online?: string | null;
  /** Why the last probe failed, in plain words. */
  error?: string | null;
}

export interface GameServer {
  id: string;
  guild_id: string;
  kind: GameServerKind;
  name: string;
  /** `host:port`, ready to paste into the game. */
  address: string;
  created_at: string;
  status: GameServerStatus;
  /** Managers only. */
  announce_channel_id?: string | null;
  /** Managers only: why the last announcement couldn't be posted. */
  announce_error?: string | null;
}

export interface GameServerList {
  enabled: boolean;
  can_manage: boolean;
  limit: number;
  servers: GameServer[];
}

export interface GameServerPreview {
  kind: GameServerKind;
  address: string;
  online: boolean;
  /** The name it would get if none is typed. */
  name: string;
  players_online?: number | null;
  players_max?: number | null;
  player_names?: string[] | null;
  map?: string | null;
  version?: string | null;
  motd?: string | null;
  latency_ms?: number | null;
  error: string | null;
}

export interface CreateGameServerBody {
  kind: GameServerKind;
  address: string;
  name?: string;
  announce_channel_id?: string;
}

export interface UpdateGameServerBody {
  kind?: GameServerKind;
  address?: string;
  name?: string;
  /** `null` stops announcing. */
  announce_channel_id?: string | null;
}

export function createGameServersApi(getApi: () => RestClient) {
  return {
    list: (guildId: string) => getApi().get<GameServerList>(`/guilds/${guildId}/game-servers`),
    setEnabled: (guildId: string, enabled: boolean) =>
      getApi().put<{ enabled: boolean }>(`/guilds/${guildId}/game-servers/settings`, { enabled }),
    preview: (guildId: string, body: { kind: GameServerKind; address: string }) =>
      getApi().post<GameServerPreview>(`/guilds/${guildId}/game-servers/preview`, body),
    create: (guildId: string, body: CreateGameServerBody) =>
      getApi().post<GameServer>(`/guilds/${guildId}/game-servers`, body),
    update: (guildId: string, serverId: string, body: UpdateGameServerBody) =>
      getApi().patch<GameServer>(`/guilds/${guildId}/game-servers/${serverId}`, body),
    remove: (guildId: string, serverId: string) =>
      getApi().delete(`/guilds/${guildId}/game-servers/${serverId}`),
  };
}

export const gameServersApi = createGameServersApi(getActiveApi);

/** An error as the person should read it, without the "bad request:" prefix. */
export function gameServerErrorMessage(err: unknown): string {
  return extractApiError(err).replace(/^bad request:\s*/i, '');
}
