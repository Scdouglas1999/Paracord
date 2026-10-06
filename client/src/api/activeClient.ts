import type { AxiosInstance } from 'axios';
import { apiClient } from './client';
import { connectionManager } from '../lib/connectionManager';
import { useServerListStore } from '../stores/serverListStore';
import { LOCAL_SERVER_ID } from '../lib/serverScope';

/**
 * The selected (or named) saved server has no connection to talk through: it is
 * still connecting, being retried, or signed out. A condition of the moment, not
 * a bug: callers that run while a page renders wait for the server
 * (`useServerReady`) and show their quiet loading state, and anything that
 * reaches a request anyway gets this as a rejected promise, never a throw.
 */
export class ServerNotConnectedError extends Error {
  readonly serverId: string;

  constructor(serverId: string) {
    super('This server is not connected. Reconnect before trying again.');
    this.name = 'ServerNotConnectedError';
    this.serverId = serverId;
  }
}

export function isServerNotConnectedError(error: unknown): error is ServerNotConnectedError {
  return error instanceof ServerNotConnectedError;
}

/**
 * Resolve the axios instance domain REST should use for the *current* request.
 *
 * A selected remote server must have its own client. An unavailable connection
 * is an error: substituting the home client could send data to another server.
 *
 * Call this at request time — never capture the result at module load — because
 * the active server changes as the user switches servers.
 *
 * It THROWS when the server has no connection, so call it inside an `async`
 * function or a `try` (a throw from an effect or a render reaches the error
 * boundary and takes the page down with it); `useServerReady` says when the
 * answer will be a client.
 */
export function getApi(): AxiosInstance {
  return getServerApi(useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID);
}

export function getServerApi(serverId: string): AxiosInstance {
  if (serverId === LOCAL_SERVER_ID) return apiClient;
  const client = connectionManager.getApiClient(serverId);
  if (!client) throw new ServerNotConnectedError(serverId);
  return client;
}
