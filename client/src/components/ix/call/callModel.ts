/**
 * The Index call view as data (docs/index-spec.md §7.2, §7.3).
 *
 * Pure rules and plain types: what is in focus (a stream, somebody's camera, or
 * nobody: the people grid), how the grid is laid out, which people get a tile
 * and who sits in the "N listening" row, which set of controls the row shows,
 * and the geometry of a focused picture above the filmstrip. Nothing here reads
 * a store or renders: `CallView.tsx` feeds it from `useStageData` (the Glass
 * stage's model, reused as is) and draws what it returns.
 */

import type { StageModel, StagePerson } from '../../glass/stage/stageModel';

/* ---- Focus ------------------------------------------------------------------ */

/**
 * What fills the content area. `stream`: the stage target names a streamer
 * (Watch, a sharer's tile, or the view focusing a share on its own). `camera`:
 * somebody's camera, clicked in the grid or the filmstrip. `grid`: nobody, the
 * people grid.
 */
export type CallFocus =
  | { kind: 'grid' }
  | { kind: 'stream'; userId: string }
  | { kind: 'camera'; userId: string };

export function focusOf(
  streamerId: string | null,
  cameraFocus: string | null,
  people: readonly StagePerson[],
): CallFocus {
  if (streamerId !== null) return { kind: 'stream', userId: streamerId };
  if (cameraFocus !== null && people.some((person) => person.userId === cameraFocus && person.camera)) {
    return { kind: 'camera', userId: cameraFocus };
  }
  return { kind: 'grid' };
}

/**
 * The stream the view focuses on its own (§7.2 "A stream in focus: someone
 * shares"): somebody else's share, the earliest started, unless the person
 * put that one away ("Show everyone") during this view. Your own share is
 * never focused for you; your tile opens its preview.
 */
export function autoFocusStream(people: readonly StagePerson[], dismissed: ReadonlySet<string>): string | null {
  let best: StagePerson | null = null;
  for (const person of people) {
    if (!person.sharing || person.self || person.listening || dismissed.has(person.userId)) continue;
    if (!best || (person.streamStartedAt ?? Infinity) < (best.streamStartedAt ?? Infinity)) best = person;
  }
  return best?.userId ?? null;
}

/* ---- People ----------------------------------------------------------------- */

export interface CallPeople {
  /** Everyone with a tile: joined, and allowed to speak in a stage channel. */
  tiles: StagePerson[];
  /** Listening in, or a stage channel's audience: one row of faces, "12 listening". */
  listening: StagePerson[];
  /** Anyone in `tiles` has a camera on: tiles are 16:9 (§7.2). */
  anyCamera: boolean;
}

/**
 * Who gets a tile, in the order people joined (`joinedAt`: ms from each voice
 * state's `joined_at`, index-spec §11). The voice store re-appends a person on
 * every state change, so the order never comes from its list; somebody with no
 * `joined_at` keeps their place after those with one. `audience` is the set of
 * user ids a stage channel holds as its audience (their voice state is
 * suppressed); empty elsewhere.
 */
export function callPeople(
  model: Pick<StageModel, 'cameras' | 'chips'>,
  audience: ReadonlySet<string>,
  joinedAt: ReadonlyMap<string, number>,
): CallPeople {
  const everyone = [...model.cameras, ...model.chips].map((person, index) => ({ person, index }));
  const at = (person: StagePerson) => joinedAt.get(person.userId) ?? Infinity;
  everyone.sort((a, b) => {
    const diff = at(a.person) - at(b.person);
    if (diff !== 0 && Number.isFinite(diff)) return diff;
    if (at(a.person) !== at(b.person)) return at(a.person) === Infinity ? 1 : -1;
    return a.person.userId < b.person.userId ? -1 : a.person.userId > b.person.userId ? 1 : a.index - b.index;
  });
  const ordered = everyone.map(({ person }) => person);
  const tiles = ordered.filter((person) => !person.listening && !audience.has(person.userId));
  const listening = ordered.filter((person) => person.listening || audience.has(person.userId));
  return { tiles, listening, anyCamera: tiles.some((person) => person.camera) };
}

