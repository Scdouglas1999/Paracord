import type { Page } from '@playwright/test';
import { Directory, FINGERPRINT, INVITES, type HostIdentity } from './invites';
import { preflightAnswer, progressScript, shareAddress, type PreflightScenario, type ProgressEvent, type ReachScenario, type SetupScenario } from './hostScripts';
import { THIS_COMPUTER } from './scene';

/**
 * The desktop app's Rust commands, stubbed (docs/setup-spec.md 9.5). The page
 * gets a `window.__TAURI_INTERNALS__` whose `invoke` calls into this class, so
 * the real `@tauri-apps/api` (`invoke`, `listen`) runs against it, and the app's
 * `isTauri()` is true. Only the commands first run uses are scripted; any other
 * command is refused with a clear error and recorded in `unstubbed`, never
 * answered with a made-up success (nothing degrades silently).
 *
 *   const host = await installTauriHost(page, { preflight: 'ok', reach: 'refused' });
 *   host.setClipboard(inviteUrl('Rf8kQ2'));
 *   ...
 *   await host.step();                 // manual mode: deliver the next host://progress event
 *   expect(host.calls('host_setup_start')).toHaveLength(1);
 */
export interface TauriHostOptions {
  preflight?: PreflightScenario;
  reach?: ReachScenario;
  setup?: SetupScenario;
  /** `auto` (default): progress events arrive on a timer. `manual`: one per `step()`, for a shot between rows. */
  progress?: 'auto' | 'manual';
  /** Delay between automatic progress events. Default 120 ms. */
  progressDelayMs?: number;
  /** Text on the clipboard when the page starts (null: empty). */
  clipboard?: string | null;
  /** A deep link waiting at launch (`take_pending_deep_links`). */
  pendingDeepLinks?: string[];
  /** What `host_pick_backup` answers (S13b restore). Default `escrowed`. */
  backup?: BackupScenario;
  /** What `host_restore` does. Default `ok`. */
  restore?: RestoreScenario;
  /** What `host_on_launch` reports (spec 2.8). Default `none`. */
  launch?: LaunchScenario;
  /**
   * A computer that already hosts a server (Settings › "Paracord on this
   * computer", spec 2.9, F4). Unset: the first-run behavior (nothing hosted
   * until setup runs).
   */
  hosting?: Partial<HostingState>;
}

/** What the hosting computer reports, for Settings › "Paracord on this computer". */
export interface HostingState {
  /** `null`: the service manager couldn't be asked (`serviceError` says why). */
  service: 'running' | 'stopped' | 'starting' | 'failed' | 'not_installed' | null;
  serviceError: string | null;
  exitCode: number | null;
  autostart: boolean;
  /** Exit 78: why the storage key can't be opened. */
  storageKeyProblem: string | null;
  /** "Port {port} is in use by another program.": the host's own report of a taken port. */
  portProblem: string | null;
  /** An update that didn't come up (spec 2.8). */
  updateFailed: boolean;
  heldVersion: string | null;
  escrowed: boolean;
  lastBackupAt: string | null;
  backupError: string | null;
  /** `Reachability.confirmed_at`. */
  confirmedAt: string | null;
  /** `host_start` rejects with this (and the service stays stopped). */
  startFails: string | null;
  /** `host_remove` rejects with this. */
  removeFails: string | null;
  /** host.json gone or `enabled = false` after **Remove**. */
  enabled: boolean;
}

const HOSTING_DEFAULTS: HostingState = {
  service: 'running',
  serviceError: null,
  exitCode: null,
  autostart: true,
  storageKeyProblem: null,
  portProblem: null,
  updateFailed: false,
  heldVersion: null,
  escrowed: true,
  lastBackupAt: '2026-10-12T04:00:00Z',
  backupError: null,
  confirmedAt: null,
  startFails: null,
  removeFails: null,
  enabled: true,
};

