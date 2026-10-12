/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * What the router said, or what this computer knows, about whether people
 * outside the home network can reach this server (spec §5.2).
 */
export type ReachabilityState =
  'off' | 'asking' | 'open' | 'shared_address' | 'refused' | 'no_answer' | 'direct' | 'firewall_blocked';
/**
 * Where the at-rest storage key lives (`[at_rest] key_source`, spec §4.2).
 * Spelled the same in the config file and on the wire.
 */
export type KeySource = 'keychain' | 'systemd-creds' | 'file' | 'env';
/**
 * What protects the storage key, which decides the copy (spec §4.6).
 */
export type Protection = 'login' | 'tpm' | 'machine' | 'same_disk';

/**
 * Gateway `INSTANCE_STATUS_UPDATE`, sent to admins whenever any of these
 * changes (spec §5.5).
 */
export interface InstanceStatusUpdate {
  backups: BackupStatus;
  reachability: Reachability;
  storage: StorageStatus;
  [k: string]: unknown | undefined;
}
/**
 * Automatic backups.
 */
export interface BackupStatus {
  enabled: boolean;
  interval_seconds: number;
  /**
   * How many backups are kept.
   */
  keep: number;
  last_backup_at: string | null;
  last_error: string | null;
  [k: string]: unknown | undefined;
}
/**
 * The current reachability, as the server holds it.
 */
export interface Reachability {
  /**
   * When a connection from outside this network was observed.
   */
  confirmed_at: string | null;
  /**
   * Only ever what the router reported.
   */
  external_ip: string | null;
  gateway_ip: string | null;
  lan_ip: string | null;
  last_error: string | null;
  lease_expires_at: string | null;
  /**
   * `"upnp"`, `"nat-pmp"` or `"pcp"`.
   */
  method: string | null;
  next_retry_at: string | null;
  port: number;
  state: ReachabilityState;
  [k: string]: unknown | undefined;
}
/**
 * Stored-data encryption as the running server observes it (spec §4.5).
 */
export interface StorageStatus {
  enabled: boolean;
  /**
   * The storage key is escrowed under the owner's recovery phrase (§4.7).
   */
  escrowed: boolean;
  files_encrypted: boolean;
  key_source: KeySource | null;
  protection: Protection | null;
  /**
   * From `PRAGMA cipher_version` on the live pool, not from config.
   */
  sqlite_encrypted: boolean;
  [k: string]: unknown | undefined;
}
