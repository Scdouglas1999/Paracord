import type { AtBat, ScoringPlay, SportsAthlete } from '../../api/sports';
import { ordinal } from './gamecast';

export type ScoreSide = 'home' | 'away' | 'tie';

export function scoreSide(home: number | null, away: number | null): ScoreSide {
  if (home == null || away == null || home === away) return 'tie';
  return home > away ? 'home' : 'away';
}

export interface TimelinePlay {
  play: ScoringPlay;
  /** The other team took the lead, including after a tie. */
  leadChange: boolean;
}

export interface TimelineGroup {
  period: number | null;
  label: string;
  plays: TimelinePlay[];
}

export function periodHeading(period: number | null, sport: string): string {
  if (period == null || period < 1) return 'Scoring';
  if (sport === 'baseball') return `${ordinal(period)} inning`;
  if (period >= 5) return period === 5 ? 'Overtime' : `${period - 4}OT`;
  return `${ordinal(period)} quarter`;
}

/** Scoring plays grouped under period headers, in feed order. */
export function scoringGroups(plays: readonly ScoringPlay[], sport: string): TimelineGroup[] {
  let leader: ScoreSide = 'tie';
  const groups: TimelineGroup[] = [];
  for (const play of plays) {
    const next = scoreSide(play.home_score, play.away_score);
    const leadChange = leader !== 'tie' && next !== 'tie' && leader !== next;
    if (next !== 'tie') leader = next;
    const label = periodHeading(play.period, sport);
    const last = groups[groups.length - 1];
    const node = { play, leadChange };
    if (last && last.period === play.period) last.plays.push(node);
    else groups.push({ period: play.period, label, plays: [node] });
  }
  return groups;
}

export interface ProgressionPoint {
  index: number;
  home: number;
  away: number;
  period: number | null;
}

/** Points after each scoring play, starting from 0–0. x is the play index. */
export function progressionPoints(plays: readonly ScoringPlay[]): ProgressionPoint[] {
  const points: ProgressionPoint[] = [{ index: 0, home: 0, away: 0, period: null }];
  for (const play of plays) {
    const prev = points[points.length - 1];
    points.push({
      index: points.length,
      home: play.home_score ?? prev.home,
      away: play.away_score ?? prev.away,
      period: play.period,
    });
  }
  return points;
}

/**
 * Corners of a step chart. The score stays flat from kickoff until a play,
 * then jumps. Two points therefore draw an L, not a diagonal.
 */
export function stepCorners(
  points: readonly { index: number; value: number }[],
): { index: number; value: number }[] {
  if (points.length === 0) return [];
  const corners: { index: number; value: number }[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    corners.push({ index: points[i].index, value: points[i - 1].value });
    corners.push(points[i]);
  }
  return corners;
}

/** Vertical range with room above the highest score, so a close game does not sit on the ceiling. */
export function progressionCeiling(points: readonly ProgressionPoint[]): number {
  const max = points.reduce((best, point) => Math.max(best, point.home, point.away), 0);
  return max + 3;
}

export interface ProgressionTick {
  index: number;
  label: string;
}

/** One tick where each quarter or inning first scores. */
export function progressionTicks(points: readonly ProgressionPoint[], sport: string): ProgressionTick[] {
  const ticks: ProgressionTick[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    if (point.period == null || point.period < 1) continue;
    const label = periodHeading(point.period, sport).replace(/ (quarter|inning)$/, '');
    if (seen.has(label)) continue;
    seen.add(label);
    ticks.push({ index: point.index, label });
  }
  return ticks;
}

/** The play that just arrived. The first sight of a list highlights nothing. */
export function freshPlayId(seen: ReadonlySet<string> | null, ids: readonly string[]): { seen: Set<string>; fresh: string | null } {
  const next = new Set(ids);
  if (seen === null) return { seen: next, fresh: null };
  let fresh: string | null = null;
  for (const id of ids) {
    if (!seen.has(id)) fresh = id;
  }
  return { seen: next, fresh };
}

/** Keep a pitcher's chart selected across polls. A missing id falls back to whoever threw first. */
export function selectedPitcherId(ids: readonly string[], selected: string | null): string | null {
  if (selected && ids.includes(selected)) return selected;
  return ids[0] ?? null;
}

/** A chosen at-bat stays put. With no choice, follow the live one. */
export function followedAtBatId(ids: readonly string[], selected: string | null): string | null {
  if (selected && ids.includes(selected)) return selected;
  return ids.length ? ids[ids.length - 1] : null;
}