/** "12 listening", "1 listening". */
export function listeningLabel(count: number): string {
  return `${count} listening`;
}

/* ---- The grid --------------------------------------------------------------- */

/** Columns of the people grid: 2, 3 above 4 people, 4 above 9 (§7.2). */
export function gridColumns(count: number): number {
  if (count > 9) return 4;
  if (count > 4) return 3;
  return 2;
}

export interface GridLayout {
  columns: number;
  rows: number;
  /** A tile's size; null leaves the tiles to fill their cells (tall tiles, no camera). */
  tile: { width: number; height: number } | null;
}

export const GRID_GAP = 12;

/**
 * The grid in an area of `width` x `height`. With a camera on, every tile is
 * 16:9 at the largest size whose rows fit the height; without one the tiles
 * fill their cells, tall, as the prototype draws them.
 */
export function gridLayout(count: number, anyCamera: boolean, width: number, height: number): GridLayout {
  const columns = gridColumns(Math.max(1, count));
  const rows = Math.max(1, Math.ceil(count / columns));
  if (!anyCamera || !(width > 0) || !(height > 0)) return { columns, rows, tile: null };
  const byWidth = (width - (columns - 1) * GRID_GAP) / columns;
  const byHeight = ((height - (rows - 1) * GRID_GAP) / rows) * (16 / 9);
  const tileWidth = Math.max(0, Math.floor(Math.min(byWidth, byHeight)));
  return { columns, rows, tile: { width: tileWidth, height: Math.round((tileWidth * 9) / 16) } };
}

/* ---- Focus geometry --------------------------------------------------------- */

/** The filmstrip under a focused picture (§7.2), and the gap above it. */
export const FILMSTRIP_H = 112;
export const FILMSTRIP_GAP = 12;

/**
 * The focused picture: 16:9, as large as the area allows above the filmstrip.
 * `filmstrip` false when nobody else is left to show under it.
 */
export function focusBox(width: number, height: number, filmstrip: boolean): { width: number; height: number } {
  const room = Math.max(0, height - (filmstrip ? FILMSTRIP_H + FILMSTRIP_GAP : 0));
  const byWidth = Math.max(0, width);
  const w = Math.floor(Math.min(byWidth, (room * 16) / 9));
  return { width: w, height: Math.round((w * 9) / 16) };
}

/* ---- Controls --------------------------------------------------------------- */

/**
 * Which controls the row shows (§7.2):
 *   joined     mic, camera, screen, [Clip], More, Leave
 *   audience   Request to speak, [Clip], More, Leave (a stage channel, not invited to speak)
 *   watching   [Clip], Join (not in the call: watching a stream, or joining)
 */
export type ControlSet = 'joined' | 'audience' | 'watching';

export function controlSet(model: Pick<StageModel, 'controls' | 'audience'>): ControlSet {
  if (model.controls !== 'joined') return 'watching';
  return model.audience ? 'audience' : 'joined';
}

/* ---- Words ------------------------------------------------------------------ */

/** The view's region name (index-spec §10): "Call: General". */
export function callRegionLabel(model: Pick<StageModel, 'channelName'>): string {
  return `Call: ${model.channelName}`;
}

/** The header's amber second line: the server, or "Direct call". */
export function callPlaceLine(model: Pick<StageModel, 'dm' | 'guildName'>): string {
  return model.dm ? 'Direct call' : model.guildName ?? '';
}

/** Whether a click on a person's tile focuses something, and what. */
export function tileFocus(person: StagePerson): 'stream' | 'camera' | null {
  if (person.sharing && !person.listening) return 'stream';
  if (person.camera) return 'camera';
  return null;
}
