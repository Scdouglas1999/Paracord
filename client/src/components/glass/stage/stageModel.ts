/**
 * The call view as data (docs/index-spec.md §7).
 *
 * Pure functions and plain types: who is in the channel being watched and what
 * each person is doing, who has a camera, what the stream's overlay says and
 * which control set applies. Nothing here reads a store or renders;
 * `useStageData.ts` feeds it and the call view (`components/ix/call`) draws what
 * it returns.
 *
 * WHO GOES WHERE: everyone who joined with their camera on has a camera tile;
 * everyone else in the channel (joined without a camera, listening in, and you)
 * is a chip. Others come first in the server's order, then you.
 *
 * The person being watched is kept even after they leave the channel, so the
 * overlay can still say whose stream this was ("Vincent stopped sharing").
 *
 * THE CALL ITSELF (`target.streamerId === null`, `view: 'call'`): nobody's
 * screen is on the stage. The people take the stage, the title is the call's
 * name and the subtitle says who is in it; the controls drop the stream's
 * (Clip). A direct message call (`target.guildId === null`) is named for the
 * people in it, and has no server.
 */

import type { VoiceMode, VoiceState } from '../../../types';
import type { StageTarget } from '../../../stores/glassStore';
import type { MediaViewEndReason } from '../../../stores/voice/viewSessions';
import {
  occupantOf,
  orderOccupants,
  rosterState,
  type PillOccupant,
  type PillRelation,
  type RosterState,
} from '../pill/model';

/* ---- People ----------------------------------------------------------------- */

export interface StagePerson extends PillOccupant {
  /** Joined with the camera on (never true for a listener). */
  camera: boolean;
}

export interface StageInput {
  target: StageTarget;
  /** Voice states in the watched channel, as `voiceStore.channelParticipants` holds them. */
  states: readonly VoiceState[];
  /** Names and faces from the server's member roster (wins over the voice state). */
  people?: ReadonlyMap<string, { name: string; avatar: string | null }>;
  /** Who is talking in the watched channel. */
  speaking: ReadonlySet<string>;
  selfUserId: string | null;
  channelName: string | null;
  guildName: string | null;
  /** How this client stands to the watched channel. */
  relation: PillRelation;
  /** The mode a call to this channel is joining in, while it connects. */
  joiningMode: VoiceMode | null;
  /** Epoch ms, for "live for 42 min". */
  nowMs: number;
  /** A stage channel (type 13): people the moderators have not invited to speak are its audience. */
  stageChannel?: boolean;
}

export interface StageModel {
  /** A stream is watched, or the call itself is on the stage (no stream). */
  view: 'stream' | 'call';
  /** A direct message call: no server, no invite, no soundboard, no screen sharing. */
  dm: boolean;
  /** "Game Night Lounge": the server and the channel, always both (screens/04). */
  place: string;
  channelName: string;
  guildName: string | null;
  /** The person being watched, as the channel knows them now; null once they left. */
  streamer: StagePerson | null;
  /** Their name for the sentences ("Vincent"); "You" for your own screen. */
  streamerName: string;
  /** "Vincent's screen"; the call's name ("Game Night Lounge", "Jeremy") for the call itself. */
  label: string;
  /** Whether the server still says they are sharing. */
  streamerSharing: boolean;
  /** Whole minutes live, from `self_stream_started_at`; null when the server did not say. */
  liveMinutes: number | null;
  /** "Game Night Lounge, live for 42 min"; for the call itself, who is in it ("3 in the call"). */
  subtitle: string;
  cameras: StagePerson[];
  chips: StagePerson[];
  /** Everyone else sharing a screen: a click on their tile or chip switches the watch. */
  otherSharers: StagePerson[];
  relation: PillRelation;
  /** Which set of controls the row shows (§6.1). */
  controls: 'joined' | 'not-joined';
  /** A join (or a listen) is connecting: the row's call buttons are busy. */
  busy: boolean;
  /** Listening in (or connecting to listen): the mute circle moves the live preference too. */
  listening: boolean;
  /** A stage channel's call. */
  stageChannel: boolean;
  /**
   * In a stage channel's call as its audience (not invited to speak): the row
   * offers "Request to speak" instead of the microphone, camera and share.
   */
  audience: boolean;
  /** Your hand is raised (a request to speak is waiting for a moderator). */
  handRaised: boolean;
}

function toStagePerson(state: VoiceState, input: StageInput): StagePerson {
  const occupant = occupantOf(state, { selfUserId: input.selfUserId, people: input.people }, input.speaking.has(state.user_id));
  return { ...occupant, camera: Boolean(state.self_video) && !occupant.listening };
}

