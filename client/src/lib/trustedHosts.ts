import { create } from 'zustand';

import { isTauri } from './tauriEnv';

/**
 * The first trust sync of this run, while it is in flight or once it settled.
 *
 * The shell refuses every native request to an origin it has not verified, and
 * at a cold start it has verified none: the set is filled by this sync, which
 * GETs each server's `/health` first. Session bootstrap fires its refresh in
 * the same few milliseconds, so on a launch where those probes took longer than
 * reading the keychain (two HTTPS servers, say) the refresh was refused before
 * it left the machine ("Native fetch target is not in the trusted server
 * list"). The saved server's own connect then found its access token expired,
 * asked for the same refresh, was handed that failure, and the app sat on
 * "This server is not available" until it was restarted.
 */
let firstSync: Promise<void> | null = null;

/**
 * Resolves once the first trust sync of this run has settled (at once when none
 * has started). The desktop HTTP adapter waits on it before its first request,
 * so nothing is sent to an origin the shell is still verifying.
 */
export function trustSettled(): Promise<void> {
  // Settled either way: a sync that failed has been reported by its caller, and
  // the requests waiting on it get the shell's own refusal instead of hanging.
  return firstSync ? firstSync.catch(() => undefined) : Promise.resolve();
}

/** Syncs that have been asked for and not finished (any caller's). */
const pending = new Set<Promise<void>>();
let lastSyncEndedAt = 0;

/**
 * Ask the Tauri backend to verify and sync trusted server hosts so that
 * WebView2 allows self-signed TLS certificates for self-hosted servers.
 * No-op in browser environments.
 */
export function syncTrustedHosts(serverUrls: string[]): Promise<void> {
  const sync: Promise<void> = runSync(serverUrls).finally(() => {
    pending.delete(sync);
    lastSyncEndedAt = Date.now();
  });
  pending.add(sync);
  if (!firstSync && isTauri()) firstSync = sync;
  return sync;
}

/** Where the servers the person has saved can be read from (set by `main.tsx`; the home server included). */
let trustSource: (() => string[]) | null = null;

export function setTrustSource(source: (() => string[]) | null): void {
  trustSource = source;
}

/**
 * The shell's own refusal of a request to an origin it has not verified
 * (`ensure_native_fetch_target_is_trusted`). It leaves the machine's network
 * untouched: nothing was sent.
 */
export function isTrustRefusal(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /not in the trusted server list/i.test(message);
}

/** A refused request asks for one re-check at most this often; a server that is truly down is not probed on every click. */
export const TRUST_RECHECK_COOLDOWN_MS = 3_000;

/**
 * The longest a refused request waits for a check somebody else started. The shell
 * verifies one server after another and a new server waits on the person's answer to
 * its own dialog (up to a minute): a request must not wait that out.
 */
export const TRUST_RECHECK_WAIT_MS = 8_000;

/**
 * Verify the saved servers now, because a request was just refused for want of it.
 *
 * A server that was down at launch is not trusted until a probe reaches it, and the
 * 30-second beat in `main.tsx` was the only thing that tried again, so the sign-in
 * screen said "Could not reach" for up to half a minute after the server was back.
 * Whatever finds a request refused this way asks here instead, and retries once.
 *
 * Resolves true when a verification ran (or one that was already running has finished),
 * so the caller should send the request again; false when none could be made (not the
 * desktop, no server list to verify, or one finished just now and the answer stands).
 */
export async function recheckTrust(): Promise<boolean> {
  if (!isTauri()) return false;
  if (pending.size > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, TRUST_RECHECK_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return true;
  }
  const urls = trustSource?.() ?? [];
  if (urls.length === 0 || Date.now() - lastSyncEndedAt < TRUST_RECHECK_COOLDOWN_MS) return false;
  await syncTrustedHosts(urls);
  return true;
}

/**
 * Verify every saved server now, whatever the cooldown: the person just trusted a
 * server's new identity, and the next request to it must not meet the refusal the
 * last sync left behind.
 */
export async function resyncTrust(): Promise<void> {
  const urls = trustSource?.() ?? [];
  if (urls.length > 0) await syncTrustedHosts(urls);
}

async function runSync(serverUrls: string[]): Promise<void> {
  if (!isTauri()) return;
  // Sanitize the caller-supplied list (trim, drop empties, dedupe) so the
  // freshly-resolved host is always included exactly once. Host allow/deny and
  // SSRF validation remain the Rust side's responsibility — we only forward a
  // clean list and must not filter hosts here, or first-connect to a
  // self-signed native server would never be trusted for QUIC/WebTransport.
  const unique = Array.from(
    new Set(
      serverUrls
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter((url) => url.length > 0)
    )
  );
  if (unique.length === 0) return;
  // Listening before the shell verifies anything: an identity change it finds
  // during this sync is announced once, and it must not be missed.
  await listenForIdentityChanges();
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    await invoke('update_trusted_server_hosts', { serverUrls: unique });
  } catch (error) {
    // The shell could not verify anything (too many servers, no TLS client).
    // Nothing is trusted that was not before; say why, loudly.
    console.error('[trust] the shell could not verify the saved servers:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/* ---- Server identity (docs/setup-spec.md §7) ------------------------------------ */

/** The verifier's refusal of a certificate that is not the one pinned for its host (`PIN_MISMATCH_MESSAGE` in lib.rs). */
const PIN_MISMATCH_TEXT = 'TLS certificate pin mismatch';

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return '';
}

/**
 * The server presented a certificate other than the one this app pinned for it:
 * an identity change, never a network error. The text comes from the shell's
 * verifier through `native_fetch`, `probe_server` and the trust gate, possibly
 * wrapped once (an axios error, an error's `cause`).
 */
export function isPinMismatch(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (errorText(current).includes(PIN_MISMATCH_TEXT)) return true;
    current = current && typeof current === 'object' && 'cause' in current ? current.cause : null;
  }
  return false;
}

