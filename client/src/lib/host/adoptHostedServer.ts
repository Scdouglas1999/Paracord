import { getStoredServerUrl, setStoredServerUrl } from '../config/apiBaseUrl';
import { logVoiceDiagnostic } from '../desktopDiagnostics';
import { isTauri } from '../tauriEnv';

/**
 * A desktop that hosts a server and has no home server saved adopts its own.
 *
 * Every account screen (sign-in, unlock, setup, recovery) talks to the home
 * server, `resolveApiBaseUrl()`. A profile that lost its saved server (a fresh
 * one, a build that kept its data under another origin, a repeated host setup
 * on a computer whose server already has an owner) left that a bare `/api/v1`
 * on a computer that plainly runs one, and the recovery screen answered
 * "Paracord doesn't know which server to use yet". Its own server is the one
 * to use: the app installed it, and the shell trusts its origin with the
 * certificate on disk, without asking (`host.rs` `OwnServer`), once the
 * origin is in the trust sync, which runs after this.
 *
 * Boot awaits this before the first trust sync and before anything renders,
 * so no account request can go out ahead of it. It never replaces a saved
 * server, and a computer that hosts nothing is left as it is.
 */
export async function adoptHostedHomeServer(): Promise<string | null> {
  if (!isTauri() || getStoredServerUrl()) return null;
  let origin: string | null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    origin = await invoke<string | null>('host_home_server');
  } catch (error) {
    void logVoiceDiagnostic('[desktop] could not read whether this computer hosts a server', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!origin) return null;
  setStoredServerUrl(origin);
  void logVoiceDiagnostic('[desktop] no home server saved; using this computer’s own server', { origin });
  return origin;
}
