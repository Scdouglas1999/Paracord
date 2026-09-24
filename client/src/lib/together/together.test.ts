import { beforeEach, describe, expect, it } from 'vitest';

import { HTTP_LINK, parseTogetherLink, UNSUPPORTED_LINK } from './links';
import { expectedPositionMs, formatPlaybackTime, playsFromLine, type TogetherSession } from './model';
import { clockOffsetMs, recordClockSample, resetServerClocks, serverNowMs } from './serverClock';
import { decideCorrection, NUDGE_FAST, NUDGE_SLOW } from './sync';

function session(overrides: Partial<TogetherSession> = {}): TogetherSession {
  return {
    session_id: 's',
    channel_id: 'c',
    guild_id: 'g',
    kind: 'watch',
    controller_policy: 'everyone',
    started_by: 'u1',
    started_at: 0,
    items: [
      {
        id: 'i1',
        source: 'url',
        ref: 'https://example.com/a.mp4',
        title: 'a.mp4',
        duration_ms: null,
        thumbnail: null,
        content_type: 'video/mp4',
        added_by: 'u1',
      },
    ],
    current_index: 0,
    playing: true,
    position_ms: 10_000,
    position_at: 1_000_000,
    rate: 1,
    revision: 1,
    server_time_ms: 1_000_000,
    ...overrides,
  };
}

describe('expected position', () => {
  it('advances with the server clock while playing', () => {
    expect(expectedPositionMs(session(), 1_002_500)).toBe(12_500);
  });

  it('holds still while paused', () => {
    expect(expectedPositionMs(session({ playing: false }), 1_060_000)).toBe(10_000);
  });

  it('stops at a known duration and never goes negative', () => {
    const s = session();
    s.items[0].duration_ms = 11_000;
    expect(expectedPositionMs(s, 1_060_000)).toBe(11_000);
    expect(expectedPositionMs(session({ position_ms: 0 }), 999_000)).toBe(0);
  });

  it('has nothing to advance when the queue ran out', () => {
    expect(expectedPositionMs(session({ current_index: 1 }), 1_060_000)).toBe(10_000);
  });

  it('formats times the way the controls show them', () => {
    expect(formatPlaybackTime(760_000)).toBe('12:40');
    expect(formatPlaybackTime(3_723_000)).toBe('1:02:03');
    expect(formatPlaybackTime(-5)).toBe('0:00');
  });
});

describe('drift correction', () => {
  it('seeks when more than 1.5 s off, either way, on any player', () => {
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 12_000, currentRate: 1, player: 'element' })).toEqual({
      kind: 'seek',
      toMs: 10_000,
      rate: 1,
    });
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 7_000, currentRate: 1, player: 'youtube' }).kind).toBe('seek');
  });

  it('does not seek again while the last seek is still landing', () => {
    expect(
      decideCorrection({ expectedMs: 10_000, actualMs: 13_000, currentRate: 1, player: 'element', sinceLastSeekMs: 500 }).kind,
    ).toBe('none');
    expect(
      decideCorrection({ expectedMs: 10_000, actualMs: 13_000, currentRate: 1, player: 'element', sinceLastSeekMs: 2500 }).kind,
    ).toBe('seek');
  });

  it('nudges the rate for 0.25–1.5 s on a media element', () => {
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 10_600, currentRate: 1, player: 'element' })).toEqual({
      kind: 'rate',
      rate: NUDGE_SLOW,
    });
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 9_400, currentRate: 1, player: 'element' })).toEqual({
      kind: 'rate',
      rate: NUDGE_FAST,
    });
  });

  it('keeps nudging until within 0.1 s, then returns to normal speed', () => {
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 10_150, currentRate: NUDGE_SLOW, player: 'element' })).toEqual({
      kind: 'rate',
      rate: NUDGE_SLOW,
    });
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 10_050, currentRate: NUDGE_SLOW, player: 'element' })).toEqual({
      kind: 'rate',
      rate: 1,
    });
  });

  it('leaves small drift alone', () => {
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 10_200, currentRate: 1, player: 'element' })).toEqual({
      kind: 'none',
      rate: 1,
    });
  });

  it('never nudges YouTube', () => {
    expect(decideCorrection({ expectedMs: 10_000, actualMs: 11_000, currentRate: 1, player: 'youtube' })).toEqual({
      kind: 'none',
      rate: 1,
    });
  });
});

describe('server clock', () => {
  beforeEach(() => resetServerClocks());

  it('takes the midpoint of the round trip', () => {
    recordClockSample('srv', 1_000, 1_100, 5_050);
    expect(clockOffsetMs('srv', 1_100)).toBe(4_000);
    expect(serverNowMs('srv', 2_000)).toBe(6_000);
  });

  it('trusts the shortest round trip', () => {
    recordClockSample('srv', 1_000, 1_800, 9_999); // slow, noisy
    recordClockSample('srv', 2_000, 2_020, 6_010); // fast: offset 4000
    expect(clockOffsetMs('srv', 2_100)).toBe(4_000);
  });

  it('keeps servers apart and has no guess before a sample', () => {
    recordClockSample('a', 0, 10, 105);
    expect(clockOffsetMs('b')).toBeNull();
    expect(serverNowMs('b', 123)).toBe(123);
  });

  it('ignores a missing stamp', () => {
    recordClockSample('srv', 0, 10, Number.NaN);
    expect(clockOffsetMs('srv')).toBeNull();
  });
});

describe('links', () => {
  it('reads every common YouTube form', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=42',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123456789012',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(parseTogetherLink(link)).toEqual({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
    }
    expect(parseTogetherLink('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI')).toEqual({
      kind: 'youtube-playlist',
      listId: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
    });
  });

  it('accepts direct media files and says which are audio', () => {
    expect(parseTogetherLink('https://cdn.example.com/clip.MP4?x=1')).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/clip.MP4?x=1',
      audio: false,
      host: 'cdn.example.com',
    });
    expect(parseTogetherLink('https://127.0.0.1:8443/song.flac')).toMatchObject({ kind: 'url', audio: true, host: '127.0.0.1:8443' });
  });

  it('refuses plain http media, which the desktop app cannot play', () => {
    expect(parseTogetherLink('http://example.com/clip.mp4')).toEqual({ kind: 'error', message: HTTP_LINK });
  });

  it('says where each device fetches an item from', () => {
    const base = { id: 'i', title: 't', duration_ms: null, thumbnail: null, content_type: null, added_by: 'u' };
    expect(playsFromLine({ ...base, source: 'url', ref: 'https://cdn.example.com/a.mp4' })).toBe(
      "Plays from cdn.example.com on each person's device",
    );
    expect(playsFromLine({ ...base, source: 'youtube', ref: 'dQw4w9WgXcQ' })).toBe("Plays from YouTube on each person's device");
    expect(playsFromLine({ ...base, source: 'attachment', ref: '1' })).toBeNull();
  });

  it('refuses everything else in plain words', () => {
    for (const link of ['https://example.com/page', 'ftp://x/a.mp4', 'not a link', 'https://vimeo.com/123']) {
      expect(parseTogetherLink(link)).toEqual({ kind: 'error', message: UNSUPPORTED_LINK });
    }
    expect(parseTogetherLink('https://www.youtube.com/@channel').kind).toBe('error');
  });
});
