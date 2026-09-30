import { describe, expect, it } from 'vitest';
import { isListeningIn, listenersOf, liveMinutes, streamStartedAt } from './selectors';
import type { VoiceState } from '../../types';

const base: VoiceState = {
  user_id: '1', channel_id: 'c', session_id: 's', deaf: false, mute: false, self_deaf: false,
  self_mute: false, self_stream: false, self_video: false, suppress: false,
};

describe('Glass voice-state fields', () => {
  it('reads "Listening in" from the mode, joined when absent', () => {
    expect(isListeningIn({ ...base, mode: 'listen' })).toBe(true);
    expect(isListeningIn({ ...base, mode: 'joined' })).toBe(false);
    expect(isListeningIn(base)).toBe(false);
    expect(listenersOf([{ ...base, mode: 'listen' }, base]).map((m) => m.mode)).toEqual(['listen']);
  });

  it('gives "LIVE 42 MIN" only for a stream the server stamped', () => {
    const live = { ...base, self_stream: true, self_stream_started_at: '2026-09-30T20:30:00Z' };
    expect(liveMinutes(live, Date.parse('2026-09-30T21:12:59Z'))).toBe(42);
    expect(streamStartedAt({ ...live, self_stream: false })).toBeNull();
    expect(streamStartedAt({ ...base, self_stream: true, self_stream_started_at: null })).toBeNull();
    expect(streamStartedAt({ ...base, self_stream: true, self_stream_started_at: 'not a time' })).toBeNull();
  });
});
