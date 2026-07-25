import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.fn();
const setSpace = vi.fn();
const clearSpace = vi.fn();

vi.mock('../api/notificationSettings', () => ({
  notificationSettingsApi: {
    list: (...args: unknown[]) => list(...args),
    setSpace: (...args: unknown[]) => setSpace(...args),
    clearSpace: (...args: unknown[]) => clearSpace(...args),
  },
}));

import {
  readMutedGuildIds,
  syncMutedGuildsFromServer,
  toggleGuildMuted,
  writeMutedGuildIds,
} from './useMutedGuilds';

describe('useMutedGuilds', () => {
  beforeEach(() => {
    localStorage.clear();
    list.mockReset();
    setSpace.mockReset().mockResolvedValue({});
    clearSpace.mockReset().mockResolvedValue(undefined);
  });

  /// The mute used to live only in localStorage, so it never followed the user
  /// to another device. The server is now the source of truth.
  it('replaces the local set with the server set on sync', async () => {
    writeMutedGuildIds(['stale-local-only']);
    list.mockResolvedValue({
      spaces: [
        { space_id: '111', muted: true, muted_now: true },
        { space_id: '222', muted: false, muted_now: false },
      ],
      channels: [],
    });

    const ids = await syncMutedGuildsFromServer();

    expect(ids).toEqual(['111']);
    expect(readMutedGuildIds()).toEqual(['111']);
  });

  /// A timed mute that has already lapsed must stop counting without needing a
  /// sweep, so the resolved `muted_now` is what decides — not the stored flag.
  it('ignores a mute whose timer has already lapsed', async () => {
    list.mockResolvedValue({
      spaces: [
        {
          space_id: '333',
          muted: true,
          muted_now: false,
          muted_until: '2020-01-01T00:00:00Z',
        },
      ],
      channels: [],
    });

    expect(await syncMutedGuildsFromServer()).toEqual([]);
  });

  it('mutes through the server and updates the local set', async () => {
    expect(await toggleGuildMuted('444')).toBe(true);

    expect(setSpace).toHaveBeenCalledWith('444', { muted: true });
    expect(readMutedGuildIds()).toEqual(['444']);
  });

  /// Unmuting clears the override rather than storing an explicit "not muted"
  /// row, so the space returns to the default.
  it('unmuting clears the override instead of storing a false row', async () => {
    writeMutedGuildIds(['555']);

    expect(await toggleGuildMuted('555')).toBe(false);

    expect(clearSpace).toHaveBeenCalledWith('555');
    expect(setSpace).not.toHaveBeenCalled();
    expect(readMutedGuildIds()).toEqual([]);
  });

  /// The write is optimistic so the UI responds immediately. If the server
  /// rejects it, the local set must go back — otherwise the sidebar shows a
  /// mute that does not exist anywhere else.
  it('rolls the local set back when the server rejects the write', async () => {
    setSpace.mockRejectedValue(new Error('nope'));

    await expect(toggleGuildMuted('666')).rejects.toThrow('nope');

    expect(readMutedGuildIds()).toEqual([]);
  });

  it('rolls back an unmute that fails, keeping the space muted', async () => {
    writeMutedGuildIds(['777']);
    clearSpace.mockRejectedValue(new Error('nope'));

    await expect(toggleGuildMuted('777')).rejects.toThrow('nope');

    expect(readMutedGuildIds()).toEqual(['777']);
  });
});
