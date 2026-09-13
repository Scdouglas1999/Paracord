import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTyping } from './useTyping';
import { channelApi } from '../api/channels';
import { TYPING_TIMEOUT } from '../lib/constants';

vi.mock('../api/channels', () => ({
  channelApi: { triggerTyping: vi.fn(async () => undefined) },
}));

const triggerTyping = vi.mocked(channelApi.triggerTyping);

describe('useTyping', () => {
  beforeEach(() => {
    triggerTyping.mockClear();
    vi.useRealTimers();
  });

  it('sends one start per throttle window and a stop that reopens it', () => {
    const { result } = renderHook(() => useTyping('chan-1'));
    act(() => { result.current.triggerTyping(); result.current.triggerTyping(); });
    expect(triggerTyping.mock.calls).toEqual([['chan-1']]);

    act(() => { result.current.stopTyping(); });
    expect(triggerTyping.mock.calls[1]).toEqual(['chan-1', true]);

    // The stop clears the throttle: the next keystroke starts a fresh
    // indicator instead of waiting out a window that no longer means anything.
    act(() => { result.current.triggerTyping(); });
    expect(triggerTyping.mock.calls[2]).toEqual(['chan-1']);
    expect(TYPING_TIMEOUT).toBeGreaterThan(0);
  });

  it('never sends a stop for a composer that never started', () => {
    const { result } = renderHook(() => useTyping('chan-1'));
    act(() => { result.current.stopTyping(); result.current.stopTyping(); });
    expect(triggerTyping).not.toHaveBeenCalled();
  });

  it('stops when the composer is unmounted or moves to another conversation', () => {
    const { result, rerender, unmount } = renderHook(({ id }: { id: string }) => useTyping(id), {
      initialProps: { id: 'chan-1' },
    });
    act(() => { result.current.triggerTyping(); });
    rerender({ id: 'chan-2' });
    expect(triggerTyping.mock.calls).toEqual([['chan-1'], ['chan-1', true]]);

    act(() => { result.current.triggerTyping(); });
    unmount();
    expect(triggerTyping.mock.calls.at(-1)).toEqual(['chan-2', true]);
  });

  it('does nothing at all without a conversation', () => {
    const { result } = renderHook(() => useTyping(null));
    act(() => { result.current.triggerTyping(); result.current.stopTyping(); });
    expect(triggerTyping).not.toHaveBeenCalled();
  });
});
