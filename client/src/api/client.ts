import axios, { type AxiosError, type AxiosInstance } from 'axios';
import { resolveApiBaseUrl } from '../lib/config/apiBaseUrl';
import { getTauriAdapter } from '../lib/tauriAxiosAdapter';
import { isTauri } from '../lib/tauriEnv';
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
import type { ApiRequestContext } from './requestContext';
import { DATABASE_HISTORY_HEADER } from '../lib/databaseHistory';
import {
  coordinateRefresh,
  HOME_REFRESH_SCOPE,
  type SessionRefreshResult,
} from '../lib/authRefreshCoordinator';
import { noteSessionEnded, SESSION_REVOKED_MESSAGE } from '../lib/sessionEnded';

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
let clientInstanceSequence = 0;

type TimedRequestConfig = {
  _paracordContext?: ApiRequestContext;
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
 * The HTTP status behind an error, when there is one.
 *
 * Used to tell "we cannot reach the server" (worth a toast) apart from "this is
 * not yours to see" (the surface renders a state; a toast is just noise on top
 * of it).
 */
export function apiErrorStatus(err: unknown): number | null {
  return axios.isAxiosError(err) ? (err.response?.status ?? null) : null;
}

/** True when the server answered "you cannot see this", or "there is no this". */
export function isMissingOrForbidden(err: unknown): boolean {
  const status = apiErrorStatus(err);
  return status === 403 || status === 404;
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

/**
 * True when the server has definitively said the session no longer exists.
 *
 * Only this answer may end a session. A timeout, a dropped connection, a 500 or
 * a 503 mean "ask again later" — tearing the session down on those is how a
 * four-second server restart used to sign the user out of an app that was
 * otherwise fine.
 */
function isSessionGoneError(err: unknown): boolean {
  const status = apiErrorStatus(err);
  return status === 401 || status === 403;
}

/**
 * End the home session and say why.
 *
 * Clearing `authStore` alone is not enough: the saved-server entry that carries
 * the *same* credential keeps its copy, `ProtectedRoute` still sees a hydrated
 * server session, and the user is left inside a shell with no name, no
 * buildings and a permanent "Connection lost" bar. Every copy of the dead
 * credential goes, and the sign-in screen is handed a sentence to show.
 */
function endHomeSession(reason: string): void {
  const deadAccess = getAccessToken();
  const deadRefresh = getRefreshToken();
  clearPersistedAuth();
  useAuthStore.setState({ token: null, user: null });

  const store = useServerListStore.getState();
  for (const server of store.servers) {
    const carriesDeadCredential =
      (!!deadAccess && server.token === deadAccess) ||
      (!!deadRefresh && server.refreshToken === deadRefresh);
    if (!carriesDeadCredential) continue;
    store.updateToken(server.id, '');
    store.updateRefreshToken(server.id, null);
  }

  // Only a session that existed can have ended. A brand-new profile that has
  // never signed in still meets 401s (a probe, a stale saved server), and
  // telling that person "your session ended on the server" is a lie on the
  // very first screen they see.
  if (deadAccess || deadRefresh) noteSessionEnded(reason);
}

/**
 * Shared single-flight session refresh for the home session.
 *
 * Every caller that refreshes the *same* credential must go through the
 * refresh coordinator with the same scope key — see
 * `lib/authRefreshCoordinator`. The server rotates the refresh token on each
 * use and treats a second presentation of a spent token as theft, so two
 * concurrent refreshes do not merely make the loser 401: they revoke every
 * session the account has.
 */
export function refreshSharedSession(): Promise<string> {
  return refreshLegacyToken();
}

/**
 * A refresh with no credential in it.
 *
 * The refresh endpoint takes the rotating token in the body, or — same-origin
 * in a browser — from the HttpOnly `paracord_refresh` cookie. The desktop has
 * neither: its page is `tauri://localhost`, so no cookie of the instance's is
 * ever sent, and a POST with no body is not an expired session, it is a
 * malformed request. The server answered 400, the shell read "the session is
 * gone" and showed the password screen — on every single launch, which is
 * exactly how a lost refresh token wore the face of an expired one (a real
 * credential that had gone bad would have answered 401).
 *
 * So: on the desktop, no stored refresh token means there is nothing to
 * refresh. Say so here rather than asking the server to say it.
 */
export class NoRefreshCredentialError extends Error {
  constructor() {
    super('This device holds no saved session for this instance.');
    this.name = 'NoRefreshCredentialError';
  }
}

/** Whether a refresh may be attempted at all with the credential we hold. */
export function canAttemptRefresh(refreshToken: string | null): boolean {
  return Boolean(refreshToken) || !isTauri();
}

async function refreshLegacyToken(context?: ApiRequestContext): Promise<string> {
  const result = await coordinateRefresh(HOME_REFRESH_SCOPE, async () => {
    // Read the stored refresh token *inside* the flight: a value captured
    // before someone else's rotation is precisely the spent credential that
    // trips the server's reuse detection.
    const refreshToken = getRefreshToken();
    if (!canAttemptRefresh(refreshToken)) throw new NoRefreshCredentialError();
    const refresh = await apiClient.post<{ token: string; refresh_token?: string }>(
      '/auth/refresh',
      refreshToken ? { refresh_token: refreshToken } : undefined,
      context ? { _paracordContext: context, signal: context.signal } : undefined,
    );
    return { token: refresh.data.token, refreshToken: refresh.data.refresh_token ?? null };
  });
  context?.assertCurrent();
  // Applied by every caller, including one that only joined someone else's
  // flight, so nobody is left holding the pre-rotation credential.
  setAccessToken(result.token);
  if (result.refreshToken) setRefreshToken(result.refreshToken);
  return result.token;
}

function markRequestApiReachable(baseURL: string | undefined, reachable: boolean): void {
  if (!baseURL) return;
  const requestUrl = new URL(baseURL, window.location.href).href;
  const store = useServerListStore.getState();
  const server = store.getServerByUrl(requestUrl);
  if (server) store.setApiReachable(server.id, reachable);
}

// Auth interceptor for legacy client
apiClient.interceptors.request.use((config) => {
  // Resolve at request time so "Add server" updates apply without full reload.
  config._paracordContext?.assertCurrent();
  if (config._paracordContext) {
    if (config._paracordContext.historyEpoch) config.headers.set(DATABASE_HISTORY_HEADER, config._paracordContext.historyEpoch);
    else config.headers.delete(DATABASE_HISTORY_HEADER);
  }
  config.baseURL = config._paracordContext?.baseURL ?? resolveApiBaseUrl();
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
    res.config._paracordContext?.assertResponseCurrent?.(res.headers);
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
    markRequestApiReachable(res.config.baseURL, true);
    return res;
  },
  async (err) => {
    const original = err.config as ({
      _retry?: boolean;
      url?: string;
      headers?: Record<string, string>;
    } & TimedRequestConfig);
    original?._paracordContext?.assertCurrent();
    if (err.response) original?._paracordContext?.assertResponseCurrent?.(err.response.headers);
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
      markRequestApiReachable(err.config?.baseURL, true);
    }

    if (
      err.response?.status === 401 &&
      !original?._retry &&
      original?.url !== '/auth/refresh'
    ) {
      original._retry = true;
      try {
        const nextToken = await refreshLegacyToken(original?._paracordContext);
        original?._paracordContext?.assertCurrent();
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${nextToken}`;
        return apiClient.request(original);
      } catch (refreshErr) {
        original?._paracordContext?.assertCurrent();
        // Only a definitive "this session is gone" ends the session. A refresh
        // that failed because the server was restarting must leave the
        // credential alone — ProtectedRoute redirects to /login via React
        // Router, and a hard navigation would kill voice and gateway sockets
        // mid-call over what was a four-second blip.
        if (isSessionGoneError(refreshErr)) endHomeSession(SESSION_REVOKED_MESSAGE);
        return Promise.reject(err);
      }
    }

    if (err.response?.status === 401 && original?.url !== '/auth/refresh') {
      endHomeSession(SESSION_REVOKED_MESSAGE);
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
  /**
   * Which *credential* this client refreshes, so every instance that draws on
   * the same stored refresh token shares one flight. Omit it only for a client
   * whose session is genuinely its own — the default is a key unique to this
   * instance, which is a single-flight guard for this instance alone and, as
   * this app learned the hard way, no guard at all for a shared credential.
   */
  refreshScope?: string | (() => string),
): AxiosInstance {
  const client = axios.create({
    baseURL: baseUrl,
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
    timeout: 15_000,
    adapter: getTauriAdapter(),
  });

  const ownScope = `auth:client:${baseUrl}:${(clientInstanceSequence += 1)}`;
  const resolveRefreshScope = (): string =>
    typeof refreshScope === 'function' ? refreshScope() : (refreshScope ?? ownScope);

  const refreshAccessToken = async (context?: ApiRequestContext): Promise<string> => {
    const result: SessionRefreshResult = await coordinateRefresh(
      resolveRefreshScope(),
      async () => {
        // Pass the stored per-server refresh token in the body: for remote
        // servers the HttpOnly `paracord_refresh` cookie is unavailable
        // cross-origin, so cookie-only refresh always 401s. Read it inside the
        // flight — a token captured before another caller's rotation is the
        // spent credential that trips reuse detection.
        const refreshToken = getRefreshToken?.() ?? null;
        if (!canAttemptRefresh(refreshToken)) throw new NoRefreshCredentialError();
        const refresh = await client.post<{ token: string; refresh_token?: string }>(
          '/auth/refresh',
          refreshToken ? { refresh_token: refreshToken } : undefined,
          context ? { _paracordContext: context, signal: context.signal } : undefined,
        );
        return { token: refresh.data.token, refreshToken: refresh.data.refresh_token ?? null };
      },
    );
    context?.assertCurrent();
    // Persist the rotated refresh token so the next refresh presents a valid
    // credential (the server rotates on every refresh). Run for joiners too,
    // so a client that only awaited someone else's flight still stores it.
    onTokenRefreshed?.(result.token, result.refreshToken ?? undefined);
    return result.token;
  };

  // Auth interceptor
  client.interceptors.request.use((config) => {
    config._paracordContext?.assertCurrent();
    if (config._paracordContext) {
      if (config._paracordContext.historyEpoch) config.headers.set(DATABASE_HISTORY_HEADER, config._paracordContext.historyEpoch);
      else config.headers.delete(DATABASE_HISTORY_HEADER);
    }
    if (config._paracordContext) config.baseURL = config._paracordContext.baseURL;
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
      res.config._paracordContext?.assertResponseCurrent?.(res.headers);
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
      original?._paracordContext?.assertCurrent();
      if (err.response) original?._paracordContext?.assertResponseCurrent?.(err.response.headers);
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
          const nextToken = await refreshAccessToken(original?._paracordContext);
          original?._paracordContext?.assertCurrent();
          original.headers = original.headers ?? {};
          original.headers.Authorization = `Bearer ${nextToken}`;
          return client.request(original);
        } catch (refreshErr) {
          original?._paracordContext?.assertCurrent();
          // A refresh that failed because the server was unreachable or
          // restarting is not a reason to throw the credential away; only the
          // server saying the session is gone is.
          if (isSessionGoneError(refreshErr)) onAuthFailed?.();
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
