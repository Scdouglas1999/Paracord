/**
 * The call pill as data (docs/glass-spec.md §5, §7, §8).
 *
 * Pure functions and plain types: which live voice channel the pill shows, who
 * is in it and what each person is doing, what the pill says about it, and how
 * much of itself it can afford to draw. Nothing here reads a store or renders;
 * `useCallPill.ts` feeds it and the components draw what it returns, so every
 * rule below is unit-tested without React.
 *
 * WHICH CHANNEL THE PILL SHOWS (first that applies):
 *
 *   1. **The call you hold**, anywhere (joining, listening or joined). Named
 *      with its server when it is not the one you are reading ("Game Night
 *      Lounge"). A DM call is named for the person.
 *   2. **This server's busiest live voice channel.**
 *   3. **A live voice channel in another server**, named with its server
 *      (screens/02: reading Basecamp while Game Night's Lounge is live).
 *   4. Nothing: the pill is not drawn.
 *
 * "Live" means somebody has actually joined. People who are only listening in
 * never make a channel live: nobody is talking to them.
 *
 * "Busiest": a channel somebody else is streaming in comes first, then the one
 * with the most people, then the one with the most talking, then the server's
 * own channel order. The stream is chosen the way the room light chooses it
 * (`lib/room/sources.ts`: the earliest one started, never your own), so the
 * pill's preview and the room's ambient view draw the same stream.
 */

import { ChannelType, type VoiceMode, type VoiceState } from '../../../types';
import { displayName } from '../../../lib/displayName';
import type { AccountScope } from '../../../lib/serverScope';

/** The sentinel `voiceStore` uses for a DM call's guild. */
export const DM_GUILD = 'dm';

/** Faces drawn on the compact pill before "+N". */
export const PILL_FACES = 4;

/** Faces kept when the pill is as small as it gets (faces and Join). */
export const PILL_FACES_MINIMAL = 2;

/* ---- Inputs ----------------------------------------------------------------- */

/** What the pill needs to know about a channel. */
export interface PillChannel {
  id: string;
  name: string;
  /** Null for a DM. */
  guildId: string | null;
  type: number;
  position: number;
}

/** The call this client holds, from `voiceStore`. */
export interface HeldCall {
  scope: AccountScope;
  channelId: string;
  /** The guild id, `DM_GUILD` for a DM call, or null when the call was started without one. */
  guildId: string | null;
  phase: 'joining' | 'connected' | 'reconnecting' | 'closing' | 'closed' | 'failed' | 'idle';
  mode: VoiceMode | null;
}

export interface PillInput {
  /** The account the window is showing. */
  scope: AccountScope;
  /** The route's server, null in a DM or on a page with no server. */
  routeGuildId: string | null;
  held: HeldCall | null;
  /** Voice states by channel, as `voiceStore` holds them. */
  channelParticipants: ReadonlyMap<string, readonly VoiceState[]>;
  /** Channels the pill might name, by id, in the current account. */
  channels: ReadonlyMap<string, PillChannel>;
  /** The held call's channel, when it belongs to another account than `scope`. */
  heldChannel: PillChannel | null;
  /** Server names by guild id, in the current account. */
  guildNames: ReadonlyMap<string, string>;
  /** The held call's server name, when it belongs to another account. */
  heldGuildName: string | null;
  /** What a DM call is called: the person, or the group (a DM channel has no name of its own). */
  dmTitle?: string | null;
  /**
   * Names and faces the client knows from elsewhere: the server's member roster
   * (a voice state carries a username, not the name people use), or a DM's
   * recipients (a DM voice state carries neither). Wins over the voice state.
   */
  people?: ReadonlyMap<string, { name: string; avatar: string | null }>;
  /** Who is talking in one channel (engine flags in your call, else the server's). */
  speakers: (guildId: string, channelId: string) => ReadonlySet<string>;
  selfUserId: string | null;
}

/* ---- Outputs ---------------------------------------------------------------- */

/** How this client stands to the channel. */
export type PillRelation = 'idle' | 'joining' | 'listening' | 'joined';

export interface PillOccupant {
  userId: string;
  name: string;
  avatar: string | null;
  self: boolean;
  /** "Listening in": hears the voices, sends nothing. */
  listening: boolean;
  muted: boolean;
  /** Sharing a screen. */
  sharing: boolean;
  /** When the stream began (ms), if the server said; the earliest is the one Watch is for. */
  streamStartedAt: number | null;
  talking: boolean;
}

export interface PillTarget {
  /** The instance whose API and relay carry this channel (`StageTarget.serverId`). */
  serverId: string;
  /** The guild, or `DM_GUILD`. */
  guildId: string;
  channelId: string;
  channelName: string;
  /** "Lounge", or "Game Night Lounge" from another server. */
  title: string;
  /** Not the server the window is reading. */
  crossServer: boolean;
  isDm: boolean;
  relation: PillRelation;
  /** What this client is joining or doing, for the moment it is still connecting. */
  mode: VoiceMode | null;
  /** Everyone in the channel: people who joined first, listeners after. */
  occupants: PillOccupant[];
  /** Who joined (not listeners), the faces on the compact pill. */
  faces: PillOccupant[];
  talkers: PillOccupant[];
  /** The first person other than you sharing a screen: the one Watch is for. */
  streamer: PillOccupant | null;
}

