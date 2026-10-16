/**
 * The host setup rows (docs/setup-spec.md 1.7, 2.6) as data the first-run
 * page renders: title, the line under it, the state of the status circle and
 * the chips. `applyProgress` folds one `host://progress` event into the rows;
 * row 3 (the account) is driven by the page through `setAccountRow`.
 *
 * Copy lives here once: the setup screen, Settings and claim mode share it.
 */
import type { HostPreflightReason } from '../../api/generated/HostPreflight';
import type { HostProgress, HostSetupStep } from '../../api/generated/HostProgress';
import type { Reachability } from '../../api/generated/HostStatus';

export type HostRowId = 1 | 2 | 3 | 4 | 5;
export type HostRowState = 'waiting' | 'run' | 'ok' | 'warn' | 'fail';
/** Chips under a warn/fail row (spec 1.7, 5.4). */
export type HostRowChip = 'show_me_how' | 'try_again' | 'show_details' | 'what_can_i_do' | 'allow';

export interface HostRow {
  row: HostRowId;
  title: string;
  /** The line under the title for the current state. */
  detail: string;
  state: HostRowState;
  /** The step the row is on (row 1 has four). */
  step: HostSetupStep | 'account' | null;
  /** Machine reason: a reachability state, `start_timeout`, `storage_key`, ... */
  code: string | null;
  chips: HostRowChip[];
}

interface RowCopy {
  title: string;
  pending: string;
  done: string;
}

export const HOST_ROW_COPY: Record<HostRowId, RowCopy> = {
  1: {
    title: 'Starting Paracord on this computer',
    pending: 'It keeps running in the background, even with this window closed.',
    done: 'It keeps running in the background, even with this window closed.',
  },
  2: {
    title: 'Encrypting everything it stores',
    pending: 'Messages and files are encrypted on disk. The key is kept in your system keychain.',
    done: 'Messages and files are encrypted on disk. The key is kept in your system keychain.',
  },
  3: {
    title: 'Creating your encryption keys',
    pending: 'Private messages, voice and video are end-to-end encrypted.',
    done: 'Private messages, voice and video are end-to-end encrypted.',
  },
  4: {
    title: 'Letting friends reach you',
    pending: 'Asking your router to open a port.',
    done: 'Asking your router to open a port.',
  },
  5: {
    title: 'Turning on daily backups',
    pending: 'Kept on this computer for 14 days.',
    done: 'Kept on this computer for 14 days.',
  },
};

/** The step that ends each Rust row (row 1 runs install, init, service, start). */
const LAST_STEP: Partial<Record<HostRowId, HostSetupStep>> = {
  1: 'start',
  2: 'storage',
  4: 'reach',
  5: 'backup',
};

export function initialHostRows(): HostRow[] {
  return ([1, 2, 3, 4, 5] as HostRowId[]).map((row) => ({
    row,
    title: HOST_ROW_COPY[row].title,
    detail: HOST_ROW_COPY[row].pending,
    state: 'waiting',
    step: null,
    code: null,
    chips: [],
  }));
}

/** Row 4's chips for a warning code (spec 5.4). */
export function reachChips(code: string | null): HostRowChip[] {
  switch (code) {
    case 'shared_address':
      return ['what_can_i_do'];
    case 'firewall_blocked':
      return ['allow'];
    case 'off':
      return [];
    default:
      // refused, no_answer, asking (no answer in time), status_unavailable
      return ['show_me_how', 'try_again'];
  }
}

function isRowId(row: number): row is HostRowId {
  return row === 1 || row === 2 || row === 3 || row === 4 || row === 5;
}

/** Fold one `host://progress` event into the rows (a new array). */
export function applyProgress(rows: HostRow[], event: HostProgress): HostRow[] {
  if (!isRowId(event.row)) return rows;
  const id = event.row;
  const copy = HOST_ROW_COPY[id];
  const code = event.code ?? null;
  return rows.map((row): HostRow => {
    if (row.row !== id) return row;
    switch (event.state) {
      case 'run':
        return { ...row, state: 'run', step: event.step, detail: copy.pending, code: null, chips: [] };
      case 'ok':
        // An inner step of row 1 finishing keeps the row running.
        if (LAST_STEP[id] !== event.step) return { ...row, state: 'run', step: event.step };
        return { ...row, state: 'ok', step: event.step, detail: event.detail ?? copy.done, code, chips: [] };
      case 'warn':
        return {
          ...row,
          state: 'warn',
          step: event.step,
          detail: event.detail ?? copy.pending,
          code,
          chips: id === 4 ? reachChips(code) : [],
        };
      case 'fail':
        return {
          ...row,
          state: 'fail',
          step: event.step,
          detail: event.detail ?? copy.pending,
          code,
          chips: ['try_again', 'show_details'],
        };
      default:
        return row;
    }
  });
}

