import type { SportsAthlete } from '../../api/sports';

/**
 * Field geometry for the game view.
 *
 * Football: home defends the left end zone. `ball_on` is yards from the home
 * goal line (0 = home goal line, 100 = away goal line), so x only grows to
 * the right. Offense direction is separate: the home team attacks toward 100,
 * the away team attacks toward 0.
 *
 * Baseball hits use the 250×250 Gameday square. Home plate is (125, 204) and
 * y shrinks toward the outfield. Pitch x/y share the catcher's view, y down.
 */

export const LIVE_DETAIL_MS = 10_000;
export const QUIET_DETAIL_MS = 60_000;
export const PLAY_STEP_MS = 900;

export const FIELD = {
  width: 1200,
  height: 533,
  endzone: 100,
  playLength: 1000,
} as const;

export const GAMEDAY = { size: 250, plateX: 125, plateY: 204 } as const;

/** Observed pitch window from the feed, catcher's view, y growing downward. */
export const PITCH_SPACE = { minX: 35, maxX: 195, minY: 98, maxY: 252 } as const;

export const ZONE_VIEW = { width: 220, height: 275, pad: 28 } as const;

/**
 * Called-strike bounds observed in the feed (contract: called strikes sit
 * about x 86..149, y 148..196). The server omits strike_zone when the feed
 * has none; the panel uses this box instead of drawing nothing.
 */
export const DEFAULT_STRIKE_ZONE = { left: 88, right: 147, top: 150, bottom: 195 } as const;

export const BASE_POINTS = {
  home: { x: 125, y: 204 },
  first: { x: 185, y: 145 },
  second: { x: 125, y: 78 },
  third: { x: 65, y: 145 },
} as const;

export type OffenseDirection = 1 | -1;
export type BaseName = 'first' | 'second' | 'third';
export type BaseSlot = BaseName | 'home';

const BASE_ORDER: BaseName[] = ['first', 'second', 'third'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Yards from the home goal line → SVG x. Home's goal line is on the left. */
export function yardsToFieldX(yards: number): number {
  const y = clamp(yards, 0, 100);
  return FIELD.endzone + (y / 100) * FIELD.playLength;
}

/**
 * Ball x and which way the offense is going.
 * Home possession attacks the right (away) end zone. Away possession attacks
 * the left (home) end zone. The ball's x does not flip with possession.
 */
export function fieldPoint(
  yards: number,
  possessionTeamId: string | null | undefined,
  homeId: string,
  awayId: string,
): { x: number; direction: OffenseDirection } {
  const direction: OffenseDirection = possessionTeamId === awayId && possessionTeamId !== homeId ? -1 : 1;
  return { x: yardsToFieldX(yards), direction };
}

/**
 * First-down yard line. Distance is applied along the offense direction and
 * clamped to the goal line, so goal-to-go never draws past the end zone.
 */
export function firstDownYard(
  ballOn: number,
  distance: number | null | undefined,
  direction: OffenseDirection,
): number | null {
  if (distance == null || !Number.isFinite(distance) || distance < 0) return null;
  const raw = ballOn + direction * distance;
  if (direction === 1) return Math.min(100, Math.max(0, raw));
  return Math.max(0, Math.min(100, raw));
}

/** The 20 yards in front of the goal the offense is attacking. */
export function redZoneYards(direction: OffenseDirection): { from: number; to: number } {
  return direction === 1 ? { from: 80, to: 100 } : { from: 0, to: 20 };
}

export function yardSpot(ballOn: number, homeAbbr: string, awayAbbr: string): string {
  const y = clamp(Math.round(ballOn), 0, 100);
  if (y === 50) return 'midfield';
  if (y < 50) return `the ${homeAbbr} ${y}`;
  return `the ${awayAbbr} ${100 - y}`;
}

export function playStroke(type: string | null | undefined): 'solid' | 'dashed' | 'dotted' {
  const text = (type ?? '').toLowerCase();
  if (text.includes('penal')) return 'dotted';
  if (text.includes('pass') || text.includes('sack') || text.includes('incomplete')) return 'dashed';
  return 'solid';
}

/** Hit landing in the diamond's drawing space. y shrinks toward the outfield. */
export function hitToField(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(x, 0, GAMEDAY.size),
    y: clamp(y, 0, GAMEDAY.size),
  };
}

