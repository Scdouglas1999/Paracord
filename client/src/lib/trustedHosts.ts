import { isTauri } from './tauriEnv';

/**
 * Ask the Tauri backend to verify and sync trusted server hosts so that
 * WebView2 allows self-signed TLS certificates for self-hosted servers.
 * No-op in browser environments.
 */
export async function syncTrustedHosts(serverUrls: string[]): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('update_trusted_server_hosts', { serverUrls });
  } catch {
    // Silently ignore — worst case the cert override doesn't apply
  }
}