/**
 * The backup the file picker returns: `escrowed` carries the escrow of the
 * shared vector (vectors.json `escrow[0]`, owner = `phrase[0]`), `other-owner`
 * the same escrow for another owner's key, `no-escrow` none, `not-a-backup`
 * the shell's refusal, `cancel` the picker closed.
 */
export type BackupScenario = 'escrowed' | 'other-owner' | 'no-escrow' | 'not-a-backup' | 'cancel';
export type RestoreScenario = 'ok' | 'database-exists';
export type LaunchScenario = 'none' | 'update-failed';

/** The shared vectors (client/src/lib/credential/vectors.json): the phrase that owns the scripted backup. */
export const RESTORE_VECTOR = {
  phrase: 'spot flush pizza wide dolphin bar surface again imitate learn sibling blue fee present remain zero frog chuckle budget high citizen sound cushion omit',
  publicKey: 'ad1556f6b39cd51a513052c0be97b86e668adb99fadb813e0c02ebddf7037fd4',
  instanceId: '7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a',
  /** b64url escrow key of `phrase` for `instanceId`. */
  wrappingKey: 'A5duufTfSAhw6-4tTUla0i3MI52HGT1fuTgu828jiM8',
} as const;

function backupAnswer(scenario: BackupScenario): unknown {
  const file = {
    path: '/home/sam/Backups/paracord_backup_20261003_040000.tar.gz',
    file_name: 'paracord_backup_20261003_040000.tar.gz',
    size_bytes: 4_300_000,
    created_at: '2026-10-03T16:00:00Z',
    server_version: '3.4.0',
    encrypted: true,
    escrow: { instance_id: RESTORE_VECTOR.instanceId, owner_public_key: RESTORE_VECTOR.publicKey },
  };
  switch (scenario) {
    case 'other-owner':
      return { ...file, escrow: { instance_id: RESTORE_VECTOR.instanceId, owner_public_key: '5f'.repeat(32) } };
    case 'no-escrow':
      return { ...file, escrow: null };
    case 'cancel':
      return null;
    default:
      return file;
  }
}

export interface RecordedCall {
  command: string;
  args: unknown;
}

/** Commands answered with a plain acknowledgement because the app calls them at boot, whatever the screen. */
const QUIET = new Set(['update_trusted_server_hosts', 'append_client_log', 'set_activity_sharing_enabled', 'media_clip_disarm']);

export class TauriHost {
  readonly log: RecordedCall[] = [];
  readonly unstubbed = new Set<string>();
  readonly directory = new Directory();
  preflight: PreflightScenario;
  reach: ReachScenario;
  setup: SetupScenario;
  clipboard: string | null;
  pendingDeepLinks: string[];
  private readonly mode: 'auto' | 'manual';
  private readonly delay: number;
  private queue: ProgressEvent[] = [];
  private timers: NodeJS.Timeout[] = [];
  private readonly secure = new Map<string, string>();
  /** host -> fingerprint the app pinned through `trust_server`. */
  readonly pinned = new Map<string, string>();
  /** The answer `host_claim` gives (a spec scripts the account it made); unset: refused. */
  claim: ((request: unknown) => unknown) | null = null;
  /** `host.json.setup.completed_steps`. */
  readonly completed = new Set<string>();
  backup: BackupScenario;
  restore: RestoreScenario;
  launch: LaunchScenario;
  /** `host_rollback_update` waits for this when set (a spec shoots "restoring…"). */
  rollbackHold: Promise<void> | null = null;
  /** Settings › "Paracord on this computer" (F4); null: not hosting yet. */
  hosting: HostingState | null;
  /** `host_start` / `host_stop` wait for this when set (a spec shoots "Starting"). */
  serviceHold: Promise<void> | null = null;

