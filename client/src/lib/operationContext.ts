import { AxiosHeaders, type AxiosRequestConfig, type AxiosResponse, type RawAxiosHeaders } from 'axios';
import { getServerApi } from '../api/activeClient';
import type { ApiRequestContext } from '../api/requestContext';
import { createRestClient } from '../api/restClient';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { resolveApiBaseUrl } from './config/apiBaseUrl';
import { getServerUser } from './serverIdentity';
import { accountScopeKey, LOCAL_SERVER_ID, type AccountScope } from './serverScope';
import { DATABASE_HISTORY_HEADER, getDatabaseHistoryEpoch, requestHistoryReconciliation, subscribeDatabaseHistoryOperation } from './databaseHistory';

export class OperationExpiredError extends Error {
  constructor(message = 'The account for this operation is no longer signed in.') { super(message); }
}

export class DatabaseHistoryExpiredError extends OperationExpiredError {
  constructor() { super('Database history changed. Reconnect this account before continuing.'); }
}

/** Resolve an API-version path without allowing URL normalization to change its target. */
export function resolveCapturedApiRoot(baseURL: string, path: string): string {
  const pathname = path.split('?')[0];
  if (!/^\/api\/v[12]\//.test(pathname) || path.includes('#') || /[\\\s]/.test(path)) {
    throw new Error('Expected an origin-relative /api/v1/ or /api/v2/ path.');
  }
  let decoded = pathname;
  for (let i = 0; i < 5; i++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('//')
      || decoded.split('/').some(segment => segment === '.' || segment === '..')
      || decoded.split('/').length !== pathname.split('/').length) {
    throw new Error('API paths cannot contain encoded separators or traversal.');
  }
  const base = new URL(baseURL, typeof window === 'undefined' ? 'http://localhost' : window.location.href);
  const target = new URL(path, base.origin);
  if (target.origin !== base.origin || target.pathname !== pathname) throw new Error('Invalid API path.');
  return target.href;
}

/** Capture before any await. Selection changes never retarget this operation. */
export function captureOperationContext(serverId = useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID) {
  const user = getServerUser(serverId);
  if (!user) throw new Error('Sign in to this server before continuing.');
  const client = getServerApi(serverId);
  const resolveScopeBase = () => {
    if (serverId === LOCAL_SERVER_ID) return resolveApiBaseUrl();
    const server = useServerListStore.getState().getServer(serverId);
    return server ? `${server.url.replace(/\/+$/, '')}/api/v1` : null;
  };
  const baseURL = resolveScopeBase();
  if (!baseURL) throw new OperationExpiredError();
  const scope: AccountScope = Object.freeze({ serverId, userId: user.id });
  const historyEpoch = getDatabaseHistoryEpoch(scope);
  const controller = new AbortController();
  const unsubscribers: Array<() => void> = [];
  const expire = () => controller.abort(new OperationExpiredError());
  const expireHistory = () => controller.abort(new DatabaseHistoryExpiredError());
  const assertCurrent = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const current = getServerUser(serverId);
    const token = serverId === LOCAL_SERVER_ID
      ? useAuthStore.getState().token
      : useServerListStore.getState().getServer(serverId)?.token;
    if (!token || current?.id !== scope.userId || resolveScopeBase() !== baseURL) {
      expire();
      throw new OperationExpiredError();
    }
    if (getDatabaseHistoryEpoch(scope) !== historyEpoch) {
      expireHistory();
      throw controller.signal.reason;
    }
  };
  controller.signal.addEventListener('abort', () => unsubscribers.splice(0).forEach(unsubscribe => unsubscribe()), { once: true });
  unsubscribers.push(subscribeDatabaseHistoryOperation(scope, expireHistory));
  if (serverId === LOCAL_SERVER_ID) {
    unsubscribers.push(useAuthStore.subscribe((next, previous) => {
      if (!next.token || next.user?.id !== scope.userId || (next.token !== previous.token && next.user !== previous.user)) expire();
    }));
  } else {
    unsubscribers.push(useServerListStore.subscribe(() => {
      try { assertCurrent(); } catch { /* assertCurrent already expires the operation. */ }
    }));
  }
  assertCurrent();
  const assertResponseCurrent = (headers: unknown) => {
    assertCurrent();
    if (historyEpoch && AxiosHeaders.from(headers as RawAxiosHeaders).get(DATABASE_HISTORY_HEADER) !== historyEpoch) {
      expireHistory(); requestHistoryReconciliation(scope);
      throw controller.signal.reason;
    }
  };
  const ownership: ApiRequestContext = { baseURL, signal: controller.signal, historyEpoch, assertCurrent, assertResponseCurrent };
  const performRequest = async <T>(config: AxiosRequestConfig, rootPath = false): Promise<AxiosResponse<T>> => {
    assertCurrent();
    if (!config.url?.startsWith('/') || config.url.startsWith('//') || config.url.includes('\\')) {
      throw new Error('Operation requests must use a server-relative API path.');
    }
    const url = rootPath ? resolveCapturedApiRoot(baseURL, config.url) : config.url;
    const headers = AxiosHeaders.from(config.headers as RawAxiosHeaders | undefined);
    if (historyEpoch) headers.set(DATABASE_HISTORY_HEADER, historyEpoch);
    else headers.delete(DATABASE_HISTORY_HEADER);
    let response: AxiosResponse<T>;
    try {
      response = await client.request<T>({
        ...config, url, headers, baseURL,
        signal: config.signal ? AbortSignal.any([controller.signal, config.signal as AbortSignal]) : controller.signal,
        _paracordContext: ownership,
      });
    } catch (error) {
      assertCurrent();
      const failure = error as { response?: AxiosResponse };
      if (failure.response?.status === 409 && failure.response.data?.code === 'HISTORY_CHANGED') {
        expireHistory(); requestHistoryReconciliation(scope);
      }
      throw error;
    }
    assertResponseCurrent(response.headers);
    return response;
  };
  const request = <T>(config: AxiosRequestConfig) => performRequest<T>(config);
  const requestRoot = <T>(config: AxiosRequestConfig) => performRequest<T>(config, true);
  return {
    scope,
    historyEpoch,
    key: accountScopeKey(scope),
    user: Object.freeze({ ...user }),
    signal: controller.signal,
    assertCurrent,
    request,
    requestRoot,
    api: createRestClient(request),
    dispose: expire,
  };
}

export type OperationContext = ReturnType<typeof captureOperationContext>;

/** Validate a reference captured by a view before starting an operation for it. */
export function captureScopedOperation(scope: AccountScope): OperationContext {
  const context = captureOperationContext(scope.serverId);
  if (context.scope.userId !== scope.userId) {
    context.dispose();
    throw new OperationExpiredError();
  }
  return context;
}
