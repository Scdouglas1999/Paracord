import { AxiosHeaders, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, redactApiLogUrl } from './client';
import { resetRefreshCoordination } from '../lib/authRefreshCoordinator';

// The refresh coordinator is module-level on purpose (one flight per
// credential, across every axios instance), so each test starts from clean.
afterEach(() => resetRefreshCoordination());

const NEW_ACCESS_TOKEN = 'access-token-v2';

/**
 * Build a mock axios adapter that simulates a server with rotating refresh
 * tokens. Protected endpoints 401 until an `Authorization` header carrying the
 * refreshed access token is presented. `/auth/refresh` succeeds once, then
 * (mimicking refresh-token rotation) 401s if hit again with the same body.
 */
function makeRefreshAdapter() {
  const refreshBodies: unknown[] = [];
  let refreshCalls = 0;
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const respond = (status: number, data: unknown): AxiosResponse => {
      const response: AxiosResponse = {
        data,
        status,
        statusText: '',
        headers: AxiosHeaders.from({ 'content-type': 'application/json' }),
        config,
      };
      if (status >= 200 && status < 300) return response;
      const error = new Error(`Request failed with status code ${status}`) as Error & {
        config: InternalAxiosRequestConfig;
        response: AxiosResponse;
        isAxiosError: boolean;
      };
      error.config = config;
      error.response = response;
      error.isAxiosError = true;
      throw error;
    };

    if (config.url === '/auth/refresh') {
      refreshCalls += 1;
      const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
      refreshBodies.push(body);
      // Refresh-token rotation: a second concurrent refresh presenting the
      // already-consumed token must fail (this is what the single-flight
      // guard prevents from ever happening).
      if (refreshCalls > 1) return respond(401, { code: 'unauthorized', message: 'rotated' });
      return respond(200, { token: NEW_ACCESS_TOKEN, refresh_token: 'refresh-token-v2' });
    }

    const auth = config.headers?.Authorization;
    if (auth === `Bearer ${NEW_ACCESS_TOKEN}`) {
      return respond(200, { ok: true, url: config.url });
    }
    return respond(401, { code: 'unauthorized', message: 'expired' });
  };
  return {
    adapter,
    getRefreshCalls: () => refreshCalls,
    getRefreshBodies: () => refreshBodies,
  };
}

describe('API client log redaction', () => {
  it('redacts webhook token path segments without redacting webhook IDs', () => {
    expect(redactApiLogUrl('/webhooks/123456')).toBe('/webhooks/123456');
    expect(redactApiLogUrl('/webhooks/123456/secret-token')).toBe(
      '/webhooks/123456/[redacted]',
    );
    expect(redactApiLogUrl('/webhooks/123456/secret-token?wait=false')).toBe(
      '/webhooks/123456/[redacted]?wait=false',
    );
    expect(redactApiLogUrl('/webhooks/123456/secret-token/messages/987')).toBe(
      '/webhooks/123456/[redacted]/messages/987',
    );
  });

  it('redacts interaction token path segments and sensitive query parameters', () => {
    expect(
      redactApiLogUrl(
        'https://server.example/api/v1/interactions/app-1/interaction-token/messages/@original?session_id=sid&cursor=10',
      ),
    ).toBe(
      'https://server.example/api/v1/interactions/app-1/[redacted]/messages/@original?session_id=[redacted]&cursor=10',
    );
    expect(redactApiLogUrl('/interactions/interaction-1/callback-token/callback')).toBe(
      '/interactions/interaction-1/[redacted]/callback',
    );
    expect(redactApiLogUrl('/channels/123/messages?before=456')).toBe(
      '/channels/123/messages?before=456',
    );
  });
});