export function hitArcLift(trajectory: string | null | undefined): number {
  const text = (trajectory ?? '').toLowerCase();
  if (text === 'popup' || text === 'p' || text === 'pu') return 78;
  if (text === 'fly' || text === 'f') return 56;
  if (text === 'line' || text === 'l') return 26;
  if (text === 'ground' || text === 'g') return 6;
  return 20;
}

/** Control point of the hit arc. A higher trajectory lifts it further above the straight line. */
export function hitArcControl(
  to: { x: number; y: number },
  trajectory: string | null | undefined,
): { x: number; y: number } {
  const from = { x: GAMEDAY.plateX, y: GAMEDAY.plateY };
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2 - hitArcLift(trajectory),
  };
}

export function strikeZoneOrDefault(
  zone: { left: number; right: number; top: number; bottom: number } | null | undefined,
): { left: number; right: number; top: number; bottom: number } {
  if (!zone) return { ...DEFAULT_STRIKE_ZONE };
  const { left, right, top, bottom } = zone;
  if (![left, right, top, bottom].every((value) => Number.isFinite(value))) return { ...DEFAULT_STRIKE_ZONE };
  if (right <= left || bottom <= top) return { ...DEFAULT_STRIKE_ZONE };
  return { left, right, top, bottom };
}

/**
 * Window drawn around a strike zone so the zone fills the panel and a gutter
 * remains on each side for the batter. Pitches outside the window still map;
 * they simply land near the edge.
 */
export function pitchFrame(zone: { left: number; right: number; top: number; bottom: number }): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const width = Math.max(8, zone.right - zone.left);
  const height = Math.max(8, zone.bottom - zone.top);
  return {
    minX: zone.left - width * 0.18,
    maxX: zone.right + width * 0.18,
    minY: zone.top - height * 0.22,
    maxY: zone.bottom + height * 0.4,
  };
}

/** A pitch inside a frame, with side gutters left open for the batter. */
export function pitchInFrame(
  x: number,
  y: number,
  frame: { minX: number; maxX: number; minY: number; maxY: number },
): { x: number; y: number } {
  const gutter = 36;
  const innerW = ZONE_VIEW.width - gutter * 2;
  const innerH = ZONE_VIEW.height - 28;
  const spanX = frame.maxX - frame.minX || 1;
  const spanY = frame.maxY - frame.minY || 1;
  // A pitch in the dirt or a foot outside is still a pitch: it is held at the
  // panel's edge, a marker's radius in, rather than drawn where nobody can see it.
  const edge = 11;
  const hold = (value: number, size: number) => Math.min(size - edge, Math.max(edge, value));
  return {
    x: hold(gutter + ((x - frame.minX) / spanX) * innerW, ZONE_VIEW.width),
    y: hold(12 + ((y - frame.minY) / spanY) * innerH, ZONE_VIEW.height),
  };
}

/** Pitch coordinate → the strike-zone panel. Larger feed y is lower on the panel. */
export function pitchToZone(x: number, y: number): { x: number; y: number } {
  const spanX = PITCH_SPACE.maxX - PITCH_SPACE.minX;
  const spanY = PITCH_SPACE.maxY - PITCH_SPACE.minY;
  const innerW = ZONE_VIEW.width - ZONE_VIEW.pad * 2;
  const innerH = ZONE_VIEW.height - ZONE_VIEW.pad * 2;
  return {
    x: ZONE_VIEW.pad + ((x - PITCH_SPACE.minX) / spanX) * innerW,
    y: ZONE_VIEW.pad + ((y - PITCH_SPACE.minY) / spanY) * innerH,
  };
}

export function pitchLabel(pitch: {
  type?: string | null;
  type_abbr?: string | null;
  velocity?: number | null;
}): string {
  const type = pitch.type?.trim() ?? '';
  const abbr = pitch.type_abbr?.trim() ?? '';
  // The display name often already ends in a short mark ("Four-seam FB") while
  // type_abbr is a different code ("FF"). Keep the display name, and use the
  // code only when the feed did not send one.
  const name = type || abbr;
  if (pitch.velocity == null || Number.isNaN(pitch.velocity)) return name || 'Pitch';
  const vel = Number.isInteger(pitch.velocity) ? String(pitch.velocity) : String(Math.round(pitch.velocity));
  return name ? `${name} ${vel} mph` : `${vel} mph`;
}

export function pitchResultLabel(result: string | null | undefined): string {
  switch (result) {
    case 'ball': return 'Ball';
    case 'strike-looking': return 'Called strike';
    case 'strike-swinging': return 'Swinging strike';
    case 'foul': return 'Foul';
    case 'in-play': return 'In play';
    default: return 'Other';
  }
}

