/**
 * Presence → a person's light (docs/lantern-stage-spec.md §1.5).
 *
 * `src/lib/presence.ts` owns the status → rim mapping; this module turns that
 * plus the voice state into the {@link PersonLight} the components consume, and
 * counts "lights on" for a building and across all buildings (the "24 in" and
 * "+17 lights on" numbers in §7.1 and §7.3).
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

/** How many of these people have their lights on. */
export function countLightsOn(people: readonly PersonLight[]): number {
  let count = 0;
  for (const person of people) if (person.level === 'on') count += 1;
  return count;
}

/**
 * Merge the same human seen on more than one connected server into one light.
 *
 * The unified layer lists a person once per account they are visible through;
 * the brightest observation wins, because a person with the app open on any
 * connected server has their lights on. Identity is `userId` scoped by the
 * caller's own key function — user ids are per-server snowflakes, so a caller
 * merging across servers must pass a key that says who the person really is
 * (a verified account link), not the raw id.
 */
export function mergePersonLights(
  people: readonly PersonLight[],
  keyOf: (person: PersonLight) => string = (person) => person.userId,
): PersonLight[] {
  const rank: Record<PersonLightLevel, number> = { on: 2, dim: 1, off: 0 };
  const merged = new Map<string, PersonLight>();
  for (const person of people) {
    const key = keyOf(person);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, person);
      continue;
    }
    const brighter = rank[person.level] > rank[existing.level];
    // A speaking observation is strictly newer information than a silent one at
    // the same level: somebody is talking on one of the connections right now.
    const louder = rank[person.level] === rank[existing.level] && person.speaking && !existing.speaking;
    if (brighter || louder) merged.set(key, person);
  }
  return [...merged.values()];
}