  /** `host_info` for a computer that hosts (F4). */
  hostingInfo(h: HostingState): Record<string, unknown> {
    return {
      enabled: h.enabled,
      port: THIS_COMPUTER.port,
      autostart: h.autostart,
      installed_version: '3.5.0',
      completed_steps: ['install', 'init', 'service', 'start', 'storage', 'claim', 'escrow', 'reach', 'backup'],
      service: h.enabled && h.service ? { state: h.service, enabled: h.autostart, exit_code: h.exitCode } : null,
      service_error: h.enabled ? h.serviceError : null,
      home_url: h.enabled ? `https://127.0.0.1:${THIS_COMPUTER.port}` : null,
      storage_key_problem: h.storageKeyProblem,
      port_problem: h.portProblem,
      update_failure: h.updateFailed
        ? { from_version: '3.4.0', to_version: '3.5.0', backup_name: 'paracord_backup_20261012_203000.tar.gz', failure: 'the server did not answer /health within 60 s' }
        : null,
      held_version: h.heldVersion,
      instance_id: RESTORE_VECTOR.instanceId,
    };
  }

  /** `HostStatus` (contract shape) for the scripted reach. */
  status(): Record<string, unknown> {
    const reachable = this.reach === 'open' || this.reach === 'direct';
    const h = this.hosting;
    return {
      version: '3.5.0',
      started_at: '2026-10-12T20:30:00Z',
      setup_required: false,
      storage: { enabled: true, sqlite_encrypted: true, files_encrypted: true, key_source: 'keychain', protection: 'login', escrowed: h?.escrowed ?? false },
      reachability: {
        state: this.reach,
        method: 'upnp',
        external_ip: reachable ? THIS_COMPUTER.externalIp : null,
        gateway_ip: THIS_COMPUTER.gatewayIp,
        lan_ip: THIS_COMPUTER.lanIp,
        port: THIS_COMPUTER.port,
        lease_expires_at: null,
        next_retry_at: null,
        last_error: null,
        confirmed_at: h?.confirmedAt ?? null,
      },
      backups: { enabled: true, interval_seconds: 86400, keep: 14, last_backup_at: h?.lastBackupAt ?? null, last_error: h?.backupError ?? null },
      instance_id: RESTORE_VECTOR.instanceId,
      tls: { fingerprint_sha256: FINGERPRINT.kanto, self_signed: true },
      share: shareAddress(this.reach),
    };
  }

  constructor(
    readonly page: Page,
    options: TauriHostOptions,
  ) {
    this.preflight = options.preflight ?? 'ok';
    this.reach = options.reach ?? 'open';
    this.setup = options.setup ?? 'ok';
    this.mode = options.progress ?? 'auto';
    this.delay = options.progressDelayMs ?? 120;
    this.clipboard = options.clipboard ?? null;
    this.pendingDeepLinks = options.pendingDeepLinks ?? [];
    this.backup = options.backup ?? 'escrowed';
    this.restore = options.restore ?? 'ok';
    this.launch = options.launch ?? 'none';
    this.hosting = options.hosting ? { ...HOSTING_DEFAULTS, ...options.hosting } : null;
  }

  /** Every call of one command, in order. */
  calls(command: string): RecordedCall[] {
    return this.log.filter((c) => c.command === command);
  }

  setClipboard(text: string | null): void {
    this.clipboard = text;
  }

  /** Deliver an event to the page's `listen()` callbacks. */
  async emit(event: string, payload: unknown): Promise<void> {
    await this.page.evaluate(([e, p]) => (window as unknown as { __setupEmit: (e: string, p: unknown) => void }).__setupEmit(e, p), [event, payload] as const);
  }

  /** Manual mode: deliver the next queued progress event; false when none is left. */
  async step(): Promise<boolean> {
    const next = this.queue.shift();
    if (!next) return false;
    await this.emit('host://progress', next);
    return true;
  }

  /** Manual mode: deliver every remaining event. */
  async finish(): Promise<void> {
    while (await this.step());
  }

