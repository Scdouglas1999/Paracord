import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOW_PLAYING_DEBOUNCE_MS,
  NOW_PLAYING_MIN_INTERVAL_MS,
  NOW_PLAYING_PAUSE_GRACE_MS,
  NowPlayingPublisher,
  nowPlayingActivity,
  sameListening,
  type NowPlayingSnapshot,
} from './nowPlaying';
import type { Activity } from '../types';

const T0 = Date.parse('2026-09-24T10:00:00.000Z');

function track(title: string, overrides: Partial<NowPlayingSnapshot> = {}): NowPlayingSnapshot {
  return {
    player: 'Spotify',
    title,
    artist: 'Aphex Twin',
    status: 'playing',
    position_ms: 10_000,
    duration_ms: 200_000,
    ...overrides,
  };
}

describe('nowPlayingActivity', () => {
  it('is a listening activity whose timeline puts the track at its position now', () => {
    const activity = nowPlayingActivity(track('Windowlicker'), T0);
    expect(activity).toEqual({
      name: 'Spotify',
      type: 2,
      details: 'Windowlicker',
      state: 'Aphex Twin',
      started_at: '2026-09-24T09:59:50.000Z',
      ends_at: '2026-09-24T10:03:10.000Z',
    });
  });

  it('leaves the timeline out when the player does not report one', () => {
    const activity = nowPlayingActivity(track('Live stream', { position_ms: null, duration_ms: null, artist: null }), T0);
    expect(activity.started_at).toBeNull();
    expect(activity.ends_at).toBeNull();
    expect(activity.state).toBeNull();
  });
});

describe('sameListening', () => {
  it('ignores a timeline that only drifted, but not a seek', () => {
    const a = nowPlayingActivity(track('A'), T0);
    const drift = nowPlayingActivity(track('A', { position_ms: 11_200 }), T0 + 1_000);
    const seek = nowPlayingActivity(track('A', { position_ms: 90_000 }), T0 + 1_000);
    expect(sameListening(a, drift)).toBe(true);
    expect(sameListening(a, seek)).toBe(false);
    expect(sameListening(a, nowPlayingActivity(track('B'), T0))).toBe(false);
    expect(sameListening(null, null)).toBe(true);
    expect(sameListening(a, null)).toBe(false);
  });
});

describe('NowPlayingPublisher', () => {
  let published: Array<Activity | null>;
  let publisher: NowPlayingPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    published = [];
    publisher = new NowPlayingPublisher((activity) => published.push(activity));
  });

  afterEach(() => {
    publisher.dispose();
    vi.useRealTimers();
  });

  it('shows a new track within about two seconds', () => {
    publisher.update(track('A'));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS - 1);
    expect(published).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.details).toBe('A');
    expect(NOW_PLAYING_DEBOUNCE_MS).toBeLessThanOrEqual(2_000);
  });

  it('skipping through tracks sends only where it settled', () => {
    publisher.update(track('A'));
    vi.advanceTimersByTime(400);
    publisher.update(track('B'));
    vi.advanceTimersByTime(400);
    publisher.update(track('C'));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    expect(published.map((a) => a?.details)).toEqual(['C']);
  });

  it('never sends more than one update per five seconds', () => {
    publisher.update(track('A'));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    expect(published).toHaveLength(1);

    // Next track 2 s later: held until 5 s after the last send.
    vi.advanceTimersByTime(2_000);
    publisher.update(track('B'));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS - 2_000 - NOW_PLAYING_DEBOUNCE_MS);
    expect(published.map((a) => a?.details)).toEqual(['A', 'B']);
  });

  it('the same track read again is not an update', () => {
    publisher.update(track('A'));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    vi.advanceTimersByTime(10_000);
    publisher.update(track('A', { position_ms: 20_000 }));
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    expect(published).toHaveLength(1);
  });

  it('a short pause keeps the track up; more than 30 s clears it', () => {
    publisher.update(track('A'));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    publisher.update(track('A', { status: 'paused', position_ms: 11_500 }));
    vi.advanceTimersByTime(20_000);
    expect(published).toHaveLength(1);
    // Resuming re-times the same track (it is 20 s behind where it would
    // have been), so everyone's progress bar lines up again.
    publisher.update(track('A', { position_ms: 11_500 }));
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    expect(published).toHaveLength(2);
    expect(published[1]?.details).toBe('A');
    expect(Date.parse(published[1]!.started_at!) - Date.parse(published[0]!.started_at!)).toBe(20_000);

    publisher.update(track('A', { status: 'paused' }));
    vi.advanceTimersByTime(NOW_PLAYING_PAUSE_GRACE_MS - 1);
    expect(published).toHaveLength(2);
    vi.advanceTimersByTime(1 + NOW_PLAYING_DEBOUNCE_MS);
    expect(published.at(-1)).toBeNull();
  });

  it('stopping, or the player going away, clears it', () => {
    publisher.update(track('A'));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    publisher.update(track('A', { status: 'stopped' }));
    vi.advanceTimersByTime(NOW_PLAYING_DEBOUNCE_MS);
    expect(published.at(-1)).toBeNull();

    publisher.update(track('B'));
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    publisher.update(null);
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    expect(published.map((a) => a?.details ?? null)).toEqual(['A', null, 'B', null]);
  });

  it('a track that plays and stops before it settled is never sent', () => {
    publisher.update(track('A'));
    vi.advanceTimersByTime(500);
    publisher.update(null);
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    expect(published).toEqual([]);
  });

  it('sends nothing after dispose', () => {
    publisher.update(track('A'));
    publisher.dispose();
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    publisher.update(track('B'));
    vi.advanceTimersByTime(NOW_PLAYING_MIN_INTERVAL_MS);
    expect(published).toEqual([]);
  });
});
