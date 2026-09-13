import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { personLight, type RoomLight } from '../../lib/attention/light';
import { peerLightSentence, useRoomLitEvents } from './messageLight';

/**
 * The one client-side event the timeline carries (docs/lantern-stage-spec.md
 * §7.4): a voice room in this building lighting up **while you are reading**.
 *
 * It is a transition in WP1's room light, never a server message, so the rules
 * that matter are about honesty:
 *
 *   - a room that was already lit when you arrived is state, not news;
 *   - a room that empties again loses its event immediately, because the Join
 *     it offers must never lead into a dark room;
 *   - a room you are already in is not an invitation.
 */

const rooms = vi.hoisted(() => ({ current: [] as RoomLight[] }));

vi.mock('../../hooks/useLights', async () => {
  const stub = await import('../../test/messageLightMock');
  return { ...stub, useRoomLights: () => rooms.current };
});

function occupant(name: string, index: number) {
  return {
    person: personLight({
      userId: `v${index}`,
      name,
      status: 'online' as const,
      inRoom: true,
      roomName: 'Shop floor',
    }),
    speaking: false,
    muted: false,
    sharingScreen: false,
    sharingCamera: false,
  };
}

function voiceRoom(overrides: Partial<RoomLight> = {}): RoomLight {
  const names = ['Mara', 'Priya', 'Ren'];
  return {
    key: 'room:shop-floor',
    scope: { serverId: '__local__', userId: 'me' },
    guildId: 'guild-1',
    channelId: 'voice-1',
    name: 'Shop floor',
    kind: 'voice',
    order: 0,
    level: 'white',
    lit: true,
    occupants: names.map(occupant),
    talkingCount: 0,
    screenSharer: null,
    cameraSharer: null,
    durationMs: 0,
    youAreHere: false,
    readers: [],
    readingCount: 0,
    lastLitMs: null,
    caption: '3 talking',
    thumbnail: { live: false, reason: 'not-joined', label: 'LIVE' },
    ...overrides,
  };
}

const darkRoom = () => voiceRoom({ lit: false, level: 'dark', occupants: [], caption: 'Dark · nobody in' });

describe('useRoomLitEvents (§7.4)', () => {
  beforeEach(() => {
    rooms.current = [];
  });

  it('reports nothing for a room that was already lit when you arrived', () => {
    rooms.current = [voiceRoom()];
    const { result } = renderHook(() => useRoomLitEvents('guild-1'));
    expect(result.current).toEqual([]);
  });

  it('reports a room that lights up while you are reading, and names who is in it', () => {
    rooms.current = [darkRoom()];
    const { result, rerender } = renderHook(() => useRoomLitEvents('guild-1'));
    expect(result.current).toEqual([]);

    act(() => {
      rooms.current = [voiceRoom()];
    });
    rerender();

    expect(result.current).toHaveLength(1);
    expect(result.current[0].headline).toBe('Shop floor lit up');
    expect(result.current[0].detail).toBe('Mara, Priya and Ren are in there now');
    expect(result.current[0].channelId).toBe('voice-1');
  });

  it('drops the event the moment the room empties again', () => {
    rooms.current = [darkRoom()];
    const { result, rerender } = renderHook(() => useRoomLitEvents('guild-1'));
    act(() => {
      rooms.current = [voiceRoom()];
    });
    rerender();
    expect(result.current).toHaveLength(1);

    act(() => {
      rooms.current = [darkRoom()];
    });
    rerender();
    expect(result.current).toEqual([]);
  });

  it('does not invite you into a room you are already in', () => {
    rooms.current = [darkRoom()];
    const { result, rerender } = renderHook(() => useRoomLitEvents('guild-1'));
    act(() => {
      rooms.current = [voiceRoom({ youAreHere: true })];
    });
    rerender();
    expect(result.current).toEqual([]);
  });

  it('ignores text rooms — an amber window is not an event', () => {
    rooms.current = [];
    const { result, rerender } = renderHook(() => useRoomLitEvents('guild-1'));
    act(() => {
      rooms.current = [
        voiceRoom({ kind: 'text', level: 'amber', occupants: [], readingCount: 2, caption: '2 reading' }),
      ];
    });
    rerender();
    expect(result.current).toEqual([]);
  });

  it('keeps at most two events, the most recent ones', () => {
    rooms.current = [];
    const { result, rerender } = renderHook(() => useRoomLitEvents('guild-1'));
    act(() => {
      rooms.current = [
        voiceRoom({ key: 'a', channelId: 'a', name: 'Shop floor' }),
        voiceRoom({ key: 'b', channelId: 'b', name: 'Lounge' }),
        voiceRoom({ key: 'c', channelId: 'c', name: 'Bench' }),
      ];
    });
    rerender();
    expect(result.current).toHaveLength(2);
  });
});

/**
 * The DM header's sentence (§7.6). "reading this" is only ever added when the
 * room can actually tell the peer is here — presence alone is "lights on" and
 * says exactly that.
 */
describe('peerLightSentence (§7.6)', () => {
  it('says the peer, their light, and whether they are reading this', () => {
    const peer = personLight({ userId: 'ren', name: 'Ren', status: 'online' });
    expect(peerLightSentence(peer, true)).toBe('Ren · lights on · reading this');
    expect(peerLightSentence(peer, false)).toBe('Ren · lights on');
  });

  it('never claims somebody is reading when their lights are off', () => {
    const peer = personLight({ userId: 'ren', name: 'Ren', status: 'offline' });
    expect(peerLightSentence(peer, false)).toBe('Ren · lights off');
  });

  it('says away rather than pretending a dim person is here', () => {
    const peer = personLight({ userId: 'ren', name: 'Ren', status: 'idle' });
    expect(peerLightSentence(peer, false)).toBe('Ren · away');
  });
});