  /** The certificate this host presents changes while the app is running (spec 7.4). Emits `trust://identity-changed` if it was pinned. */
  async rekey(host: string, identity: HostIdentity): Promise<void> {
    this.directory.rekey(host, identity);
    const pinned = this.pinned.get(host);
    if (pinned && identity.fingerprint && pinned !== identity.fingerprint) {
      await this.emit('trust://identity-changed', { host, pinned_fp: pinned, presented_fp: identity.fingerprint });
    }
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** The page's `invoke` lands here. Resolves `{ ok, value | error }`; the page rejects with the string like Tauri does. */
  async handle(command: string, args: Record<string, unknown> | undefined): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    this.log.push({ command, args });
    const ok = (value: unknown = null) => ({ ok: true as const, value });
    const fail = (error: string) => ({ ok: false as const, error });
    switch (command) {
      case 'host_preflight':
        return ok(preflightAnswer(this.preflight));
      case 'host_setup_start': {
        // S7's contract: rows 1-2 first; rows 4-5 only once the page wrote the escrow (row 3).
        const escrowed = this.completed.has('escrow');
        const script = progressScript(this.setup, this.reach);
        this.queue = escrowed ? script.filter((e) => e.row >= 4) : script.filter((e) => e.row <= 2);
        if (!escrowed && !this.queue.some((e) => e.state === 'fail')) for (const step of ['install', 'init', 'service', 'start', 'storage']) this.completed.add(step);
        if (this.mode === 'auto') this.play();
        return ok();
      }
      case 'host_info':
        if (this.hosting) return ok(this.hostingInfo(this.hosting));
        return ok({
          enabled: this.completed.size > 0,
          port: THIS_COMPUTER.port,
          autostart: true,
          installed_version: '3.5.0',
          completed_steps: [...this.completed],
          service: null,
          service_error: null,
          home_url: `https://127.0.0.1:${THIS_COMPUTER.port}`,
          storage_key_problem: null,
          update_failure: null,
          held_version: null,
          instance_id: '7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a',
        });
      case 'host_on_launch':
        if (this.launch === 'update-failed') {
          const failure = { from_version: '3.3.0', to_version: '3.4.0', backup_name: 'paracord_backup_20261012_203000.tar.gz', failure: 'the server did not answer /health within 60 s' };
          return ok({
            info: { enabled: true, port: THIS_COMPUTER.port, autostart: true, installed_version: '3.4.0', completed_steps: [], service: { state: 'failed', enabled: true, exit_code: 1 }, service_error: null, home_url: `https://127.0.0.1:${THIS_COMPUTER.port}`, storage_key_problem: null, update_failure: failure, held_version: null },
            update: { kind: 'failed', from: '3.3.0', to: '3.4.0', detail: failure.failure },
            start_error: null,
          });
        }
        return ok({ info: { enabled: false, port: null, autostart: false, installed_version: null, completed_steps: [], service: null, service_error: null, home_url: null, storage_key_problem: null, update_failure: null, held_version: null }, update: { kind: 'none' }, start_error: null });
      case 'host_rollback_update':
        if (this.rollbackHold) await this.rollbackHold;
        if (this.hosting) {
          this.hosting.updateFailed = false;
          this.hosting.heldVersion = '3.5.0';
          this.hosting.service = 'running';
        }
        return ok();
      case 'host_pick_backup':
        if (this.backup === 'not-a-backup') return fail('notes.txt isn\'t a Paracord backup.');
        return ok(backupAnswer(this.backup));
      case 'host_restore':
        // S7: install, init, the generated key taken back, restore-backup --escrow-key-stdin; the owner came with it, the escrow is written again by the page.
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (this.restore === 'database-exists') return fail('This computer already has a server database; restoring over it is refused.');
        for (const step of ['install', 'init', 'claim']) this.completed.add(step);
        return ok();
      case 'host_write_escrow':
        this.completed.add('escrow');
        return ok();
      case 'host_allow_firewall':
        return ok('allowed');
      case 'host_status':
        if (this.hosting && this.hosting.service !== 'running') return fail('Paracord on this computer is not running.');
        return ok(this.status());
      case 'host_start':
      case 'host_stop': {
        if (!this.hosting) break;
        if (this.serviceHold) await this.serviceHold;
        if (command === 'host_start' && this.hosting.startFails) {
          this.hosting.service = 'stopped';
          return fail(this.hosting.startFails);
        }
        this.hosting.service = command === 'host_start' ? 'running' : 'stopped';
        this.hosting.storageKeyProblem = null;
        return ok();
      }
      case 'host_set_autostart':
        if (!this.hosting) break;
        this.hosting.autostart = Boolean(args?.enabled);
        return ok();
      case 'host_remove':
        if (!this.hosting) break;
        if (this.hosting.removeFails) return fail(this.hosting.removeFails);
        this.hosting.enabled = false;
        this.hosting.service = null;
        return ok();
      case 'host_retry_reachability':
      case 'host_backup_now':
        if (command === 'host_backup_now' && this.hosting) {
          this.hosting.lastBackupAt = new Date(await this.page.evaluate(() => Date.now())).toISOString();
          this.hosting.backupError = null;
        }
        return ok(command === 'host_backup_now' ? { name: 'paracord-2026-10-12.tar.zst' } : null);
      case 'probe_server': {
        const url = new URL(String(args?.serverUrl ?? ''));
        const identity = this.directory.identityOf(url.hostname);
        if (!identity.fingerprint) return fail(`Could not connect to ${url.host}.`);
        const pinned = this.pinned.get(url.hostname);
        if (pinned && pinned !== identity.fingerprint) return fail(`TLS certificate pin mismatch for ${url.hostname}`);
        return ok({ status: 'ok', service: 'paracord', name: INVITES.Rf8kQ2.host === url.hostname ? 'Kanto Friends' : url.hostname, fingerprint: identity.fingerprint, ca_verified: identity.caVerified });
      }
      case 'preview_invite': {
        // The shell's first-contact invite preview (S13): the scenario's answer and the certificate it came over.
        const url = new URL(String(args?.serverUrl ?? ''));
        const code = String(args?.code ?? '');
        const scenario = (INVITES as Record<string, (typeof INVITES)[keyof typeof INVITES]>)[code];
        const identity = scenario && scenario.host === url.hostname && code === 'Changed1' ? scenario.identity : this.directory.identityOf(url.hostname);
        if (!identity.fingerprint || (scenario && 'refuse' in scenario.answer)) return fail(`Connection refused or unreachable: ${url.host}`);
        const pinned = this.pinned.get(url.hostname);
        if (pinned && pinned !== identity.fingerprint) return fail(`TLS certificate pin mismatch for ${url.hostname}`);
        if (!scenario) return ok({ status: 404, body: { code: 'invite_not_found', message: 'Invite not found' }, fingerprint: identity.fingerprint, ca_verified: identity.caVerified });
        const answer = scenario.answer as { status: number; body: unknown };
        return ok({ status: answer.status, body: answer.body, fingerprint: identity.fingerprint, ca_verified: identity.caVerified });
      }
      case 'pending_identity_change': {
        // The shell records a mismatch when a pinned host presents another certificate (S10).
        const host = String(args?.host ?? '');
        const pinned = this.pinned.get(host);
        const presented = this.directory.identityOf(host).fingerprint;
        return ok(pinned && presented && pinned !== presented ? { host, pinned_fp: pinned, presented_fp: presented } : null);
      }
      case 'host_claim':
        if (!this.claim) return fail('setup review harness: host_claim has no scripted answer');
        this.completed.add('claim');
        return ok(await this.claim(args?.request));
      case 'host_logs_tail':
        return ok("2026-10-12T20:30:01Z  INFO paracord: starting\n2026-10-12T20:30:31Z ERROR paracord: the server did not answer /health within 30 s");
      case 'trust_server': {
        // Spec 7.3: pins only if the observed fingerprint equals the one shown.
        const url = new URL(String(args?.url ?? ''));
        const shown = String(args?.fingerprint ?? '');
        const observed = this.directory.identityOf(url.hostname).fingerprint;
        if (observed !== shown) return fail("This server's identity changed while you were looking at it.");
        this.pinned.set(url.hostname, shown);
        return ok();
      }
      case 'accept_changed_identity': {
        const host = String(args?.host ?? '');
        const presented = String(args?.presentedFp ?? args?.presented_fp ?? '');
        if (this.directory.identityOf(host).fingerprint !== presented) return fail('That is not the identity this server presented.');
        this.pinned.set(host, presented);
        return ok();
      }
      case 'take_pending_deep_links': {
        const links = this.pendingDeepLinks;
        this.pendingDeepLinks = [];
        return ok(links);
      }
      case 'plugin:clipboard-manager|read_text':
        return ok(this.clipboard);
      case 'plugin:clipboard-manager|write_text':
        this.clipboard = String(args?.text ?? '');
        return ok();
      case 'secure_store_set':
        this.secure.set(String(args?.key), String(args?.value));
        return ok();
      case 'secure_store_get':
        return ok(this.secure.get(String(args?.key)) ?? null);
      case 'secure_store_delete':
        this.secure.delete(String(args?.key));
        return ok();
      case 'get_client_log_path':
        return ok('/tmp/paracord-client.log');
      default:
        if (QUIET.has(command)) return ok();
        break;
    }
    // Unscripted (or not for this scene, e.g. host_start before anything is hosted): refused, loudly.
    this.unstubbed.add(command);
    return fail(`setup review harness: the Tauri command "${command}" is not stubbed`);
  }