/** Row 3 is the page's (identity + credential + claim + escrow). */
export function setAccountRow(rows: HostRow[], state: 'run' | 'ok' | 'fail', detail?: string): HostRow[] {
  const copy = HOST_ROW_COPY[3];
  return rows.map((row) =>
    row.row !== 3
      ? row
      : {
          ...row,
          state,
          step: 'account',
          detail: state === 'run' ? copy.pending : state === 'ok' ? copy.done : (detail ?? copy.pending),
          code: state === 'fail' ? 'account_failed' : null,
          chips: state === 'fail' ? ['try_again'] : [],
        },
  );
}

/** Continue is enabled when no row is waiting, running or failed (spec 1.7). */
export function setupCanContinue(rows: HostRow[]): boolean {
  return rows.every((row) => row.state === 'ok' || row.state === 'warn');
}

/** The preview's status line follows row 1 (spec 1.7). */
export function previewStatus(rows: HostRow[]): 'not_running' | 'starting' | 'online' {
  const row1 = rows.find((row) => row.row === 1);
  if (!row1 || row1.state === 'waiting' || row1.state === 'fail') return 'not_running';
  return row1.state === 'ok' ? 'online' : 'starting';
}

/** A public IPv4 address (not private, carrier-grade NAT, loopback, link-local or reserved). */
function isPublicIpv4(text: string | null | undefined): text is string {
  const parts = (text ?? '').trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * The public address friends would use: the router's own report when it is
 * public, else what a STUN server saw (`observed_ip`). Null when neither is.
 */
export function publicAddress(reach: Reachability): string | null {
  if (isPublicIpv4(reach.external_ip)) return reach.external_ip.trim();
  if (isPublicIpv4(reach.observed_ip)) return reach.observed_ip.trim();
  return null;
}

/** Row 4 / Settings / Invite sheet copy for a reachability state (spec 5.4). */
export function reachabilityCopy(reach: Reachability): { tone: 'ok' | 'warn'; text: string } {
  const ip = reach.external_ip ?? 'your public address';
  const outside = publicAddress(reach);
  // Someone outside already got through on that address (a port forwarded by
  // hand): the router's silence no longer matters.
  if (outside && reach.confirmed_at && (reach.state === 'refused' || reach.state === 'no_answer')) {
    return { tone: 'ok', text: `Friends can reach you at ${outside}.` };
  }
  switch (reach.state) {
    case 'open':
      return { tone: 'ok', text: `Your router opened the way. Friends can reach you at ${ip}.` };
    case 'direct':
      return {
        tone: 'ok',
        text: `This computer has its own public address (${ip}). Friends can reach it if your firewall allows port ${reach.port}.`,
      };
    case 'refused':
      return {
        tone: 'warn',
        text: outside
          ? `Your router didn't allow it. Once port ${reach.port} is forwarded on your router, friends will reach you at ${outside}; people on your home network can join now.`
          : "Your router didn't allow it, so for now only people on your home network can join.",
      };
    case 'no_answer':
    case 'asking':
      return {
        tone: 'warn',
        text: outside
          ? `Your router didn't answer. Once port ${reach.port} is forwarded on your router, friends will reach you at ${outside}; people on your home network can join now.`
          : "Your router didn't answer, so for now only people on your home network can join.",
      };
    case 'shared_address':
      return {
        tone: 'warn',
        text: "Your internet connection shares its public address with others (your provider, or another router in front of yours), so friends outside can't reach this computer. People on your home network can join.",
      };
    case 'firewall_blocked':
      return { tone: 'warn', text: 'Windows Firewall is blocking friends.' };
    case 'off':
    default:
      return { tone: 'warn', text: "Paracord isn't asking your router to let friends in." };
  }
}

/** The Name screen's blocking notice per preflight reason (spec 2.3). */
export const PREFLIGHT_COPY: Record<Exclude<HostPreflightReason, 'already_hosting'>, string> = {
  no_user_services:
    "Hosting from this computer needs systemd user services, which this system doesn't run. You can still host with the server installer: paracord.chat/docs/host.",
  no_keychain:
    "Paracord keeps the key that encrypts your server in your system keychain, and this computer doesn't have one running. Install or turn on GNOME Keyring or KWallet, then try again.",
  existing_server: 'Paracord is already running on this computer.',
  no_port: 'Every port Paracord could use (8443 to 8463) is taken.',
  no_space: 'This computer needs at least 1 GB free to host a server.',
};

/** Settings status line copy for an update that didn't come up (spec 2.8). */
export const UPDATE_FAILED_COPY = "Paracord on this computer didn't start after the update.";