describe('createApiClient token refresh', () => {
  it('serializes concurrent 401 refreshes behind a single /auth/refresh call', async () => {
    const { adapter, getRefreshCalls } = makeRefreshAdapter();
    let currentToken: string | null = 'stale-access-token';
    const onTokenRefreshed = vi.fn((token: string) => {
      currentToken = token;
    });

    const client = createApiClient(
      'http://server.example/api/v1',
      () => currentToken,
      onTokenRefreshed,
      undefined,
      undefined,
      () => 'refresh-token-v1',
    );
    client.defaults.adapter = adapter;

    // Two simultaneous requests that both 401 on their first attempt.
    const [resA, resB] = await Promise.all([
      client.get('/channels/1/messages'),
      client.get('/channels/2/messages'),
    ]);

    // Exactly one refresh despite two concurrent 401s.
    expect(getRefreshCalls()).toBe(1);
    // Persistence runs per caller, not per HTTP refresh: whoever joins the
    // flight must still store the rotated credential, or it is left holding
    // the token the server has already spent.
    expect(onTokenRefreshed).toHaveBeenCalledWith(NEW_ACCESS_TOKEN, 'refresh-token-v2');
    for (const call of onTokenRefreshed.mock.calls) {
      expect(call).toEqual([NEW_ACCESS_TOKEN, 'refresh-token-v2']);
    }

    // Both original requests retried and succeeded with the new token.
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.config.headers?.Authorization).toBe(`Bearer ${NEW_ACCESS_TOKEN}`);
    expect(resB.config.headers?.Authorization).toBe(`Bearer ${NEW_ACCESS_TOKEN}`);
  });

  it('sends the stored per-server refresh token in the /auth/refresh body', async () => {
    const { adapter, getRefreshBodies } = makeRefreshAdapter();
    let currentToken: string | null = 'stale-access-token';

    const client = createApiClient(
      'http://server.example/api/v1',
      () => currentToken,
      (token) => {
        currentToken = token;
      },
      undefined,
      undefined,
      () => 'server-refresh-token',
    );
    client.defaults.adapter = adapter;

    const res = await client.get('/me');

    expect(res.status).toBe(200);
    expect(getRefreshBodies()).toEqual([{ refresh_token: 'server-refresh-token' }]);
  });

  it('shares one refresh between separate clients on the same credential', async () => {
    // The defect this exists for: the home session is spoken for by several
    // axios instances at once — the legacy singleton, the `__local__`
    // connection, and the saved-server entry that is the same account under
    // another name. Each used to guard only itself, so one navigation past the
    // access-token expiry fired three or four concurrent refreshes; the first
    // rotated the token, the rest presented the spent one, and the server
    // (correctly) read that as theft and revoked every session the account had.
    const { adapter, getRefreshCalls } = makeRefreshAdapter();
    const scope = 'auth:home';
    let sharedToken: string | null = 'stale-access-token';
    const storeA = vi.fn((token: string) => {
      sharedToken = token;
    });
    const storeB = vi.fn((token: string) => {
      sharedToken = token;
    });

    const makeClient = (onRefreshed: (token: string, refreshToken?: string) => void) => {
      const client = createApiClient(
        'http://server.example/api/v1',
        () => sharedToken,
        onRefreshed,
        undefined,
        undefined,
        () => 'refresh-token-v1',
        scope,
      );
      client.defaults.adapter = adapter;
      return client;
    };
    const clientA = makeClient(storeA);
    const clientB = makeClient(storeB);

    const [resA, resB] = await Promise.all([
      clientA.get('/channels/1/messages'),
      clientB.get('/users/@me'),
    ]);

    expect(getRefreshCalls()).toBe(1);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Both stores end up holding the rotated credential, including the one
    // that only awaited the other's flight.
    expect(storeA).toHaveBeenCalledWith(NEW_ACCESS_TOKEN, 'refresh-token-v2');
    expect(storeB).toHaveBeenCalledWith(NEW_ACCESS_TOKEN, 'refresh-token-v2');
  });

  it('does not throw the session away when the server is merely unreachable', async () => {
    // A four-second restart is not a revocation. Signing the user out on any
    // failed refresh is how a blip became "constant reconnecting" and an app
    // that emptied itself.
    const onAuthFailed = vi.fn();
    const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
      if (config.url === '/auth/refresh') throw Object.assign(new Error('Network Error'), {
        config,
        isAxiosError: true,
        code: 'ECONNREFUSED',
      });
      const error = new Error('Request failed with status code 401') as Error & {
        config: InternalAxiosRequestConfig;
        response: AxiosResponse;
        isAxiosError: boolean;
      };
      error.config = config;
      error.response = {
        data: { code: 'unauthorized', message: 'expired' },
        status: 401,
        statusText: '',
        headers: AxiosHeaders.from({ 'content-type': 'application/json' }),
        config,
      };
      error.isAxiosError = true;
      throw error;
    };

    const client = createApiClient(
      'http://server.example/api/v1',
      () => 'stale-access-token',
      undefined,
      onAuthFailed,
      undefined,
      () => 'refresh-token-v1',
    );
    client.defaults.adapter = adapter;

    await expect(client.get('/users/@me')).rejects.toBeTruthy();
    expect(onAuthFailed).not.toHaveBeenCalled();
  });

  it('does not claim a session ended on a profile that never had one', async () => {
    // A fresh install meets 401s before anyone has signed in. Telling that
    // person "your session ended on the server" is a lie on the first screen.
    const { peekSessionEndedNotice, clearSessionEndedNotice } = await import('../lib/sessionEnded');
    clearSessionEndedNotice();
    const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
      const error = new Error('Request failed with status code 401') as Error & {
        config: InternalAxiosRequestConfig;
        response: AxiosResponse;
        isAxiosError: boolean;
      };
      error.config = config;
      error.response = {
        data: { code: 'unauthorized', message: 'no session' },
        status: 401,
        statusText: '',
        headers: AxiosHeaders.from({ 'content-type': 'application/json' }),
        config,
      };
      error.isAxiosError = true;
      throw error;
    };

    // No access token and no refresh token: nobody is signed in here.
    const client = createApiClient('http://server.example/api/v1', () => '', undefined, undefined, undefined, () => null);
    client.defaults.adapter = adapter;

    await expect(client.get('/users/@me')).rejects.toBeTruthy();
    expect(peekSessionEndedNotice()).toBeNull();
  });

  it('omits the refresh body when no per-server refresh token is available', async () => {
    const { adapter, getRefreshBodies } = makeRefreshAdapter();
    let currentToken: string | null = 'stale-access-token';

    const client = createApiClient(
      'http://server.example/api/v1',
      () => currentToken,
      (token) => {
        currentToken = token;
      },
    );
    client.defaults.adapter = adapter;

    await client.get('/me');

    // No getRefreshToken callback -> cookie-only refresh (undefined body).
    expect(getRefreshBodies()).toEqual([undefined]);
  });
});