  private play(): void {
    let at = 0;
    for (const event of this.queue.splice(0)) {
      at += this.delay;
      this.timers.push(setTimeout(() => void this.emit('host://progress', event).catch(() => undefined), at));
    }
  }
}

/** Install the Tauri stub. Call before the first `page.goto`. */
export async function installTauriHost(page: Page, options: TauriHostOptions = {}): Promise<TauriHost> {
  const host = new TauriHost(page, options);
  await page.exposeFunction('__setupHost', (command: string, args: Record<string, unknown> | undefined) => host.handle(command, args));
  await page.addInitScript(() => {
    let next = 1;
    const callbacks = new Map<number, (payload: unknown) => unknown>();
    const listeners = new Map<string, Map<number, number>>();
    const w = window as unknown as Record<string, unknown>;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback(cb: (payload: unknown) => unknown, once?: boolean) {
        const id = next++;
        callbacks.set(id, (p) => {
          if (once) callbacks.delete(id);
          return cb(p);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (p: string) => p,
      async invoke(cmd: string, args?: Record<string, unknown>) {
        if (cmd === 'plugin:event|listen') {
          const id = next++;
          const event = String(args?.event);
          if (!listeners.has(event)) listeners.set(event, new Map());
          listeners.get(event)!.set(id, Number(args?.handler));
          return id;
        }
        if (cmd === 'plugin:event|unlisten') {
          listeners.get(String(args?.event))?.delete(Number(args?.eventId));
          return null;
        }
        if (cmd === 'native_fetch') {
          // The shell's HTTP, stood in for by the page's own fetch, so the scene's routes answer it.
          const req = (args?.req ?? {}) as { url: string; method?: string; body?: unknown; headers?: Record<string, string> | null };
          const response = await fetch(req.url, {
            method: req.method ?? 'GET',
            headers: { 'Content-Type': 'application/json', ...(req.headers ?? {}) },
            body: req.body === null || req.body === undefined || req.method === 'GET' ? undefined : JSON.stringify(req.body),
          });
          const text = await response.text();
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          return { status: response.status, body, headers };
        }
        const answer = await (w.__setupHost as (c: string, a?: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: string }>)(cmd, args);
        if (!answer.ok) throw answer.error; // Tauri rejects with the command's error string
        return answer.value;
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string, id: number) => listeners.get(event)?.delete(id) };
    w.__setupEmit = (event: string, payload: unknown) => {
      for (const [eventId, handler] of listeners.get(event) ?? []) callbacks.get(handler)?.({ event, id: eventId, payload });
    };
  });
  return host;
}