/* ---- Names and states ------------------------------------------------------- */

/** When a stream began (ms since epoch), or null when the server did not say. */
function streamStartedAt(state: Pick<VoiceState, 'self_stream' | 'self_stream_started_at'>): number | null {
  if (!state.self_stream || !state.self_stream_started_at) return null;
  const at = Date.parse(state.self_stream_started_at);
  return Number.isFinite(at) ? at : null;
}

/** The person Watch is for: somebody else's stream, the earliest one started. */
export function pickStreamer(occupants: readonly PillOccupant[]): PillOccupant | null {
  const streamers = occupants.filter((person) => person.sharing && !person.self);
  return streamers.reduce<PillOccupant | null>(
    (best, person) =>
      !best || (person.streamStartedAt ?? Infinity) < (best.streamStartedAt ?? Infinity) ? person : best,
    null,
  );
}

export function occupantOf(
  state: VoiceState,
  input: Pick<PillInput, 'selfUserId' | 'people'>,
  talking: boolean,
): PillOccupant {
  const self = state.user_id === input.selfUserId;
  const listening = state.mode === 'listen';
  const muted = Boolean(state.self_mute || state.mute);
  const known = input.people?.get(state.user_id);
  return {
    userId: state.user_id,
    name: self ? 'You' : known?.name ?? displayName(state),
    avatar: state.avatar_hash ?? known?.avatar ?? null,
    self,
    listening,
    muted,
    sharing: Boolean(state.self_stream) && !listening,
    streamStartedAt: streamStartedAt(state),
    talking: talking && !muted && !listening,
  };
}

/** Joined people in the order the server gave them, then the listeners. */
export function orderOccupants(occupants: readonly PillOccupant[]): PillOccupant[] {
  return [...occupants.filter((o) => !o.listening), ...occupants.filter((o) => o.listening)];
}

export type RosterTone = 'amber' | 'dim' | 'ink';

export interface RosterState {
  text: string;
  tone: RosterTone;
}

/**
 * What a person is doing, in one phrase (§5): "Sharing screen" and "Talking" in
 * amber, "Muted" and "Listening in" in ink-2. A person with an open microphone
 * who is neither talking nor sharing has "Mic on".
 */
export function rosterState(occupant: PillOccupant): RosterState {
  if (occupant.listening) return { text: 'Listening in', tone: 'dim' };
  if (occupant.sharing) return { text: 'Sharing screen', tone: 'amber' };
  if (occupant.talking) return { text: 'Talking', tone: 'amber' };
  if (occupant.muted) return { text: 'Muted', tone: 'dim' };
  return { text: 'Mic on', tone: occupant.self ? 'ink' : 'dim' };
}

/** A sentence for the row under the name (expanded, and the phone's first row). */
export function pillLine(target: PillTarget, selfMuted: boolean): string | null {
  if (target.relation === 'listening') return 'Listening in quietly';
  if (target.relation === 'joined' && selfMuted) return "You're muted";
  const others = target.talkers.filter((person) => !person.self);
  if (others.length === 1) return `${others[0].name} is talking`;
  if (others.length === 2) return `${others[0].name} and ${others[1].name} are talking`;
  if (others.length > 2) return `${others.length} people are talking`;
  if (target.talkers.length > 0) return "You're talking";
  if (target.streamer && !target.streamer.self) return `${target.streamer.name} is streaming`;
  return null;
}

/** "Vincent's screen": the label on the preview. */
export function streamLabel(streamer: Pick<PillOccupant, 'name' | 'self'>): string {
  return streamer.self ? 'Your screen' : `${streamer.name}'s screen`;
}

/* ---- Choosing the channel --------------------------------------------------- */

