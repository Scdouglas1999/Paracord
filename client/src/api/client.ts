import axios, { type AxiosError, type AxiosInstance } from 'axios';
import { resolveApiBaseUrl } from '../lib/config/apiBaseUrl';
import { getTauriAdapter } from '../lib/tauriAxiosAdapter';
import {
  clearLegacyPersistedAuth,
  getAccessToken,
  getCsrfToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from '../lib/authToken';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { toast } from '../stores/toastStore';

const API_SLOW_REQUEST_MS = 800;
const API_TIMING_VERBOSE =
  import.meta.env.VITE_API_TIMING_TRACE === '1' ||
  import.meta.env.VITE_API_TIMING_TRACE === 'true';
const API_LOG_REDACTED = '[redacted]';
const API_LOG_SENSITIVE_QUERY_RE =
  /([?&](?:token|ticket|access_token|refresh_token|media_token|session_id|csrf|secret|password|webhook_token)=)[^&#\s]+/gi;
const API_LOG_WEBHOOK_TOKEN_PATH_RE =
  /(\/webhooks\/[^/?#\s]+\/)([^/?#\s]+)(?=(?:\/messages\/|[/?#\s]|$))/gi;
const API_LOG_INTERACTION_TOKEN_PATH_RE =
  /(\/interactions\/[^/?#\s]+\/)([^/?#\s]+)(?=(?:\/(?:callback|messages|followup)|[/?#\s]|$))/gi;

let apiRequestSequence = 0;

type TimedRequestConfig = {
  _pcStartMs?: number;
  _pcRequestId?: string;
  _pcAttempt?: number;
  method?: string;
  url?: string;
};

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function nextRequestId(): string {
  apiRequestSequence += 1;
  return `api-${Date.now().toString(36)}-${apiRequestSequence.toString(36)}`;
}

function startTiming(config: TimedRequestConfig): void {
  config._pcStartMs = nowMs();
  config._pcRequestId = config._pcRequestId ?? nextRequestId();
  config._pcAttempt = (config._pcAttempt ?? 0) + 1;
}

function elapsedMs(config: TimedRequestConfig): number | null {
  if (typeof config._pcStartMs !== 'number') return null;
  return Math.max(0, Math.round(nowMs() - config._pcStartMs));
}

export function redactApiLogUrl(url: string): string {
  return url
    .replace(API_LOG_SENSITIVE_QUERY_RE, `$1${API_LOG_REDACTED}`)
    .replace(API_LOG_WEBHOOK_TOKEN_PATH_RE, `$1${API_LOG_REDACTED}`)
    .replace(API_LOG_INTERACTION_TOKEN_PATH_RE, `$1${API_LOG_REDACTED}`);
}

function requestLabel(config: TimedRequestConfig): string {
  const method = (config.method ?? 'GET').toUpperCase();
  const url = redactApiLogUrl(config.url ?? '(unknown-url)');
  return `${method} ${url}`;
}

function readTraceIdFromHeaders(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null;

  const headerHolder = headers as { get?: (name: string) => unknown };
  if (typeof headerHolder.get === 'function') {
    // Call as a method so `this` stays bound: axios's AxiosHeaders.get relies
    // on `this` and throws if invoked detached from the headers instance.
    const fromGet = headerHolder.get('x-paracord-trace-id');
    if (typeof fromGet === 'string' && fromGet.trim().length > 0) {
      return fromGet.trim();
    }
  }

  const raw = (headers as Record<string, unknown>)['x-paracord-trace-id']
    ?? (headers as Record<string, unknown>)['X-Paracord-Trace-Id'];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }

  return null;
}

function shouldAttachCsrf(method?: string): boolean {
  if (!method) return false;
  const normalized = method.toUpperCase();
  return normalized === 'POST' || normalized === 'PUT' || normalized === 'PATCH' || normalized === 'DELETE';
}

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

// ---------------------------------------------------------------------------
// REST routing decision (PATH A: per-server REST)
// ---------------------------------------------------------------------------
// Paracord genuinely supports multiple simultaneously-connected servers:
// `connectionManager.connectAll()` opens a `ServerConnection` — each with its
// own axios instance built by `createApiClient()` and its own isolated token —
// for every entry in `serverListStore`, plus an optional `__local__`
// connection. The UI tracks which server is focused via
// `serverListStore.activeServerId`.
//
// Domain REST therefore must target the *active* server's per-server client so
// requests carry that server's token and base URL. Domain modules call
// `getApi()` (see ./activeClient) at request time, which returns
// `connectionManager.getActiveApiClient()` and falls back to the `apiClient`
// singleton below only during LOCAL bootstrap (login/register, before any
// per-server connection exists).
//
// `apiClient` is the LOCAL-only singleton: its token is the global authStore /
// authToken access token used for same-origin login flows and the `__local__`
// server. Per-remote-server tokens live in secure per-server storage and are
// NOT written into the global authStore, keeping the singleton LOCAL-only.
export const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
  timeout: 15_000, // 15s default timeout to avoid indefinite hangs.
  adapter: getTauriAdapter(),
});

const clearPersistedAuth = () => {
  setAccessToken(null);
  clearLegacyPersistedAuth();
};

// Single-flight refresh guard for the legacy client. When multiple requests
// 401 at once (e.g. a burst on app load), the first one performs the refresh
// and every concurrent 401 awaits the same promise. Without this, the 2nd+
// refresh would present an already-rotated refresh token, fail, and log the
// user out mid-session.
let legacyRefreshPromise: Promise<string> | null = null;

/**
 * Shared single-flight session refresh for the active server.
 *
 * Every caller that refreshes the *same* credential must go through here.
 * The server rotates the refresh token on each use, so two concurrent
 * refreshes present the same (now-stale) token and the loser 401s — which
 * previously logged the user out at random on page load, because session
 * bootstrap refreshed on its own path while the request interceptor
 * refreshed on this one.
 */
export function refreshSharedSession(): Promise<string> {
  return refreshLegacyToken();
}

async function refreshLegacyToken(): Promise<string> {
  if (!legacyRefreshPromise) {
    legacyRefreshPromise = (async () => {
      const refreshToken = getRefreshToken();
      const refresh = await apiClient.post<{ token: string; refresh_token?: string }>(
        '/auth/refresh',
        refreshToken ? { refresh_token: refreshToken } : undefined,
      );
      const nextToken = refresh.data.token;
      setAccessToken(nextToken);
      if (refresh.data.refresh_token) setRefreshToken(refresh.data.refresh_token);
      return nextToken;
    })().finally(() => {
      legacyRefreshPromise = null;
    });
  }
  return legacyRefreshPromise;
}

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
  startTiming(config as TimedRequestConfig);
  const token = getAccessToken();
  if (shouldAttachCsrf(config.method)) {
    const csrf = getCsrfToken();
    if (csrf) {
      config.headers['X-Paracord-CSRF'] = csrf;
    }
  }
  if (token && token !== 'null' && token !== 'undefined') {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Error interceptor for legacy client
apiClient.interceptors.response.use(
  (res) => {
    const cfg = res.config as TimedRequestConfig;
    const tookMs = elapsedMs(cfg);
    if (tookMs != null && (API_TIMING_VERBOSE || tookMs >= API_SLOW_REQUEST_MS)) {
      const traceId = readTraceIdFromHeaders(res.headers);
      console.info('[api] response', {
        requestId: cfg._pcRequestId ?? null,
        attempt: cfg._pcAttempt ?? null,
        request: requestLabel(cfg),
        status: res.status,
        tookMs,
        traceId,
      });
    }
    markActiveServerApiReachable(true);
    return res;
  },
  async (err) => {
    const original = err.config as ({
      _retry?: boolean;
      url?: string;
      headers?: Record<string, string>;
    } & TimedRequestConfig);
    const tookMs = elapsedMs(original ?? {});
    const traceId = readTraceIdFromHeaders(err.response?.headers);
    if (
      API_TIMING_VERBOSE ||
      tookMs == null ||
      tookMs >= API_SLOW_REQUEST_MS ||
      !err.response
    ) {
      console.warn('[api] error', {
        requestId: original?._pcRequestId ?? null,
        attempt: original?._pcAttempt ?? null,
        request: requestLabel(original ?? {}),
        status: err.response?.status ?? null,
        tookMs,
        traceId,
        code: err.code ?? null,
        message: err.message,
      });
    }
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
        const nextToken = await refreshLegacyToken();
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
 * Domain REST reaches these instances via `getApi()` (see ./activeClient),
 * which resolves the active server's client at request time.
 */
export function createApiClient(
  baseUrl: string,
  getToken: () => string | null,
  onTokenRefreshed?: (token: string, refreshToken?: string) => void,
  onAuthFailed?: () => void,
  onApiReachabilityChanged?: (reachable: boolean) => void,
  getRefreshToken?: () => string | null,
): AxiosInstance {
  const client = axios.create({
    baseURL: baseUrl,
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
    timeout: 15_000,
    adapter: getTauriAdapter(),
  });

  // Single-flight refresh guard scoped to this client instance. Concurrent
  // 401s share one in-flight refresh so rotating refresh tokens are not
  // presented twice (which would fail and tear down the connection).
  let refreshPromise: Promise<string> | null = null;
  const refreshAccessToken = (): Promise<string> => {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        // Pass the stored per-server refresh token in the body: for remote
        // servers the HttpOnly `paracord_refresh` cookie is unavailable
        // cross-origin, so cookie-only refresh always 401s.
        const refreshToken = getRefreshToken?.() ?? null;
        const refresh = await client.post<{ token: string; refresh_token?: string }>(
          '/auth/refresh',
          refreshToken ? { refresh_token: refreshToken } : undefined,
        );
        const nextToken = refresh.data.token;
        // Persist the rotated refresh token so the next refresh presents a
        // valid credential (the server rotates on every refresh).
        onTokenRefreshed?.(nextToken, refresh.data.refresh_token);
        return nextToken;
      })().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  };

  // Auth interceptor
  client.interceptors.request.use((config) => {
    startTiming(config as TimedRequestConfig);
    const token = getToken();
    if (shouldAttachCsrf(config.method)) {
      const csrf = getCsrfToken();
      if (csrf) {
        config.headers['X-Paracord-CSRF'] = csrf;
      }
    }
    if (token && token !== 'null' && token !== 'undefined') {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // Error + refresh interceptor
  client.interceptors.response.use(
    (res) => {
      const cfg = res.config as TimedRequestConfig;
      const tookMs = elapsedMs(cfg);
      if (tookMs != null && (API_TIMING_VERBOSE || tookMs >= API_SLOW_REQUEST_MS)) {
        const traceId = readTraceIdFromHeaders(res.headers);
        console.info('[api] response', {
          requestId: cfg._pcRequestId ?? null,
          attempt: cfg._pcAttempt ?? null,
          request: requestLabel(cfg),
          status: res.status,
          tookMs,
          traceId,
        });
      }
      onApiReachabilityChanged?.(true);
      return res;
    },
    async (err) => {
      const original = err.config as ({
        _retry?: boolean;
        url?: string;
        headers?: Record<string, string>;
      } & TimedRequestConfig);
      const tookMs = elapsedMs(original ?? {});
      const traceId = readTraceIdFromHeaders(err.response?.headers);
      if (
        API_TIMING_VERBOSE ||
        tookMs == null ||
        tookMs >= API_SLOW_REQUEST_MS ||
        !err.response
      ) {
        console.warn('[api] error', {
          requestId: original?._pcRequestId ?? null,
          attempt: original?._pcAttempt ?? null,
          request: requestLabel(original ?? {}),
          status: err.response?.status ?? null,
          tookMs,
          traceId,
          code: err.code ?? null,
          message: err.message,
        });
      }
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
          const nextToken = await refreshAccessToken();
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