export function pitchAnnouncement(pitch: {
  type?: string | null;
  type_abbr?: string | null;
  velocity?: number | null;
  result?: string | null;
  text?: string | null;
}): string {
  const words = pitch.text?.trim();
  if (words) return words.endsWith('.') ? words : `${words}.`;
  const result = pitchResultLabel(pitch.result);
  return `${pitchLabel(pitch)}, ${result.toLowerCase()}.`;
}

export interface Bases {
  first: SportsAthlete | null;
  second: SportsAthlete | null;
  third: SportsAthlete | null;
}

export interface RunnerChange {
  id: string;
  shortName: string;
  from: BaseName | null;
  to: BaseSlot | null;
  kind: 'advanced' | 'scored' | 'new' | 'out' | 'left' | 'stayed';
}

function baseOf(bases: Bases, id: string): BaseName | null {
  for (const name of BASE_ORDER) {
    if (bases[name]?.id === id) return name;
  }
  return null;
}

function indexOf(base: BaseName): number {
  return BASE_ORDER.indexOf(base);
}

function shortName(athlete: SportsAthlete): string {
  return athlete.short_name || athlete.name || 'Runner';
}

/**
 * What changed between two base snapshots.
 * A runner who leaves the bases is scored when the at-bat scored and the new
 * outs do not account for them. Outs are charged to the trailers. A new
 * half-inning that did not score leaves the departed runners on the bases
 * they had — they did not score, and the feed does not say they were out.
 */
export function diffRunners(
  prev: Bases,
  next: Bases,
  opts: { outsBefore: number; outsAfter: number; scoring?: boolean; inningChanged?: boolean },
): RunnerChange[] {
  const changes: RunnerChange[] = [];
  const prevIds = new Map<string, SportsAthlete>();
  const nextIds = new Map<string, SportsAthlete>();
  for (const name of BASE_ORDER) {
    const before = prev[name];
    const after = next[name];
    if (before) prevIds.set(before.id, before);
    if (after) nextIds.set(after.id, after);
  }

  for (const [id, athlete] of nextIds) {
    const from = baseOf(prev, id);
    const to = baseOf(next, id);
    if (!to) continue;
    if (!from) {
      changes.push({ id, shortName: shortName(athlete), from: null, to, kind: 'new' });
      continue;
    }
    if (from === to) {
      changes.push({ id, shortName: shortName(athlete), from, to, kind: 'stayed' });
      continue;
    }
    changes.push({ id, shortName: shortName(athlete), from, to, kind: 'advanced' });
  }

  const gone = BASE_ORDER
    .flatMap((name) => {
      const athlete = prev[name];
      if (!athlete || nextIds.has(athlete.id)) return [];
      return [{ athlete, from: name }];
    })
    .sort((a, b) => indexOf(b.from) - indexOf(a.from));

  const outsAdded = opts.outsAfter >= opts.outsBefore ? opts.outsAfter - opts.outsBefore : 0;
  if (opts.inningChanged && !opts.scoring) {
    for (const { athlete, from } of gone) {
      changes.push({ id: athlete.id, shortName: shortName(athlete), from, to: null, kind: 'left' });
    }
    return changes;
  }

  let scoredCount = Math.max(0, gone.length - outsAdded);
  if (opts.scoring && gone.length > 0 && scoredCount === 0) scoredCount = 1;
  gone.forEach((item, index) => {
    const scored = index < scoredCount;
    changes.push({
      id: item.athlete.id,
      shortName: shortName(item.athlete),
      from: item.from,
      to: scored ? 'home' : null,
      kind: scored ? 'scored' : 'out',
    });
  });
  return changes;
}

/**
 * Which final score to dim. Winner flags win when the feed sets them;
 * otherwise the lower score is the loser. A tie stays even.
 */
export function losingSide(game: {
  state: string;
  home: { winner?: boolean; score: number | null };
  away: { winner?: boolean; score: number | null };
}): 'home' | 'away' | null {
  if (game.state !== 'post') return null;
  if (game.home.winner && !game.away.winner) return 'away';
  if (game.away.winner && !game.home.winner) return 'home';
  const home = game.home.score;
  const away = game.away.score;
  if (home == null || away == null || home === away) return null;
  return home > away ? 'away' : 'home';
}