function isVoiceType(type: number): boolean {
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

const NOBODY: ReadonlySet<string> = new Set();

function buildTarget(args: {
  input: PillInput;
  serverId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  guildName: string | null;
  states: readonly VoiceState[];
  relation: PillRelation;
  mode: VoiceMode | null;
  crossServer: boolean;
}): PillTarget {
  const { input, guildId, channelId } = args;
  const speaking = input.speakers(guildId, channelId) ?? NOBODY;
  const occupants = orderOccupants(
    args.states.map((state) => occupantOf(state, input, speaking.has(state.user_id))),
  );
  const isDm = guildId === DM_GUILD;
  return {
    serverId: args.serverId,
    guildId,
    channelId,
    channelName: args.channelName,
    title: args.crossServer && args.guildName && !isDm ? `${args.guildName} ${args.channelName}` : args.channelName,
    crossServer: args.crossServer,
    isDm,
    relation: args.relation,
    mode: args.mode,
    occupants,
    faces: occupants.filter((person) => !person.listening),
    talkers: occupants.filter((person) => person.talking),
    streamer: pickStreamer(occupants),
  };
}

function relationOf(held: HeldCall): PillRelation {
  if (held.phase === 'joining') return 'joining';
  return held.mode === 'listen' ? 'listening' : 'joined';
}

/** Voice channels somebody has joined, ranked busiest first. */
export function rankLiveChannels(
  input: Pick<PillInput, 'channelParticipants' | 'channels' | 'guildNames' | 'speakers' | 'selfUserId'>,
  routeGuildId: string | null,
): Array<{ channel: PillChannel; guildId: string; states: readonly VoiceState[]; sameServer: boolean }> {
  const live: Array<{
    channel: PillChannel;
    guildId: string;
    states: readonly VoiceState[];
    sameServer: boolean;
    people: number;
    talking: number;
    streaming: boolean;
  }> = [];
  for (const [channelId, states] of input.channelParticipants) {
    const joined = states.filter((state) => state.mode !== 'listen');
    if (joined.length === 0) continue;
    const channel = input.channels.get(channelId);
    // A channel the client cannot name is not drawn: the pill never invents one.
    if (!channel || !isVoiceType(channel.type) || !channel.guildId) continue;
    if (!input.guildNames.has(channel.guildId)) continue;
    const speaking = input.speakers(channel.guildId, channelId) ?? NOBODY;
    live.push({
      channel,
      guildId: channel.guildId,
      states,
      sameServer: channel.guildId === routeGuildId,
      people: states.length,
      talking: joined.filter((state) => speaking.has(state.user_id) && !state.self_mute && !state.mute).length,
      streaming: joined.some((state) => state.self_stream && state.user_id !== input.selfUserId),
    });
  }
  return live.sort(
    (a, b) =>
      Number(b.sameServer) - Number(a.sameServer)
      || Number(b.streaming) - Number(a.streaming)
      || b.people - a.people
      || b.talking - a.talking
      || a.channel.position - b.channel.position
      || a.channel.id.localeCompare(b.channel.id, undefined, { numeric: true }),
  );
}

/** The channel the pill shows, or null when there is nothing to show. */
export function pickPillTarget(input: PillInput): PillTarget | null {
  const { held } = input;
  if (held && held.phase !== 'closed' && held.phase !== 'closing' && held.phase !== 'idle' && held.phase !== 'failed') {
    const sameAccount =
      held.scope.serverId === input.scope.serverId && held.scope.userId === input.scope.userId;
    const channel = sameAccount ? input.channels.get(held.channelId) ?? input.heldChannel : input.heldChannel;
    const isDm = held.guildId === DM_GUILD;
    // A call started without a guild id still knows which guild its channel is in.
    const guildId = held.guildId ?? channel?.guildId ?? '';
    const guildName = isDm
      ? null
      : (sameAccount ? input.guildNames.get(guildId) : null) ?? input.heldGuildName;
    const states = input.channelParticipants.get(held.channelId) ?? [];
    return buildTarget({
      input,
      serverId: held.scope.serverId,
      guildId,
      channelId: held.channelId,
      channelName: (isDm ? input.dmTitle?.trim() : null) || channel?.name?.trim() || (isDm ? 'Voice call' : 'Voice channel'),
      guildName,
      states,
      relation: relationOf(held),
      mode: held.mode,
      crossServer: !isDm && (!sameAccount || guildId !== input.routeGuildId),
    });
  }

  const [best] = rankLiveChannels(input, input.routeGuildId);
  if (!best) return null;
  return buildTarget({
    input,
    serverId: input.scope.serverId,
    guildId: best.guildId,
    channelId: best.channel.id,
    channelName: best.channel.name.trim() || 'Voice channel',
    guildName: input.guildNames.get(best.guildId) ?? null,
    states: best.states,
    relation: 'idle',
    mode: null,
    crossServer: !best.sameServer,
  });
}

/* ---- What fits -------------------------------------------------------------- */

/**
 * How much of the pill is drawn (§5: "When space is short, it gives up, in
 * order: the talking name, the Watch and Listen labels, then everything but
 * faces and Join").
 *
 *   0  everything
 *   1  no talking name (the line under the channel's name)
 *   2  Watch and Listen keep their icons and lose their labels
 *   3  faces and Join (or Leave) only
 *
 * The compact row of `screens/01` does not draw a talking name, so on the row
 * level 1 looks like level 0; the expanded pill and the phone's first row draw
 * it and give it up first.
 */
export type CollapseLevel = 0 | 1 | 2 | 3;

export const MAX_COLLAPSE: CollapseLevel = 3;

/**
 * The first level at which the pill fits: `widthAt(level)` is its natural width
 * drawn at that level, `available` the room the header gives it. An unknown
 * `available` (nothing measured yet) draws everything.
 */
export function collapseLevelFor(
  available: number,
  widthAt: (level: CollapseLevel) => number,
): CollapseLevel {
  if (!(available > 0)) return 0;
  for (const level of [0, 1, 2, 3] as const) {
    if (widthAt(level) <= available + 0.5) return level;
  }
  return MAX_COLLAPSE;
}
