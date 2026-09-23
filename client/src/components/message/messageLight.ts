/**
 * The light a text room and a DM need (docs/lantern-stage-spec.md §7.4, §7.6).
 *
 * WP1 owns every rule about who is lit, who is talking and who is reading
 * (`src/lib/attention/`), and `src/hooks/useLights.ts` is the only place the
 * stores are read for a *building*. This module is the same seam for the two
 * things a message surface needs that a building does not model:
 *
 *   1. **The author of a message, as light** — the 36px lit avatar on a timeline
 *      row and the "in Shop floor · 9:12 AM" meta (§7.4). It is built with
 *      WP1's own `personLight()`, fed the voice occupancy WP1 already derived;
 *      nothing here re-derives a light (WP1 handover, "two things WP2–WP6 must
 *      not do").
 *   2. **A DM as a text room** (§7.6) — a DM has no guild, so it never appears
 *      in a `BuildingLight`. It is lit by WP1's `textRoomLight()` with exactly
 *      the same inputs a guild text room gets, so "reading" means the same
 *      thing in a DM as it does in `#build-log`, term for term.
 *
 * Plus the one client-side event the timeline shows: a voice room in this
 * building **lighting up while you are reading** ("Shop floor lit up · Mara,
 * Priya and Ren are in there now"). It is a transition in WP1's room light,
 * never a server message.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { getAccountChannelView } from '../../lib/channelView';
import { usePresenceStore } from '../../stores/presenceStore';
import { useTypingStore } from '../../stores/typingStore';
import { useCurrentMessageStore } from '../../hooks/useMessageStore';
import {
  useLightClock,
  useRoomLights,
  useWindowIsVisible,
  type HereNow,
} from '../../hooks/useLights';
import {
  countLightsOn,
  hereNowCaption,
  nameList,
  personLight,
  textRoomLight,
  type PersonLight,
  type RoomLight,
} from '../../lib/attention/light';
import { accountScopeKey, type AccountScope } from '../../lib/serverScope';
import { displayName } from '../../lib/displayName';
import { dmTitleFor } from '../../lib/dmTitle';
import type { Channel, Message, User } from '../../types';

const NO_TYPING: string[] = [];
const NO_MESSAGES: Message[] = [];
const NO_EVENTS: RoomLitEvent[] = [];
const NO_PEOPLE: PersonLight[] = [];

/** A room that lit up while you were reading stays in the timeline this long. */
export const ROOM_EVENT_TTL_MS = 10 * 60_000;

/** How many rooms-lit-up events the timeline will carry at once. */
export const MAX_ROOM_EVENTS = 2;

/* ---------------------------------------------------------------------------
 * 1. An author, as light
 * ------------------------------------------------------------------------- */

/** The minimum a timeline row knows about whoever wrote it. */
export interface MessageAuthorRef {
  id: string;
  name: string;
  avatar?: string | null;
}

/** Turn one message author into the light the row draws. */
export type AuthorLightResolver = (author: MessageAuthorRef) => PersonLight;

interface VoicePresence {
  roomName: string;
  speaking: boolean;
}

/**
 * Who in this building is in a voice room right now, by user id.
 *
 * Read straight off WP1's `RoomLight.occupants`, which is exact — the gateway
 * sends every `VOICE_STATE_UPDATE`, so "in Shop floor" on a message is never a
 * guess.
 */
function voicePresenceByUser(rooms: readonly RoomLight[]): Map<string, VoicePresence> {
  const byUser = new Map<string, VoicePresence>();
  for (const room of rooms) {
    if (room.kind !== 'voice' || !room.lit) continue;
    for (const occupant of room.occupants) {
      byUser.set(occupant.person.userId, {
        roomName: room.name,
        speaking: occupant.speaking,
      });
    }
  }
  return byUser;
}

/**
 * A resolver from a message author to their light (§1.5, §7.4).
 *
 * `serverId` scopes the presence lookup: user ids are per-server snowflakes, so
 * a presence read without its owning server can light the wrong person.
 */
export function useAuthorLights(
  guildId: string | null | undefined,
  serverId: string | null | undefined,
): AuthorLightResolver {
  const rooms = useRoomLights(guildId);
  // Subscribed for invalidation only; the per-user read goes through the
  // store's own index (scanning the whole map per row is what made the old
  // member list O(rows × presences)).
  const presences = usePresenceStore((state) => state.presences);
  const inVoice = useMemo(() => voicePresenceByUser(rooms), [rooms]);

  return useMemo(() => {
    void presences;
    const getPresence = usePresenceStore.getState().getPresence;
    return (author: MessageAuthorRef) => {
      const voice = inVoice.get(author.id);
      return personLight({
        userId: author.id,
        name: author.name,
        status: getPresence(author.id, serverId ?? undefined)?.status,
        avatar: author.avatar ?? null,
        inRoom: Boolean(voice),
        roomName: voice?.roomName ?? null,
        speaking: voice?.speaking ?? false,
      });
    };
  }, [inVoice, presences, serverId]);
}