/** Home team's win probability, named. A finished game says "finished", not "is now". */
export function winProbabilityText(
  points: readonly { home_pct: number }[],
  teamName: string,
  ended = false,
): string | null {
  if (points.length === 0) return null;
  const who = teamName.trim() || 'That team';
  const first = Math.round(points[0].home_pct);
  const last = Math.round(points[points.length - 1].home_pct);
  if (points.length === 1) return `${who} win probability is ${first}%.`;
  const tail = ended ? `finished at ${last}%` : `is now ${last}%`;
  return `${who} win probability started at ${first}% and ${tail}.`;
}

/**
 * A live game follows the drive in progress (null). A finished or unstarted
 * game opens on the last scoring drive, or the last drive if nobody scored.
 */
export function openingDriveId(
  drives: readonly { id: string; is_score?: boolean }[],
  state: string,
): string | null {
  if (state === 'in' || drives.length === 0) return null;
  for (let index = drives.length - 1; index >= 0; index -= 1) {
    if (drives[index].is_score) return drives[index].id;
  }
  return drives[drives.length - 1].id;
}

export function ordinal(value: number): string {
  const mod = value % 100;
  if (mod >= 11 && mod <= 13) return `${value}th`;
  switch (value % 10) {
    case 1: return `${value}st`;
    case 2: return `${value}nd`;
    case 3: return `${value}rd`;
    default: return `${value}th`;
  }
}

/**
 * The strip above the diamond. A game that is not in progress does not invent
 * a count: null, and a finished 0-0, are absent. The status line stands in.
 */
export function baseballScorebug(opts: {
  state: string;
  detail: string;
  half: 'top' | 'bottom' | null;
  inning: number | null;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
}): string {
  if (opts.state !== 'in') {
    const detail = opts.detail.trim();
    if (detail) return detail;
    return opts.state === 'post' ? 'Final' : 'Not started';
  }
  const parts: string[] = [];
  if ((opts.half === 'top' || opts.half === 'bottom') && opts.inning != null && opts.inning > 0) {
    const half = opts.half === 'bottom' ? 'Bottom' : 'Top';
    parts.push(`${half} ${ordinal(opts.inning)}`);
  }
  if (opts.balls != null && opts.strikes != null) parts.push(`${opts.balls}-${opts.strikes}`);
  if (opts.outs != null) parts.push(opts.outs === 1 ? '1 out' : `${opts.outs} outs`);
  return parts.join(' · ');
}

export function detailInterval(state: string | undefined): number {
  return state === 'in' ? LIVE_DETAIL_MS : QUIET_DETAIL_MS;
}

export function footballFieldLabel(opts: {
  ballOn: number | null;
  downText: string | null;
  homeAbbr: string;
  awayAbbr: string;
  possessionAbbr: string | null;
  playText?: string | null;
}): string {
  const bits: string[] = [];
  if (opts.downText) bits.push(opts.downText);
  if (opts.ballOn != null) bits.push(`Ball on ${yardSpot(opts.ballOn, opts.homeAbbr, opts.awayAbbr)}`);
  if (opts.possessionAbbr) bits.push(`${opts.possessionAbbr} has the ball`);
  if (opts.playText?.trim()) bits.push(opts.playText.trim());
  return bits.join('. ');
}

export function baseballFieldLabel(opts: {
  live?: boolean;
  status?: string;
  half: 'top' | 'bottom' | null;
  inning: number | null;
  outs: number | null;
  balls: number | null;
  strikes: number | null;
  bases: Bases;
}): string {
  const runners = BASE_ORDER
    .filter((name) => opts.bases[name])
    .map((name) => `${opts.bases[name]?.short_name || 'Runner'} on ${name}`);
  const who = runners.join(', ') || 'Bases empty';
  if (opts.live === false) return [opts.status?.trim() || 'Final', who].filter(Boolean).join('. ');
  const half = opts.half === 'bottom' ? 'Bottom' : opts.half === 'top' ? 'Top' : '';
  const inning = half && opts.inning != null && opts.inning > 0 ? `${half} of the ${opts.inning}` : half;
  const outs = opts.outs == null ? '' : opts.outs === 1 ? '1 out' : `${opts.outs} outs`;
  const count = opts.balls != null && opts.strikes != null ? `Count ${opts.balls} and ${opts.strikes}` : '';
  return [inning, outs, who, count].filter(Boolean).join('. ');
}

export function stepIndex(index: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return clamp(index + direction, 0, count - 1);
}