/** One server's identity change, as the shell recorded it (fingerprints as lowercase hex). */
export interface IdentityChange {
  host: string;
  pinnedFp: string;
  presentedFp: string;
}

interface IdentityChangeWire {
  host: string;
  pinned_fp: string;
  presented_fp: string;
}

function fromWire(change: IdentityChangeWire): IdentityChange {
  return { host: change.host, pinnedFp: change.pinned_fp, presentedFp: change.presented_fp };
}

interface IdentityChangeStore {
  /** By host (lowercase, IPv6 without brackets: the shell's pin key). */
  changes: Record<string, IdentityChange>;
  record: (change: IdentityChange) => void;
  clear: (host: string) => void;
}

/** Identity changes the shell announced this run and nobody has accepted yet. */
export const useIdentityChangeStore = create<IdentityChangeStore>()((set) => ({
  changes: {},
  record: (change) => set((state) => ({ changes: { ...state.changes, [change.host]: change } })),
  clear: (host) =>
    set((state) => {
      if (!state.changes[host]) return state;
      const { [host]: _accepted, ...rest } = state.changes;
      return { changes: rest };
    }),
}));

/** The host a URL's certificate is pinned under (the shell's `pin_host_from_url`). */
export function pinHostFromUrl(serverUrl: string): string | null {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    return host.replace(/^\[/, '').replace(/\]$/, '') || null;
  } catch {
    return null;
  }
}

/** The identity change recorded for a server, if its host has one. */
export function identityChangeFor(serverUrl: string): IdentityChange | null {
  const host = pinHostFromUrl(serverUrl);
  return host ? useIdentityChangeStore.getState().changes[host] ?? null : null;
}

let identityListener: Promise<void> | null = null;

/** Subscribe to `trust://identity-changed` once per page (desktop only). */
export function listenForIdentityChanges(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  identityListener ??= (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<IdentityChangeWire>('trust://identity-changed', (event) => {
      useIdentityChangeStore.getState().record(fromWire(event.payload));
    });
  })().catch((error: unknown) => {
    identityListener = null;
    throw error;
  });
  return identityListener;
}

/**
 * The shell's record of a server's identity change, for a page that was not
 * listening when it was announced (a reload). Null when there is none.
 */
export async function loadIdentityChange(serverUrl: string): Promise<IdentityChange | null> {
  const host = pinHostFromUrl(serverUrl);
  if (!host) return null;
  const known = useIdentityChangeStore.getState().changes[host];
  if (known) return known;
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const change = await invoke<IdentityChangeWire | null>('pending_identity_change', { host });
  if (!change) return null;
  const recorded = fromWire(change);
  useIdentityChangeStore.getState().record(recorded);
  return recorded;
}

/** What `probe_server` answers: the server's `/health`, plus its certificate (§7.3). */
export interface ServerProbe {
  service?: string;
  name?: string;
  /** Hex SHA-256 of the leaf certificate; null over plain HTTP. */
  fingerprint: string | null;
  /** A public certificate authority signed the chain (no pin is kept). */
  caVerified: boolean;
  [key: string]: unknown;
}

/**
 * Ask the shell for a server's `/health` and identity (desktop only). Refusals and pin mismatches are thrown as they are.
 *
 * A saved server the shell has not verified yet (this computer's own server right after setup or a restore, which the
 * shell trusts by its certificate on the next sync) is refused before anything is sent: like the desktop HTTP adapter,
 * that refusal asks for one re-check and the probe runs once more.
 */
export async function probeServerIdentity(serverUrl: string): Promise<ServerProbe> {
  const { invoke } = await import('@tauri-apps/api/core');
  const probe = () => invoke<Record<string, unknown>>('probe_server', { serverUrl });
  let answer: Record<string, unknown>;
  try {
    answer = await probe();
  } catch (error) {
    if (!isTrustRefusal(error) || !(await recheckTrust())) throw error;
    answer = await probe();
  }
  const { fingerprint, ca_verified: caVerified, ...health } = answer;
  return {
    ...health,
    fingerprint: typeof fingerprint === 'string' ? fingerprint : null,
    caVerified: caVerified === true,
  };
}

/**
 * Trust the server whose words the person just confirmed (§7.3): the shell pins
 * `fingerprint` only if the server still presents it, and otherwise refuses
 * ("This server's identity changed while you were looking at it."). Throws the
 * refusal as an Error.
 */
export async function trustServer(serverUrl: string, fingerprint: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    await invoke('trust_server', { url: serverUrl, fingerprint });
  } catch (error) {
    throw error instanceof Error ? error : new Error(errorText(error) || String(error));
  }
}

/**
 * "Trust the new identity" (§7.4): the shell re-pins the host only to the
 * certificate it recorded as the change. Throws the refusal as an Error.
 */
export async function acceptChangedIdentity(change: IdentityChange): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    await invoke('accept_changed_identity', { host: change.host, presentedFp: change.presentedFp });
  } catch (error) {
    throw error instanceof Error ? error : new Error(errorText(error) || String(error));
  }
  useIdentityChangeStore.getState().clear(change.host);
}
