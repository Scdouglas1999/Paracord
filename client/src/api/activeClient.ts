import type { AxiosInstance } from 'axios';
import { apiClient } from './client';
import { connectionManager } from '../lib/connectionManager';
import { useServerListStore } from '../stores/serverListStore';
import { LOCAL_SERVER_ID } from '../lib/serverScope';

/**
 * Resolve the axios instance domain REST should use for the *current* request.
 *
 * A selected remote server must have its own client. An unavailable connection
 * is an error: substituting the home client could send data to another server.
 *
 * Call this at request time — never capture the result at module load — because
 * the active server changes as the user switches servers.
 */
export function getApi(): AxiosInstance {
  return getServerApi(useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID);
}

export function getServerApi(serverId: string): AxiosInstance {
  if (serverId === LOCAL_SERVER_ID) return apiClient;
  const client = connectionManager.getApiClient(serverId);
  if (!client) throw new Error('This server is not connected. Reconnect before trying again.');
  return client;
}
