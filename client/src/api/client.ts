import axios, { type AxiosInstance } from 'axios';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl';

// Legacy singleton for backward compatibility during migration.
// New code should use createApiClient() or the connection manager.
export const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
});

const clearPersistedAuth = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('auth-storage');
};

// Auth interceptor for legacy client
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token && token !== 'null' && token !== 'undefined') {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Error interceptor for legacy client
apiClient.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config as { _retry?: boolean; url?: string; headers?: Record<string, string> };
    const token = localStorage.getItem('token');
    if (
      err.response?.status === 401 &&
      token &&
      !original?._retry &&
      original?.url !== '/auth/refresh'
    ) {
      original._retry = true;
      try {
        const refresh = await apiClient.post<{ token: string }>('/auth/refresh');
        const nextToken = refresh.data.token;
        localStorage.setItem('token', nextToken);
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${nextToken}`;
        return apiClient.request(original);
      } catch {
        clearPersistedAuth();
        window.location.href = '/login';
        return Promise.reject(err);
      }
    }
    if (err.response?.status === 401) {
      clearPersistedAuth();
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

/**
 * Create a new API client for a specific server.
 * Each server gets its own axios instance with its own base URL and token management.
 */
export function createApiClient(
  baseUrl: string,
  getToken: () => string | null,
  onTokenRefreshed?: (token: string) => void,
  onAuthFailed?: () => void,
): AxiosInstance {
  const client = axios.create({
    baseURL: baseUrl,
    headers: { 'Content-Type': 'application/json' },
  });

  // Auth interceptor
  client.interceptors.request.use((config) => {
    const token = getToken();
    if (token && token !== 'null' && token !== 'undefined') {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // Error + refresh interceptor
  client.interceptors.response.use(
    (res) => res,
    async (err) => {
      const original = err.config as { _retry?: boolean; url?: string; headers?: Record<string, string> };
      const token = getToken();
      if (
        err.response?.status === 401 &&
        token &&
        !original?._retry &&
        original?.url !== '/auth/refresh'
      ) {
        original._retry = true;
        try {
          const refresh = await client.post<{ token: string }>('/auth/refresh');
          const nextToken = refresh.data.token;
          onTokenRefreshed?.(nextToken);
          original.headers = original.headers ?? {};
          original.headers.Authorization = `Bearer ${nextToken}`;
          return client.request(original);
        } catch {
          onAuthFailed?.();
          return Promise.reject(err);
        }
      }
      if (err.response?.status === 401) {
        onAuthFailed?.();
      }
      return Promise.reject(err);
    }
  );

  return client;
}
