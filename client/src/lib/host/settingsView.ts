/**
 * Settings › "Paracord on this computer" (docs/setup-spec.md §2.9) as data:
 * what each row says for a given `host_info` + `host_status`, which tone it is
 * drawn in and which actions it offers. Pure, so every state is unit tested;
 * the page (`components/host/HostSettingsSection.tsx`) only draws it.
 *
 * Copy comes from the spec: §2.9 (status words, the switch), §5.4 "Elsewhere"
 * (reachability), §4.6 (stored data), §4.7 (the recovery copy of the key),
 * §2.8 (an update that didn't come up). Nothing here claims more than the
 * service manager, the running server or the router reported.
 */
import { formatDistance } from 'date-fns';

import type { BackupStatus, HostStatus, Reachability, StorageStatus } from '../../api/generated/HostStatus';
import { storageCopy } from '../../pages/firstRun/rows';
import { HOST_ROW_COPY, publicAddress, reachabilityCopy } from './rows';
import type { HostInfo } from './types';

export type Tone = 'ok' | 'warn' | 'fail' | 'plain';

/* ---- Status (§2.9: Running / Stopped / Starting / Can't start + reason) ---- */

export type ServiceView =
  | { kind: 'running'; label: 'Running'; tone: 'ok'; reason: null }
  | { kind: 'starting'; label: 'Starting'; tone: 'plain'; reason: null }
  | { kind: 'stopping'; label: 'Stopping'; tone: 'plain'; reason: null }
  | { kind: 'stopped'; label: 'Stopped'; tone: 'warn'; reason: string }
  | { kind: 'cant_start'; label: "Can't start"; tone: 'fail'; reason: string }
  | { kind: 'unknown'; label: "Can't tell"; tone: 'fail'; reason: string };

/** What the page is doing right now: a Start or Stop the person pressed and is waiting on. */
export type PendingAction = 'start' | 'stop' | null;

const sentence = (text: string) => {
  const trimmed = text.trim().replace(/[.\s]+$/, '');
  return trimmed ? `${trimmed}.` : '';
};

/**
 * The status line. `startError` is the reason the last **Start** pressed on
 * this page (or at launch) failed; it is the most specific reason there is.
 */
export function serviceView(info: HostInfo, pending: PendingAction, startError: string | null): ServiceView {
  if (pending === 'start') return { kind: 'starting', label: 'Starting', tone: 'plain', reason: null };
  if (pending === 'stop') return { kind: 'stopping', label: 'Stopping', tone: 'plain', reason: null };
  if (!info.service) {
    return {
      kind: 'unknown',
      label: "Can't tell",
      tone: 'fail',
      reason: info.service_error
        ? `Paracord couldn't ask this computer whether it's running: ${sentence(info.service_error)}`
        : "Paracord couldn't ask this computer whether it's running.",
    };
  }
  if (info.storage_key_problem) {
    return { kind: 'cant_start', label: "Can't start", tone: 'fail', reason: `It can't open its storage key: ${sentence(info.storage_key_problem)}` };
  }
  if (info.port_problem && info.service.state !== 'running' && info.service.state !== 'starting') {
    return { kind: 'cant_start', label: "Can't start", tone: 'fail', reason: sentence(info.port_problem) };
  }
  switch (info.service.state) {
    case 'running':
      return { kind: 'running', label: 'Running', tone: 'ok', reason: null };
    case 'starting':
      return { kind: 'starting', label: 'Starting', tone: 'plain', reason: null };
    case 'failed':
      return {
        kind: 'cant_start',
        label: "Can't start",
        tone: 'fail',
        reason: startError
          ? sentence(startError)
          : info.service.exit_code !== null
            ? `It stopped with exit code ${info.service.exit_code}. Show logs says why.`
            : 'It stopped. Show logs says why.',
      };
    case 'not_installed':
      return {
        kind: 'cant_start',
        label: "Can't start",
        tone: 'fail',
        reason: "Its background service isn't registered on this computer. Remove Paracord from this computer and set it up again from the first-run screen.",
      };
    case 'stopped':
    default:
      if (startError) return { kind: 'cant_start', label: "Can't start", tone: 'fail', reason: sentence(startError) };
      return {
        kind: 'stopped',
        label: 'Stopped',
        tone: 'warn',
        reason: 'Nobody can reach the server until it starts again, you included.',
      };
  }
}

