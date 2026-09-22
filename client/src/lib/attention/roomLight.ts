/**
 * Rooms → light (docs/lantern-stage-spec.md §1.2, §7.1, §7.3).
 *
 * A voice room is **white** when somebody is in it; a text room is **amber**
 * when somebody is reading it; both are dark otherwise. Pure — NO store or
 * React imports; `src/hooks/useLights.ts` supplies the inputs.
 *
 * ---------------------------------------------------------------------------
 * WHO IS "READING" — the exact client-side definition
 * ---------------------------------------------------------------------------
 * The server has **no "viewing channel" signal**, and WP1 does not invent one.
 * Amber light is therefore derived from signals the client already receives,
 * and it is deliberately conservative: presence alone is NEVER enough, because
 * "has the app open somewhere" is not "is in this room".
 *
 * A member `m` is reading text room `c` at time `t` when:
 *
 *   1. `m` has their lights on — presence is `online` or `streaming`
 *      (`idle`, `dnd` and `offline` can never read); AND
 *   2. at least one channel-bound signal for `m` in `c` is fresh at `t`:
 *
 *      a. **typing** — `m` appears in `typingStore.typingByChannel[c]`.
 *         The store expires an entry 8 s after the last `TYPING_START`, and the
 *         server re-emits while a composer is active, so this is a live "is in
 *         this room" signal for any member.
 *
 *      b. **authored** — `m` wrote one of the last {@link RECENT_AUTHOR_LIMIT}
 *         messages in `c`, and that message is younger than
 *         {@link READING_WINDOW_MS}. Somebody who just posted is in the room.
 *         This term only contributes for channels whose timeline this client
 *         has loaded — an unopened channel has no messages in `messageStore`,
 *         so it simply contributes nothing rather than guessing.
 *
 *      c. **viewing (self only)** — `m` is the local account, this client has
 *         `c` selected, and the window is visible (`document.visibilityState`).
 *         Only the local client can know this about itself; there is no
 *         equivalent for anybody else, and none is faked.
 *
 * Consequences, stated plainly so no surface over-claims:
 *   - A silent lurker who has the channel open is **not** counted (nobody can
 *     see them). The count is "people the room can tell are here", not
 *     "people looking at it".
 *   - The count is a floor, never an overestimate. That is the right direction
 *     for a signal that means "say something to these people".
 *   - If the server ever gains a real channel-presence event, it becomes term
 *     (d) and every caller of this module improves at once.
 */

import { entityScopeKey, type AccountScope } from '../serverScope';
import { snowflakeToMs } from './conversationModel';
import {
  darkRoomCaption,
  quietTextCaption,
  readingCaption,
  talkingCaption,
} from './lightCaptions';
import type {
  PersonLight,
  ReadingReason,
  RoomLight,
  RoomOccupant,
  RoomReader,
  RoomThumbnailState,
} from './lightModel';

/** An author counts as reading for five minutes after their message. */
export const READING_WINDOW_MS = 5 * 60_000;

/** Only the tail of a timeline is scanned for recent authors. */
export const RECENT_AUTHOR_LIMIT = 40;

/** A message, reduced to what the reading derivation needs. */
export interface RecentAuthorSample {
  authorId: string;
  /** Message snowflake — decoded with `snowflakeToMs`, never a wall clock. */
  messageId: string;
}

export interface TextRoomLightInput {
  scope: AccountScope;
  guildId: string | null;
  channelId: string;
  name: string;
  /** The room's position in the building (the channel's `position`). */
  order?: number;
  /** Everyone who could be in this room, already lit by `personLight`. */
  candidates: readonly PersonLight[];
  /** User ids currently typing in this channel (`typingStore`). */
  typingUserIds?: readonly string[];
  /** The tail of the loaded timeline, newest last. */
  recentAuthors?: readonly RecentAuthorSample[];
  /** The local account's user id, for the self-viewing term. */
  selfUserId?: string | null;
  /** This client has the channel selected AND the window is visible. */
  selfIsViewing?: boolean;
  /** When the room was last amber. */
  lastLitMs?: number | null;
  nowMs: number;
}

/** Reason ranking — the strongest observed signal is the one reported. */
const REASON_RANK: Record<ReadingReason, number> = { typing: 3, viewing: 2, authored: 1 };

/**
 * Who is reading `c` right now, by the definition at the top of this file.
 * Ordered by signal strength then by name so the avatar stack is stable.
 */
export function readersOf(input: TextRoomLightInput): RoomReader[] {
  const byId = new Map<string, PersonLight>();
  for (const person of input.candidates) byId.set(person.userId, person);

  const reasons = new Map<string, ReadingReason>();
  const claim = (userId: string, reason: ReadingReason) => {
    const person = byId.get(userId);
    // Rule 1: lights on, always. A dim or absent person can never read.
    if (!person || person.level !== 'on') return;
    const existing = reasons.get(userId);
    if (!existing || REASON_RANK[reason] > REASON_RANK[existing]) reasons.set(userId, reason);
  };

  for (const userId of input.typingUserIds ?? []) claim(userId, 'typing');

  const authors = input.recentAuthors ?? [];
  const tail = authors.slice(-RECENT_AUTHOR_LIMIT);
  for (const sample of tail) {
    const postedAt = safeSnowflakeMs(sample.messageId);
    if (postedAt == null) continue;
    const age = input.nowMs - postedAt;
    if (age < 0 || age > READING_WINDOW_MS) continue;
    claim(sample.authorId, 'authored');
  }

  if (input.selfIsViewing && input.selfUserId) claim(input.selfUserId, 'viewing');

  const readers: RoomReader[] = [];
  for (const [userId, reason] of reasons) {
    const person = byId.get(userId);
    if (person) readers.push({ person, reason });
  }
  readers.sort(
    (a, b) =>
      REASON_RANK[b.reason] - REASON_RANK[a.reason] ||
      a.person.name.localeCompare(b.person.name),
  );
  return readers;
}