/* ---------------------------------------------------------------------------
 * 1b. A timeline's lights, outside the timeline's own render
 * ------------------------------------------------------------------------- */

/**
 * The lights a timeline draws, held where the timeline does not have to
 * re-render to read them.
 *
 * A building's light changes whenever anybody in it speaks, arrives, goes
 * away or writes anywhere; the timeline used to subscribe to it directly, so
 * every one of those re-rendered every visible message. The timeline now
 * renders {@link TimelineLightSource} (which subscribes) and each row's face
 * reads its own author out of this store with {@link TimelineAuthor}: a row
 * re-renders when its author's light changes, and nothing else does.
 */
export interface TimelineLightStore {
  subscribe: (listener: () => void) => () => void;
  /** The author resolver for the timeline's building. */
  resolver: () => AuthorLightResolver | null;
  /** Voice rooms that lit up while the timeline was open. */
  events: () => RoomLitEvent[];
}

interface TimelineLightStoreImpl extends TimelineLightStore {
  stage: (resolver: AuthorLightResolver, events: RoomLitEvent[]) => void;
  notify: () => void;
}

function sameEvents(a: readonly RoomLitEvent[], b: readonly RoomLitEvent[]): boolean {
  return (
    a.length === b.length
    && a.every((event, index) => {
      const other = b[index];
      return (
        event.key === other.key
        && event.atMs === other.atMs
        && event.headline === other.headline
        && event.detail === other.detail
        && event.channelId === other.channelId
        && event.guildId === other.guildId
        && event.roomName === other.roomName
      );
    })
  );
}

export function createTimelineLightStore(): TimelineLightStore {
  let currentResolver: AuthorLightResolver | null = null;
  let currentEvents: RoomLitEvent[] = NO_EVENTS;
  let dirty = false;
  const listeners = new Set<() => void>();
  const store: TimelineLightStoreImpl = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolver: () => currentResolver,
    events: () => currentEvents,
    stage(resolver, events) {
      if (resolver !== currentResolver) {
        currentResolver = resolver;
        dirty = true;
      }
      // An unchanged list keeps its identity, so the timeline does not rebuild
      // its rows because a room light was recomputed around the same events.
      if (!sameEvents(events, currentEvents)) {
        currentEvents = events;
        dirty = true;
      }
    },
    notify() {
      if (!dirty) return;
      dirty = false;
      for (const listener of listeners) listener();
    },
  };
  return store;
}

export interface TimelineLightSourceProps {
  guildId: string | null | undefined;
  serverId: string | null | undefined;
  store: TimelineLightStore;
}

/**
 * Subscribes to the building's light on the timeline's behalf and hands it to
 * the store. Render it before any row that reads the store: it stages the
 * light during its own render, so rows rendered after it in the same pass see
 * it, and tells everybody else once it commits.
 */
export const TimelineLightSource = memo(function TimelineLightSource({
  guildId,
  serverId,
  store,
}: TimelineLightSourceProps) {
  const resolver = useAuthorLights(guildId, serverId);
  const events = useRoomLitEvents(guildId);
  const impl = store as TimelineLightStoreImpl;
  impl.stage(resolver, events);
  useLayoutEffect(() => {
    impl.notify();
  }, [impl, resolver, events]);
  return null;
});

/** Everything a row draws from a person's light, as one comparable string. */
function lightSignature(person: PersonLight): string {
  return JSON.stringify(person);
}

/** One author's light, re-rendering only when that author's light changes. */
export function useTimelineAuthorLight(store: TimelineLightStore, author: MessageAuthorRef): PersonLight {
  const { id, name, avatar = null } = author;
  const read = (): PersonLight => {
    const resolver = store.resolver();
    if (!resolver) {
      throw new Error('A timeline row read its author light before TimelineLightSource rendered.');
    }
    return resolver({ id, name, avatar });
  };
  const signature = useSyncExternalStore(store.subscribe, () => lightSignature(read()));
  // A `PersonLight` is plain data, so the signature is the light itself; the
  // object is rebuilt only when it changes.
  return useMemo(() => JSON.parse(signature) as PersonLight, [signature]);
}

export interface TimelineAuthorProps {
  store: TimelineLightStore;
  author: MessageAuthorRef;
  children: (person: PersonLight) => ReactNode;
}

/** A piece of a row that draws its author's light (the face, the meta). */
export function TimelineAuthor({ store, author, children }: TimelineAuthorProps) {
  const person = useTimelineAuthorLight(store, author);
  return children(person);
}

