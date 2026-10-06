import { afterEach, describe, expect, it } from 'vitest';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import { createApiClient } from './client';

/**
 * The CSRF double-submit belongs to this page's own origin. A write to another saved
 * server must not carry it: that server never issued it, and its CORS does not allow
 * the header, so the browser failed the preflight of every write to a second server
 * (its realtime session could not even be created).
 */

function capture() {
  const seen: Array<Record<string, unknown>> = [];
  const adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    seen.push({ ...(config.headers as Record<string, unknown>) });
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  return { seen, adapter };
}

afterEach(() => {
  document.cookie = 'paracord_csrf=; Max-Age=0; path=/';
});

describe('the CSRF header', () => {
  it('goes with a write to this page\'s own origin, and not with a read', async () => {
    document.cookie = 'paracord_csrf=own-token; path=/';
    const { seen, adapter } = capture();
    const client = createApiClient(`${window.location.origin}/api/v1`, () => 'access');
    client.defaults.adapter = adapter;
    await client.post('/channels/1/messages', {});
    await client.get('/users/@me');
    expect(seen[0]['X-Paracord-CSRF']).toBe('own-token');
    expect(seen[1]['X-Paracord-CSRF']).toBeUndefined();
  });

  it('never goes to another server, whatever the path looks like', async () => {
    document.cookie = 'paracord_csrf=own-token; path=/';
    const { seen, adapter } = capture();
    const client = createApiClient('https://lantern.example:8443/api/v1', () => 'access');
    client.defaults.adapter = adapter;
    await client.post('/channels/1/messages', {});
    await client.post('https://lantern.example:8443/api/v2/rt/session');
    expect(seen.map((headers) => headers['X-Paracord-CSRF'])).toEqual([undefined, undefined]);
    expect(seen[0].Authorization).toBe('Bearer access');
  });

  it('a refresh that carries its token in the body sends no cookies (the server would read a stale cookie first)', async () => {
    const sent: Array<{ url?: string; withCredentials?: boolean; body?: unknown }> = [];
    const client = createApiClient(
      'https://lantern.example:8443/api/v1',
      () => 'expired',
      undefined,
      undefined,
      undefined,
      () => 'refresh-1',
    );
    client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      sent.push({ url: config.url, withCredentials: config.withCredentials, body: config.data ? JSON.parse(String(config.data)) : undefined });
      if (config.url === '/auth/refresh') return { data: { token: 'fresh', refresh_token: 'refresh-2' }, status: 200, statusText: 'OK', headers: {}, config };
      if (sent.filter((request) => request.url === '/users/@me').length === 1) {
        const { AxiosError } = await import('axios');
        throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, { data: {}, status: 401, statusText: '', headers: {}, config } as AxiosResponse);
      }
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    await client.get('/users/@me');
    const refresh = sent.find((request) => request.url === '/auth/refresh');
    expect(refresh).toEqual({ url: '/auth/refresh', withCredentials: false, body: { refresh_token: 'refresh-1' } });
  });
});
