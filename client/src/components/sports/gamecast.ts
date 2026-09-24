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

export interface MiniFieldBar {
  /** Yards from the home goal line. 0 is the home goal line, 100 the away goal line. */
  ball: number;
  /** First-down line, or null when the feed did not name possession or a distance. */
  firstDown: number | null;
  label: string;
}

/**
 * A 100-yard strip for a live football card. Home defends the left.
 * `ball_on` (yards from the home goal line) wins when it is in range.
 * The situation line is the spot only when `ball_on` is null.
 * The first-down line is `ball_on` plus the "& N" in the text, or
 * `yards_to_endzone` when the text says "& Goal".
 */
export function miniFieldBar(game: {
  down_distance: string | null;
  ball_on?: number | null;
  possession_team_id?: string | null;
  yards_to_endzone?: number | null;
  home: { id?: string; abbr: string; possession: boolean };
  away: { id?: string; abbr: string; possession: boolean };
}): MiniFieldBar | null {
  const text = game.down_distance?.trim() ?? '';
  const fed = ballOnYards(game.ball_on);
  const ball = fed ?? (text ? spotFromSituation(text, game.home.abbr, game.away.abbr) : null);
  if (ball == null) return null;
  const direction = offenseDirection(game);
  let firstDown: number | null = null;
  if (direction != null) {
    if (/&\s*goal\b/i.test(text)) {
      const toGoal = game.yards_to_endzone;
      firstDown = toGoal != null && Number.isFinite(toGoal) && toGoal >= 0
        ? firstDownYard(ball, toGoal, direction)
        : (direction === 1 ? 100 : 0);
    } else {
      const yards = text.match(/&\s*(\d+)/);
      if (yards) firstDown = firstDownYard(ball, Number(yards[1]), direction);
    }
  }
  const spot = yardSpot(ball, game.home.abbr, game.away.abbr);
  const next = firstDown == null ? '' : ` First down at ${yardSpot(firstDown, game.home.abbr, game.away.abbr)}.`;
  return { ball, firstDown, label: `Ball on ${spot}.${next}` };
}

