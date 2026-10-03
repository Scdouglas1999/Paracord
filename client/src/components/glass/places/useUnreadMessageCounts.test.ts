import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COUNT_PROBE_LIMIT } from './model';
import { resetUnreadCounts, unreadKey, useUnreadMessageCounts, type UnreadTarget } from './useUnreadMessageCounts';

const request = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/operationContext', () => ({
  captureScopedOperation: () => ({
    request,
    assertCurrent: () => {},
    dispose: () => {},
  }),
}));

const SCOPE = { serverId: 'srv', userId: 'me' };
const target = (over: Partial<UnreadTarget> = {}): UnreadTarget => ({
  channelId: 'clips',
  scope: SCOPE,
  cursor: '10',
  tail: '13',
  ...over,
});
const KEY = unreadKey(SCOPE, 'clips');
const messages = (count: number, author = 'them') => Array.from({ length: count }, (_, index) => ({ id: String(11 + index), author: { id: author } }));

describe('useUnreadMessageCounts', () => {
  beforeEach(() => {
    resetUnreadCounts();
    request.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has no number until the server has answered, then the exact count', async () => {
    request.mockResolvedValue({ data: messages(3) });
    const { result } = renderHook(() => useUnreadMessageCounts([target()]));
    expect(result.current.get(KEY)).toBeNull();
    await waitFor(() => expect(result.current.get(KEY)).toBe(3));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: '/channels/clips/messages',
      params: { after: '10', limit: COUNT_PROBE_LIMIT },
    });
  });

  it('asks from the start for a channel that was never opened', async () => {
    request.mockResolvedValue({ data: messages(2) });
    const { result } = renderHook(() => useUnreadMessageCounts([target({ cursor: null })]));
    await waitFor(() => expect(result.current.get(KEY)).toBe(2));
    expect(request.mock.calls[0][0].params.after).toBe('0');
  });

  it('caps what it reports: a full page back means more than the cap', async () => {
    request.mockResolvedValue({ data: messages(COUNT_PROBE_LIMIT) });
    const { result } = renderHook(() => useUnreadMessageCounts([target()]));
    await waitFor(() => expect(result.current.get(KEY)).toBe(COUNT_PROBE_LIMIT));
  });

  it('does not count what you wrote yourself', async () => {
    request.mockResolvedValue({ data: [...messages(2), ...messages(2, 'me')] });
    const { result } = renderHook(() => useUnreadMessageCounts([target()]));
    await waitFor(() => expect(result.current.get(KEY)).toBe(2));
  });

  it('answers from its cache while your position and the channel’s newest message are the same', async () => {
    request.mockResolvedValue({ data: messages(3) });
    const { result, rerender } = renderHook(({ targets }) => useUnreadMessageCounts(targets), { initialProps: { targets: [target()] } });
    await waitFor(() => expect(result.current.get(KEY)).toBe(3));
    rerender({ targets: [target()] });
    expect(result.current.get(KEY)).toBe(3);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('asks again, after a short quiet, when a new message arrives, and does not show the stale count meanwhile', async () => {
    request.mockResolvedValue({ data: messages(3) });
    const { result, rerender } = renderHook(({ targets }) => useUnreadMessageCounts(targets), { initialProps: { targets: [target()] } });
    await waitFor(() => expect(result.current.get(KEY)).toBe(3));
    request.mockResolvedValue({ data: messages(4) });
    rerender({ targets: [target({ tail: '14' })] });
    // A count for a different tail is not this channel's count: a dot until the answer.
    expect(result.current.get(KEY)).toBeNull();
    await waitFor(() => expect(result.current.get(KEY)).toBe(4));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retries the newest tail when it changes during an in-flight count', async () => {
    vi.useFakeTimers();
    let finish!: (value: { data: ReturnType<typeof messages> }) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    request.mockResolvedValue({ data: messages(4) });
    const { result, rerender } = renderHook(({ targets }) => useUnreadMessageCounts(targets), {
      initialProps: { targets: [target()] },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(request).toHaveBeenCalledTimes(1);
    rerender({ targets: [target({ tail: '14' })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ data: messages(3) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.get(KEY)).toBe(4);
  });

  it('leaves a burst of messages as one request', async () => {
    request.mockResolvedValue({ data: messages(5) });
    const { result, rerender } = renderHook(({ targets }) => useUnreadMessageCounts(targets), { initialProps: { targets: [target()] } });
    await waitFor(() => expect(result.current.get(KEY)).toBe(5));
    request.mockClear();
    vi.useFakeTimers();
    for (const tail of ['14', '15', '16', '17']) {
      rerender({ targets: [target({ tail })] });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps the dot when the server refuses, and asks again later', async () => {
    vi.useFakeTimers();
    request.mockRejectedValueOnce(new Error('403'));
    request.mockResolvedValue({ data: messages(2) });
    const { result } = renderHook(() => useUnreadMessageCounts([target()]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.get(KEY)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    // The retry timer re-renders the hook; its effect then asks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.get(KEY)).toBe(2);
  });

  it('asks for at most three channels at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    request.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { data: messages(1) };
    });
    const targets = ['a', 'b', 'c', 'd', 'e', 'f'].map((channelId) => target({ channelId }));
    const { result } = renderHook(() => useUnreadMessageCounts(targets));
    await waitFor(() => expect([...result.current.values()].every((count) => count === 1)).toBe(true));
    expect(request).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps servers apart: the same channel id in another account is another channel', async () => {
    request.mockResolvedValue({ data: messages(3) });
    const otherScope = { serverId: 'other', userId: 'me' };
    request.mockResolvedValueOnce({ data: messages(3) });
    request.mockResolvedValueOnce({ data: messages(7) });
    const { result } = renderHook(() => useUnreadMessageCounts([target(), target({ scope: otherScope, tail: '99' })]));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.size).toBe(2));
    await waitFor(() => expect([result.current.get(KEY), result.current.get(unreadKey(otherScope, 'clips'))].sort()).toEqual([3, 7]));
  });
});
