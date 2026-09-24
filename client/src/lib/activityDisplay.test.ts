import { describe, expect, it } from 'vitest';
import {
  activityElapsed,
  describeActivity,
  displayActivity,
  formatTrackTime,
  statusLine,
  trackProgress,
} from './activityDisplay';
import type { Activity, Presence } from '../types';

const listening: Activity = {
  name: 'Spotify',
  type: 2,
  details: 'Windowlicker',
  state: 'Aphex Twin',
  started_at: '2026-09-24T10:00:00.000Z',
  ends_at: '2026-09-24T10:06:07.000Z',
};
const playing: Activity = { name: 'Factorio', type: 0, details: 'Playing Factorio', state: null };
const together: Activity = { name: 'Paracord', type: 3, details: 'Watching Koyaanisqatsi' };

function presence(activities: Activity[], extra: Partial<Presence> = {}): Presence {
  return { user_id: '1', status: 'online', activities, ...extra };
}

describe('describeActivity', () => {
  it('reads a track as title — artist, with the app in the sentence', () => {
    const view = describeActivity(listening)!;
    expect(view.kind).toBe('listening');
    expect(view.verb).toBe('Listening to');
    expect(view.title).toBe('Windowlicker');
    expect(view.subtitle).toBe('Aphex Twin');
    expect(view.app).toBe('Spotify');
    expect(view.line).toBe('Windowlicker — Aphex Twin');
    expect(view.sentence).toBe('Listening to Windowlicker by Aphex Twin on Spotify');
    expect(view.endsMs! - view.startedMs!).toBe(367_000);
  });

  it('reads a watch-together session, dropping a verb already in the details', () => {
    const view = describeActivity(together)!;
    expect(view.kind).toBe('watching');
    expect(view.title).toBe('Koyaanisqatsi');
    expect(view.line).toBe('Watching Koyaanisqatsi');
    expect(view.sentence).toBe('Watching Koyaanisqatsi on Paracord');
  });

  it('reads a listen-together session sent as "Listening to <title>"', () => {
    const view = describeActivity({ name: 'Paracord', type: 2, details: 'Listening to Music for Airports' })!;
    expect(view.title).toBe('Music for Airports');
    expect(view.line).toBe('Music for Airports');
    expect(view.sentence).toBe('Listening to Music for Airports on Paracord');
  });

  it('reads a game as "Playing X" without repeating the foreground label', () => {
    const view = describeActivity(playing)!;
    expect(view.line).toBe('Playing Factorio');
    expect(view.subtitle).toBeNull();
    expect(describeActivity({ ...playing, state: 'Nauvis — 12:40' })!.subtitle).toBe('Nauvis — 12:40');
  });

  it('accepts the legacy activity_type key and ignores kinds it cannot render', () => {
    expect(describeActivity({ name: 'X', type: undefined as unknown as number, activity_type: 3, details: 'Y' })?.kind).toBe('watching');
    expect(describeActivity({ name: 'X', type: 4 })).toBeNull();
    expect(describeActivity({ name: 'X', type: 42 })).toBeNull();
    expect(describeActivity({ name: ' ', type: 2 })).toBeNull();
  });
});

describe('precedence', () => {
  it('watching beats listening beats playing, whatever the order', () => {
    expect(displayActivity(presence([playing, listening]))?.kind).toBe('listening');
    expect(displayActivity(presence([playing, listening, together]))?.kind).toBe('watching');
    expect(displayActivity(presence([]))).toBeNull();
  });

  it('a row shows the custom status first, then the activity; nothing when offline', () => {
    expect(statusLine(presence([listening], { custom_status: 'heads down' }))).toEqual({
      type: 'custom',
      text: 'heads down',
    });
    const line = statusLine(presence([listening], { custom_status: '  ' }));
    expect(line?.type).toBe('activity');
    expect(statusLine(presence([listening], { status: 'offline' }))).toBeNull();
    expect(statusLine(undefined)).toBeNull();
  });
});

describe('timeline', () => {
  it('reports progress clamped to the track', () => {
    const view = describeActivity(listening)!;
    const start = view.startedMs!;
    expect(trackProgress(view, start + 60_000)).toEqual({
      elapsedMs: 60_000,
      durationMs: 367_000,
      fraction: 60_000 / 367_000,
    });
    expect(trackProgress(view, start + 999_000)?.fraction).toBe(1);
    expect(trackProgress(describeActivity(playing)!, start)).toBeNull();
  });

  it('formats times', () => {
    expect(formatTrackTime(187_400)).toBe('3:07');
    expect(formatTrackTime(3_765_000)).toBe('1:02:45');
    expect(activityElapsed({ startedMs: 1_000 }, 1_000 + 754_000)).toBe('for 12m 34s');
    expect(activityElapsed({ startedMs: null }, 5)).toBeNull();
  });
});
