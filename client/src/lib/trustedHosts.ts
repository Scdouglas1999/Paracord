import { isTauri } from './tauriEnv';

/**
 * Ask the Tauri backend to verify and sync trusted server hosts so that
 * WebView2 allows self-signed TLS certificates for self-hosted servers.
 * No-op in browser environments.
 */
export async function syncTrustedHosts(serverUrls: string[]): Promise<void> {
  if (!isTauri()) return;
  // Sanitise the caller-supplied list (trim, drop empties, dedupe) so the
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
