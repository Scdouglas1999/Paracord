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
        this.queue = progressScript(this.setup, this.reach);
        if (this.mode === 'auto') this.play();
        return ok();
      }
      case 'host_status':
        return ok({
          running: this.setup === 'ok',
          port: THIS_COMPUTER.port,
          reachability: { state: this.reach, external_ip: this.reach === 'open' || this.reach === 'direct' ? THIS_COMPUTER.externalIp : null, lan_ip: THIS_COMPUTER.lanIp, gateway_ip: THIS_COMPUTER.gatewayIp, port: THIS_COMPUTER.port },
          storage: { sqlite_encrypted: true, files_encrypted: true, key_source: 'keychain' },
          tls: { fingerprint_sha256: FINGERPRINT.kanto },
          share: shareAddress(this.reach),
        });
      case 'host_retry_reachability':
      case 'host_backup_now':
        return ok(command === 'host_backup_now' ? { name: 'paracord-2026-10-12.tar.zst' } : null);
      case 'probe_server': {
        const url = new URL(String(args?.serverUrl ?? ''));
        const identity = this.directory.identityOf(url.hostname);
        if (!identity.fingerprint) return fail(`Could not connect to ${url.host}.`);
        return ok({ status: 'ok', service: 'paracord', name: INVITES.Rf8kQ2.host === url.hostname ? 'Kanto Friends' : url.hostname, fingerprint: identity.fingerprint, ca_verified: identity.caVerified });
      }
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
        const presented = String(args?.presented_fp ?? '');
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
        this.unstubbed.add(command);
        return fail(`setup review harness: the Tauri command "${command}" is not stubbed`);
    }
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
