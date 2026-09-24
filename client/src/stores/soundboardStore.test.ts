import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SoundboardSound } from '../api/guilds';

const mocks = vi.hoisted(() => ({
  listSounds: vi.fn(),
}));

vi.mock('../api/guilds', () => ({
  guildApi: { listSounds: mocks.listSounds },
}));

import { useSoundboardStore } from './soundboardStore';

function sound(over: Partial<SoundboardSound> = {}): SoundboardSound {
  return {
    id: 'snd1',
    guild_id: 'g1',
    name: 'ding',
    emoji: '🔔',
    volume: 100,
    duration_ms: 1000,
    content_type: 'audio/wav',
    size: 10,
    creator_id: 'u1',
    sound_url: '/api/v1/guilds/g1/sounds/snd1/file',
    created_at: '2026-09-24T00:00:00Z',
    ...over,
  };
}

describe('soundboardStore', () => {
  beforeEach(() => {
    mocks.listSounds.mockReset();
    useSoundboardStore.setState({
      soundsByGuild: new Map(),
      loadingGuilds: new Set(),
      recentPlays: [],
    });
  });

  it('fetches once and serves the cache until asked to refresh', async () => {
    mocks.listSounds.mockResolvedValue({ data: [sound()] });
    const first = await useSoundboardStore.getState().loadSounds('g1');
    const second = await useSoundboardStore.getState().loadSounds('g1');
    expect(first).toHaveLength(1);
    expect(second).toBe(first);
    expect(mocks.listSounds).toHaveBeenCalledTimes(1);

    mocks.listSounds.mockResolvedValue({ data: [sound(), sound({ id: 'snd2', name: 'bonk' })] });
    const refreshed = await useSoundboardStore.getState().loadSounds('g1', true);
    expect(refreshed).toHaveLength(2);
    expect(mocks.listSounds).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    let release: (v: { data: SoundboardSound[] }) => void = () => {};
    mocks.listSounds.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const a = useSoundboardStore.getState().loadSounds('g1');
    const b = useSoundboardStore.getState().loadSounds('g1');
    release({ data: [sound()] });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toHaveLength(1);
    expect(rb).toEqual(ra);
    expect(mocks.listSounds).toHaveBeenCalledTimes(1);
  });

  it('folds GUILD_SOUNDS_UPDATE into a loaded list only', async () => {
    // Unloaded guild: the update is ignored (nothing to fold into).
    useSoundboardStore.getState().applySoundsUpdate('g9', sound({ guild_id: 'g9' }), null);
    expect(useSoundboardStore.getState().soundsByGuild.has('g9')).toBe(false);

    mocks.listSounds.mockResolvedValue({ data: [sound()] });
    await useSoundboardStore.getState().loadSounds('g1');

    // New sound prepends; an update to a known id replaces in place.
    useSoundboardStore.getState().applySoundsUpdate('g1', sound({ id: 'snd2', name: 'bonk' }), null);
    let list = useSoundboardStore.getState().soundsByGuild.get('g1') ?? [];
    expect(list.map((s) => s.id)).toEqual(['snd2', 'snd1']);
    useSoundboardStore.getState().applySoundsUpdate('g1', sound({ id: 'snd1', name: 'ding louder', volume: 40 }), null);
    list = useSoundboardStore.getState().soundsByGuild.get('g1') ?? [];
    expect(list.find((s) => s.id === 'snd1')?.name).toBe('ding louder');
    expect(list.find((s) => s.id === 'snd1')?.volume).toBe(40);

    // Deletion removes by id.
    useSoundboardStore.getState().applySoundsUpdate('g1', null, 'snd1');
    list = useSoundboardStore.getState().soundsByGuild.get('g1') ?? [];
    expect(list.map((s) => s.id)).toEqual(['snd2']);
  });

  it('evicts a guild’s list', async () => {
    mocks.listSounds.mockResolvedValue({ data: [sound()] });
    await useSoundboardStore.getState().loadSounds('g1');
    useSoundboardStore.getState().evictGuild('g1');
    expect(useSoundboardStore.getState().soundsByGuild.has('g1')).toBe(false);
    // A subsequent load refetches.
    await useSoundboardStore.getState().loadSounds('g1');
    expect(mocks.listSounds).toHaveBeenCalledTimes(2);
  });

  it('records plays newest-first and caps the ledger', () => {
    for (let i = 0; i < 40; i++) {
      useSoundboardStore.getState().recordPlay({
        channelId: 'ch1',
        userId: `u${i}`,
        emoji: '🔔',
        soundName: `s${i}`,
      });
    }
    const plays = useSoundboardStore.getState().recentPlays;
    expect(plays).toHaveLength(32);
    expect(plays[0].userId).toBe('u39');
    expect(new Set(plays.map((p) => p.key)).size).toBe(32);
  });
});
