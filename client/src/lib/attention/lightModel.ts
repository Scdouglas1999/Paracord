/**
 * The light vocabulary, as data (docs/lantern-stage-spec.md §0, §1.2, §1.5).
 *
 * Paracord is a building at night, and light means people. This module is the
 * single place the three models are written down:
 *
 *   - {@link RoomLight}   — one window: dark, white (talking) or amber (reading).
 *   - {@link PersonLight} — one person: lights on, dim, or off.
 *   - {@link BuildingLight} — one building: the window map, the counts, the
 *     one-sentence "Around now" summary.
 *
 * Pure types and constants only — NO store, React or DOM imports. The builders
 * live next door (`personLight.ts`, `roomLight.ts`, `buildingLight.ts`) and are
 * wired to the stores by `src/hooks/useLights.ts`.
 *
 * Two rules the types exist to enforce (§0):
 *   1. **Every glow has a source.** A `level` other than `dark` always carries
 *      the occupants or readers that caused it. There is no way to construct a
 *      lit room with nobody in it.
 *   2. **Light is never the only cue** (§9). Every model carries a `caption`
 *      string that a component must render somewhere a screen reader can reach.
 */

import type { AccountScope } from '../serverScope';

/** A room is a window: white = talking, amber = reading, dark = empty (§1.2). */
export type RoomLightLevel = 'dark' | 'white' | 'amber';

/** Voice/stage rooms carry white light; text rooms carry amber. */
export type RoomKind = 'voice' | 'text';

/** A person's lights: on (app open), dim (away / dnd), off (signed out). */
export type PersonLightLevel = 'on' | 'dim' | 'off';

/** One person, as light (§1.5). Presence is a rim, never a coloured dot. */
export interface PersonLight {
  userId: string;
  /** Visible identity — already resolved through `displayName`. */
  name: string;
  level: PersonLightLevel;
  /** Draw the lit rim. */
  lit: boolean;
  /** Matte: away, do-not-disturb or offline. */
  dim: boolean;
  /** Do not disturb: dim plus the danger slash across the rim. */
  dnd: boolean;
  /** Talking right now — the rim breathes (§5). */
  speaking: boolean;
  /** In a voice room or streaming right now. */
  live: boolean;
  /** The room they are in, when we know it ("Shop floor"). */
  roomName: string | null;
  /** Stored avatar hash, for the `<img>`; null renders initials. */
  avatar: string | null;
  /** The `pc-*` recipe class for the avatar element. */
  avatarClass: string;
  /** The DOM text equivalent (§9). Never let light be the only cue. */
  label: string;
}

/** Why we believe somebody is reading a text room. See `roomLight.ts`. */
export type ReadingReason = 'typing' | 'authored' | 'viewing';

/** Somebody present in a text room right now. */
export interface RoomReader {
  person: PersonLight;
  reason: ReadingReason;
}

/** Somebody in a voice room right now. */
export interface RoomOccupant {
  person: PersonLight;
  speaking: boolean;
  /** Self-muted or server-muted. */
  muted: boolean;
  sharingScreen: boolean;
  sharingCamera: boolean;
}

/** Why a room thumbnail is a still rather than a live frame. */
export type ThumbnailStillReason =
  /** You are not in this room, so no decoder is running for it. */
  | 'not-joined'
  /** Nobody in the room is publishing video. */
  | 'no-publisher'
  /** The platform composites video below the webview; no DOM frames exist. */
  | 'native-surface'
  /** No media engine is running at all. */
  | 'no-engine';

/**
 * What the thumbnail can show *right now* (§5 "Live thumbnail"). `live` is only
 * ever true when real frames are arriving; otherwise `reason` says why, and the
 * component draws a still plus the LIVE dot. There is no in-between and no
 * fake motion.
 */
export interface RoomThumbnailState {
  live: boolean;
  reason: ThumbnailStillReason | null;
  /** The DOM text equivalent — "LIVE · Mara is sharing a screen". */
  label: string;
}

