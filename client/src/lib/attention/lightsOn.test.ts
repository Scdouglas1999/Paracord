import { describe, expect, it } from 'vitest';

import { createLightsOnTracker, RETURN_AFTER_HIDDEN_MS } from './lightsOn';

/**
 * §5.3's hardest line: "never animate on first paint what the user did not
 * cause or presence did not cause". Everything below is a case where the
 * building must NOT wake up.
 */
describe('the lights-on tracker (§5.1, §5.3)', () => {
  const on = { presenceResolved: true, connected: true, visible: true };
  const off = { presenceResolved: false, connected: false, visible: true };

  it('fires once when presence first resolves, and never again for the same data', () => {
    const tracker = createLightsOnTracker();
    expect(tracker.observe({ ...off, nowMs: 0 })).toBeNull();
    expect(tracker.observe({ ...on, nowMs: 100 })).toBe('first');
    expect(tracker.observe({ ...on, nowMs: 200 })).toBeNull();
    expect(tracker.observe({ ...on, nowMs: 300 })).toBeNull();
  });

  it('does not fire for a re-render, a route change or a presence tick', () => {
    const tracker = createLightsOnTracker();
    tracker.observe({ ...on, nowMs: 0 });
    for (let i = 1; i <= 20; i += 1) {
      expect(tracker.observe({ ...on, nowMs: i * 50 })).toBeNull();
    }
  });

  it('fires again when the gateway comes back — but only once presence has', () => {
    const tracker = createLightsOnTracker();
    tracker.observe({ ...on, nowMs: 0 });
    // The gateway drops. Nothing happens: going away is not a moment.
    expect(tracker.observe({ ...on, connected: false, nowMs: 1_000 })).toBeNull();
    // It comes back a beat before the picture does, and the moment waits for
    // the picture: lighting the building up over stale data is the bug.
    expect(
      tracker.observe({ ...on, connected: true, presenceResolved: false, nowMs: 2_000 }),
    ).toBeNull();
    expect(tracker.observe({ ...on, nowMs: 2_100 })).toBe('reconnect');
    expect(tracker.observe({ ...on, nowMs: 2_200 })).toBeNull();
  });

  it('fires when the window comes back after a long absence, and not a short one', () => {
    const tracker = createLightsOnTracker();
    tracker.observe({ ...on, nowMs: 0 });

    // A glance at another app.
    tracker.observe({ ...on, visible: false, nowMs: 1_000 });
    expect(tracker.observe({ ...on, visible: true, nowMs: 1_000 + 30_000 })).toBeNull();

    // An afternoon away.
    tracker.observe({ ...on, visible: false, nowMs: 100_000 });
    expect(
      tracker.observe({ ...on, visible: true, nowMs: 100_000 + RETURN_AFTER_HIDDEN_MS }),
    ).toBe('return');
    expect(tracker.observe({ ...on, nowMs: 500_000 })).toBeNull();
  });

  it('counts the first connection of a run as `first`, never as a reconnect', () => {
    const tracker = createLightsOnTracker();
    expect(tracker.observe({ ...off, nowMs: 0 })).toBeNull();
    expect(tracker.observe({ ...off, connected: true, nowMs: 50 })).toBeNull();
    expect(tracker.observe({ ...on, nowMs: 100 })).toBe('first');
    expect(tracker.observe({ ...on, nowMs: 150 })).toBeNull();
  });

  it('a building that empties is not a building that was never lit', () => {
    const tracker = createLightsOnTracker();
    expect(tracker.observe({ ...on, nowMs: 0 })).toBe('first');
    expect(tracker.observe({ ...on, presenceResolved: false, nowMs: 100 })).toBeNull();
    expect(tracker.observe({ ...on, nowMs: 200 })).toBeNull();
  });

  it('forgets everything on reset, with the rest of the session', () => {
    const tracker = createLightsOnTracker();
    expect(tracker.observe({ ...on, nowMs: 0 })).toBe('first');
    tracker.reset();
    expect(tracker.observe({ ...on, nowMs: 10 })).toBe('first');
  });
});
