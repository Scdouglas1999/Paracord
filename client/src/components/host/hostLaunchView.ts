import type { HostLaunch } from '../../lib/host/types';

/**
 * What the app says at launch about "Paracord on this computer"
 * (docs/setup-spec.md §2.8), from `useHostStore`'s `onLaunch()` result.
 * One strip at most; `null` when there is nothing to say.
 *
 * - An update that didn't come up: the spec's sentence, **Show details** and
 *   **Restore the backup from before the update**. Nothing is reverted until
 *   the person asks; it is said on every launch until then.
 * - While and after that restore: what is happening, then what it did (the new
 *   version is held, so it is not tried again on its own).
 * - An update that never started (the backup before it failed): nothing
 *   changed, said once.
 * - The storage key can't be opened (exit 78), or the server didn't start:
 *   the reason, **Show details** and **Try again**.
 */

export type RollbackState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done' } | { kind: 'failed'; error: string };

export type HostLaunchAction = 'details' | 'rollback' | 'start' | 'dismiss';

export interface HostLaunchView {
  id: string;
  text: string;
  tone: 'plain' | 'danger';
  role: 'status' | 'alert';
  /** The strip's main text action. */
  primary: { action: HostLaunchAction; label: string; disabled?: boolean } | null;
  /** Show details, inline before the main action. */
  details: boolean;
  dismissable: boolean;
}

export const HOST_LAUNCH_COPY = {
  updateFailed: "Paracord on this computer didn't start after the update.",
  rollback: 'Restore the backup from before the update',
  rollingBack: 'Restoring the backup from before the update…',
  rolledBack: (from: string, to: string) =>
    `Paracord on this computer is running ${from} again, with the backup from before the update. ${to} won't be installed again until a newer version comes out.`,
  rollbackFailed: (error: string) => `Restoring the backup from before the update didn't finish: ${error}`,
  notStarted: (detail: string) => `Paracord on this computer wasn't updated, and nothing changed: ${detail}`,
  storageKey: (reason: string) => `Paracord on this computer can't open its storage key: ${reason}`,
  startFailed: (reason: string) => `Paracord on this computer didn't start: ${reason}`,
} as const;

const strip = (reason: string) => reason.trim().replace(/\.$/, '');

export function hostLaunchView(launch: HostLaunch | null, rollback: RollbackState, starting = false): HostLaunchView | null {
  if (!launch) return null;
  const update = launch.update;
  const failure = update.kind === 'failed' ? { from: update.from, to: update.to } : launch.info.update_failure ? { from: launch.info.update_failure.from_version, to: launch.info.update_failure.to_version } : null;

  if (failure || rollback.kind !== 'idle') {
    const from = failure?.from ?? launch.info.installed_version ?? 'the previous version';
    const to = failure?.to ?? 'the new version';
    switch (rollback.kind) {
      case 'running':
        return { id: 'host-rollback', text: HOST_LAUNCH_COPY.rollingBack, tone: 'plain', role: 'status', primary: null, details: false, dismissable: false };
      case 'done':
        return { id: 'host-rolled-back', text: HOST_LAUNCH_COPY.rolledBack(from, to), tone: 'plain', role: 'status', primary: null, details: false, dismissable: true };
      case 'failed':
        return {
          id: 'host-rollback-failed',
          text: HOST_LAUNCH_COPY.rollbackFailed(strip(rollback.error)) + '.',
          tone: 'danger',
          role: 'alert',
          primary: { action: 'rollback', label: 'Try again' },
          details: true,
          dismissable: true,
        };
      default:
        return {
          id: 'host-update-failed',
          text: HOST_LAUNCH_COPY.updateFailed,
          tone: 'danger',
          role: 'alert',
          primary: { action: 'rollback', label: HOST_LAUNCH_COPY.rollback },
          details: true,
          dismissable: true,
        };
    }
  }

  if (update.kind === 'not_started') {
    return { id: 'host-update-not-started', text: HOST_LAUNCH_COPY.notStarted(strip(update.detail)) + '.', tone: 'plain', role: 'status', primary: null, details: false, dismissable: true };
  }

  const keyProblem = launch.info.storage_key_problem;
  if (keyProblem) {
    return {
      id: 'host-storage-key',
      text: HOST_LAUNCH_COPY.storageKey(strip(keyProblem)) + '.',
      tone: 'danger',
      role: 'alert',
      primary: { action: 'start', label: starting ? 'Starting…' : 'Try again', disabled: starting },
      details: true,
      dismissable: true,
    };
  }
  if (launch.start_error) {
    return {
      id: 'host-start-failed',
      text: HOST_LAUNCH_COPY.startFailed(strip(launch.start_error)) + '.',
      tone: 'danger',
      role: 'alert',
      primary: { action: 'start', label: starting ? 'Starting…' : 'Try again', disabled: starting },
      details: true,
      dismissable: true,
    };
  }
  return null;
}