/** Last play text from a game detail, for a board card that did not carry one. */
export function latestPlayText(detail: {
  football?: { drives?: { plays?: { text?: string | null }[] }[] } | null;
  baseball?: { at_bats?: { result_text?: string | null; pitches?: { text?: string | null }[] }[] } | null;
}): string | null {
  const drives = detail.football?.drives ?? [];
  const plays = drives[drives.length - 1]?.plays ?? [];
  const play = plays[plays.length - 1]?.text?.trim();
  if (play) return play;
  const atBats = detail.baseball?.at_bats ?? [];
  const atBat = atBats[atBats.length - 1];
  const result = atBat?.result_text?.trim();
  if (result) return result;
  const pitches = atBat?.pitches ?? [];
  const pitch = [...pitches].reverse().find((item) => item.text?.trim())?.text?.trim();
  return pitch || null;
}

export function progressionText(
  points: readonly ProgressionPoint[],
  awayAbbr: string,
  homeAbbr: string,
): string {
  if (points.length <= 1) return 'No scoring plays yet.';
  const last = points[points.length - 1];
  const scored = points.length - 1;
  return `${awayAbbr} ${last.away}, ${homeAbbr} ${last.home} after ${scored} scoring ${scored === 1 ? 'play' : 'plays'}.`;
}

const STRIKES = new Set(['strike-looking', 'strike-swinging', 'foul', 'in-play']);

export interface PitchTypeCount {
  type: string;
  count: number;
  pct: number;
}

export interface PitchTick {
  velocity: number;
  type: string;
}

export interface PitcherLine {
  pitcher: SportsAthlete;
  pitches: number;
  strikes: number;
  whiffs: number;
  strikePct: number;
  types: PitchTypeCount[];
  velocities: PitchTick[];
  fastest: number | null;
}

function typeName(type: string | null | undefined, abbr: string | null | undefined): string {
  const name = (type || abbr || '').trim();
  return name || 'Other';
}

/** One line per pitcher who threw a pitch, in the order they appear. */
export function pitcherLines(atBats: readonly AtBat[]): PitcherLine[] {
  const order: string[] = [];
  const byId = new Map<string, { pitcher: SportsAthlete; pitches: AtBat['pitches'] }>();
  for (const atBat of atBats) {
    const pitcher = atBat.pitcher;
    if (!pitcher?.id) continue;
    for (const pitch of atBat.pitches ?? []) {
      let bucket = byId.get(pitcher.id);
      if (!bucket) {
        bucket = { pitcher, pitches: [] };
        byId.set(pitcher.id, bucket);
        order.push(pitcher.id);
      }
      bucket.pitches.push(pitch);
    }
  }
  return order.map((id) => {
    const bucket = byId.get(id)!;
    const pitches = bucket.pitches;
    const strikes = pitches.filter((pitch) => STRIKES.has(pitch.result ?? '')).length;
    const whiffs = pitches.filter((pitch) => pitch.result === 'strike-swinging').length;
    const counts = new Map<string, number>();
    const velocities: PitchTick[] = [];
    for (const pitch of pitches) {
      const name = typeName(pitch.type, pitch.type_abbr);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (pitch.velocity != null && Number.isFinite(pitch.velocity)) {
        velocities.push({ velocity: pitch.velocity, type: name });
      }
    }
    const types = [...counts.entries()]
      .map(([type, count]) => ({
        type,
        count,
        pct: pitches.length === 0 ? 0 : Math.round((count / pitches.length) * 100),
      }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    const fastest = velocities.reduce<number | null>((best, tick) => (
      best == null || tick.velocity > best ? tick.velocity : best
    ), null);
    return {
      pitcher: bucket.pitcher,
      pitches: pitches.length,
      strikes,
      whiffs,
      strikePct: pitches.length === 0 ? 0 : Math.round((strikes / pitches.length) * 100),
      types,
      velocities,
      fastest,
    };
  });
}

/** A phone turned sideways: short, and wider than it is tall. */
export function landscapeStage(width: number, height: number): boolean {
  return height > 0 && height < 500 && width > height;
}

export function pinGameKey(game: { league_path: string; id: string }): string {
  return `${game.league_path}/${game.id}`;
}

const TYPE_TONES = [
  'var(--sports-pitch-ball)',
  'var(--sports-pitch-looking)',
  'var(--sports-pitch-swinging)',
  'var(--sports-pitch-foul)',
  'var(--sports-pitch-inplay)',
  'var(--accent-primary)',
  'var(--sports-first-down)',
  'var(--sports-leather)',
] as const;

/** A stable token for a pitch type. The type name is always printed beside it. */
export function pitchTypeTone(type: string): string {
  let hash = 0;
  for (let index = 0; index < type.length; index += 1) hash = (hash + type.charCodeAt(index)) % TYPE_TONES.length;
  return TYPE_TONES[hash];
}