/** Start is offered when it isn't running; Stop when it is (or is coming up). */
export function serviceActions(view: ServiceView): { start: boolean; stop: boolean } {
  switch (view.kind) {
    case 'running':
      return { start: false, stop: true };
    case 'starting':
    case 'stopping':
      return { start: false, stop: false };
    case 'stopped':
    case 'cant_start':
      return { start: true, stop: false };
    case 'unknown':
    default:
      return { start: true, stop: true };
  }
}

/* ---- Reachability (§5.4, the "Elsewhere" column) -------------------------- */

export type ReachChip = 'show_me_how' | 'try_again' | 'what_can_i_do' | 'allow';

export interface ReachView {
  tone: Tone;
  text: string;
  /** A second line: an outside connection seen, or "checks again every minute". */
  note: string | null;
  chips: ReachChip[];
  /** Which sheet **Show me how** opens. */
  sheet: 'refused' | 'no_answer' | null;
  /** A quiet "Check the router again" where no chip already asks again. */
  recheck: boolean;
  /** Which address invite links use, and how to give out another one (`public_url`). */
  linkHint?: string | null;
}

/**
 * The address invite links carry, and the one override there is: a domain name
 * (or any address) set as `public_url` in the server's config file.
 */
export function inviteAddressHint(reach: Reachability): string | null {
  if (reach.state === 'asking' || reach.state === 'off') return null;
  const ip = publicAddress(reach);
  const uses = ip ? `your public address, ${ip}` : 'your address on the home network';
  return `Invite links use ${uses}. To give out a domain name instead, set public_url under [server] in the server's paracord.toml and restart it.`;
}

/** `now` and `confirmed_at` are compared for "… {relative time}." */
export function reachView(reach: Reachability, now: number): ReachView {
  return { ...reachViewWithoutHint(reach, now), linkHint: inviteAddressHint(reach) };
}

function reachViewWithoutHint(reach: Reachability, now: number): ReachView {
  if (reach.state === 'asking') {
    return { tone: 'plain', text: HOST_ROW_COPY[4].pending, note: null, chips: [], sheet: null, recheck: false };
  }
  const { tone, text } = reachabilityCopy(reach);
  switch (reach.state) {
    case 'open':
    case 'direct': {
      const confirmed = reach.confirmed_at ? Date.parse(reach.confirmed_at) : Number.NaN;
      const note = Number.isFinite(confirmed)
        ? `A friend connected from outside ${formatDistance(confirmed, now, { addSuffix: true })}.`
        : null;
      return { tone, text, note, chips: [], sheet: null, recheck: true };
    }
    case 'refused':
    case 'no_answer': {
      const confirmed = reach.confirmed_at ? Date.parse(reach.confirmed_at) : Number.NaN;
      if (tone === 'ok' && Number.isFinite(confirmed)) {
        return {
          tone,
          text,
          note: `A friend connected from outside ${formatDistance(confirmed, now, { addSuffix: true })}.`,
          chips: [],
          sheet: null,
          recheck: true,
        };
      }
      return {
        tone,
        text,
        note: 'Paracord checks again every minute.',
        chips: ['show_me_how', 'try_again'],
        sheet: reach.state,
        recheck: false,
      };
    }
    case 'shared_address':
      return { tone, text, note: 'Paracord checks again every minute.', chips: ['what_can_i_do'], sheet: null, recheck: true };
    case 'firewall_blocked':
      return { tone, text, note: null, chips: ['allow'], sheet: null, recheck: true };
    case 'off':
    default:
      return { tone: 'warn', text, note: null, chips: [], sheet: null, recheck: false };
  }
}

/** While the router is being asked, the page reads the status again (≤ 15 s, spec 2.6 row 4). */
export const reachIsSettling = (reach: Reachability | null | undefined): boolean => reach?.state === 'asking';

/* ---- Stored data and the recovery copy of its key (§4.6, §4.7) ----------- */

export interface StorageView {
  tone: Tone;
  text: string;
  /** Absent when nothing is encrypted (there is no key to keep a copy of). */
  escrow: { tone: Tone; text: string; canSave: boolean } | null;
}

export const ESCROW_COPY = {
  saved:
    "Your recovery phrase can also unlock this server's storage key, so its backups can be restored on another computer.",
  missing:
    "Your recovery phrase can't unlock this server's storage key yet. Until it can, its backups can only be restored on this computer.",
  saveNow: 'Save it now',
  saved_now: 'Saved. Your recovery phrase can now restore this server on another computer.',
  /** The page can't derive the key: the account isn't unlocked here, or this app isn't signed in to this computer's server. */
  needsUnlock: "Sign in to this computer's server with the account that set it up, then try again.",
} as const;

