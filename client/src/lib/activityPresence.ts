import type { Activity, Presence } from '../types';
import { getVersionedJson, setVersionedJson } from './versionedStorage';

const KNOWN_APPS_STORAGE_KEY = 'activity-known-apps';

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function normalizeDetectedAppId(processName: string): string {
  return processName.trim().toLowerCase();
}

export function readableAppName(processName: string): string {
  const trimmed = processName.trim();
  const withoutExt = trimmed.replace(/\.exe$/i, '');
  const normalized = withoutExt.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
  const labeled = toTitleCase(normalized.trim());
  return labeled || 'Unknown App';
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

export function getKnownActivityAppsFromStorage(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = getVersionedJson<unknown>(KNOWN_APPS_STORAGE_KEY, [], ['activity-known-apps']);
    return readStringArray(parsed);
  } catch {
    return [];
  }
}

export function saveKnownActivityAppsToStorage(apps: string[]): void {
  if (typeof window === 'undefined') return;
  const deduped = Array.from(new Set(readStringArray(apps))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
  try {
    setVersionedJson(KNOWN_APPS_STORAGE_KEY, deduped);
  } catch {
    // ignore storage errors
  }
}

export function recordKnownActivityApp(appId: string): string[] {
  const normalized = normalizeDetectedAppId(appId);
  if (!normalized) return getKnownActivityAppsFromStorage();
  const current = new Set(getKnownActivityAppsFromStorage());
  current.add(normalized);
  const next = Array.from(current);
  saveKnownActivityAppsToStorage(next);
  return next;
}

export function getActivityType(activity: Activity): number {
  if (typeof activity.type === 'number') return activity.type;
  if (typeof activity.activity_type === 'number') return activity.activity_type;
  return 0;
}

export function getPrimaryActivity(presence?: Presence): Activity | null {
  if (!presence?.activities?.length) return null;
  return (
    presence.activities.find((activity) => getActivityType(activity) === 0) ??
    presence.activities[0] ??
    null
  );
}

export function formatActivityLabel(activity: Activity | null): string | null {
  if (!activity) return null;
  const kind = getActivityType(activity);
  if (kind === 0) return `Playing ${activity.name}`;
  if (activity.details) return activity.details;
  return activity.name;
}

export function formatActivityElapsed(startedAt: string | undefined, nowMs = Date.now()): string | null {
  if (!startedAt) return null;
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedMs) || startedMs <= 0) return null;
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
