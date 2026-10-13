/**
 * "Paracord on this computer" on the client: preflight, the setup rows the
 * first run renders (docs/setup-spec.md 1.7, 2.6), launch supervision and the
 * Settings actions (2.8, 2.9). Desktop only; everything goes through the
 * typed commands in `lib/host/commands.ts`.
 *
 * Setup: `runSetup({ port, account })` runs rows 1-2 in Rust, then row 3 by
 * calling `account()` (the page's identity + credential + `claim` +
 * `writeEscrow`), then rows 4-5 in Rust. Each row is shown running for at
 * least 300 ms so the sequence reads; nothing else is delayed. A failed row
 * stops the run; **Try again** is `retry()`, which resumes at that row.
 *
 * No polling: status is read when a page asks (`loadStatus`, `loadInfo`).
 */
import { create } from 'zustand';
import type { BackupNowResponse } from '../api/generated/BackupNowResponse';
import type { HostPreflight } from '../api/generated/HostPreflight';
import type { HostProgress } from '../api/generated/HostProgress';
import type { HostStatus } from '../api/generated/HostStatus';
import type { NewOwnerClaim } from '../api/generated/NewOwnerClaim';
import * as commands from '../lib/host/commands';
import {
  applyProgress,
  initialHostRows,
  setAccountRow,
  type HostRow,
  type HostRowId,
} from '../lib/host/rows';
import type { HostInfo, HostLaunch } from '../lib/host/types';
import type { BackupFile } from './firstRunStore';

/** Spec 1.7: each row is shown in `run` for at least this long. */
export const MIN_RUN_MS = 300;
/** How long to wait for trailing events after a setup call resolves. */
const SETTLE_MS = 2000;

export type HostSetupPhase =
  | 'idle'
  | 'running'
  /** Rows 1-2 done; row 3 (the page's account work) is running. */
  | 'account'
  | 'done'
  | 'failed';

export interface HostSetupArgs {
  port: number;
  /**
   * Row 3: create the identity and credential, `claim()`, publish prekeys and
   * `writeEscrow()`. Reject with an Error whose message is the row's detail.
   */
  account: () => Promise<void>;
}

