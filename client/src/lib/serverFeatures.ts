import { create } from 'zustand';

import { isMissingRoute } from '../api/client';

/**
 * What an older server cannot do, learned from the server itself.
 *
 * Paracord is self-hosted, so a new client often talks to a server that is
 * older than it (a friend's instance that has not been updated). A feature that
 * needs a newer server is turned off for that server once the server shows it
 * lacks it: the route answers {@link isMissingRoute}, or a payload leaves out a
 * field this version always sends. The UI then hides or disables the feature
 * with the reason ({@link olderServerReason}); it never retries or substitutes
 * something else. This is protocol-version tolerance, not a fallback: there is
 * one path per server version.
 *
 * Only absences are recorded. Until a server shows a feature missing, it is
 * assumed present (the current server always has everything), so the record is
 * empty for a current server and nothing changes there.
 */
export type ServerFeature =
  /** Watching a stream without joining (`/api/v2/voice/{id}/view`, `/watchers`). */
  | 'voiceViews'
  /** The sidebar's message previews (`/guilds/{id}/channel-previews`). */
  | 'channelPreviews'
  /** Listening in (`listen_in_enabled` on a channel's features, `?mode=listen` joins). */
  | 'listenIn'
  /** Remind me (`/users/@me/reminders`, `/channels/{id}/messages/{id}/reminder`). */
  | 'reminders'
  /** Server settings > File storage (`/guilds/{id}/storage`, `/guilds/{id}/files`). */
  | 'fileStorage';

interface ServerFeatureState {
  /** serverId -> the features that server has shown it lacks. */
  missing: Record<string, Partial<Record<ServerFeature, true>>>;
  markMissing: (serverId: string, feature: ServerFeature) => void;
  /** Forget what a server lacked (it reconnected, and may have been updated meanwhile). */
  forget: (serverId: string) => void;
}

export const useServerFeatureStore = create<ServerFeatureState>()((set) => ({
  missing: {},
  markMissing: (serverId, feature) =>
    set((state) =>
      state.missing[serverId]?.[feature]
        ? state
        : { missing: { ...state.missing, [serverId]: { ...state.missing[serverId], [feature]: true } } },
    ),
  forget: (serverId) =>
    set((state) => {
      if (!state.missing[serverId]) return state;
      const { [serverId]: _forgotten, ...rest } = state.missing;
      return { missing: rest };
    }),
}));

/** Whether `serverId` has shown it lacks `feature`. */
export function serverLacks(serverId: string | null | undefined, feature: ServerFeature): boolean {
  return !!serverId && !!useServerFeatureStore.getState().missing[serverId]?.[feature];
}

/** The hook form of {@link serverLacks}. */
export function useServerLacks(serverId: string | null | undefined, feature: ServerFeature): boolean {
  return useServerFeatureStore((state) => !!serverId && !!state.missing[serverId]?.[feature]);
}

/**
 * Record `feature` as missing on `serverId` when `error` is the server saying the
 * route does not exist. Returns whether it was.
 */
export function noteMissingRoute(serverId: string | null | undefined, feature: ServerFeature, error: unknown): boolean {
  if (!serverId || !isMissingRoute(error)) return false;
  useServerFeatureStore.getState().markMissing(serverId, feature);
  return true;
}

/** What the UI says about a feature an older server lacks. */
export function olderServerReason(feature: ServerFeature): string {
  switch (feature) {
    case 'voiceViews':
      return 'This server runs an older version of Paracord. Join the call to watch.';
    case 'channelPreviews':
      return 'This server runs an older version of Paracord that has no message previews.';
    case 'listenIn':
      return 'This server runs an older version of Paracord that has no listening in. Join the call instead.';
    case 'reminders':
      return 'This server runs an older version of Paracord that has no reminders.';
    case 'fileStorage':
      return 'This server runs an older version of Paracord that cannot manage file storage. Update the server to see its usage and set an upload policy.';
  }
}

/** An operation refused because the server is too old for it (the message says so). */
export class OlderServerError extends Error {
  constructor(readonly feature: ServerFeature) {
    super(olderServerReason(feature));
    this.name = 'OlderServerError';
  }
}

/** For tests. */
export function resetServerFeaturesForTests(): void {
  useServerFeatureStore.setState({ missing: {} });
}
