/**
 * The stage as data (docs/glass-spec.md §6, §6.1).
 *
 * Pure functions and plain types: who is in the channel being watched and what
 * each person is doing, who gets a camera tile and who a chip, what the stream's
 * overlay says, which control set the row shows, and how the pane's height is
 * shared between the stream and the people row. Nothing here reads a store or
 * renders; `useStageData.ts` feeds it and the components draw what it returns.
 *
 * WHO GOES WHERE (§6.1):
 *   - a camera tile for everyone who joined with their camera on (equal widths);
 *   - a 200x52 chip, in a column at the end of the row, for everyone else in the
 *     channel: joined without a camera, listening in, and you.
 *   Others come first in the server's order, then you, the way the reference
 *   draws it ("Nick", then "You").
 *
 * The person being watched is kept even after they leave the channel, so the
 * overlay can still say whose stream this was ("Vincent stopped sharing").
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
}

export interface StageModel {
  /** "Game Night Lounge": the server and the channel, always both (screens/04). */
  place: string;
  channelName: string;
  guildName: string | null;
  /** The person being watched, as the channel knows them now; null once they left. */
  streamer: StagePerson | null;
  /** Their name for the sentences ("Vincent"); "You" for your own screen. */
  streamerName: string;
  /** "Vincent's screen". */
  label: string;
  /** Whether the server still says they are sharing. */
  streamerSharing: boolean;
  /** Whole minutes live, from `self_stream_started_at`; null when the server did not say. */
  liveMinutes: number | null;
  /** "Game Night Lounge, live for 42 min". */
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

export function buildStageModel(input: StageInput): StageModel {
  const { target } = input;
  const everyone = orderOccupants(input.states.map((state) => toStagePerson(state, input))) as StagePerson[];
  const others = everyone.filter((person) => !person.self);
  const self = everyone.filter((person) => person.self);
  const ordered = [...others, ...self];

  const streamerState = input.states.find((state) => state.user_id === target.streamerId) ?? null;
  const streamer = ordered.find((person) => person.userId === target.streamerId) ?? null;
  const knownName = input.people?.get(target.streamerId)?.name;
  const streamerName = streamer?.name ?? knownName ?? 'Someone';
  const isSelf = target.streamerId === input.selfUserId;
  const label = isSelf ? 'Your screen' : `${streamerName}'s screen`;
  const streamerSharing = Boolean(streamerState?.self_stream) && streamerState?.mode !== 'listen';

  const channelName = input.channelName?.trim() || 'Voice channel';
  const place = input.guildName?.trim() ? `${input.guildName.trim()} ${channelName}` : channelName;
  const liveMinutes = streamerSharing ? minutesSince(streamerState?.self_stream_started_at, input.nowMs) : null;
  const subtitle = liveMinutes === null ? place : `${place}, ${liveFor(liveMinutes)}`;

  const cameras = ordered.filter((person) => person.camera);
  const chips = ordered.filter((person) => !person.camera);
  const otherSharers = ordered.filter((person) => person.sharing && !person.self && person.userId !== target.streamerId);

  const listening = input.relation === 'listening' || (input.relation === 'joining' && input.joiningMode === 'listen');
  return {
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

export type WatchPhase = 'starting' | 'connecting' | 'live' | 'paused' | 'blocked' | 'ended' | 'failed';

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
    case 'paused':
      return { text: 'Paused while the window is hidden.', retry: false, pending: true };
    case 'blocked':
      return { text: 'Another view on this account is holding the stream.', retry: true, pending: false };
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

/* ---- Geometry ----------------------------------------------------------------- */

/** §6.1 and the prototype's side-by-side numbers (GlassV14Side.dc.html). */
export const STAGE_INSET = 12;
export const STAGE_GAP = 12;
export const STAGE_CONTROLS_H = 64;
/** The smallest people row that still reads as faces and names. */
export const STAGE_ROW_MIN = 120;
export const STAGE_CHIP_H = 52;
export const STAGE_CHIP_GAP = 8;

export interface StageGeometry {
  /** The stream box: 16:9, as wide as the pane allows (minus 24), shrunk only when the height is short. */
  streamW: number;
  streamH: number;
  /** The people row under it (0 when nobody is in the row). */
  rowH: number;
}

/**
 * Share the pane between the stream, the people row and the controls. The
 * stream takes the full width minus 24 at 16:9 whenever the height allows (at
 * 972x868 that is 948x533 and a 223px row, the reference); a short window
 * shrinks the stream, never the row below its minimum.
 */
export function stageGeometry(args: { width: number; height: number; cameras: number; chips: number }): StageGeometry {
  const innerW = Math.max(0, args.width - 2 * STAGE_INSET);
  const hasRow = args.cameras > 0 || args.chips > 0;
  const chipColumn = args.chips > 0 ? args.chips * STAGE_CHIP_H + (args.chips - 1) * STAGE_CHIP_GAP : 0;
  const rowMin = !hasRow ? 0 : args.cameras > 0 ? STAGE_ROW_MIN : Math.min(chipColumn, STAGE_ROW_MIN);
  const avail = Math.max(
    0,
    args.height - 2 * STAGE_INSET - STAGE_CONTROLS_H - STAGE_GAP - (hasRow ? STAGE_GAP : 0),
  );
  const byWidth = Math.round((innerW * 9) / 16);
  const streamH = Math.max(0, Math.min(byWidth, avail - rowMin));
  const streamW = streamH === byWidth ? innerW : Math.round((streamH * 16) / 9);
  return { streamW, streamH, rowH: hasRow ? Math.max(0, avail - streamH) : 0 };
}

/**
 * How much of the control row fits (§5's "give up in order", applied to the
 * stage): 0 everything; 1 Clip keeps its glyph and loses its label; 2 flame and
 * heart move into More. Measured against the pane's inner width.
 */
export type ControlsFit = 0 | 1 | 2;

export function controlsFit(innerWidth: number, controls: 'joined' | 'not-joined'): ControlsFit {
  // Widths of the full rows at 44px buttons, 10px gaps (the prototype's).
  const full = controls === 'joined' ? 640 : 420;
  if (!(innerWidth > 0) || innerWidth >= full) return 0;
  if (innerWidth >= full - 48) return 1;
  return 2;
}
