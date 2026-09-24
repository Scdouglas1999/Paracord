/**
 * "Share what I'm listening to": turns what the desktop app reads from the
 * system's media controls into a "Listening to" presence activity, at a pace
 * that is kind to everyone who receives it.
 *
 *  - A track change shows up within ~2 s (a {@link NOW_PLAYING_DEBOUNCE_MS}
 *    settle, so skipping through five tracks sends one update, not five).
 *  - No more than one presence update per {@link NOW_PLAYING_MIN_INTERVAL_MS}.
 *  - Paused for more than {@link NOW_PLAYING_PAUSE_GRACE_MS}, or stopped, and
 *    the activity is cleared.
 *
 * The native half (client/src-tauri/src/now_playing) emits
 * `now_playing_changed` with a {@link NowPlayingSnapshot} or null.
 */
import { ActivityType, type Activity } from '../types';

export const NOW_PLAYING_DEBOUNCE_MS = 1_500;
export const NOW_PLAYING_MIN_INTERVAL_MS = 5_000;
export const NOW_PLAYING_PAUSE_GRACE_MS = 30_000;
/** A timeline that moved by more than this is a seek worth re-sending. */
const TIMELINE_TOLERANCE_MS = 3_000;

/** The `notifications` settings key the toggle is stored under (off by default). */
export const NOW_PLAYING_SETTING_KEY = 'nowPlayingSharingEnabled';

/** What the desktop app sends in `now_playing_changed` (see now_playing/model.rs). */
export interface NowPlayingSnapshot {
  player: string;
  title: string;
  artist: string | null;
  status: 'playing' | 'paused' | 'stopped';
  position_ms: number | null;
  duration_ms: number | null;
}

/** The activity for a playing track, its timeline anchored at `nowMs`. */
export function nowPlayingActivity(snapshot: NowPlayingSnapshot, nowMs: number): Activity {
  const position = Math.max(0, snapshot.position_ms ?? 0);
  const startedMs = nowMs - position;
  const duration = snapshot.duration_ms ?? 0;
  return {
    name: snapshot.player.trim() || 'Media player',
    type: ActivityType.LISTENING,
    details: snapshot.title,
    state: snapshot.artist || null,
    started_at: snapshot.position_ms == null ? null : new Date(startedMs).toISOString(),
    ends_at:
      snapshot.position_ms == null || duration <= 0
        ? null
        : new Date(startedMs + duration).toISOString(),
  };
}

function timeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function closeInTime(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = timeMs(a);
  const right = timeMs(b);
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= TIMELINE_TOLERANCE_MS;
}

/**
 * Whether two listening activities say the same thing. The timeline is
 * compared loosely: the same track re-read a second later lands a few
 * milliseconds apart, which is not news; a seek is.
 */
export function sameListening(a: Activity | null, b: Activity | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.name === b.name &&
    a.details === b.details &&
    (a.state ?? null) === (b.state ?? null) &&
    closeInTime(a.started_at, b.started_at) &&
    closeInTime(a.ends_at, b.ends_at)
  );
}

/**
 * The pacing between the native reader and the presence. Feed it every
 * snapshot; it calls `publish` with the activity to show (or null) when that
 * should change.
 */
export class NowPlayingPublisher {
  private desired: Activity | null = null;
  private published: Activity | null = null;
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly publish: (activity: Activity | null) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  update(snapshot: NowPlayingSnapshot | null): void {
    if (this.disposed) return;
    if (!snapshot || snapshot.status === 'stopped' || !snapshot.title.trim()) {
      this.clearPauseTimer();
      this.setDesired(null);
      return;
    }
    if (snapshot.status === 'paused') {
      // A short pause keeps the track up; a long one takes it down. The track
      // shown stays the one that was playing.
      if (!this.pauseTimer) {
        this.pauseTimer = setTimeout(() => {
          this.pauseTimer = null;
          this.setDesired(null);
        }, NOW_PLAYING_PAUSE_GRACE_MS);
      }
      return;
    }
    this.clearPauseTimer();
    this.setDesired(nowPlayingActivity(snapshot, this.now()));
  }

  /** Stop all timers. Publishes nothing: the caller clears what is shown. */
  dispose(): void {
    this.disposed = true;
    this.clearPauseTimer();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  private setDesired(activity: Activity | null): void {
    if (sameListening(activity, this.desired)) return;
    this.desired = activity;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    if (sameListening(this.desired, this.published)) return;
    const now = this.now();
    const at = Math.max(now + NOW_PLAYING_DEBOUNCE_MS, this.lastPublishAt + NOW_PLAYING_MIN_INTERVAL_MS);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.disposed) return;
      this.published = this.desired;
      this.lastPublishAt = this.now();
      this.publish(this.desired);
    }, at - now);
  }
}
