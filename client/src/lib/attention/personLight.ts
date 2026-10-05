/**
 * Presence → a person's light (docs/lantern-stage-spec.md §1.5).
 *
 * `src/lib/presence.ts` owns the status → rim mapping; this module turns that
 * plus the voice state into the {@link PersonLight} the components consume, and
 * counts "lights on" for a building and across all buildings (the "24 online" and
 * "+17 online" numbers in §7.1 and §7.3).
 *
 * Pure — NO store or React imports. `src/hooks/useLights.ts` supplies the
 * inputs from the stores.
 */

import { presenceLight, type PresenceStatus } from '../presence';
import type { PersonLight, PersonLightLevel } from './lightModel';

/** Everything the light of one person depends on. */
export interface PersonLightInput {
  userId: string;
  /** Already resolved through `displayName` — this layer never formats names. */
  name: string;
  status: PresenceStatus | null | undefined;
  avatar?: string | null;
  /** They are talking right now (voice store `speakingUsers`). */
  speaking?: boolean;
  /** They are in a voice room right now. */
  inRoom?: boolean;
  /** The room they are in, when known. */
  roomName?: string | null;
}

function levelFor(status: PresenceStatus | null | undefined): PersonLightLevel {
  switch (status) {
    case 'online':
    case 'streaming':
      return 'on';
    case 'idle':
    case 'dnd':
      return 'dim';
    default:
      return 'off';
  }
}

/**
 * Build the light for one person.
 *
 * `speaking` only survives when their lights are on and they are in a room —
 * a breathing rim asserts that somebody is talking *right now* (§0 rule 2), so
 * a stale speaking flag on an offline person must not paint one.
 */
export function personLight(input: PersonLightInput): PersonLight {
  const base = presenceLight(input.status);
  const level = levelFor(input.status);
  const inRoom = Boolean(input.inRoom);
  const speaking = Boolean(input.speaking) && level === 'on' && inRoom;
  const live = base.live || inRoom;
  const roomName = input.roomName?.trim() || null;

  let label = base.label;
  if (speaking) label = roomName ? `Speaking in ${roomName}` : 'Speaking';
  else if (inRoom && roomName) label = `In ${roomName}`;

  return {
    userId: input.userId,
    name: input.name,
    level,
    lit: base.lit,
    dim: base.dim,
    dnd: base.dnd,
    speaking,
    live,
    roomName,
    avatar: input.avatar ?? null,
    avatarClass: speaking ? 'pc-speaking' : base.avatarClass,
    label,
  };
}

