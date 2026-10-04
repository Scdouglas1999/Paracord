/**
 * The live room card as data (docs/index-spec.md §4.3, §4.4, §4.10).
 *
 * Pure functions and plain types: which room a place's card shows, who is in
 * it and in what order, what its head says, and what its accessible name is.
 * Nothing here reads a store or renders; `useCardWorld.ts` feeds it and the
 * components draw what it returns, so every rule is unit-tested without React.
 *
 * WHICH CARD A PLACE SHOWS
 *
 *   inline (under the sidebar's search field, in the place's own pane):
 *     1. The call you hold, when it belongs to this place (a server's voice or
 *        stage channel in that server; a DM or group call in People).
 *     2. Otherwise, in a server, its busiest live room: the most people
 *        (listeners do not count), ties to the earliest start, then the
 *        server's channel order. People has no busiest room.
 *   pinned (above the sidebar header, never slides, §5.4):
 *     the call you hold when it belongs to ANOTHER place (or another account),
 *     named with its server ("Fuel", or "Direct call"), and an incoming DM call
 *     (§4.10, its own model: `IncomingCallModel`).
 *
 * "Live" means somebody has actually joined. People who only listen in never
 * make a room live: nobody is talking to them.
 */

import { ChannelType, type VoiceMode, type VoiceState } from '../../../types';
import { displayName } from '../../../lib/displayName';
import type { AccountScope } from '../../../lib/serverScope';
import { DM_GUILD, occupantOf, type HeldCall, type PillChannel, type PillOccupant, type PillRelation } from '../../glass/pill/model';
import { samePlace, type Place } from '../shell/place';

export { DM_GUILD };
export type { HeldCall, PillChannel as CardChannel };

/** At most this many people rows; a bigger room shows five and "and N more". */
export const CARD_MAX_ROWS = 6;
/** Faces drawn on the "and N more" row. */
export const CARD_OVERFLOW_FACES = 5;

const MINUTE_MS = 60_000;

/* ---- Inputs ----------------------------------------------------------------- */

/** Everything the card rules read, gathered once per render by `useCardWorld`. */
export interface CardWorld {
  /** The account the window shows. */
  scope: AccountScope;
  held: HeldCall | null;
  /** Voice states by channel, as `voiceStore` holds them (current account). */
  channelParticipants: ReadonlyMap<string, readonly VoiceState[]>;
  /** Channels the card might name, by id, in the current account. */
  channels: ReadonlyMap<string, PillChannel>;
  /** The held call's channel when it belongs to another account than `scope`. */
  heldChannel: PillChannel | null;
  /** Server names by guild id (current account). */
  guildNames: ReadonlyMap<string, string>;
  /** The held call's server name when it belongs to another account. */
  heldGuildName: string | null;
  /** What a DM call is called (the person, or the group). */
  dmTitle: string | null;
  /** Names and faces the client knows (member rosters, DM recipients). */
  people: ReadonlyMap<string, { name: string; avatar: string | null }>;
  /** Who is talking in one channel (engine flags in your call, else the server's relay). */
  speakers: (guildId: string, channelId: string) => ReadonlySet<string>;
  /** Watcher counts per streamer in one channel (`voiceStore.watchers`). */
  watchers: (channelId: string) => ReadonlyMap<string, number> | undefined;
  selfUserId: string;
}

/* ---- Outputs ---------------------------------------------------------------- */

export type CardState = 'live' | 'streaming' | 'listening' | 'yours';

export interface CardPerson extends PillOccupant {
  /** The person's own name, for their monogram ("You" is only the row's words). */
  faceName: string;
  /** When this person came into the room (ms), from `voice_states.joined_at`. */
  joinedAt: number | null;
  /** How many people watch this person's stream (0 when none or not sharing). */
  watchers: number;
}

export interface RoomCardModel {
  /** `serverId:channelId`: one card per room. */
  key: string;
  serverId: string;
  /** The guild id, or `DM_GUILD`. */
  guildId: string;
  channelId: string;
  /** The room's name, or the person / group of a DM call. */
  title: string;
  /** The server line on a pinned card: the server's name, "Direct call" for a DM. Null inline. */
  serverLine: string | null;
  isDm: boolean;
  /** A stage channel: Join joins the audience, and there is no Listen. */
  stage: boolean;
  relation: PillRelation;
  mode: VoiceMode | null;
  reconnecting: boolean;
  /** In a stage channel's call as its audience (no microphone to offer). */
  audience: boolean;
  state: CardState;
  /** Everyone, in the card's stable order (§4.3). */
  people: CardPerson[];
  /** Somebody else's streams, busiest first (most watchers, then earliest started). */
  streams: CardPerson[];
  /** The stream Watch opens: the busiest. */
  watchTarget: CardPerson | null;
  talkers: CardPerson[];
  /** When the room went live (ms): the earliest `joined_at` of the people in it. */
  startedAt: number | null;
  /** This client hears the room (joined or listening): the waveform follows real levels. */
  heard: boolean;
}