/** One room in one building on one account. */
export interface RoomLight {
  /** `entityScopeKey(scope, channelId)` — unique across servers and accounts. */
  key: string;
  scope: AccountScope;
  guildId: string | null;
  channelId: string;
  name: string;
  kind: RoomKind;
  /**
   * The room's own position in the building, as the people who made it ordered
   * it. Equally-lit rooms keep that order rather than falling back to the
   * alphabet — a building's rooms are arranged on purpose.
   */
  order: number;
  level: RoomLightLevel;
  /** `level !== 'dark'`. */
  lit: boolean;

  // ---- voice rooms -------------------------------------------------------
  /** Everyone in the room, speakers first. Empty for a text room. */
  occupants: RoomOccupant[];
  talkingCount: number;
  /** The occupant sharing a screen, if any. */
  screenSharer: RoomOccupant | null;
  /** The occupant whose camera is the focused one, if any. */
  cameraSharer: RoomOccupant | null;
  /** How long the call has been running (ms), or null when nobody is in. */
  durationMs: number | null;
  /** The local account is in this room. */
  youAreHere: boolean;

  // ---- text rooms --------------------------------------------------------
  /** Everyone present in the room now. Empty for a voice room. */
  readers: RoomReader[];
  readingCount: number;

  /** When the room was last lit (ms), for "last lit 2 h ago". */
  lastLitMs: number | null;
  /** The DOM text equivalent — "3 talking", "5 reading", "Dark · nobody in". */
  caption: string;
  thumbnail: RoomThumbnailState;
}

/** One cell of a building's window map (§3, §8). */
export interface BuildingWindow {
  key: string;
  channelId: string;
  name: string;
  /** `on` = talking (white), `warm` = reading (amber), `dark` = empty. */
  state: 'on' | 'warm' | 'dark';
  kind: RoomKind;
  /** The DOM text equivalent for this one cell. */
  label: string;
}

/** One building (guild) on one account. */
export interface BuildingLight {
  /** `entityScopeKey(scope, guildId)`. */
  key: string;
  scope: AccountScope;
  guildId: string;
  name: string;
  icon: string | null;

  /** One window per room, voice first then text by activity. At most 2×8. */
  windows: BuildingWindow[];
  /** Rooms that did not fit in the two rows — folded into the caption. */
  overflowCount: number;

  rooms: RoomLight[];
  /** The brightest lit voice room, for the building's live thumbnail. */
  brightestRoom: RoomLight | null;

  roomsLit: number;
  talkingCount: number;
  readingCount: number;
  /** Members of this building whose lights are on. */
  lightsOn: number;
  /**
   * Everybody this building can see, lit or not — so a count across several
   * buildings can be de-duplicated rather than summed (one person in two
   * buildings is one person), and so the Around-now sentence can name somebody
   * whose lights are on while they are in no room at all.
   */
  people: PersonLight[];
  memberCount: number;

  /** Ordering key — brightest building first (§7.1, §7.5). Higher is brighter. */
  brightness: number;
  /** "2 rooms lit · 3 reading", "1 reading", "Dark · nobody in". */
  caption: string;
  /**
   * Do we actually know what is in this building? A building whose rooms and
   * members have not been fetched has no light to report, and must say so
   * rather than assert an empty map, "0 in" and "Dark · nobody in" — all three
   * of which are claims, and all three of which would be false.
   */
  rosterKnown: boolean;
}

/** The window map is one window per room, ≤ 8 per row, ≤ 2 rows (§3). */
export const WINDOWS_PER_ROW = 8;
export const WINDOW_ROWS = 2;
export const MAX_WINDOWS = WINDOWS_PER_ROW * WINDOW_ROWS;

/** A "here now" strip shows at most five faces before it counts (§8). */
export const HERE_NOW_MAX_FACES = 5;
