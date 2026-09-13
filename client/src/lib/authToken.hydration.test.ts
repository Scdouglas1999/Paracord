import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRefreshToken, hydrateRefreshTokenStorage, setRefreshToken } from './authToken';
import { secureGet } from './secureStorage';
vi.mock('./tauriEnv', () => ({ isTauri: () => true }));
vi.mock('./secureStorage', () => ({ secureGet: vi.fn(), secureSet: vi.fn(), secureDelete: vi.fn() }));

beforeEach(() => {
  vi.mocked(secureGet).mockReset();
  localStorage.clear();
  setRefreshToken(null);
});
function delayedRead() {
  let resolve!: (token: string | null) => void;
  vi.mocked(secureGet).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  return (token: string | null) => resolve(token);
}

describe('native refresh credential hydration', () => {
  it('does not restore the previous token when logout happens during a keychain read', async () => {
    const finish = delayedRead();
    const pending = hydrateRefreshTokenStorage();
    setRefreshToken(null);
    finish('logged-out-token');
    await pending;
    expect(getRefreshToken()).toBeNull();
  });

  it('does not overwrite a freshly issued token with an older keychain result', async () => {
    const finish = delayedRead();
    const pending = hydrateRefreshTokenStorage();
    setRefreshToken('new-token');
    finish('old-token');
    await pending;
    expect(getRefreshToken()).toBe('new-token');
  });

  it('keeps a replacement read coalesced when the old read finishes first', async () => {
    const finishOld = delayedRead();
    const old = hydrateRefreshTokenStorage();
    setRefreshToken(null);
    const finishNew = delayedRead();
    const fresh = hydrateRefreshTokenStorage();
    finishOld('old-token');
    await old;
    const coalesced = hydrateRefreshTokenStorage();
    expect(secureGet).toHaveBeenCalledTimes(2);
    finishNew('fresh-token');
    await Promise.all([fresh, coalesced]);
    expect(getRefreshToken()).toBe('fresh-token');
  });
});
