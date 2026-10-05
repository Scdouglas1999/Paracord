/**
 * A call's people as data, shared by the room card (`components/ix/card`) and the
 * call view's model (`components/glass/stage/stageModel.ts`).
 *
 * Pure functions and plain types: what each person in a voice channel is doing
 * (talking, sharing, muted, listening in), in what order they are listed, and
 * what the call this client holds looks like to the card. Nothing here reads a
 * store or renders, so every rule below is unit-tested without React.
 *
 * "Live" means somebody has actually joined. People who are only listening in
 * never make a channel live: nobody is talking to them.
 */

import type { VoiceMode, VoiceState } from '../../../types';
import { displayName } from '../../../lib/displayName';
import type { AccountScope } from '../../../lib/serverScope';

/** The sentinel `voiceStore` uses for a DM call's guild. */
export const DM_GUILD = 'dm';

/* ---- Inputs ----------------------------------------------------------------- */

/** What the card needs to know about a channel. */
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

/* ---- Names and states ------------------------------------------------------- */

/** When a stream began (ms since epoch), or null when the server did not say. */
function streamStartedAt(state: Pick<VoiceState, 'self_stream' | 'self_stream_started_at'>): number | null {
  if (!state.self_stream || !state.self_stream_started_at) return null;
  const at = Date.parse(state.self_stream_started_at);
  return Number.isFinite(at) ? at : null;
}

export function occupantOf(
  state: VoiceState,
  input: { selfUserId: string | null; people?: ReadonlyMap<string, { name: string; avatar: string | null }> },
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
