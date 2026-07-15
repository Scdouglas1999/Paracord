import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLegacyPersistedAuth,
  getAccessToken,
  getRefreshToken,
  hydrateRefreshTokenStorage,
  setAccessToken,
  setRefreshToken,
} from './authToken';

describe('authToken', () => {
  beforeEach(() => {
    localStorage.clear();
    setAccessToken(null);
    setRefreshToken(null);
  });

  it('stores access token in memory only', () => {
    setAccessToken('  access-token  ');
    expect(getAccessToken()).toBe('access-token');
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('stores and clears refresh token in memory for same-origin API', () => {
    setRefreshToken('refresh-token');
    expect(getRefreshToken()).toBe('refresh-token');

    setRefreshToken(null);
    expect(getRefreshToken()).toBeNull();
  });

  it('hydrates refresh token from legacy localStorage in web mode', async () => {
    localStorage.setItem('paracord:refresh-token', 'hydrated-token');

    await hydrateRefreshTokenStorage();

    expect(getRefreshToken()).toBe('hydrated-token');
  });

  it('never persists the refresh token at rest in web mode', () => {
    setRefreshToken('refresh-token');

    expect(getRefreshToken()).toBe('refresh-token');
    // The refresh token must live in memory only — no localStorage copy that
    // an XSS payload could exfiltrate for persistent account takeover.
    expect(localStorage.getItem('paracord:auth:refresh-token')).toBeNull();
    expect(localStorage.getItem('paracord:refresh-token')).toBeNull();
  });

  it('purges any wrapped refresh token left by older web builds', async () => {
    localStorage.setItem(
      'paracord:auth:refresh-token',
      JSON.stringify({ iv: 'aaaa', ct: 'bbbb' }),
    );

    await hydrateRefreshTokenStorage();

    expect(localStorage.getItem('paracord:auth:refresh-token')).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('clears legacy auth keys without clearing refresh token', () => {
    localStorage.setItem('token', 'legacy-token');
    localStorage.setItem('auth-storage', '{"state":{}}');
    setRefreshToken('refresh-token');

    clearLegacyPersistedAuth();

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('auth-storage')).toBeNull();
    expect(getRefreshToken()).toBe('refresh-token');
  });
});
