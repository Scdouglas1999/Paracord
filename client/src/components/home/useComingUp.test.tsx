import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useComingUp } from './useComingUp';
import { captureScopedOperation } from '../../lib/operationContext';
import {
  buildingLight,
  voiceRoomLight,
  type BuildingLight,
} from '../../lib/attention/light';

vi.mock('../../lib/operationContext', () => ({ captureScopedOperation: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn() } }));

const SCOPE = { serverId: 'a', userId: 'viewer' };
const NOW = new Date(2026, 8, 12, 20, 0, 0, 0).getTime();

const request = vi.fn();
const dispose = vi.fn();

function building(guildId: string, name: string): BuildingLight {
  return buildingLight({
    scope: SCOPE,
    guildId,
    name,
    rooms: [
      voiceRoomLight({
        scope: SCOPE,
        guildId,
        channelId: `v-${guildId}`,
        name: 'Shop floor',
        occupants: [],
        nowMs: NOW,
      }),
    ],
    members: [],
    memberCount: 3,
  });
}

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    name: 'Thermal test',
    channel_id: null,
    scheduled_start: new Date(NOW + 3_600_000).toISOString(),
    status: 1,
    location: null,
    user_count: 6,
    user_rsvp: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(captureScopedOperation).mockImplementation(
    () => ({ request, dispose, assertCurrent: vi.fn() }) as never,
  );
  request.mockResolvedValue({ data: [] });
});

describe('Coming up, across the servers', () => {
  it('asks each server once and merges the answers soonest first', async () => {
    request.mockImplementation(({ url }: { url: string }) =>
      Promise.resolve({
        data: url.includes('g1')
          ? [event({ id: 'later', scheduled_start: new Date(NOW + 7_200_000).toISOString() })]
          : [event({ id: 'sooner' })],
      }),
    );
    const { result } = renderHook(() =>
      useComingUp([building('g1', 'Kestrel'), building('g2', 'Saltmarsh')], NOW),
    );
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((e) => e.id)).toEqual(['sooner', 'later']);
    expect(result.current.events[0].buildingName).toBe('Saltmarsh');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('drops cancelled, completed and finished events', async () => {
    request.mockResolvedValue({
      data: [
        event({ id: 'cancelled', status: 4 }),
        event({ id: 'completed', status: 3 }),
        event({ id: 'yesterday', scheduled_start: new Date(NOW - 86_400_000).toISOString() }),
        event({ id: 'running', status: 2, scheduled_start: new Date(NOW - 600_000).toISOString() }),
        event({ id: 'soon' }),
      ],
    });
    const { result } = renderHook(() => useComingUp([building('g1', 'Kestrel')], NOW));
    await waitFor(() => expect(result.current.events.length).toBeGreaterThan(0));
    expect(result.current.events.map((e) => e.id)).toEqual(['running', 'soon']);
  });

  it('names the room an event is bound to', async () => {
    request.mockResolvedValue({ data: [event({ channel_id: 'v-g1' })] });
    const { result } = renderHook(() => useComingUp([building('g1', 'Kestrel')], NOW));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.events[0].roomName).toBe('Shop floor');
  });

  it('keeps a server that cannot answer from blanking the others', async () => {
    request.mockImplementation(({ url }: { url: string }) =>
      url.includes('g1') ? Promise.reject(new Error('offline')) : Promise.resolve({ data: [event()] }),
    );
    const { result } = renderHook(() =>
      useComingUp([building('g1', 'Kestrel'), building('g2', 'Saltmarsh')], NOW),
    );
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.events[0].buildingName).toBe('Saltmarsh');
  });

  it('caps the list — the server keeps the full one', async () => {
    request.mockResolvedValue({
      data: [1, 2, 3, 4, 5].map((n) =>
        event({ id: `e${n}`, scheduled_start: new Date(NOW + n * 3_600_000).toISOString() }),
      ),
    });
    const { result } = renderHook(() => useComingUp([building('g1', 'Kestrel')], NOW));
    await waitFor(() => expect(result.current.events.length).toBeGreaterThan(0));
    expect(result.current.events).toHaveLength(3);
  });

  it('does not refetch when only the light on a server changed', async () => {
    request.mockResolvedValue({ data: [event()] });
    const { result, rerender } = renderHook(
      ({ clock }: { clock: number }) => useComingUp([building('g1', 'Kestrel')], clock),
      { initialProps: { clock: NOW } },
    );
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    rerender({ clock: NOW + 1000 });
    rerender({ clock: NOW + 2000 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends the RSVP the row asked for and tells the server about it', async () => {
    request.mockResolvedValue({ data: [event()] });
    const { result } = renderHook(() => useComingUp([building('g1', 'Kestrel')], NOW));
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    const changed = vi.fn();
    window.addEventListener('paracord:scheduled-events-changed', changed);
    request.mockResolvedValue({ data: {} });
    await act(async () => {
      await result.current.setGoing(result.current.events[0], true);
    });
    window.removeEventListener('paracord:scheduled-events-changed', changed);

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'PUT', url: '/guilds/g1/events/e1/rsvp' }),
    );
    expect(changed).toHaveBeenCalled();
  });
});
