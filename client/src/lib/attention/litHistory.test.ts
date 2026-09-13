import { describe, expect, it } from 'vitest';

import { createLitHistory } from './litHistory';

describe('lit history', () => {
  it('knows nothing until it has seen something', () => {
    const history = createLitHistory();
    expect(history.peek('room')).toEqual({ litSinceMs: null, lastLitMs: null });
  });

  it('starts the clock the first time a room is lit and keeps it while it stays lit', () => {
    const history = createLitHistory();
    expect(history.observe('room', true, 1_000)).toEqual({ litSinceMs: 1_000, lastLitMs: 1_000 });
    expect(history.observe('room', true, 5_000)).toEqual({ litSinceMs: 1_000, lastLitMs: 5_000 });
  });

  it('drops the start when the room empties but remembers when it was last lit', () => {
    const history = createLitHistory();
    history.observe('room', true, 1_000);
    expect(history.observe('room', false, 9_000)).toEqual({
      litSinceMs: null,
      lastLitMs: 1_000,
    });
  });

  it('restarts the clock when the room lights up again', () => {
    const history = createLitHistory();
    history.observe('room', true, 1_000);
    history.observe('room', false, 2_000);
    expect(history.observe('room', true, 3_000).litSinceMs).toBe(3_000);
  });

  it('evicts the least recently touched room past the cap', () => {
    const history = createLitHistory(2);
    history.observe('a', true, 1);
    history.observe('b', true, 2);
    history.observe('c', true, 3);
    expect(history.size).toBe(2);
    expect(history.peek('a').lastLitMs).toBeNull();
    expect(history.peek('c').lastLitMs).toBe(3);
  });

  it('clears on logout', () => {
    const history = createLitHistory();
    history.observe('room', true, 1_000);
    history.clear();
    expect(history.size).toBe(0);
    expect(history.peek('room').lastLitMs).toBeNull();
  });
});
