/**
 * How presence activities read on screen: "Listening to", "Watching",
 * "Playing" — one set of words for the profile card, the member lists, the DM
 * list and the face-pile tooltips.
 *
 * Precedence, everywhere:
 *  - Which activity: watching > listening > playing > streaming > competing.
 *    A watch-together session is the most social thing on the list, and a
 *    track beats a foreground app because it is what people asked to share.
 *  - Custom status vs. activity: in one-line places (member rows, tooltips) the
 *    custom status someone typed wins; they chose those words. The profile
 *    card has room for both and shows the activity as its own section.
 */
import { ActivityType, type Activity, type Presence } from '../types';

export type ActivityKind = 'listening' | 'watching' | 'playing' | 'streaming' | 'competing';

export interface ActivityView {
  kind: ActivityKind;
  /** "Listening to", "Watching", "Playing", "Streaming", "Competing in". */
  verb: string;
  /** The track or video title; for playing/streaming/competing, the app or game. */
  title: string;
  /** Listening: the artist. Watching: any extra line. Playing: the window. */
  subtitle: string | null;
  /** The app it is happening in ("Spotify", "Paracord"), when that is not the title. */
  app: string | null;
  /** One short line for a row: "Windowlicker — Aphex Twin", "Watching Koyaanisqatsi". */
  line: string;
  /** Everything, for a tooltip or a screen reader: "Listening to Windowlicker by Aphex Twin on Spotify". */
  sentence: string;
  /** Epoch ms, when the timeline is known. */
  startedMs: number | null;
  endsMs: number | null;
}

const KIND_BY_TYPE: Record<number, ActivityKind | undefined> = {
  [ActivityType.PLAYING]: 'playing',
  [ActivityType.STREAMING]: 'streaming',
  [ActivityType.LISTENING]: 'listening',
  [ActivityType.WATCHING]: 'watching',
  [ActivityType.COMPETING]: 'competing',
};

const VERB: Record<ActivityKind, string> = {
  listening: 'Listening to',
  watching: 'Watching',
  playing: 'Playing',
  streaming: 'Streaming',
  competing: 'Competing in',
};

const RANK: Record<ActivityKind, number> = {
  watching: 0,
  listening: 1,
  playing: 2,
  streaming: 3,
  competing: 4,
};

function activityKind(activity: Activity): ActivityKind | null {
  const type = typeof activity.type === 'number' ? activity.type : activity.activity_type;
  return typeof type === 'number' ? KIND_BY_TYPE[type] ?? null : null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function timeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** "Watching Koyaanisqatsi" sent as the details already: keep just the title. */
function withoutVerb(text: string, kind: ActivityKind): string {
  const verb = VERB[kind];
  return text.toLowerCase().startsWith(`${verb.toLowerCase()} `) ? text.slice(verb.length + 1).trim() : text;
}

export function describeActivity(activity: Activity | null | undefined): ActivityView | null {
  if (!activity) return null;
  const kind = activityKind(activity);
  if (!kind) return null;
  const name = clean(activity.name);
  const details = clean(activity.details);
  const state = clean(activity.state);
  const verb = VERB[kind];
  const startedMs = timeMs(activity.started_at);
  const endsMs = timeMs(activity.ends_at);

  if (kind === 'listening' || kind === 'watching') {
    const title = details ? withoutVerb(details, kind) : name;
    if (!title) return null;
    const app = details && name ? name : null;
    const subtitle = state;
    const line =
      kind === 'listening'
        ? subtitle
          ? `${title} — ${subtitle}`
          : title
        : `${verb} ${title}`;
    const by = kind === 'listening' && subtitle ? ` by ${subtitle}` : subtitle ? ` · ${subtitle}` : '';
    const on = app ? ` on ${app}` : '';
    return { kind, verb, title, subtitle, app, line, sentence: `${verb} ${title}${by}${on}`, startedMs, endsMs };
  }

  // Playing / streaming / competing: the app or game is the title. The
  // desktop app's foreground detection sends "Playing X" as the details, so
  // details only count as a subtitle when they add something.
  if (!name) return null;
  const extra = details && details.toLowerCase() !== `${verb} ${name}`.toLowerCase() ? details : state;
  return {
    kind,
    verb,
    title: name,
    subtitle: extra,
    app: null,
    line: `${verb} ${name}`,
    sentence: extra ? `${verb} ${name} · ${extra}` : `${verb} ${name}`,
    startedMs,
    endsMs,
  };
}

/** The one activity to show for a presence (see the precedence above). */
export function displayActivity(presence: Pick<Presence, 'activities'> | null | undefined): ActivityView | null {
  let best: ActivityView | null = null;
  for (const activity of presence?.activities ?? []) {
    const view = describeActivity(activity);
    if (view && (!best || RANK[view.kind] < RANK[best.kind])) best = view;
  }
  return best;
}

/** What a one-line row shows under a name: the custom status, else the activity. */
export type StatusLine =
  | { type: 'custom'; text: string }
  | { type: 'activity'; activity: ActivityView };

export function statusLine(presence: Presence | null | undefined): StatusLine | null {
  if (!presence || presence.status === 'offline') return null;
  const custom = clean(presence.custom_status);
  if (custom) return { type: 'custom', text: custom };
  const activity = displayActivity(presence);
  return activity ? { type: 'activity', activity } : null;
}

/** "for 12m 3s" — how long an activity without a timeline has been going. */
export function activityElapsed(view: Pick<ActivityView, 'startedMs'>, nowMs: number): string | null {
  if (view.startedMs === null) return null;
  const total = Math.max(0, Math.floor((nowMs - view.startedMs) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `for ${hours}h ${minutes}m`;
  if (minutes > 0) return `for ${minutes}m ${seconds}s`;
  return `for ${seconds}s`;
}

/** "3:07" / "1:02:45". */
export function formatTrackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Where a timeline stands at `nowMs`, or null when it is not a timeline. */
export function trackProgress(
  view: Pick<ActivityView, 'startedMs' | 'endsMs'>,
  nowMs: number,
): { elapsedMs: number; durationMs: number; fraction: number } | null {
  if (view.startedMs === null || view.endsMs === null) return null;
  const durationMs = view.endsMs - view.startedMs;
  if (durationMs <= 0) return null;
  const elapsedMs = Math.min(durationMs, Math.max(0, nowMs - view.startedMs));
  return { elapsedMs, durationMs, fraction: elapsedMs / durationMs };
}
