/**
 * Typed wrappers for the desktop host commands (docs/setup-spec.md 9.5,
 * `client/src-tauri/src/host.rs`). Desktop only: every call rejects in a
 * browser, loudly, rather than pretending.
 */
import type { BackupNowResponse } from '../../api/generated/BackupNowResponse';
import type { HostPreflight } from '../../api/generated/HostPreflight';
import type { HostProgress } from '../../api/generated/HostProgress';
import type { HostStatus } from '../../api/generated/HostStatus';
import type { NewOwnerClaim } from '../../api/generated/NewOwnerClaim';
import { isTauri } from '../tauriEnv';
import type { HostInfo, HostLaunch } from './types';

export const HOST_PROGRESS_EVENT = 'host://progress';

async function core() {
  if (!isTauri()) throw new Error('Hosting a server needs the Paracord desktop app.');
  return import('@tauri-apps/api/core');
}

export async function hostPreflight(): Promise<HostPreflight> {
  const { invoke } = await core();
  return invoke<HostPreflight>('host_preflight');
}

/** Rows 1-2, and 4-5 once row 3 is recorded. Progress arrives as events. */
export async function hostSetupStart(port: number): Promise<void> {
  const { invoke } = await core();
  await invoke('host_setup_start', { port });
}

/** Returns the server's ClaimResponse JSON. */
export async function hostClaim(request: NewOwnerClaim): Promise<unknown> {
  const { invoke } = await core();
  return invoke('host_claim', { request });
}

/** `wrappingKey`: b64url of the 32-byte escrow key (spec 4.7). */
export async function hostWriteEscrow(wrappingKey: string): Promise<void> {
  const { invoke } = await core();
  await invoke('host_write_escrow', { wrappingKey });
}

export async function hostStatus(): Promise<HostStatus> {
  const { invoke } = await core();
  return invoke<HostStatus>('host_status');
}

export async function hostRetryReachability(): Promise<void> {
  const { invoke } = await core();
  await invoke('host_retry_reachability');
}

export async function hostBackupNow(): Promise<BackupNowResponse> {
  const { invoke } = await core();
  return invoke<BackupNowResponse>('host_backup_now');
}

export async function hostStart(): Promise<void> {
  const { invoke } = await core();
  await invoke('host_start');
}

export async function hostStop(): Promise<void> {
  const { invoke } = await core();
  await invoke('host_stop');
}

export async function hostSetAutostart(enabled: boolean): Promise<void> {
  const { invoke } = await core();
  await invoke('host_set_autostart', { enabled });
}

export async function hostRemove(deleteData: boolean): Promise<void> {
  const { invoke } = await core();
  await invoke('host_remove', { deleteData });
}

export async function hostLogsTail(lines: number): Promise<string> {
  const { invoke } = await core();
  return invoke<string>('host_logs_tail', { lines });
}

export async function hostRestore(archivePath: string, wrappingKey: string): Promise<void> {
  const { invoke } = await core();
  await invoke('host_restore', { archivePath, wrappingKey });
}

export async function hostInfo(): Promise<HostInfo> {
  const { invoke } = await core();
  return invoke<HostInfo>('host_info');
}

export async function hostOnLaunch(): Promise<HostLaunch> {
  const { invoke } = await core();
  return invoke<HostLaunch>('host_on_launch');
}

export async function hostRollbackUpdate(): Promise<void> {
  const { invoke } = await core();
  await invoke('host_rollback_update');
}

/** Windows only. */
export async function hostAllowFirewall(): Promise<'allowed' | 'declined'> {
  const { invoke } = await core();
  return invoke<'allowed' | 'declined'>('host_allow_firewall');
}

/** Listen to `host://progress`; resolves to the unlisten function. */
export async function listenHostProgress(handler: (event: HostProgress) => void): Promise<() => void> {
  if (!isTauri()) throw new Error('Hosting a server needs the Paracord desktop app.');
  const { listen } = await import('@tauri-apps/api/event');
  return listen<HostProgress>(HOST_PROGRESS_EVENT, (event) => handler(event.payload));
}
