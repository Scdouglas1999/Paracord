import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isHappeningNow, resetGuildEventsForTests, toEventView, useGuildEvent } from './useGuildEvent';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const toastError = vi.hoisted(() => vi.fn());
const server = vi.hoisted(() => ({ ready: true }));

vi.mock('../../../api/activeClient', () => ({ getApi: () => api }));
vi.mock('../../../stores/toastStore', () => ({ toast: { error: toastError } }));
vi.mock('../../../hooks/useServerReady', () => ({ useServerReady: () => server.ready }));
vi.mock('../../../stores/serverListStore', () => ({
  useServerListStore: { getState: () => ({ activeServerId: 'srv-a' }) },
}));

const wire = (over: Record<string, unknown> = {}) => ({
  id: '7001',
  guild_id: 'g1',
  name: 'Haz 5 run',
  channel_id: '2002',
  creator_id: '101',
  scheduled_start: '2026-10-01T21:30:00-05:00',
  scheduled_end: null,
  location: null,
  status: 1,
  user_count: 3,
  user_rsvp: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  server.ready = true;
  resetGuildEventsForTests();
});

describe('toEventView', () => {
  it('reads an event, and refuses what is not one', () => {
    expect(toEventView(wire(), 'g1')).toMatchObject({ id: '7001', name: 'Haz 5 run', going: 3, youAreGoing: false, channelId: '2002' });
    expect(toEventView({ id: '1' }, 'g1')).toBeNull();
    expect(toEventView(null, 'g1')).toBeNull();
    expect(toEventView(wire({ scheduled_start: 'not a date' }), 'g1')).toBeNull();
  });

  it('knows an event is under way: marked active, or started and not over', () => {
    const now = Date.parse('2026-10-01T21:45:00-05:00');
    expect(isHappeningNow(toEventView(wire(), 'g1')!, now)).toBe(true);
    expect(isHappeningNow(toEventView(wire({ scheduled_end: '2026-10-01T21:40:00-05:00' }), 'g1')!, now)).toBe(false);
    expect(isHappeningNow(toEventView(wire({ status: 2, scheduled_start: '2026-10-02T21:30:00-05:00' }), 'g1')!, now)).toBe(true);
    expect(isHappeningNow(toEventView(wire({ status: 4 }), 'g1')!, now)).toBe(false);
  });
});

describe('useGuildEvent', () => {
  it('asks once for an event however many chips and cards name it', async () => {
    api.get.mockResolvedValue({ data: wire() });
    const a = renderHook(() => useGuildEvent('g1', '7001'));
    const b = renderHook(() => useGuildEvent('g1', '7001'));
    await waitFor(() => expect(a.result.current.status).toBe('ready'));
    expect(b.result.current.event?.name).toBe('Haz 5 run');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/guilds/g1/events/7001');
  });

  it('takes the spot and gives it back, keeping the count', async () => {
    api.get.mockResolvedValue({ data: wire() });
    api.put.mockResolvedValue({});
    api.delete.mockResolvedValue({});
    const { result } = renderHook(() => useGuildEvent('g1', '7001'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.toggleRsvp();
    });
    expect(api.put).toHaveBeenCalledWith('/guilds/g1/events/7001/rsvp');
    expect(result.current.event).toMatchObject({ youAreGoing: true, going: 4 });

    await act(async () => {
      await result.current.toggleRsvp();
    });
    expect(api.delete).toHaveBeenCalledWith('/guilds/g1/events/7001/rsvp');
    expect(result.current.event).toMatchObject({ youAreGoing: false, going: 3 });
  });

  it('leaves the RSVP as it was, and says so, when the server refuses', async () => {
    api.get.mockResolvedValue({ data: wire() });
    api.put.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useGuildEvent('g1', '7001'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.toggleRsvp();
    });
    expect(result.current.event).toMatchObject({ youAreGoing: false, going: 3 });
    expect(result.current.busy).toBe(false);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Could not update your RSVP'));
  });

  it('is “missing” for an event that is not there, and “error” for one that could not be asked', async () => {
    api.get.mockRejectedValueOnce({ response: { status: 404 } });
    const gone = renderHook(() => useGuildEvent('g1', '1'));
    await waitFor(() => expect(gone.result.current.status).toBe('missing'));

    api.get.mockRejectedValueOnce(new Error('offline'));
    const failed = renderHook(() => useGuildEvent('g1', '2'));
    await waitFor(() => expect(failed.result.current.status).toBe('error'));
    expect(failed.result.current.error).toBeTruthy();
  });

  it('asks again when the gateway says the calendar changed', async () => {
    api.get.mockResolvedValue({ data: wire() });
    const { result } = renderHook(() => useGuildEvent('g1', '7001'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    api.get.mockResolvedValue({ data: wire({ name: 'Haz 5 run (late)' }) });
    act(() => {
      window.dispatchEvent(new CustomEvent('paracord:scheduled-events-changed', { detail: { guild_id: 'g1' } }));
    });
    await waitFor(() => expect(result.current.event?.name).toBe('Haz 5 run (late)'));
  });

  it('does not ask when there is no server to ask', () => {
    renderHook(() => useGuildEvent(null, '7001'));
    expect(api.get).not.toHaveBeenCalled();
  });

  it('waits for a server that is not connected yet, loading and quiet, then asks', async () => {
    server.ready = false;
    api.get.mockResolvedValue({ data: wire() });
    const { result, rerender } = renderHook(() => useGuildEvent('g1', '7001'));
    expect(result.current.status).toBe('loading');
    expect(api.get).not.toHaveBeenCalled();
    server.ready = true;
    rerender();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
