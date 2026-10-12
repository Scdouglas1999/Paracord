/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * The state a setup row is in.
 */
export type HostProgressState = 'run' | 'ok' | 'warn' | 'fail';
/**
 * A step of `host_setup_start` (spec §2.6). Row 3 (the account) runs in JS.
 */
export type HostSetupStep = 'install' | 'init' | 'service' | 'start' | 'storage' | 'reach' | 'backup';

/**
 * Tauri event `host://progress`.
 */
export interface HostProgress {
  /**
   * A machine-readable reason, e.g. a reachability state or exit code.
   */
  code?: string | null;
  detail?: string | null;
  /**
   * The setup row, 1-5.
   */
  row: number;
  state: HostProgressState;
  step: HostSetupStep;
  [k: string]: unknown | undefined;
}