/* ---- People ----------------------------------------------------------------- */

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function personOf(state: VoiceState, world: CardWorld, talking: boolean, watchers: ReadonlyMap<string, number> | undefined): CardPerson {
  const occupant = occupantOf(state, { selfUserId: world.selfUserId, people: world.people }, talking);
  return {
    ...occupant,
    faceName: occupant.self ? world.people.get(state.user_id)?.name ?? displayName(state) : occupant.name,
    joinedAt: parseTime(state.joined_at),
    watchers: occupant.sharing ? watchers?.get(state.user_id) ?? 0 : 0,
  };
}

const byJoin = (a: CardPerson, b: CardPerson) => (a.joinedAt ?? Infinity) - (b.joinedAt ?? Infinity);
const byStreamStart = (a: CardPerson, b: CardPerson) =>
  (a.streamStartedAt ?? Infinity) - (b.streamStartedAt ?? Infinity) || byJoin(a, b);

/**
 * The card's stable order (§4.3): people who share a screen first (in the
 * order they started), then everyone else in the order they joined, then the
 * people who only listen. The voice store re-appends a person on every state
 * change (a mute moves them to the end), so the order comes from `joined_at`,
 * never from the list; a state without one keeps its place after those with.
 */
export function orderPeople(people: readonly CardPerson[]): CardPerson[] {
  const indexed = people.map((person, index) => ({ person, index }));
  const stable = <T extends { person: CardPerson; index: number }>(compare: (a: CardPerson, b: CardPerson) => number) =>
    (a: T, b: T) => compare(a.person, b.person) || a.index - b.index;
  const sharing = indexed.filter(({ person }) => person.sharing && !person.listening).sort(stable(byStreamStart));
  const joined = indexed.filter(({ person }) => !person.sharing && !person.listening).sort(stable(byJoin));
  const listening = indexed.filter(({ person }) => person.listening).sort(stable(byJoin));
  return [...sharing, ...joined, ...listening].map(({ person }) => person);
}

/** Other people's streams, busiest first: the most watchers, then the earliest started. */
export function rankStreams(people: readonly CardPerson[]): CardPerson[] {
  return people
    .filter((person) => person.sharing && !person.self)
    .sort((a, b) => b.watchers - a.watchers || byStreamStart(a, b));
}

