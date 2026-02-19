import axios, { type AxiosError, type AxiosInstance } from 'axios';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl';
import { clearLegacyPersistedAuth, getAccessToken, getRefreshToken, setAccessToken, setRefreshToken } from '../lib/authToken';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { toast } from '../stores/toastStore';

/** Standardized API error response shape from the server. */
export interface ApiErrorResponse {
  code: string;
  message: string;
  details?: unknown;
  /** Legacy field kept for backwards compatibility. */
  error?: string;
}

/**
 * Extract a human-readable error message from an API error.
 * Supports the standardized {code, message, details} format.
 */
export function extractApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = (err as AxiosError<ApiErrorResponse>).response?.data;
    if (data && typeof data === 'object' && typeof data.message === 'string') {
      return data.message;
    }
    const legacyError = (data as { error?: unknown } | undefined)?.error;
    if (legacyError != null) {
      return String(legacyError);
    }
    if (err.message) return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'An unexpected error occurred';
}

/**
 * Extract the machine-readable error code from an API error response.
 */
export function extractApiErrorCode(err: unknown): string | null {
  if (axios.isAxiosError(err)) {
    const data = (err as AxiosError<ApiErrorResponse>).response?.data;
    if (data && typeof data === 'object' && 'code' in data) {
      return String(data.code);
    }
  }
  return null;
}

/**
 * Show a toast for an API error. Use as a one-liner in catch blocks:
 * `.catch(toastApiError)`
 */
export function toastApiError(err: unknown): void {
  const message = extractApiError(err);
  toast.error(message);
}

// Legacy singleton for backward compatibility during migration.
// New code should use createApiClient() or the connection manager.
export const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
  timeout: 15_000, // 15s default timeout to avoid indefinite hangs.
});

const clearPersistedAuth = () => {
  setAccessToken(null);
  clearLegacyPersistedAuth();
};

function markActiveServerApiReachable(reachable: boolean): void {
  const store = useServerListStore.getState();
  const activeServerId = store.activeServerId;
  if (!activeServerId) return;
  store.setApiReachable(activeServerId, reachable);
}

// Auth interceptor for legacy client
apiClient.interceptors.request.use((config) => {
  // Resolve at request time so "Add Server" updates apply without full reload.
  config.baseURL = resolveApiBaseUrl();
  const token = getAccessToken();
  if (token && token !== 'null' && token !== 'undefined') {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Error interceptor for legacy client
apiClient.interceptors.response.use(
  (res) => {
    markActiveServerApiReachable(true);
    return res;
  },
  async (err) => {
    const original = err.config as { _retry?: boolean; url?: string; headers?: Record<string, string> };
    if (err.response) {
      // HTTP response means transport was reachable (even for 4xx/5xx).
      markActiveServerApiReachable(true);
    }

    if (
      err.response?.status === 401 &&
      !original?._retry &&
      original?.url !== '/auth/refresh'
    ) {
      original._retry = true;
      try {
        const refreshToken = getRefreshToken();
        const refresh = await apiClient.post<{ token: string; refresh_token?: string }>(
          '/auth/refresh',
          refreshToken ? { refresh_token: refreshToken } : undefined,
        );
        const nextToken = refresh.data.token;
        setAccessToken(nextToken);
        if (refresh.data.refresh_token) setRefreshToken(refresh.data.refresh_token);
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${nextToken}`;
        return apiClient.request(original);
      } catch {
        clearPersistedAuth();
        // Clear auth state so ProtectedRoute redirects to /login via React
        // Router.  A hard `window.location.href` navigation would kill all
        // active WebSocket connections (voice, gateway) mid-call.
        useAuthStore.setState({ token: null, user: null });
        return Promise.reject(err);
      }
    }

    if (err.response?.status === 401 && original?.url !== '/auth/refresh') {
      clearPersistedAuth();
      useAuthStore.setState({ token: null, user: null });
    }
    return Promise.reject(err);
  }
);

/**
 * Create a new API client for a specific server.
 * Each server gets its own axios instance with isolated token management.
 */
export function createApiClient(
  baseUrl: string,
  getToken: () => string | null,
  onTokenRefreshed?: (token: string) => void,
  onAuthFailed?: () => void,
  onApiReachabilityChanged?: (reachable: boolean) => void,
): AxiosInstance {
  const client = axios.create({
    baseURL: baseUrl,
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
    timeout: 15_000,
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
    (res) => {
      onApiReachabilityChanged?.(true);
      return res;
    },
    async (err) => {
      const original = err.config as { _retry?: boolean; url?: string; headers?: Record<string, string> };
      if (err.response) {
        onApiReachabilityChanged?.(true);
      }
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
      if (err.response?.status === 401 && original?.url !== '/auth/refresh') {
        onAuthFailed?.();
      }
      return Promise.reject(err);
    }
  );

  return client;
}