/** A text room's light. Amber when somebody is reading, dark otherwise. */
export function textRoomLight(input: TextRoomLightInput): RoomLight {
  const readers = readersOf(input);
  const lit = readers.length > 0;
  return {
    key: entityScopeKey(input.scope, input.channelId),
    scope: input.scope,
    guildId: input.guildId,
    channelId: input.channelId,
    name: input.name,
    kind: 'text',
    order: input.order ?? 0,
    level: lit ? 'amber' : 'dark',
    lit,
    occupants: [],
    talkingCount: 0,
    screenSharer: null,
    cameraSharer: null,
    durationMs: null,
    youAreHere: Boolean(input.selfIsViewing),
    readers,
    readingCount: readers.length,
    lastLitMs: lit ? input.nowMs : (input.lastLitMs ?? null),
    caption: lit ? readingCaption(readers.length) : quietTextCaption(),
    thumbnail: { live: false, reason: 'no-publisher', label: quietTextCaption() },
  };
}

/** One person in a voice room, from the gateway's voice state. */
export interface VoiceOccupantInput {
  person: PersonLight;
  speaking?: boolean;
  muted?: boolean;
  sharingScreen?: boolean;
  sharingCamera?: boolean;
}

export interface VoiceRoomLightInput {
  scope: AccountScope;
  guildId: string | null;
  channelId: string;
  name: string;
  /** The room's position in the building (the channel's `position`). */
  order?: number;
  occupants: readonly VoiceOccupantInput[];
  /** The local account's user id. */
  selfUserId?: string | null;
  /** When this call started (ms) — `null` until the client has observed it. */
  startedAtMs?: number | null;
  lastLitMs?: number | null;
  /** What the frame tap can deliver for this room right now. */
  thumbnail?: RoomThumbnailState;
  nowMs: number;
}

/**
 * A voice room's light. White whenever somebody is in it — voice occupancy is
 * exact (the gateway sends every `VOICE_STATE_UPDATE`), so nothing here is an
 * approximation.
 */
export function voiceRoomLight(input: VoiceRoomLightInput): RoomLight {
  const occupants: RoomOccupant[] = input.occupants.map((entry) => ({
    person: entry.person,
    speaking: Boolean(entry.speaking),
    muted: Boolean(entry.muted),
    sharingScreen: Boolean(entry.sharingScreen),
    sharingCamera: Boolean(entry.sharingCamera),
  }));
  // Speakers first, then sharers, then by name — the avatar stack must not
  // reshuffle on every tick.
  occupants.sort(
    (a, b) =>
      Number(b.speaking) - Number(a.speaking) ||
      Number(b.sharingScreen) - Number(a.sharingScreen) ||
      a.person.name.localeCompare(b.person.name),
  );

  const lit = occupants.length > 0;
  const talkingCount = occupants.filter((o) => o.speaking).length;
  const screenSharer = occupants.find((o) => o.sharingScreen) ?? null;
  const cameraSharer = occupants.find((o) => o.sharingCamera) ?? null;
  const youAreHere = Boolean(
    input.selfUserId && occupants.some((o) => o.person.userId === input.selfUserId),
  );
  const durationMs =
    lit && input.startedAtMs != null ? Math.max(0, input.nowMs - input.startedAtMs) : null;

  return {
    key: entityScopeKey(input.scope, input.channelId),
    scope: input.scope,
    guildId: input.guildId,
    channelId: input.channelId,
    name: input.name,
    kind: 'voice',
    order: input.order ?? 0,
    level: lit ? 'white' : 'dark',
    lit,
    occupants,
    talkingCount,
    screenSharer,
    cameraSharer,
    durationMs,
    youAreHere,
    readers: [],
    readingCount: 0,
    lastLitMs: lit ? input.nowMs : (input.lastLitMs ?? null),
    caption: voiceRoomCaption(occupants.length, talkingCount, youAreHere),
    thumbnail:
      input.thumbnail ??
      ({
        live: false,
        reason: lit ? 'not-joined' : 'no-publisher',
        label: lit ? liveLabel(screenSharer, cameraSharer) : darkRoomCaption('row'),
      } satisfies RoomThumbnailState),
  };
}

/** "you're here" · "3 talking" · "2 in" · "Empty" (§7.1). */
export function voiceRoomCaption(
  occupantCount: number,
  talkingCount: number,
  youAreHere: boolean,
): string {
  if (occupantCount === 0) return darkRoomCaption('row');
  if (youAreHere) return "you're here";
  if (talkingCount > 0) return talkingCaption(talkingCount);
  return occupantCount === 1 ? '1 in' : `${occupantCount} in`;
}

/** "LIVE · Mara is sharing a screen" (§7.3) / "LIVE · sharing" (§7.1). */
export function liveLabel(
  screenSharer: RoomOccupant | null,
  cameraSharer: RoomOccupant | null,
): string {
  if (screenSharer) return `LIVE · ${screenSharer.person.name} is sharing a screen`;
  if (cameraSharer) return `LIVE · ${cameraSharer.person.name} is on camera`;
  return 'LIVE';
}

/** A snowflake that is not a snowflake must not throw inside a selector. */
function safeSnowflakeMs(id: string): number | null {
  if (!/^\d{1,19}$/.test(id)) return null;
  try {
    return snowflakeToMs(id);
  } catch {
    return null;
  }
}
