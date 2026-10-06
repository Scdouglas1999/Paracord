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
  return firstSync ?? Promise.resolve();
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
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('update_trusted_server_hosts', { serverUrls: unique });
  } catch {
    // Silently ignore — worst case the cert override doesn't apply
  }
}