interface HostStoreState {
  preflight: HostPreflight | null;
  preflightError: string | null;
  rows: HostRow[];
  phase: HostSetupPhase;
  /** The error that stopped a setup call outside a row (app state unreadable). */
  setupError: string | null;
  info: HostInfo | null;
  status: HostStatus | null;
  launch: HostLaunch | null;
  error: string | null;
  runPreflight: () => Promise<HostPreflight | null>;
  runSetup: (args: HostSetupArgs) => Promise<HostSetupPhase>;
  /** **Try again** on a failed row: resume with the last arguments. */
  retry: () => Promise<HostSetupPhase>;
  claim: (request: NewOwnerClaim) => Promise<unknown>;
  /** The escrow body (`EscrowRequest` in pages/firstRun/escrow.ts). */
  writeEscrow: (request: { wrapping_key: string; owner_public_key: string }) => Promise<void>;
  retryReachability: () => Promise<void>;
  allowFirewall: () => Promise<'allowed' | 'declined' | null>;
  loadInfo: () => Promise<HostInfo | null>;
  loadStatus: () => Promise<HostStatus | null>;
  onLaunch: () => Promise<HostLaunch | null>;
  backupNow: () => Promise<BackupNowResponse | null>;
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  setAutostart: (enabled: boolean) => Promise<boolean>;
  remove: (deleteData: boolean) => Promise<boolean>;
  logsTail: (lines?: number) => Promise<string>;
  rollbackUpdate: () => Promise<boolean>;
  /** The system file picker for a backup (null: closed). Rejects with the reason the file can't be used. */
  pickBackup: () => Promise<BackupFile | null>;
  /**
   * Restore a backup on this computer (spec §4.8): install, init, the
   * restore with the escrow key on stdin. Resets the rows; rows 1-5 then run
   * through `runSetup`. Rejects with the reason.
   */
  restore: (archivePath: string, wrappingKey: string) => Promise<void>;
  reset: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let lastArgs: HostSetupArgs | null = null;

/**
 * Applies progress events in order, holding a row's terminal event until it
 * has been `run` for MIN_RUN_MS.
 */
function createPacer(apply: (event: HostProgress) => void) {
  const runSince = new Map<number, number>();
  let chain: Promise<void> = Promise.resolve();
  return {
    push(event: HostProgress) {
      chain = chain.then(async () => {
        if (event.state === 'run') {
          if (!runSince.has(event.row)) runSince.set(event.row, Date.now());
        } else {
          const since = runSince.get(event.row);
          if (since !== undefined) {
            const wait = MIN_RUN_MS - (Date.now() - since);
            if (wait > 0) await sleep(wait);
          }
          runSince.delete(event.row);
        }
        apply(event);
      });
    },
    idle: () => chain,
  };
}

export const useHostStore = create<HostStoreState>()((set, get) => {
  const rowState = (row: HostRowId) => get().rows.find((r) => r.row === row)?.state;
  const anyFailed = () => get().rows.some((r) => r.state === 'fail');

  /** Wait until `done()` holds, or SETTLE_MS passes (trailing events). */
  const settle = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      if (done()) return resolve();
      const timer = setTimeout(() => {
        unsubscribe();
        resolve();
      }, SETTLE_MS);
      const unsubscribe = useHostStore.subscribe(() => {
        if (!done()) return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });

  /** One `host_setup_start` with the progress listener attached. */
  const setupCall = async (port: number, until: () => boolean) => {
    const pacer = createPacer((event) => set((s) => ({ rows: applyProgress(s.rows, event) })));
    const unlisten = await commands.listenHostProgress((event) => pacer.push(event));
    try {
      await commands.hostSetupStart(port);
      await settle(() => until() || anyFailed());
      await pacer.idle();
    } finally {
      unlisten();
    }
  };

  const terminal = (row: HostRowId) => {
    const state = rowState(row);
    return state === 'ok' || state === 'warn' || state === 'fail';
  };

  return {
    preflight: null,
    preflightError: null,
    rows: initialHostRows(),
    phase: 'idle',
    setupError: null,
    info: null,
    status: null,
    launch: null,
    error: null,

    async runPreflight() {
      set({ preflightError: null });
      try {
        const preflight = await commands.hostPreflight();
        set({ preflight });
        return preflight;
      } catch (err) {
        set({ preflight: null, preflightError: message(err) });
        return null;
      }
    },

    async runSetup(args) {
      lastArgs = args;
      // Rows that failed run again; finished ones come back as ok from Rust.
      set((s) => ({
        phase: 'running',
        setupError: null,
        rows: s.rows.map((row) => (row.state === 'fail' ? { ...initialHostRows()[row.row - 1] } : row)),
      }));
      try {
        const info = await commands.hostInfo().catch(() => null);
        const accountDone = info?.completed_steps.includes('escrow') ?? false;

        if (!(accountDone && terminal(5))) {
          await setupCall(args.port, () => terminal(2) && (!accountDone || terminal(5)));
        }
        if (anyFailed()) {
          set({ phase: 'failed' });
          return 'failed';
        }
        if (accountDone) {
          set((s) => ({ rows: setAccountRow(s.rows, 'ok') }));
        } else {
          set((s) => ({ phase: 'account', rows: setAccountRow(s.rows, 'run') }));
          const since = Date.now();
          try {
            await args.account();
          } catch (err) {
            set((s) => ({ phase: 'failed', rows: setAccountRow(s.rows, 'fail', message(err)) }));
            return 'failed';
          }
          const wait = MIN_RUN_MS - (Date.now() - since);
          if (wait > 0) await sleep(wait);
          set((s) => ({ phase: 'running', rows: setAccountRow(s.rows, 'ok') }));
          await setupCall(args.port, () => terminal(5));
        }
        const phase: HostSetupPhase = anyFailed() ? 'failed' : 'done';
        set({ phase });
        return phase;
      } catch (err) {
        set({ phase: 'failed', setupError: message(err) });
        return 'failed';
      }
    },

    async retry() {
      if (!lastArgs) throw new Error('Setup has not started.');
      return get().runSetup(lastArgs);
    },

    claim: (request) => commands.hostClaim(request),
    writeEscrow: (request) => commands.hostWriteEscrow(request),

    async retryReachability() {
      const pacer = createPacer((event) => set((s) => ({ rows: applyProgress(s.rows, event) })));
      const unlisten = await commands.listenHostProgress((event) => pacer.push(event));
      try {
        await commands.hostRetryReachability();
        await settle(() => rowState(4) !== 'run');
        await pacer.idle();
        set({ error: null });
      } catch (err) {
        set({ error: message(err) });
      } finally {
        unlisten();
      }
      await get().loadStatus();
    },

    async allowFirewall() {
      try {
        const outcome = await commands.hostAllowFirewall();
        if (outcome === 'allowed') await get().retryReachability();
        return outcome;
      } catch (err) {
        set({ error: message(err) });
        return null;
      }
    },

    async loadInfo() {
      try {
        const info = await commands.hostInfo();
        set({ info });
        return info;
      } catch (err) {
        set({ error: message(err) });
        return null;
      }
    },

    async loadStatus() {
      try {
        const status = await commands.hostStatus();
        set({ status, error: null });
        return status;
      } catch (err) {
        set({ status: null, error: message(err) });
        return null;
      }
    },

    async onLaunch() {
      try {
        const launch = await commands.hostOnLaunch();
        set({ launch, info: launch.info });
        return launch;
      } catch (err) {
        set({ error: message(err) });
        return null;
      }
    },

    async backupNow() {
      try {
        return await commands.hostBackupNow();
      } catch (err) {
        set({ error: message(err) });
        return null;
      }
    },

    async start() {
      return action(set, get, commands.hostStart);
    },
    async stop() {
      return action(set, get, commands.hostStop);
    },
    async setAutostart(enabled) {
      return action(set, get, () => commands.hostSetAutostart(enabled));
    },
    async remove(deleteData) {
      return action(set, get, () => commands.hostRemove(deleteData));
    },
    async rollbackUpdate() {
      return action(set, get, commands.hostRollbackUpdate);
    },

    logsTail: (lines = 200) => commands.hostLogsTail(lines),

    pickBackup: () => commands.hostPickBackup(),

    async restore(archivePath, wrappingKey) {
      lastArgs = null;
      set({ rows: initialHostRows(), phase: 'idle', setupError: null });
      await commands.hostRestore(archivePath, wrappingKey);
    },

    reset() {
      lastArgs = null;
      set({
        preflight: null,
        preflightError: null,
        rows: initialHostRows(),
        phase: 'idle',
        setupError: null,
        info: null,
        status: null,
        launch: null,
        error: null,
      });
    },
  };
});

/** Run a Settings action, record its error, refresh `info`. */
async function action(
  set: (partial: Partial<HostStoreState>) => void,
  get: () => HostStoreState,
  run: () => Promise<void>,
): Promise<boolean> {
  try {
    await run();
    set({ error: null });
    await get().loadInfo();
    return true;
  } catch (err) {
    set({ error: message(err) });
    await get().loadInfo();
    return false;
  }
}
