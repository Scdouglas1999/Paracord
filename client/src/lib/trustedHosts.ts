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

/**
 * Ask the Tauri backend to verify and sync trusted server hosts so that
 * WebView2 allows self-signed TLS certificates for self-hosted servers.
 * No-op in browser environments.
 */
export function syncTrustedHosts(serverUrls: string[]): Promise<void> {
  const sync = runSync(serverUrls);
  if (!firstSync && isTauri()) firstSync = sync;
  return sync;
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
