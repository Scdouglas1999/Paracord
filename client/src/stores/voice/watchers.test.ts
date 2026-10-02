import { describe, expect, it } from 'vitest';
import { applyWatchersSnapshot, isVoiceWatchersUpdate, watcherCount, type WatcherIndex } from './watchers';

const A = { serverId: 'A', userId: '1' };
const B = { serverId: 'B', userId: '1' };

describe('watcher counts', () => {
  it('reads the gateway payload strictly', () => {
    expect(isVoiceWatchersUpdate({ guild_id: 'g', channel_id: 'c', streams: [{ user_id: 'v', watchers: 2 }] })).toBe(true);
    expect(isVoiceWatchersUpdate({ guild_id: 'g', channel_id: 'c' })).toBe(false);
    expect(isVoiceWatchersUpdate({ guild_id: 'g', channel_id: 'c', streams: [{ user_id: 'v', watchers: -1 }] })).toBe(false);
    expect(isVoiceWatchersUpdate({ guild_id: 'g', channel_id: '', streams: [] })).toBe(false);
    // A DM call's counts have no guild; an absent or empty one is still refused.
    expect(isVoiceWatchersUpdate({ guild_id: null, channel_id: 'dm', streams: [{ user_id: 'v', watchers: 1 }] })).toBe(true);
    expect(isVoiceWatchersUpdate({ channel_id: 'dm', streams: [] })).toBe(false);
    expect(isVoiceWatchersUpdate({ guild_id: '', channel_id: 'dm', streams: [] })).toBe(false);
  });

  it('replaces a channel’s counts with each snapshot: a streamer not listed has none', () => {
    let index: WatcherIndex = new Map();
    index = applyWatchersSnapshot(index, A, { guild_id: 'g', channel_id: 'c', streams: [
      { user_id: 'v', watchers: 2 }, { user_id: 'b', watchers: 1 }] });
    expect(watcherCount(index, A, 'c', 'v')).toBe(2);
    index = applyWatchersSnapshot(index, A, { guild_id: 'g', channel_id: 'c', streams: [{ user_id: 'v', watchers: 1 }] });
    expect(watcherCount(index, A, 'c', 'v')).toBe(1);
    expect(watcherCount(index, A, 'c', 'b')).toBe(0);
  });

  it('keeps two instances apart even when their snowflakes collide', () => {
    let index: WatcherIndex = new Map();
    index = applyWatchersSnapshot(index, A, { guild_id: 'g', channel_id: 'c', streams: [{ user_id: 'v', watchers: 3 }] });
    expect(watcherCount(index, B, 'c', 'v')).toBe(0);
    expect(watcherCount(index, null, 'c', 'v')).toBe(0);
  });
});
