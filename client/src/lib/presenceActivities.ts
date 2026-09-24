/**
 * The one place this client's own presence is assembled and sent.
 *
 * Several features put an activity on your presence: the desktop app's
 * foreground detection ("Playing …"), its now-playing reader ("Listening to
 * …") and a watch-together session ("Watching …"). Each used to send its own
 * presence update with only its own activity in it, so whichever spoke last
 * wiped the others, and the idle timer and the status menu wiped all of them.
 *
 * Now each feature sets its *source* here and this module sends one presence
 * made of all of them, with the status you chose (or "idle" while you are
 * away) and your custom status.
 */
import { gateway, LOCAL_SERVER_ID } from '../gateway/manager';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { registerSessionReset } from '../stores/sessionReset';
import { useServerListStore } from '../stores/serverListStore';
import type { Activity, Presence } from '../types';

/**
 * Where an activity came from. `together` is the watch/listen-together session
 * in a voice channel; `listening` is the OS media session; `playing` is the
 * foreground app.
 */
export type ActivitySource = 'together' | 'listening' | 'playing';

/** Order on the wire: the first activity is the one most surfaces show. */
const SOURCE_ORDER: readonly ActivitySource[] = ['together', 'listening', 'playing'];

const sources = new Map<ActivitySource, Activity>();
let autoIdle = false;
let lastSent: string | null = null;

function mapStatus(status: string | undefined): Presence['status'] {
  if (status === 'idle' || status === 'dnd' || status === 'offline') return status;
  if (status === 'invisible') return 'offline';
  return 'online';
}

/**
 * The activities to send, in order. While a together session is on, it is
 * what you are listening to or watching, so the OS media session's track
 * (which is very likely the same thing, played by Paracord) steps aside.
 */
export function composeActivities(
  current: ReadonlyMap<ActivitySource, Activity> = sources,
): Activity[] {
  const out: Activity[] = [];
  for (const source of SOURCE_ORDER) {
    if (source === 'listening' && current.has('together')) continue;
    const activity = current.get(source);
    if (activity) out.push(activity);
  }
  return out;
}

/** The status to send: what you chose, or idle while you are away from an online status. */
export function currentPresenceStatus(): Presence['status'] {
  const chosen = mapStatus(useAuthStore.getState().settings?.status);
  return autoIdle && chosen === 'online' ? 'idle' : chosen;
}

/**
 * Send this client's presence to every connected server, and show it locally.
 *
 * Skips the send when nothing changed since the last one unless `force` is
 * set (a reconnect: the server forgot the activities when the connection
 * dropped).
 */
export function publishPresence(options: { force?: boolean } = {}): void {
  const status = currentPresenceStatus();
  // Invisible means nobody sees anything, activities included.
  const activities = status === 'offline' ? [] : composeActivities();
  // An empty string, not null, when there is none: the gateway reads a null
  // custom status as "keep the previous one", so null could never clear it.
  const customStatus =
    status === 'offline' ? '' : (useAuthStore.getState().settings?.custom_status?.trim() ?? '');
  const signature = JSON.stringify([status, customStatus, activities]);
  if (!options.force && signature === lastSent) return;
  lastSent = signature;

  gateway.updatePresenceAll(status, activities, customStatus);
  for (const conn of gateway.getAllConnections()) {
    if (!conn.connected) continue;
    const userId =
      useServerListStore.getState().getServer(conn.serverId)?.userId ??
      (conn.serverId === LOCAL_SERVER_ID ? useAuthStore.getState().user?.id : null);
    if (userId) {
      usePresenceStore
        .getState()
        .updatePresence({ user_id: userId, status, activities, custom_status: customStatus }, conn.serverId);
    }
  }
}

function sameActivity(a: Activity | undefined, b: Activity | null): boolean {
  if (!a || !b) return !a && !b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Set (or clear, with `null`) one source's activity and send the result. */
export function setActivitySource(source: ActivitySource, activity: Activity | null): void {
  if (sameActivity(sources.get(source), activity)) return;
  if (activity) sources.set(source, activity);
  else sources.delete(source);
  publishPresence();
}

/** The idle timer: you stepped away (true) or came back (false). */
export function setAutoIdle(idle: boolean): void {
  if (autoIdle === idle) return;
  autoIdle = idle;
  publishPresence();
}

/**
 * A server connection just became ready. The server only remembers a
 * presence while the connection that set it is open, so anything beyond a
 * plain "online" has to be said again.
 */
export function republishPresenceAfterReconnect(): void {
  if (sources.size === 0 && currentPresenceStatus() === 'online') return;
  publishPresence({ force: true });
}

/** Forget everything (sign-out, and between tests). */
export function resetPresenceActivities(): void {
  sources.clear();
  autoIdle = false;
  lastSent = null;
}

registerSessionReset('presenceActivities', resetPresenceActivities);