function ballOnYards(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function offenseDirection(game: {
  possession_team_id?: string | null;
  home: { id?: string; possession: boolean };
  away: { id?: string; possession: boolean };
}): OffenseDirection | null {
  const id = game.possession_team_id;
  if (id) {
    if (game.away.id && id === game.away.id) return -1;
    if (game.home.id && id === game.home.id) return 1;
  }
  if (game.away.possession && !game.home.possession) return -1;
  if (game.home.possession && !game.away.possession) return 1;
  return null;
}

function spotFromSituation(text: string, homeAbbr: string, awayAbbr: string): number | null {
  if (/\bmidfield\b/i.test(text) || /\bat\s+(?:the\s+)?50\b/i.test(text)) return 50;
  const match = text.match(/\bat\s+([A-Za-z]{2,4})\s+(\d{1,2})\b/);
  if (!match) return null;
  const yard = Number(match[2]);
  if (yard > 50) return null;
  const token = match[1].toUpperCase();
  if (token === homeAbbr.toUpperCase()) return yard;
  if (token === awayAbbr.toUpperCase()) return 100 - yard;
  return null;
}

export interface WinChartFrame {
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WinAreaFill {
  /** Area where the home team was ahead of 50. */
  home: string;
  /** Area where the away team was ahead of 50. */
  away: string;
  end: { x: number; y: number; side: 'home' | 'away' | 'even'; pct: number };
}

/** The region between the win line and the 50 mark, split by who was ahead. */
export function winAreaFill(
  points: readonly { home_pct: number }[],
  frame: WinChartFrame,
): WinAreaFill | null {
  if (points.length === 0) return null;
  const plotW = frame.width - frame.left - frame.right;
  const plotH = frame.height - frame.top - frame.bottom;
  const yOf = (pct: number) => frame.top + (1 - Math.min(100, Math.max(0, pct)) / 100) * plotH;
  const xOf = (index: number) => (
    points.length === 1 ? frame.left + plotW / 2 : frame.left + (index / (points.length - 1)) * plotW
  );
  const mid = yOf(50);
  const home: string[] = [];
  const away: string[] = [];
  const add = (side: 'home' | 'away', ax: number, ay: number, bx: number, by: number) => {
    const path = `M${round1(ax)} ${round1(ay)} L${round1(bx)} ${round1(by)} L${round1(bx)} ${round1(mid)} L${round1(ax)} ${round1(mid)} Z`;
    (side === 'home' ? home : away).push(path);
  };
  const sideOf = (pct: number) => (pct > 50 ? 1 : pct < 50 ? -1 : 0);
  if (points.length === 1) {
    const side = sideOf(points[0].home_pct);
    if (side !== 0) add(side > 0 ? 'home' : 'away', xOf(0) - 1, yOf(points[0].home_pct), xOf(0) + 1, yOf(points[0].home_pct));
  } else {
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index].home_pct;
      const b = points[index + 1].home_pct;
      const ax = xOf(index);
      const bx = xOf(index + 1);
      const ay = yOf(a);
      const by = yOf(b);
      const aSide = sideOf(a);
      const bSide = sideOf(b);
      if (aSide === 0 && bSide === 0) continue;
      if (aSide === bSide || aSide === 0 || bSide === 0) {
        add((aSide || bSide) > 0 ? 'home' : 'away', ax, ay, bx, by);
        continue;
      }
      const t = (50 - a) / (b - a);
      const cx = ax + t * (bx - ax);
      add(aSide > 0 ? 'home' : 'away', ax, ay, cx, mid);
      add(bSide > 0 ? 'home' : 'away', cx, mid, bx, by);
    }
  }
  const last = points[points.length - 1].home_pct;
  const side = last > 50 ? 'home' : last < 50 ? 'away' : 'even';
  return {
    home: home.join(' '),
    away: away.join(' '),
    end: { x: xOf(points.length - 1), y: yOf(last), side, pct: Math.round(last) },
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
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

export interface CatcherLayout {
  /** Called-strike box: as wide as the plate, 1.3× as tall, just above it. */
  zone: { x: number; y: number; width: number; height: number };
  plate: { cx: number; top: number; width: number; height: number };
  boxes: { y: number; width: number; height: number; left: number; right: number };
  catcher: { x: number; y: number; width: number; height: number };
  /** Stance height. Feet sit on the box baseline. */
  batterHeight: number;
}

/**
 * Catcher's view. The zone is the point of the panel, so it takes ~40% of the
 * width and floats above a plate of the same width near the bottom. The
 * batter's boxes sit either side, outside the zone, and the batter is a faint
 * figure in one of them — under half the panel tall, so the pitches stay the
 * hero and a pitch high out of the zone still has room above.
 */
export function catcherLayout(): CatcherLayout {
  const plateWidth = Math.round(ZONE_VIEW.width * 0.42);
  const plateHeight = 22;
  const zoneWidth = plateWidth;
  const zoneHeight = Math.round(zoneWidth * 1.3);
  const batterHeight = Math.round(ZONE_VIEW.height * 0.47);
  const plateBottom = ZONE_VIEW.height - 39;
  const plateTop = plateBottom - plateHeight;
  const zoneX = (ZONE_VIEW.width - zoneWidth) / 2;
  const boxWidth = 36;
  const gap = 8;
  const boxHeight = 52;
  const zoneLift = 14;
  return {
    zone: {
      x: zoneX,
      y: plateTop - zoneLift - zoneHeight,
      width: zoneWidth,
      height: zoneHeight,
    },
    plate: { cx: ZONE_VIEW.width / 2, top: plateTop, width: plateWidth, height: plateHeight },
    boxes: {
      y: plateBottom - boxHeight,
      width: boxWidth,
      height: boxHeight,
      left: zoneX - gap - boxWidth,
      right: zoneX + zoneWidth + gap,
    },
    catcher: {
      x: ZONE_VIEW.width / 2 - 18,
      y: plateBottom + 6,
      width: 36,
      height: 22,
    },
    batterHeight,
  };
}

/**
 * Map a pitch so the called-strike bounds land on the zone rectangle.
 * A pitch that would leave the panel is held at the edge.
 */
export function pitchInFrame(
  x: number,
  y: number,
  zone: { left: number; right: number; top: number; bottom: number },
): { x: number; y: number; held: boolean } {
  const rect = catcherLayout().zone;
  const spanX = zone.right - zone.left || 1;
  const spanY = zone.bottom - zone.top || 1;
  const rawX = rect.x + ((x - zone.left) / spanX) * rect.width;
  const rawY = rect.y + ((y - zone.top) / spanY) * rect.height;
  const edge = 11;
  const hold = (value: number, size: number) => Math.min(size - edge, Math.max(edge, value));
  const hx = hold(rawX, ZONE_VIEW.width);
  const hy = hold(rawY, ZONE_VIEW.height);
  return {
    x: hx,
    y: hy,
    held: Math.abs(hx - rawX) > 0.5 || Math.abs(hy - rawY) > 0.5,
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

/** Column index to highlight, or -1 when the game is not live or the period is missing. */
export function lineScoreLiveColumn(period: number | null, count: number, state: string): number {
  if (state !== 'in' || period == null || period < 1 || period > count) return -1;
  return period - 1;
}

/** Which total leads. A tie or a missing total has no winner. */
export function lineScoreWinner(home: number | null, away: number | null): 'home' | 'away' | null {
  if (home == null || away == null || home === away) return null;
  return home > away ? 'home' : 'away';
}

export interface DriveChartSpan {
  /** Left edge, yards from the home goal line. */
  x: number;
  /** Length in yards. A short gain still draws a sliver. */
  width: number;
  /** True when the drive moved toward the away goal, which is to the right. */
  pointsRight: boolean;
}

/** Bar on a 100-yard strip. Null when the feed did not give both yard lines. */
export function driveChartSpan(start: number | null, end: number | null): DriveChartSpan | null {
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const a = clamp(start, 0, 100);
  const b = clamp(end, 0, 100);
  const width = Math.min(100, Math.max(1.5, Math.abs(b - a)));
  return {
    x: Math.min(Math.min(a, b), 100 - width),
    width,
    pointsRight: b >= a,
  };
}

/** Short result for the chip at the end of a drive bar. Other results stay unlabeled. */
export function driveResultChip(result: string | null | undefined): string | null {
  const text = (result ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text.includes('touchdown') || text === 'td') return 'TD';
  if (text.includes('field goal') || text === 'fg') return 'FG';
  if (text.includes('punt')) return 'Punt';
  if (text.includes('interception') || text === 'int') return 'INT';
  if (text.includes('fumble')) return 'Fumble';
  if (text.includes('down')) return 'Downs';
  if (text.includes('half')) return 'End of half';
  return null;
}

export interface PassArc {
  d: string;
  midX: number;
  midY: number;
}

/**
 * A rising quadratic from the throw to the catch. The control point sits
 * above the straight line so the ball climbs and comes back down.
 */
export function passArc(x1: number, y: number, x2: number): PassArc {
  const lift = Math.max(36, Math.abs(x2 - x1) * 0.22);
  const midX = (x1 + x2) / 2;
  const midY = y - lift;
  return { d: `M${x1} ${y} Q${midX} ${midY} ${x2} ${y}`, midX, midY };
}

/** The chip a scoring play drops on the field. A safety is not labeled as a touchdown. */
export function scoreCall(type: string | null | undefined, scoring: boolean): 'TOUCHDOWN' | 'FIELD GOAL' | null {
  if (!scoring) return null;
  const text = (type ?? '').toLowerCase();
  if (text.includes('safety')) return null;
  if (text.includes('field goal') || text === 'fg') return 'FIELD GOAL';
  return 'TOUCHDOWN';
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

const HEX = /^[0-9a-f]{6}$/;
/** Primaries closer than this (0–441) are treated as the same paint. */
export const TEAM_COLOR_CLOSE = 48;

export interface TeamPaint {
  fill: string;
  ink: string;
}

interface Rgb { r: number; g: number; b: number; hex: string }

function parseTeamHex(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const hex = value.trim().toLowerCase();
  if (!HEX.test(hex)) return null;
  return {
    hex,
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function channelLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0–1. */
export function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  return 0.2126 * channelLinear(rgb.r) + 0.7152 * channelLinear(rgb.g) + 0.0722 * channelLinear(rgb.b);
}

function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function cssHex(hex: string): string {
  return String.fromCharCode(35) + hex;
}

/**
 * Paint for a team color that arrived as data. Ink is chalk on a dark fill
 * and the dark on-light ink on a light fill. When the other team's primary
 * is nearly the same, the alternate color is used if it separates them.
 * A missing color falls back to the neutral end-zone token.
 */
export function teamPaint(
  team: { color?: string | null; alt_color?: string | null } | null | undefined,
  other?: { color?: string | null; alt_color?: string | null } | null,
): TeamPaint {
  const primary = parseTeamHex(team?.color);
  const alt = parseTeamHex(team?.alt_color);
  const otherPrimary = parseTeamHex(other?.color);
  let chosen = primary;
  if (primary && otherPrimary && rgbDistance(primary, otherPrimary) < TEAM_COLOR_CLOSE) {
    if (alt && rgbDistance(alt, otherPrimary) >= TEAM_COLOR_CLOSE) chosen = alt;
  }
  if (!chosen) return { fill: 'var(--sports-endzone)', ink: 'var(--sports-chalk)' };
  const ink = relativeLuminance(chosen) > 0.179 ? 'var(--sports-ink)' : 'var(--sports-chalk)';
  return { fill: cssHex(chosen.hex), ink };
}

export type PitchShapeName = 'circle' | 'square' | 'diamond' | 'triangle' | 'star' | 'ring';

/** Result color plus a shape, so the mark still reads without the color. */
export function pitchMark(result: string | null | undefined): { fill: string; shape: PitchShapeName } {
  switch (result) {
    case 'ball': return { fill: 'var(--sports-pitch-ball)', shape: 'circle' };
    case 'strike-looking': return { fill: 'var(--sports-pitch-looking)', shape: 'square' };
    case 'strike-swinging': return { fill: 'var(--sports-pitch-swinging)', shape: 'diamond' };
    case 'foul': return { fill: 'var(--sports-pitch-foul)', shape: 'triangle' };
    case 'in-play': return { fill: 'var(--sports-pitch-inplay)', shape: 'star' };
    default: return { fill: 'var(--sports-pitch-other)', shape: 'ring' };
  }
}

/** The broadcast bug. A finished game names the score; it does not invent a down. */
export function situationBugText(opts: {
  state: string;
  downText?: string | null;
  spot?: string | null;
  clock?: string | null;
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  awayScore?: number | null;
  homeScore?: number | null;
  hideScores?: boolean;
}): string {
  if (opts.state === 'post') {
    if (opts.hideScores) return 'Final. Scores hidden';
    if (!opts.awayAbbr || !opts.homeAbbr) return 'Final';
    const awayScore = opts.awayScore == null ? '–' : String(opts.awayScore);
    const homeScore = opts.homeScore == null ? '–' : String(opts.homeScore);
    return `Final. ${opts.awayAbbr} ${awayScore}, ${opts.homeAbbr} ${homeScore}`;
  }
  if (opts.state !== 'in') return 'Not started';
  const parts = [opts.downText?.trim(), opts.spot ? `Ball on ${opts.spot}` : null, opts.clock?.trim()].filter(Boolean);
  return parts.join(' · ') || 'In progress';
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
