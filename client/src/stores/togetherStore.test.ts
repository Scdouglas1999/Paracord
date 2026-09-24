import { beforeEach, describe, expect, it } from 'vitest';

import type { TogetherSession, TogetherSessionUpdate } from '../lib/together/model';
import { noticeText, reduceCall, useTogetherStore } from './togetherStore';

function session(revision: number, overrides: Partial<TogetherSession> = {}): TogetherSession {
  return {
    session_id: 's1',
    channel_id: 'c1',
    guild_id: 'g1',
    kind: 'watch',
    controller_policy: 'everyone',
    started_by: 'u1',
    started_at: 0,
    items: [
      { id: 'i1', source: 'url', ref: 'https://x/a.mp4', title: 'Clip', duration_ms: null, thumbnail: null, content_type: 'video/mp4', added_by: 'u1' },
      { id: 'i2', source: 'youtube', ref: 'dQw4w9WgXcQ', title: 'Song', duration_ms: null, thumbnail: 'https://i.ytimg.com/vi/x/hqdefault.jpg', content_type: null, added_by: 'u2' },
    ],
    current_index: 0,
    playing: true,
    position_ms: 0,
    position_at: 0,
    rate: 1,
    revision,
    server_time_ms: 0,
    ...overrides,
  };
}

function update(revision: number, s: TogetherSession | null, action: TogetherSessionUpdate['action'] = null): TogetherSessionUpdate {
  return { channel_id: 'c1', guild_id: 'g1', revision, session: s, action };
}

describe('session reducer', () => {
  it('applies newer revisions and drops stale or repeated ones', () => {
    const first = reduceCall(undefined, update(5, session(5)));
    expect(first?.revision).toBe(5);
    expect(reduceCall(first, update(4, session(4, { playing: false })))).toBe(first);
    expect(reduceCall(first, update(5, session(5, { playing: false })))).toBe(first);
    const next = reduceCall(first, update(6, session(6, { playing: false })));
    expect(next?.session?.playing).toBe(false);
  });

  it('an ended session outranks a late start', () => {
    const ended = reduceCall(reduceCall(undefined, update(5, session(5))), update(9, null));
    expect(ended?.session).toBeNull();
    expect(reduceCall(ended, update(7, session(7)))).toBe(ended);
  });
});

describe('notices', () => {
  const prev = session(1);
  it('say what someone else did, in plain words', () => {
    expect(noticeText(prev, update(2, session(2, { playing: false }), { type: 'pause', user_id: 'u2', position_ms: 5000, item_id: null }))).toBe('paused');
    expect(noticeText(prev, update(2, session(2), { type: 'seek', user_id: 'u2', position_ms: 760_000, item_id: null }))).toBe('skipped to 12:40');
    expect(noticeText(prev, update(2, session(2, { current_index: 1 }), { type: 'skip', user_id: 'u2', position_ms: null, item_id: 'i2' }))).toBe('played Song');
    expect(noticeText(prev, update(2, null, { type: 'stop', user_id: 'u2', position_ms: null, item_id: null }))).toBe('stopped it for everyone');
    expect(noticeText(null, update(2, session(2, { kind: 'listen' }), { type: 'start', user_id: 'u2', position_ms: null, item_id: null }))).toBe('started listening together');
  });

  it('stay quiet for the media simply ending', () => {
    expect(noticeText(prev, update(2, session(2, { current_index: 1 }), { type: 'ended', user_id: 'u2', position_ms: null, item_id: 'i1' }))).toBeNull();
  });
});

describe('store', () => {
  beforeEach(() => useTogetherStore.getState().reset());

  it('keeps notices for other people only, and moves the summary with the call', () => {
    const store = useTogetherStore.getState();
    store.applySessionUpdate(update(1, session(1), { type: 'start', user_id: 'me', position_ms: null, item_id: null }), 'me');
    store.applySessionUpdate(update(2, session(2, { playing: false }), { type: 'pause', user_id: 'u2', position_ms: 0, item_id: null }), 'me');
    const state = useTogetherStore.getState();
    expect(state.notices.map((n) => n.text)).toEqual(['paused']);
    expect(state.activities.c1).toMatchObject({ guildId: 'g1', revision: 2, activity: { title: 'Clip', playing: false, kind: 'watch' } });
  });

  it('a stale slim update cannot undo a newer full one', () => {
    const store = useTogetherStore.getState();
    store.applySessionUpdate(update(10, session(10)), null);
    store.applyActivityUpdate({ guild_id: 'g1', channel_id: 'c1', revision: 9, activity: null });
    expect(useTogetherStore.getState().activities.c1.activity).not.toBeNull();
  });

  it('a server listing clears sessions it no longer lists, and keeps newer ones', () => {
    const store = useTogetherStore.getState();
    store.applyActivityUpdate({ guild_id: 'g1', channel_id: 'old', revision: 3, activity: { session_id: 'x', kind: 'listen', started_by: 'u', playing: true, title: 'Old', source: 'url', thumbnail: null, item_count: 1 } });
    store.applyActivityUpdate({ guild_id: 'g1', channel_id: 'fresh', revision: 20, activity: { session_id: 'y', kind: 'watch', started_by: 'u', playing: true, title: 'Fresh', source: 'url', thumbnail: null, item_count: 1 } });
    store.loadGuildActivities('g1', 15, []);
    const { activities } = useTogetherStore.getState();
    expect(activities.old.activity).toBeNull();
    expect(activities.fresh.activity?.title).toBe('Fresh');
  });

  it('forgets a call when you leave it', () => {
    const store = useTogetherStore.getState();
    store.applySessionUpdate(update(1, session(1)), null);
    store.forgetCall('c1');
    expect(useTogetherStore.getState().calls.c1).toBeUndefined();
  });
});
