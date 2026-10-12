/**
 * Types of the desktop host commands that are not wire contracts
 * (`paracord-hostctl`'s `HostInfo`, `HostLaunch`, `UpdateOutcome`,
 * `ServiceStatus`). The wire types (`HostStatus`, `HostPreflight`,
 * `HostProgress`, ...) are generated from Rust in `api/generated`.
 */

export type ServiceState = 'not_installed' | 'stopped' | 'starting' | 'running' | 'failed';

export interface ServiceStatus {
  state: ServiceState;
  /** Starts when the person signs in to this computer. */
  enabled: boolean;
  /** 78 = the storage key was unavailable. */
  exit_code: number | null;
}

export interface UpdateRecord {
  from_version: string;
  to_version: string;
  backup_name: string;
  failure?: string;
}

/** `host_info()`: host.json plus the live service state (spec 2.9). */
export interface HostInfo {
  enabled: boolean;
  port: number | null;
  autostart: boolean;
  installed_version: string | null;
  completed_steps: string[];
  service: ServiceStatus | null;
  service_error: string | null;
  /** `https://127.0.0.1:<port>`, the host's own home server entry. */
  home_url: string | null;
  /** Exit 78: why the server can't open its storage key. */
  storage_key_problem: string | null;
  /** An update that didn't come up: show the banner (spec 2.8). */
  update_failure: UpdateRecord | null;
  held_version: string | null;
  /** The hosted server's instance id: the info of the owner's escrow key (spec §4.7). */
  instance_id?: string | null;
}

export type UpdateOutcome =
  | { kind: 'none' }
  | { kind: 'updated'; from: string; to: string }
  | { kind: 'failed'; from: string; to: string; detail: string }
  | { kind: 'not_started'; detail: string };

/** `host_on_launch()`. */
export interface HostLaunch {
  info: HostInfo;
  update: UpdateOutcome;
  start_error: string | null;
}