/* ---------------------------------------------------------------------------
 * 2. A DM is a text room
 * ------------------------------------------------------------------------- */

/**
 * A person in a DM, as the channel record carries them.
 *
 * Structural rather than `User` because `Channel.recipient(s)` is the narrower
 * shape the DM endpoints return; both satisfy this.
 */
export interface DmPerson {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_hash?: string | null;
  avatar?: string | null;
}

/**
 * What to call a DM when it is treated as a room (§7.6).
 *
 * Everybody in it except the person reading it: a conversation is never
 * addressed to its own reader.
 */
export function dmRoomName(
  channel: Channel | undefined,
  selfUserId?: string | null,
): string {
  if (!channel) return 'this conversation';
  return dmTitleFor(channel, selfUserId, 'this conversation');
}

/** The local account, for the self-viewing reading term. */
export function useSelfUser(): User | null {
  return useAuthStore((state) => state.user) ?? null;
}

/** Everyone in a DM, as light — the recipients plus you. */
function useDmPeople(channel: Channel | undefined, scope: AccountScope | null): PersonLight[] {
  const presences = usePresenceStore((state) => state.presences);
  const self = useSelfUser();
  const recipients = channel?.recipients;
  const recipient = channel?.recipient;
  return useMemo(() => {
    if (!scope) return NO_PEOPLE;
    void presences;
    const getPresence = usePresenceStore.getState().getPresence;
    const lightFor = (person: DmPerson): PersonLight =>
      personLight({
        userId: person.id,
        name: displayName(person),
        status: getPresence(person.id, scope.serverId)?.status,
        avatar: person.avatar_hash ?? person.avatar ?? null,
      });
    const others: DmPerson[] = recipients?.length ? recipients.slice() : recipient ? [recipient] : [];
    const people = others.filter((person) => person.id !== self?.id).map(lightFor);
    if (self) people.push(lightFor(self));
    return people;
  }, [presences, recipient, recipients, scope, self]);
}

/**
 * A DM or group DM as a {@link RoomLight} (§7.6).
 *
 * A DM is a text room between two people, so it is lit by the *same* function a
 * guild text room is — `textRoomLight()` — with the same three reading terms
 * (typing, recently authored, self-viewing). Nothing about "reading" is
 * redefined here; a DM simply has no building to hang off.
 */
function useDmRoomLight(
  channelId: string | undefined,
  roomName: string,
  candidates: readonly PersonLight[],
  selfUserId: string | null,
  scope: AccountScope | null,
): RoomLight | null {
  const typingUserIds = useTypingStore((state) =>
    channelId ? (state.typingByChannel[channelId] ?? NO_TYPING) : NO_TYPING,
  );
  const messages = useCurrentMessageStore((state) =>
    channelId ? (state.messages[channelId] ?? NO_MESSAGES) : NO_MESSAGES,
  );
  const selectedChannel = useChannelStore((state) => state.selectedChannel);
  const windowVisible = useWindowIsVisible();
  const nowMs = useLightClock(Boolean(channelId));

  return useMemo(() => {
    if (!channelId || !scope) return null;
    const selfIsViewing =
      Boolean(selfUserId)
      && Boolean(selectedChannel)
      && selectedChannel?.id === channelId
      && accountScopeKey(selectedChannel.scope) === accountScopeKey(scope)
      && windowVisible;

    return textRoomLight({
      scope,
      guildId: null,
      channelId,
      name: roomName,
      candidates,
      typingUserIds,
      recentAuthors: messages
        .filter((message) => Boolean(message.author?.id))
        .map((message) => ({ authorId: message.author.id, messageId: message.id })),
      selfUserId,
      selfIsViewing,
      nowMs,
    });
  }, [
    candidates,
    channelId,
    messages,
    nowMs,
    roomName,
    scope,
    selectedChannel,
    selfUserId,
    typingUserIds,
    windowVisible,
  ]);
}

/** Everything a DM header needs to draw itself (§7.6). */
export interface DmLight {
  /** The conversation as a text room, or null until the channel is known. */
  room: RoomLight | null;
  /** The strip's model — the same shape a guild room's here-now strip uses. */
  hereNow: HereNow;
  /** The other person, for a 1:1 DM. Null for a group. */
  peer: PersonLight | null;
  /** Everyone in the conversation, for the people sheet. */
  people: PersonLight[];
  isGroup: boolean;
  name: string;
}

/**
 * A DM, as light (§7.6): the same plate as a text room, so it is lit the same
 * way. A group DM is a room with more than two people in it — nothing else
 * about it differs.
 */
