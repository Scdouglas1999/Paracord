import { AxiosHeaders, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, redactApiLogUrl } from './client';

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
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).toHaveBeenCalledWith(NEW_ACCESS_TOKEN, 'refresh-token-v2');

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
