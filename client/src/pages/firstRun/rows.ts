import type { RowChip, RowState, SetupRow } from '../../stores/firstRunStore';

/**
 * The setup rows' words (docs/setup-spec.md §1.7, §2.6, §2.11, §4.6, §5.4) and
 * the sequencer that shows them in order.
 */

export const HOST_ROW_COPY = {
  1: {
    title: 'Starting Paracord on this computer',
    pending: 'It keeps running in the background, even with this window closed.',
  },
  2: {
    title: 'Encrypting everything it stores',
    pending: 'Messages and files are encrypted on disk. The key is kept in your system keychain.',
  },
  3: {
    title: 'Creating your encryption keys',
    pending: 'Private messages, voice and video are end-to-end encrypted.',
  },
  4: {
    title: 'Letting friends reach you',
    pending: 'Asking your router to open a port.',
  },
  5: {
    title: 'Turning on daily backups',
    pending: 'Kept on this computer for 14 days.',
  },
} as const;

export const STORAGE_UNENCRYPTED_FAIL = 'Paracord on this computer is running without encryption.';
export const CLAIM_STORAGE_OFF_WARN = "Stored messages and files are not encrypted on this server's disk. To turn it on, stop the server and run paracord-server encrypt-storage.";

/**
 * The host rows as they start (spec §1.7). Claim mode leaves out row 1 and
 * makes the account first (§2.11): the other rows are read from the server
 * after the claim, as its owner, so they come after it.
 */
export function hostRows(options: { claim: boolean; backupsDays?: number } = { claim: false }): SetupRow[] {
  const rows = options.claim ? ([3, 2, 4, 5] as const) : ([1, 2, 3, 4, 5] as const);
  return rows.map((row) => {
    const copy = HOST_ROW_COPY[row];
    const pending = row === 5 && options.backupsDays ? `Kept on this computer for ${options.backupsDays} days.` : copy.pending;
    return { row, title: copy.title, pending, state: 'waiting' as RowState };
  });
}

/** The join rows (spec §1.7). The web join has no row 1: the browser already did TLS (§6.6). */
export function joinRows(serverName: string, options: { web: boolean } = { web: false }): SetupRow[] {
  const all: SetupRow[] = [
    { row: 1, title: 'Connecting securely', pending: `Your connection to ${serverName} is encrypted.`, state: 'waiting' },
    { row: 2, title: 'Creating your encryption keys', pending: 'Private messages, voice and video are end-to-end encrypted.', state: 'waiting' },
    { row: 3, title: `Joining ${serverName}`, pending: "Getting channels and who's around.", state: 'waiting' },
  ];
  return options.web ? all.slice(1) : all;
}

/** The chips under a warned or failed row. */
export function chipsFor(row: number, state: RowState, code?: string): RowChip[] | undefined {
  if (state === 'fail') return ['retry-row', 'show-details'];
  if (state !== 'warn' || row !== 4) return undefined;
  switch (code) {
    case 'shared_address':
      return ['what-can-i-do'];
    case 'firewall_blocked':
      return ['allow'];
    default:
      return ['show-me-how', 'try-again'];
  }
}

/** The copy for the stored-data row and sheet by the server's protection label (spec §4.6). */
export function storageCopy(protection: string | null | undefined, encrypted: boolean): string {
  if (!encrypted) return "Not encrypted on this server's disk.";
  switch (protection) {
    case 'login':
      return "Encrypted on this computer's disk. The key lives in your system keychain.";
    case 'tpm':
      return "Encrypted on disk. The key is sealed to this machine's security chip.";
    case 'machine':
      return "Encrypted on disk. The key is protected by this machine's own credentials.";
    case 'same_disk':
      return 'Encrypted on disk, with the key stored on the same disk. This protects backups copied elsewhere, not a stolen disk.';
    default:
      return 'Encrypted on disk.';
  }
}

/** The minimum time a row is shown running, so the sequence reads (§1.7). */
export const MIN_RUN_MS = 300;

export interface RowTarget {
  state: RowState;
  detail?: string;
  code?: string;
}

/**
 * Shows the rows in order. Each row's real state is set as its work reports;
 * what is shown is held back so a row only runs once every row before it has
 * settled, and runs for at least `MIN_RUN_MS`. Nothing is padded beyond that:
 * a row that finished early is shown done the moment its turn and minimum are
 * over. A failed row stops the rows after it.
 */
export class RowSequencer {
  private readonly targets = new Map<number, RowTarget>();
  private readonly runSince = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private base: SetupRow[],
    private readonly publish: (rows: SetupRow[]) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    for (const row of base) this.targets.set(row.row, { state: 'waiting' });
  }

  set(row: number, target: RowTarget): void {
    if (this.stopped) return;
    this.targets.set(row, target);
    this.tick();
  }

  /** A row that does not apply after all (claim mode's reach row when the router is not asked). */
  drop(row: number): void {
    this.base = this.base.filter((r) => r.row !== row);
    this.targets.delete(row);
    this.tick();
  }

  target(row: number): RowTarget | undefined {
    return this.targets.get(row);
  }

  /** Every row's real state has settled (none waiting or running). */
  settled(): boolean {
    return [...this.targets.values()].every((t) => t.state !== 'waiting' && t.state !== 'run');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    let blocked = false;
    let wakeAt = Infinity;
    const shown: SetupRow[] = this.base.map((base) => {
      if (blocked) return { ...base, state: 'waiting' };
      const target = this.targets.get(base.row) ?? { state: 'waiting' as RowState };
      if (target.state === 'waiting') {
        blocked = true;
        return { ...base, state: 'waiting' };
      }
      const since = this.runSince.get(base.row) ?? now;
      if (!this.runSince.has(base.row)) this.runSince.set(base.row, since);
      if (target.state === 'run' || now - since < MIN_RUN_MS) {
        blocked = true;
        if (target.state !== 'run') wakeAt = Math.min(wakeAt, since + MIN_RUN_MS);
        return { ...base, state: 'run', startedAt: since };
      }
      if (target.state === 'fail') blocked = true;
      return {
        ...base,
        state: target.state,
        detail: target.detail ?? (target.state === 'ok' ? base.pending : undefined),
        code: target.code,
        chips: chipsFor(base.row, target.state, target.code),
      };
    });
    this.publish(shown);
    if (wakeAt !== Infinity) this.timer = setTimeout(() => this.tick(), Math.max(0, wakeAt - now));
  }
}
