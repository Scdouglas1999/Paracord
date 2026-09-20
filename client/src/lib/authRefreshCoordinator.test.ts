import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coordinateRefresh,
  HOME_REFRESH_SCOPE,
  resetRefreshCoordination,
  serverRefreshScope,
} from './authRefreshCoordinator';

/** A refresh that only resolves when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  resetRefreshCoordination();
  vi.useRealTimers();
});

describe('refresh coordination', () => {
  it.each(['success', 'failure'])('rejects an old in-flight %s after a session replacement', async (outcome) => {
    const gate = deferred<{ token: string }>();
    const old = coordinateRefresh(HOME_REFRESH_SCOPE, () => gate.promise);
    resetRefreshCoordination(HOME_REFRESH_SCOPE);
    const replacement = await coordinateRefresh(HOME_REFRESH_SCOPE, async () => ({ token: 'replacement' }));
    const rejected = expect(old).rejects.toThrow('Session refresh was superseded');
    if (outcome === 'success') gate.resolve({ token: 'revoked' });
    else gate.reject(Object.assign(new Error('revoked'), { response: { status: 401 } }));
    await rejected;
    expect(await coordinateRefresh(HOME_REFRESH_SCOPE, async () => ({ token: 'unexpected' }))).toEqual(replacement);
  });
  it('runs one refresh for concurrent callers on the same credential', async () => {
    const gate = deferred<{ token: string; refreshToken: string }>();
    const perform = vi.fn(() => gate.promise);

    const callers = [
      coordinateRefresh(HOME_REFRESH_SCOPE, perform),
      coordinateRefresh(HOME_REFRESH_SCOPE, perform),
      coordinateRefresh(HOME_REFRESH_SCOPE, perform),
      coordinateRefresh(HOME_REFRESH_SCOPE, perform),
    ];
    gate.resolve({ token: 'access-v2', refreshToken: 'refresh-v2' });
    const results = await Promise.all(callers);

    // The whole point: the server rotates on every refresh and reads a second
    // presentation of a spent token as theft.
    expect(perform).toHaveBeenCalledTimes(1);
    // Every caller is handed the rotated credential, including the three that
    // only joined someone else's flight.
    for (const result of results) {
      expect(result).toEqual({ token: 'access-v2', refreshToken: 'refresh-v2' });
    }
  });

  it('answers a late caller from the settled window instead of rotating again', async () => {
    const perform = vi.fn(async () => ({ token: 'access-v2', refreshToken: 'refresh-v2' }));

    // A burst does not 401 simultaneously; stragglers arrive after the winner
    // has resolved. Without the settle window each would start its own rotation.
    await coordinateRefresh(HOME_REFRESH_SCOPE, perform);
    const late = await coordinateRefresh(HOME_REFRESH_SCOPE, perform);

    expect(perform).toHaveBeenCalledTimes(1);
    expect(late.token).toBe('access-v2');
  });

  it('replays a failure to the rest of the burst rather than asking again', async () => {
    const revoked = Object.assign(new Error('revoked'), { response: { status: 401 } });
    const perform = vi.fn(async () => {
      throw revoked;
    });

    await expect(coordinateRefresh(HOME_REFRESH_SCOPE, perform)).rejects.toBe(revoked);
    await expect(coordinateRefresh(HOME_REFRESH_SCOPE, perform)).rejects.toBe(revoked);

    // Once the server has said the session is gone, twenty more requests
    // asking again in the same second learn nothing.
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('refreshes again once the settled window has passed', async () => {
    vi.useFakeTimers();
    const perform = vi.fn(async () => ({ token: 'access-v2', refreshToken: 'refresh-v2' }));

    await coordinateRefresh(HOME_REFRESH_SCOPE, perform);
    vi.advanceTimersByTime(10_000);
    await coordinateRefresh(HOME_REFRESH_SCOPE, perform);

    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('keeps genuinely separate sessions on separate flights', async () => {
    const home = vi.fn(async () => ({ token: 'home-v2' }));
    const remote = vi.fn(async () => ({ token: 'remote-v2' }));

    const [homeResult, remoteResult] = await Promise.all([
      coordinateRefresh(HOME_REFRESH_SCOPE, home),
      coordinateRefresh(serverRefreshScope('s_remote'), remote),
    ]);

    expect(home).toHaveBeenCalledTimes(1);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(homeResult.token).toBe('home-v2');
    expect(remoteResult.token).toBe('remote-v2');
  });

  it('does not answer a new session out of the previous one\'s window', async () => {
    const first = vi.fn(async () => ({ token: 'access-v2' }));
    await coordinateRefresh(HOME_REFRESH_SCOPE, first);

    // Signing out and back in must not inherit the dead session's result.
    resetRefreshCoordination();
    const second = vi.fn(async () => ({ token: 'access-after-relogin' }));
    const result = await coordinateRefresh(HOME_REFRESH_SCOPE, second);

    expect(second).toHaveBeenCalledTimes(1);
    expect(result.token).toBe('access-after-relogin');
  });
});
