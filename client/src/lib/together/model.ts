/**
 * Watch together / Listen together: the shapes the server sends and the pure
 * arithmetic every client does on them.
 *
 * The server owns the session. A client never trusts its own player: it works
 * out where playback should be from `position_ms + (serverNow - position_at) *
 * rate` and steers its player there (see ./sync.ts).
 */

export type TogetherKind = 'watch' | 'listen';
export type ControllerPolicy = 'everyone' | 'starter';
export type TogetherSource = 'youtube' | 'url' | 'attachment';

export interface TogetherItem {
  id: string;
  source: TogetherSource;
  ref: string;
  title: string;
  duration_ms: number | null;
  thumbnail: string | null;
  content_type: string | null;
  added_by: string;
}

export interface TogetherSession {
  session_id: string;
  channel_id: string;
  guild_id: string | null;
  kind: TogetherKind;
  controller_policy: ControllerPolicy;
  started_by: string;
  started_at: number;
  items: TogetherItem[];
  /** `items.length` means nothing is current (the queue ran out). */
  current_index: number;
  playing: boolean;
  position_ms: number;
  /** Server wall-clock ms at which `position_ms` was true. */
  position_at: number;
  rate: number;
  revision: number;
  server_time_ms: number;
}

export interface TogetherAction {
  type: string;
  user_id: string | null;
  position_ms: number | null;
  item_id: string | null;
}

/** `TOGETHER_SESSION_UPDATE`, and the REST answer for one call. */
export interface TogetherSessionUpdate {
  channel_id: string;
  guild_id?: string | null;
  revision: number;
  server_time_ms?: number;
  session: TogetherSession | null;
  action?: TogetherAction | null;
}

/** The slim summary the sidebar and "Live now" draw. */
export interface TogetherActivity {
  session_id: string;
  kind: TogetherKind;
  started_by: string;
  playing: boolean;
  title: string | null;
  source: TogetherSource | null;
  thumbnail: string | null;
  /** Newer servers; absent from 3.2-era payloads. */
  content_type?: string | null;
  item_count: number;
}

/** `TOGETHER_ACTIVITY_UPDATE`. */
export interface TogetherActivityUpdate {
  guild_id: string;
  channel_id: string;
  revision: number;
  activity: TogetherActivity | null;
}

export function currentItem(session: TogetherSession | null | undefined): TogetherItem | null {
  if (!session) return null;
  return session.items[session.current_index] ?? null;
}

export function canControl(session: TogetherSession, userId: string | null | undefined): boolean {
  return session.controller_policy === 'everyone' || (userId != null && userId === session.started_by);
}

/** Where playback should be at `serverNowMs`, by the server's clock. */
export function expectedPositionMs(session: TogetherSession, serverNowMs: number): number {
  const item = currentItem(session);
  let position = session.position_ms;
  if (session.playing && item) {
    position += Math.max(0, serverNowMs - session.position_at) * session.rate;
  }
  if (item?.duration_ms != null) position = Math.min(position, item.duration_ms);
  return Math.max(0, position);
}

/** "12:40", "1:02:03". */
export function formatPlaybackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function isAudioItem(item: TogetherItem): boolean {
  return (item.content_type ?? '').startsWith('audio/');
}

/**
 * Where each device fetches an item from, as the quiet note under it: "Plays
 * from YouTube on each person's device". Null for files posted in the server.
 */
export function playsFromLine(item: TogetherItem | null): string | null {
  if (!item) return null;
  if (item.source === 'youtube') return "Plays from YouTube on each person's device";
  if (item.source !== 'url') return null;
  let host: string | null = null;
  try {
    host = new URL(item.ref).host;
  } catch {
    host = null;
  }
  return host ? `Plays from ${host} on each person's device` : null;
}

/** "Watching Big Buck Bunny" / "Listening to Big Buck Bunny". */
export function activityLine(kind: TogetherKind, title: string | null): string {
  if (!title) return kind === 'watch' ? 'Watching together' : 'Listening together';
  return kind === 'watch' ? `Watching ${title}` : `Listening to ${title}`;
}