export function useDmLight(channelId: string | undefined, scope: AccountScope | null): DmLight {
  const channel = useChannelStore((state) =>
    scope && channelId ? getAccountChannelView(scope, state).channelsById[channelId] : undefined,
  );
  const self = useSelfUser();
  const people = useDmPeople(channel, scope);
  const name = dmRoomName(channel, self?.id ?? null);
  const room = useDmRoomLight(channelId, name, people, self?.id ?? null, scope);

  return useMemo(() => {
    const others = people.filter((person) => person.userId !== self?.id);
    const isGroup = others.length > 1;
    const readers = room?.readers.map((reader) => reader.person) ?? NO_PEOPLE;
    return {
      room,
      hereNow: {
        people: readers,
        here: readers.length,
        lightsOn: countLightsOn(people),
        caption: hereNowCaption(readers.length, countLightsOn(people)),
      },
      peer: isGroup ? null : (others[0] ?? null),
      people,
      isGroup,
      name,
    };
  }, [name, people, room, self?.id]);
}

/** Is this person one of the people the room can tell is here right now? */
export function isReading(room: RoomLight | null, userId: string | undefined): boolean {
  if (!room || !userId) return false;
  return room.readers.some((reader) => reader.person.userId === userId);
}

/**
 * "Ren · online · here now" (§7.6).
 *
 * The third clause is only added when the room can actually tell the peer is
 * here — a fresh channel-bound signal, by WP1's definition. Presence alone is
 * "online" and says so.
 */
export function peerLightSentence(peer: PersonLight, reading: boolean): string {
  const state = peer.label.toLocaleLowerCase();
  return reading ? `${peer.name} · ${state} · here now` : `${peer.name} · ${state}`;
}

/* ---------------------------------------------------------------------------
 * 3. A room lighting up, in the timeline
 * ------------------------------------------------------------------------- */

/** A voice room that lit up while you were reading this one (§7.4). */
export interface RoomLitEvent {
  key: string;
  channelId: string;
  guildId: string | null;
  roomName: string;
  /** "Shop floor is live". */
  headline: string;
  /** "Mara, Priya and Ren are in there now". */
  detail: string;
  /** When this client first saw it light up. */
  atMs: number;
}

function occupantSentence(room: RoomLight): string {
  const names = room.occupants.map((occupant) => occupant.person.name);
  if (names.length === 0) return 'nobody is in there now';
  const list = nameList(names);
  return `${list} ${names.length === 1 ? 'is' : 'are'} in there now`;
}

/**
 * The voice rooms of this building that have lit up since you opened this text
 * room, newest last, capped and aged out.
 *
 * Rooms that were **already lit** when you arrived are deliberately not events:
 * an event says "this just happened", and the sidebar already carries the
 * standing state. A room that empties again drops its event immediately, so the
 * "Join" it offers is never an invitation into a dark room.
 */
export function useRoomLitEvents(guildId: string | null | undefined): RoomLitEvent[] {
  const rooms = useRoomLights(guildId);
  const [litAtByKey, setLitAtByKey] = useState<Record<string, number>>({});
  // The baseline carries its building: switching rooms must not inherit another
  // building's events, and re-baselining in a second effect would race the
  // first one and swallow every transition.
  const observed = useRef<{ guildId: string | null; lit: Set<string> } | null>(null);

  useEffect(() => {
    const building = guildId ?? null;
    const nowLit = new Set(
      rooms.filter((room) => room.kind === 'voice' && room.lit).map((room) => room.key),
    );
    const previous = observed.current;
    observed.current = { guildId: building, lit: nowLit };
    // The first observation of a building is the baseline, not a burst of
    // events for every room that happened to be busy when you arrived.
    if (!previous || previous.guildId !== building) {
      setLitAtByKey((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }
    setLitAtByKey((current) => {
      const now = Date.now();
      let changed = false;
      const next: Record<string, number> = {};
      for (const [key, atMs] of Object.entries(current)) {
        if (nowLit.has(key)) next[key] = atMs;
        else changed = true;
      }
      for (const key of nowLit) {
        if (previous.lit.has(key) || next[key] != null) continue;
        next[key] = now;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [guildId, rooms]);

  return useMemo(() => {
    const keys = Object.keys(litAtByKey);
    if (keys.length === 0) return NO_EVENTS;
    const now = Date.now();
    const events: RoomLitEvent[] = [];
    for (const room of rooms) {
      const atMs = litAtByKey[room.key];
      if (atMs == null || !room.lit || room.youAreHere) continue;
      if (now - atMs > ROOM_EVENT_TTL_MS) continue;
      events.push({
        key: room.key,
        channelId: room.channelId,
        guildId: room.guildId,
        roomName: room.name,
        headline: `${room.name} is live`,
        detail: occupantSentence(room),
        atMs,
      });
    }
    events.sort((a, b) => a.atMs - b.atMs);
    return events.length > MAX_ROOM_EVENTS ? events.slice(-MAX_ROOM_EVENTS) : events;
  }, [litAtByKey, rooms]);
}
