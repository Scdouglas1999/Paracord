import { vi } from 'vitest';

import type { PersonLight } from '../lib/attention/light';
import type { HereNow } from '../hooks/useLights';

/**
 * The light seam, stubbed for suites that are not about light.
 *
 * `components/message/messageLight.ts` and `hooks/useLights.ts` read half a
 * dozen stores to answer "who is here right now". The older message suites mock
 * those stores down to the two or three fields the component under test needed,
 * so wiring the real light selectors through them would make every one of them
 * a fixture for a question it is not asking.
 *
 * These suites therefore mock the seam, and the light itself is covered where it
 * belongs: `components/message/messageLight.test.tsx` (the models and the
 * transitions) and `components/message/TextRoom.test.tsx` (the header strip,
 * the in-room meta, the inline room event and the composer copy), both against
 * real store fixtures.
 *
 * Usage, at the top of a suite:
 *
 * ```ts
 * vi.mock('./messageLight', () => import('../../test/messageLightMock'));
 * vi.mock('../../hooks/useLights', () => import('../../test/messageLightMock'));
 * ```
 */

export const OFF: Omit<PersonLight, 'userId' | 'name' | 'avatar'> = {
  level: 'off',
  lit: false,
  dim: false,
  dnd: false,
  speaking: false,
  live: false,
  roomName: null,
  avatarClass: '',
  label: 'Offline',
};

export const EMPTY_HERE_NOW: HereNow = {
  people: [],
  here: 0,
  lightsOn: 0,
  caption: '0 here · 0 online',
};

/** A person with their lights off — a stub row, never an assertion of presence. */
export function stubPerson(
  author: { id: string; name?: string; avatar?: string | null },
): PersonLight {
  return { userId: author.id, name: author.name ?? author.id, avatar: author.avatar ?? null, ...OFF };
}

/* ---- components/message/messageLight ------------------------------------ */
export const useAuthorLights = () => stubPerson;
export const useRoomLitEvents = () => [];
const NO_EVENTS: never[] = [];
export const createTimelineLightStore = () => ({
  subscribe: () => () => {},
  resolver: () => stubPerson,
  events: () => NO_EVENTS,
});
export const TimelineLightSource = () => null;
export const useTimelineAuthorLight = (_store: unknown, author: { id: string; name?: string; avatar?: string | null }) =>
  stubPerson(author);
export const TimelineAuthor = ({
  author,
  children,
}: {
  author: { id: string; name?: string; avatar?: string | null };
  children: (person: PersonLight) => unknown;
}) => children(stubPerson(author));
export const useSelfUser = () => null;
export const useDmLight = () => ({
  room: null,
  hereNow: EMPTY_HERE_NOW,
  peer: null,
  people: [],
  isGroup: false,
  name: 'this conversation',
});
export const isReading = () => false;
export const peerLightSentence = (peer: PersonLight) => `${peer.name} · offline`;
export const dmRoomName = () => 'this conversation';
export const ROOM_EVENT_TTL_MS = 600_000;
export const MAX_ROOM_EVENTS = 2;

/* ---- hooks/useLights ----------------------------------------------------- */
export const useHereNow = () => EMPTY_HERE_NOW;
export const useRoomLight = () => null;
export const useRoomLights = () => [];
export const useBuildingLight = () => null;
export const useBuildingLights = () => [];
export const useBuildingPeople = () => [];
export const useLightsOnAcrossBuildings = () => 0;
export const useAroundNow = () => 'Nobody is online right now';
export const useOnAir = () => null;
export const useLightClock = () => 0;
export const useWindowIsVisible = () => true;
export const accountKeyOf = vi.fn(() => null);
