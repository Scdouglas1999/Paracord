import { afterEach, expect, it, vi } from 'vitest';
import { playVoiceJoinSound, playVoiceLeaveSound } from './voiceSounds';

afterEach(() => vi.unstubAllGlobals());

it('releases the audio device if constructing a tone fails', () => {
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    currentTime = 0;
    close = close;
    createOscillator() { throw new Error('device unavailable'); }
  });

  expect(() => playVoiceJoinSound()).not.toThrow();
  expect(close).toHaveBeenCalledOnce();
});

it('handles an unavailable audio API without breaking voice actions', () => {
  vi.stubGlobal('AudioContext', undefined);
  expect(() => playVoiceJoinSound()).not.toThrow();
  expect(() => playVoiceLeaveSound()).not.toThrow();
});
