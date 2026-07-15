import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTypingStore } from './typingStore';

describe('typingStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTypingStore.getState().reset();
  });

  afterEach(() => {
    useTypingStore.getState().reset();
    vi.useRealTimers();
  });

  it('adds a typing user and expires it after the timeout', () => {
    useTypingStore.getState().addTyping('chan-1', 'user-1');
    expect(useTypingStore.getState().typingByChannel['chan-1']).toEqual(['user-1']);

    vi.advanceTimersByTime(8000);
    expect(useTypingStore.getState().typingByChannel['chan-1']).toEqual([]);
  });

  it('refreshes the expiry without rewriting state when the user is already typing', () => {
    useTypingStore.getState().addTyping('chan-1', 'user-1');
    const before = useTypingStore.getState().typingByChannel;

    useTypingStore.getState().addTyping('chan-1', 'user-1');
    expect(useTypingStore.getState().typingByChannel).toBe(before);

    // Timer was refreshed: advancing just under 8s from the second call keeps them.
    vi.advanceTimersByTime(7999);
    expect(useTypingStore.getState().typingByChannel['chan-1']).toEqual(['user-1']);
    vi.advanceTimersByTime(1);
    expect(useTypingStore.getState().typingByChannel['chan-1']).toEqual([]);
  });

  it('clearChannel cancels pending per-user expiry timers', () => {
    useTypingStore.getState().addTyping('chan-1', 'user-1');
    useTypingStore.getState().addTyping('chan-1', 'user-2');

    useTypingStore.getState().clearChannel('chan-1');
    expect(useTypingStore.getState().typingByChannel['chan-1']).toEqual([]);

    // If the timers were not cancelled, they would fire here and could resurrect
    // stale state or run set() on a cleared channel. Nothing should change.
    vi.advanceTimersByTime(8000);
    expect(useTypingStore.getState().typingByChannel['chan-1']).toEqual([]);
    // No lingering timers scheduled.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clearChannel only cancels timers for the targeted channel', () => {
    useTypingStore.getState().addTyping('chan-1', 'user-1');
    useTypingStore.getState().addTyping('chan-2', 'user-9');

    useTypingStore.getState().clearChannel('chan-1');
    // chan-2's timer must still be pending.
    expect(useTypingStore.getState().typingByChannel['chan-2']).toEqual(['user-9']);
    vi.advanceTimersByTime(8000);
    expect(useTypingStore.getState().typingByChannel['chan-2']).toEqual([]);
  });

  it('reset clears all state and cancels every timer', () => {
    useTypingStore.getState().addTyping('chan-1', 'user-1');
    useTypingStore.getState().addTyping('chan-2', 'user-2');

    useTypingStore.getState().reset();
    expect(useTypingStore.getState().typingByChannel).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
});