/** The room's start: the earliest `joined_at` among the people in it now (index-spec §11). */
export function roomStartedAt(states: readonly VoiceState[]): number | null {
  let earliest: number | null = null;
  for (const state of states) {
    const at = parseTime(state.joined_at);
    if (at !== null && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest;
}

/* ---- Rows ------------------------------------------------------------------- */

export interface CardOverflow {
  /** How many people the overflow row stands for. */
  count: number;
  /** Up to five of them, as faces. */
  faces: CardPerson[];
}

/**
 * At most six rows (§4.3): beyond that the sixth row reads "and N more" with up
 * to five overlapped faces of the people it stands for.
 */
export function cardRows(people: readonly CardPerson[]): { rows: CardPerson[]; overflow: CardOverflow | null } {
  if (people.length <= CARD_MAX_ROWS) return { rows: [...people], overflow: null };
  const rows = people.slice(0, CARD_MAX_ROWS - 1);
  const rest = people.slice(CARD_MAX_ROWS - 1);
  return { rows, overflow: { count: rest.length, faces: rest.slice(0, CARD_OVERFLOW_FACES) } };
}

/** The words on a person's row: "You", "Jeremy", "You — listening". */
export function rowName(person: Pick<CardPerson, 'name' | 'listening'>): string {
  return person.listening ? `${person.name} — listening` : person.name;
}

/* ---- Words ------------------------------------------------------------------ */

/** "live 34 min", "live 1 hr 5 min", or "just now" under a minute. Null start: "live". */
export function liveLabel(startedAt: number | null, now: number): string {
  if (startedAt === null) return 'live';
  const minutes = Math.max(0, Math.floor((now - startedAt) / MINUTE_MS));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `live ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `live ${hours} hr ${rest} min` : `live ${hours} hr`;
}

/** The amber words at the head's right (§4.3). */
export function headLabel(card: Pick<RoomCardModel, 'state' | 'relation' | 'reconnecting' | 'startedAt'>, now: number): string {
  if (card.reconnecting) return 'Reconnecting…';
  if (card.relation === 'joining') return card.state === 'listening' ? 'Listening' : 'Joining…';
  if (card.state === 'yours') return 'You’re in';
  if (card.state === 'listening') return 'Listening';
  return liveLabel(card.startedAt, now);
}

function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The card's accessible name (§4.3): "General, live, 3 people, Vincent talking".
 * The state words are the head's ("you're in", "listening", "live 34 min").
 */
export function cardLabel(card: RoomCardModel, now: number): string {
  const parts = [card.title];
  if (card.serverLine) parts.push(card.serverLine);
  parts.push(headLabel(card, now).toLowerCase().replace(/…$/, ''));
  const joined = card.people.filter((person) => !person.listening).length;
  parts.push(joined === 1 ? '1 person' : `${joined} people`);
  const sharing = card.people.filter((person) => person.sharing);
  if (sharing.length) parts.push(`${namesList(sharing.map((person) => person.name))} sharing ${sharing.length > 1 ? 'screens' : 'a screen'}`);
  const talking = card.talkers.map((person) => person.name);
  if (talking.length) parts.push(`${namesList(talking)} talking`);
  return parts.join(', ');
}

/* ---- Choosing the room ------------------------------------------------------ */

function isVoiceType(type: number): boolean {
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

const NOBODY: ReadonlySet<string> = new Set();

function holding(held: HeldCall | null): held is HeldCall {
  return Boolean(held && held.phase !== 'closed' && held.phase !== 'closing' && held.phase !== 'idle' && held.phase !== 'failed');
}

function relationOf(held: HeldCall): PillRelation {
  if (held.phase === 'joining') return 'joining';
  return held.mode === 'listen' ? 'listening' : 'joined';
}

function stateOf(relation: PillRelation, mode: VoiceMode | null, streams: readonly CardPerson[]): CardState {
  if (relation === 'joined' || (relation === 'joining' && mode !== 'listen')) return 'yours';
  if (relation === 'listening' || relation === 'joining') return 'listening';
  return streams.length ? 'streaming' : 'live';
}

function buildCard(args: {
  world: CardWorld;
  serverId: string;
  guildId: string;
  channelId: string;
  title: string;
  serverLine: string | null;
  states: readonly VoiceState[];
  relation: PillRelation;
  mode: VoiceMode | null;
  reconnecting?: boolean;
  stage: boolean;
}): RoomCardModel {
  const { world, guildId, channelId } = args;
  const speaking = world.speakers(guildId, channelId) ?? NOBODY;
  const watchers = world.watchers(channelId);
  const people = orderPeople(args.states.map((state) => personOf(state, world, speaking.has(state.user_id), watchers)));
  const streams = rankStreams(people);
  const isDm = guildId === DM_GUILD;
  const self = args.states.find((state) => state.user_id === world.selfUserId);
  return {
    key: `${args.serverId}:${channelId}`,
    serverId: args.serverId,
    guildId,
    channelId,
    title: args.title,
    serverLine: args.serverLine,
    isDm,
    stage: args.stage,
    relation: args.relation,
    mode: args.mode,
    reconnecting: Boolean(args.reconnecting),
    audience: args.stage && args.relation === 'joined' && self?.suppress !== false,
    state: stateOf(args.relation, args.mode, streams),
    people,
    streams,
    watchTarget: streams[0] ?? null,
    talkers: people.filter((person) => person.talking),
    startedAt: roomStartedAt(args.states),
    heard: args.relation === 'joined' || args.relation === 'listening',
  };
}

/** The place a held call belongs to: People for a DM call, its server otherwise. */
export function placeOfHeld(held: HeldCall, world: Pick<CardWorld, 'channels' | 'heldChannel'>): Place | null {
  if (held.guildId === DM_GUILD) return { kind: 'people' };
  const guildId = held.guildId ?? world.channels.get(held.channelId)?.guildId ?? world.heldChannel?.guildId ?? null;
  return guildId ? { kind: 'server', guildId } : null;
}

function sameAccount(held: HeldCall, scope: AccountScope): boolean {
  return held.scope.serverId === scope.serverId && held.scope.userId === scope.userId;
}

/** The call you hold, as a card; `pinned` adds its server line. Null when you hold none. */
export function heldCard(world: CardWorld, pinned: boolean): RoomCardModel | null {
  const { held } = world;
  if (!holding(held)) return null;
  const same = sameAccount(held, world.scope);
  const channel = same ? world.channels.get(held.channelId) ?? world.heldChannel : world.heldChannel;
  const isDm = held.guildId === DM_GUILD;
  const guildId = held.guildId ?? channel?.guildId ?? '';
  const guildName = isDm ? null : (same ? world.guildNames.get(guildId) : null) ?? world.heldGuildName;
  const title = (isDm ? world.dmTitle?.trim() : null) || channel?.name?.trim() || (isDm ? 'Direct call' : 'Voice channel');
  return buildCard({
    world,
    serverId: held.scope.serverId,
    guildId,
    channelId: held.channelId,
    title,
    serverLine: pinned ? (isDm ? 'Direct call' : guildName) : null,
    states: world.channelParticipants.get(held.channelId) ?? [],
    relation: relationOf(held),
    mode: held.mode,
    reconnecting: held.phase === 'reconnecting',
    stage: channel?.type === ChannelType.Stage,
  });
}

/** Does the call you hold belong to this place (same account, same server or People)? */
export function heldBelongsTo(world: CardWorld, place: Place): boolean {
  const { held } = world;
  if (!holding(held) || !sameAccount(held, world.scope)) return false;
  const heldPlace = placeOfHeld(held, world);
  return heldPlace !== null && samePlace(heldPlace, place);
}

/** A server's live rooms, busiest first (§4.3): most people, earliest start, channel order. */
export function rankRooms(world: Pick<CardWorld, 'channelParticipants' | 'channels'>, guildId: string): Array<{ channel: PillChannel; states: readonly VoiceState[] }> {
  const live: Array<{ channel: PillChannel; states: readonly VoiceState[]; people: number; startedAt: number }> = [];
  for (const [channelId, states] of world.channelParticipants) {
    const joined = states.filter((state) => state.mode !== 'listen');
    if (joined.length === 0) continue;
    const channel = world.channels.get(channelId);
    // A room the client cannot name is never drawn: the card does not invent one.
    if (!channel || channel.guildId !== guildId || !isVoiceType(channel.type)) continue;
    live.push({ channel, states, people: joined.length, startedAt: roomStartedAt(states) ?? Infinity });
  }
  return live
    .sort(
      (a, b) =>
        b.people - a.people
        || a.startedAt - b.startedAt
        || a.channel.position - b.channel.position
        || a.channel.id.localeCompare(b.channel.id, undefined, { numeric: true }),
    )
    .map(({ channel, states }) => ({ channel, states }));
}

/** The card under the search field of `place`'s pane, or null. */
export function inlineCard(world: CardWorld, place: Place): RoomCardModel | null {
  if (heldBelongsTo(world, place)) return heldCard(world, false);
  if (place.kind !== 'server') return null;
  const [best] = rankRooms(world, place.guildId);
  if (!best) return null;
  return buildCard({
    world,
    serverId: world.scope.serverId,
    guildId: place.guildId,
    channelId: best.channel.id,
    title: best.channel.name.trim() || 'Voice channel',
    serverLine: null,
    states: best.states,
    relation: 'idle',
    mode: null,
    stage: best.channel.type === ChannelType.Stage,
  });
}

/** The room `place`'s inline card shows (for the sidebar's Rooms list, which leaves it out). */
export function inlineCardChannelId(world: CardWorld, place: Place): string | null {
  return inlineCard(world, place)?.channelId ?? null;
}

/** Your call pinned above the header of `place` (it belongs elsewhere), or null. */
export function pinnedCard(world: CardWorld, place: Place): RoomCardModel | null {
  if (!holding(world.held) || heldBelongsTo(world, place)) return null;
  return heldCard(world, true);
}

/* ---- Incoming DM call (§4.10) ----------------------------------------------- */

export interface IncomingCallModel {
  /** `incoming:channelId`. */
  key: string;
  channelId: string;
  /** "Jeremy", or "Jeremy, Nick" for a group. */
  callerName: string;
  /** The first person calling, for the face. */
  caller: { userId: string; name: string; avatar: string | null } | null;
  participantCount: number;
}

/** "Jeremy is calling"; a group call already under way says who is in it. */
export function incomingLine(call: Pick<IncomingCallModel, 'callerName' | 'participantCount'>): string {
  return call.participantCount > 2 ? `${call.callerName} are in a call` : `${call.callerName} is calling`;
}