export function storageView(storage: StorageStatus): StorageView {
  const encrypted = storage.enabled && storage.sqlite_encrypted && storage.files_encrypted;
  const text = storageCopy(storage.protection, encrypted);
  if (!encrypted) return { tone: 'warn', text, escrow: null };
  return {
    tone: 'ok',
    text,
    escrow: storage.escrowed
      ? { tone: 'ok', text: ESCROW_COPY.saved, canSave: false }
      : { tone: 'warn', text: ESCROW_COPY.missing, canSave: true },
  };
}

/* ---- Backups (§2.9: last backup time, Back up now) ------------------------ */

export interface BackupView {
  tone: Tone;
  text: string;
  note: string;
}

export function backupView(backups: BackupStatus, now: number): BackupView {
  const kept = `Kept on this computer for ${backups.keep} days.`;
  const note = backups.enabled ? `Daily. ${kept}` : 'Daily backups are off. Turn them on in Privacy › What’s protected.';
  if (backups.last_error) {
    return { tone: 'fail', text: `The last backup didn't finish: ${sentence(backups.last_error)}`, note };
  }
  const last = backups.last_backup_at ? Date.parse(backups.last_backup_at) : Number.NaN;
  if (!Number.isFinite(last)) return { tone: backups.enabled ? 'plain' : 'warn', text: 'No backup yet.', note };
  return {
    tone: backups.enabled ? 'ok' : 'warn',
    text: `Last backup ${formatDistance(last, now, { addSuffix: true })}.`,
    note,
  };
}

/* ---- The whole page ------------------------------------------------------- */

export interface HostSettingsView {
  service: ServiceView;
  actions: { start: boolean; stop: boolean };
  /** "Version 3.5.0 · port 8443". */
  facts: string;
  /** Rows that need the running server; null while it isn't answering (with why). */
  live:
    | {
        reach: ReachView;
        storage: StorageView;
        backups: BackupView;
        fingerprint: string;
      }
    | null;
  /** Why the live rows are missing. */
  liveMissing: string | null;
  /** An update that didn't come up (§2.8), or one held back after a restore. */
  update: { kind: 'failed'; text: string } | { kind: 'held'; text: string } | null;
}

export const UPDATE_COPY = {
  failed: "Paracord on this computer didn't start after the update.",
  rollback: 'Restore the backup from before the update',
  held: (version: string) =>
    `Version ${version} didn't start here, so it won't be installed again until a newer version comes out.`,
} as const;

export function hostSettingsView(input: {
  info: HostInfo;
  status: HostStatus | null;
  statusError: string | null;
  pending: PendingAction;
  startError: string | null;
  now: number;
}): HostSettingsView {
  const { info, status, statusError, pending, startError, now } = input;
  const service = serviceView(info, pending, startError);
  const version = status?.version ?? info.installed_version;
  const facts = [version ? `Version ${version}` : null, info.port ? `port ${info.port}` : null].filter(Boolean).join(' · ');

  const answering = service.kind === 'running' && status !== null;
  const live = answering
    ? {
        reach: reachView(status.reachability, now),
        storage: storageView(status.storage),
        backups: backupView(status.backups, now),
        fingerprint: status.tls.fingerprint_sha256,
      }
    : null;
  let liveMissing: string | null = null;
  if (!live) {
    if (service.kind === 'running') {
      liveMissing = statusError
        ? `It's running but didn't answer: ${sentence(statusError)}`
        : 'Reading what it reports…';
    } else {
      liveMissing = 'Who can reach it, its words, its storage and its backups show here while it runs.';
    }
  }

  let update: HostSettingsView['update'] = null;
  if (info.update_failure) update = { kind: 'failed', text: UPDATE_COPY.failed };
  else if (info.held_version) update = { kind: 'held', text: UPDATE_COPY.held(info.held_version) };

  return { service, actions: serviceActions(service), facts, live, liveMissing, update };
}

/* ---- Remove (§2.9) -------------------------------------------------------- */

/**
 * "Also delete the server's data" needs the server's name typed exactly
 * (trimmed; case matters less than intent, so it is compared case-insensitively).
 */
export function removeConfirmed(deleteData: boolean, typed: string, serverName: string): boolean {
  if (!deleteData) return true;
  const want = serverName.trim();
  return want.length > 0 && typed.trim().toLocaleLowerCase() === want.toLocaleLowerCase();
}
