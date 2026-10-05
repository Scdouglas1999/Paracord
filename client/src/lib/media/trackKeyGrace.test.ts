import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STALE_TRACK_KEY_GRACE_MS, TrackKeyGrace } from './engineShared';
import { UnopenableMediaKeyError } from './mediaKeyring';

// An older relay hands a rejoiner the stream keys sealed to its previous call
// key before its join; the publishers' fresh keys follow. The call fails only
// if none does.
describe('TrackKeyGrace', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets a stale seal wait for a key that opens, and forgets it when one does', () => {
    const fail = vi.fn();
    const grace = new TrackKeyGrace(fail);
    grace.refused('stream:v:screen:screen', new UnopenableMediaKeyError());
    vi.advanceTimersByTime(STALE_TRACK_KEY_GRACE_MS - 1);
    grace.opened('stream:v:screen:screen');
    vi.advanceTimersByTime(STALE_TRACK_KEY_GRACE_MS * 2);
    expect(fail).not.toHaveBeenCalled();
  });

  it('fails loudly when no key that opens follows', () => {
    const fail = vi.fn();
    const grace = new TrackKeyGrace(fail);
    const error = new UnopenableMediaKeyError();
    grace.refused('t', error);
    grace.refused('t', new UnopenableMediaKeyError());
    vi.advanceTimersByTime(STALE_TRACK_KEY_GRACE_MS);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(error);
  });

  it('fails at once for anything but a stale seal, and never after dispose', () => {
    const fail = vi.fn();
    const grace = new TrackKeyGrace(fail);
    const malformed = new Error('The wrapped media key has an invalid nonce.');
    grace.refused('t', malformed);
    expect(fail).toHaveBeenCalledWith(malformed);
    grace.refused('u', new UnopenableMediaKeyError());
    grace.dispose();
    vi.advanceTimersByTime(STALE_TRACK_KEY_GRACE_MS * 2);
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
