import type { AxiosInstance } from 'axios';
import { apiClient } from './client';
import { connectionManager } from '../lib/connectionManager';

/**
 * Resolve the axios instance domain REST should use for the *current* request.
 *
 * Returns the active server's per-server client (isolated base URL + token)
 * when one exists, falling back to the LOCAL-only `apiClient` singleton during
 * bootstrap (login/register, before any per-server connection is established).
 *
 * Call this at request time — never capture the result at module load — because
 * the active server changes as the user switches servers.
 */
export function getApi(): AxiosInstance {
  return connectionManager.getActiveApiClient() ?? apiClient;
}