/** "live for 42 min", "live for 1 hr 5 min", "just went live". */
export function liveFor(minutes: number): string {
  if (minutes < 1) return 'just went live';
  if (minutes < 60) return `live for ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `live for ${hours} hr` : `live for ${hours} hr ${rest} min`;
}

function minutesSince(startedAtIso: string | null | undefined, nowMs: number): number | null {
  if (!startedAtIso) return null;
  const at = Date.parse(startedAtIso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 60_000));
}

/** "3 in the call", "Just you", "Nobody is in the call": who the call itself holds. */
export function callLine(people: readonly StagePerson[]): string {
  const joined = people.filter((person) => !person.listening);
  const listeners = people.length - joined.length;
  const head =
    joined.length === 0
      ? 'Nobody is in the call'
      : joined.length === 1 && joined[0].self
        ? 'Just you'
        : `${joined.length} in the call`;
  return listeners > 0 ? `${head}, ${listeners} listening in` : head;
}

export function buildStageModel(input: StageInput): StageModel {
  const { target } = input;
  const everyone = orderOccupants(input.states.map((state) => toStagePerson(state, input))) as StagePerson[];
  const others = everyone.filter((person) => !person.self);
  const self = everyone.filter((person) => person.self);
  const ordered = [...others, ...self];
  const dm = target.guildId === null;
  const watchedId = target.streamerId;

  const channelName = input.channelName?.trim() || (dm ? 'Voice call' : 'Voice channel');
  const place = !dm && input.guildName?.trim() ? `${input.guildName.trim()} ${channelName}` : channelName;

  const streamerState = watchedId === null ? null : input.states.find((state) => state.user_id === watchedId) ?? null;
  const streamer = watchedId === null ? null : ordered.find((person) => person.userId === watchedId) ?? null;
  const knownName = watchedId === null ? undefined : input.people?.get(watchedId)?.name;
  const streamerName = watchedId === null ? '' : streamer?.name ?? knownName ?? 'Someone';
  const isSelf = watchedId !== null && watchedId === input.selfUserId;
  const label = watchedId === null ? place : isSelf ? 'Your screen' : `${streamerName}'s screen`;
  const streamerSharing = Boolean(streamerState?.self_stream) && streamerState?.mode !== 'listen';

  const liveMinutes = streamerSharing ? minutesSince(streamerState?.self_stream_started_at, input.nowMs) : null;
  const subtitle =
    watchedId === null ? callLine(ordered) : liveMinutes === null ? place : `${place}, ${liveFor(liveMinutes)}`;

  const cameras = ordered.filter((person) => person.camera);
  const chips = ordered.filter((person) => !person.camera);
  const otherSharers = ordered.filter((person) => person.sharing && !person.self && person.userId !== watchedId);

  const listening = input.relation === 'listening' || (input.relation === 'joining' && input.joiningMode === 'listen');
  const stageChannel = Boolean(input.stageChannel);
  // Until the server's voice state says you may speak, you are the audience.
  const selfState = input.selfUserId ? input.states.find((state) => state.user_id === input.selfUserId) : undefined;
  const audience = stageChannel && selfState?.suppress !== false;
  return {
    view: watchedId === null ? 'call' : 'stream',
    dm,
    place,
    channelName,
    guildName: input.guildName?.trim() || null,
    streamer,
    streamerName: isSelf ? 'You' : streamerName,
    label,
    streamerSharing,
    liveMinutes,
    subtitle,
    cameras,
    chips,
    otherSharers,
    relation: input.relation,
    controls: input.relation === 'joined' ? 'joined' : 'not-joined',
    busy: input.relation === 'joining',
    listening,
    stageChannel,
    audience,
    handRaised: audience && Boolean(selfState?.request_to_speak_at),
  };
}

/** What a chip or a tile says a person is doing (the pill's words, §5). */
export function personState(person: StagePerson): RosterState {
  return rosterState(person);
}

/** "2 watching"; nothing when the server has not counted anyone yet. */
export function watchingLabel(count: number): string | null {
  return count > 0 ? `${count} watching` : null;
}

/* ---- The watch, as the overlay tells it ------------------------------------- */

export type WatchPhase = 'starting' | 'connecting' | 'live' | 'ended' | 'failed';

export interface WatchNotice {
  /** What the stream area says instead of a picture; null while frames can show. */
  text: string | null;
  /** Offer "Watch again" (the store never retries by itself). */
  retry: boolean;
  /** Still on its way: a quiet notice, not a failure. */
  pending: boolean;
}

/**
 * What the stream area says for a watch in `phase` (G6's `MediaViewState`).
 * A connecting watch is "not yet", never a failure, and it is never cleared on a
 * timer (docs/design/glass-fix-rejoin.md, Bug 2 cause 2). An ended or failed one
 * stays down with its reason until the person asks again.
 */
export function watchNotice(args: {
  phase: WatchPhase | null;
  error: string | null;
  endReason: MediaViewEndReason | null;
  streamerName: string;
  streamerSharing: boolean;
  /** At least one frame has been drawn for this watch. */
  hasPicture: boolean;
}): WatchNotice {
  const { phase, streamerName } = args;
  const whose = streamerName === 'You' ? 'your screen' : `${streamerName}'s screen`;
  if (!args.streamerSharing && phase !== 'live') {
    return { text: streamerName === 'You' ? 'You stopped sharing.' : `${streamerName} stopped sharing.`, retry: false, pending: false };
  }
  switch (phase) {
    case null:
    case 'starting':
    case 'connecting':
      return { text: `Connecting to ${whose}…`, retry: false, pending: true };
    case 'live':
      return args.hasPicture
        ? { text: null, retry: false, pending: false }
        : { text: `Waiting for ${whose}…`, retry: false, pending: true };
    case 'ended':
      if (args.endReason === 'superseded') {
        return { text: 'You started watching on another device.', retry: true, pending: false };
      }
      if (args.endReason === 'revoked') {
        return { text: args.error ?? 'You can no longer see this channel.', retry: false, pending: false };
      }
      return { text: args.error ?? `${streamerName === 'You' ? 'Your' : `${streamerName}'s`} stream ended.`, retry: true, pending: false };
    case 'failed':
      return { text: args.error ?? `Could not open ${whose}.`, retry: true, pending: false };
  }
}
