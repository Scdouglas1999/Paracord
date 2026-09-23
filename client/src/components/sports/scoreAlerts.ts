import type { SportsScoreEvent } from '../../api/sports';
import { readHideScores } from './model';

const OFF_KEY = 'paracord.sports.alerts-off';
export const SCORE_ALERTS_EVENT = 'paracord:sports-alerts';
const REPEAT_WINDOW_MS = 10 * 60 * 1000;

/** Alerts this viewer switched off, by server. Nothing stored means on. */
function readOffMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OFF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

export function readScoreAlertsOn(guildId: string): boolean {
  return readOffMap()[guildId] !== true;
}

export function writeScoreAlertsOn(guildId: string, on: boolean) {
  try {
    const next = { ...readOffMap() };
    if (on) delete next[guildId];
    else next[guildId] = true;
    localStorage.setItem(OFF_KEY, JSON.stringify(next));
  } catch {
    // A blocked store still switches for this visit.
  }
  window.dispatchEvent(new Event(SCORE_ALERTS_EVENT));
}

export function isScoreEvent(value: unknown): value is SportsScoreEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<SportsScoreEvent>;
  return typeof event.guild_id === 'string'
    && typeof event.game === 'string'
    && (event.kind === 'score' || event.kind === 'final')
    && typeof event.content === 'string'
    && Boolean(event.home && event.away);
}

/** Title and body of the desktop notification. */
export function scoreAlertText(event: SportsScoreEvent): { title: string; body: string } {
  if (event.kind === 'final') {
    return { title: 'Final', body: event.content };
  }
  const scorer = event.team_id === event.home.id
    ? event.home
    : event.team_id === event.away.id
      ? event.away
      : null;
  const name = scorer?.name?.trim() || scorer?.abbr?.trim();
  return { title: name ? `${name} score` : 'Score', body: event.content };
}

/**
 * Someone in two servers that follow the same team hears about a score once.
 * Keyed by the game and the sentence, which names the play and the score.
 */
export function createRepeatFilter(windowMs = REPEAT_WINDOW_MS) {
  const seen = new Map<string, number>();
  return (event: SportsScoreEvent, now = Date.now()): boolean => {
    for (const [key, at] of seen) {
      if (now - at > windowMs) seen.delete(key);
    }
    const key = `${event.game}\n${event.kind}\n${event.content}`;
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  };
}

const firstTime = createRepeatFilter();

/**
 * Whether this viewer should see a notification. Spoiler-free viewers and a
 * muted server never do. The global notification switch is checked where the
 * notification is sent.
 */
export function shouldAlert(
  event: SportsScoreEvent,
  { serverMuted, now = Date.now(), fresh = firstTime }: {
    serverMuted: boolean;
    now?: number;
    fresh?: (event: SportsScoreEvent, now?: number) => boolean;
  },
): boolean {
  if (serverMuted) return false;
  if (readHideScores()) return false;
  if (!readScoreAlertsOn(event.guild_id)) return false;
  return fresh(event, now);
}

/**
 * One score, one notification. A member of a server that has both a pinned
 * channel and score alerts used to hear every score twice: once for the Sports
 * post in the channel and once for the alert, with the same sentence. Both
 * paths note the sentence here and stay quiet when the other already said it.
 */
export function createSportsLineOnce(windowMs = 2 * 60 * 1000) {
  const said = new Map<string, number>();
  return (content: string, now = Date.now()): boolean => {
    for (const [line, at] of said) {
      if (now - at > windowMs) said.delete(line);
    }
    const line = content.trim();
    if (said.has(line)) return false;
    said.set(line, now);
    return true;
  };
}

export const sportsLineOnce = createSportsLineOnce();

