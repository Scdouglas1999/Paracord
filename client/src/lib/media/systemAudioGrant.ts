import { isTauri } from '../tauriEnv';

/**
 * Whether this platform needs a Paracord-owned grant to capture the computer's
 * own audio into a stream, and whether it has one.
 *
 * `required` is false where the operating system already owns that decision —
 * on Linux the desktop portal you answer when you pick a screen *is* the grant,
 * so there is nothing for Paracord to remember and nothing to manage here.
 * Windows has no such surface, so Paracord asks once per install and keeps the
 * answer; that is the case this exists to make visible and revocable.
 */
export interface SystemAudioGrant {
  required: boolean;
  granted: boolean;
}

export async function getSystemAudioGrant(): Promise<SystemAudioGrant | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return (await invoke('system_audio_grant_state')) as SystemAudioGrant;
}

/**
 * Withdraw the grant. There is deliberately no counterpart that awards one:
 * only the native prompt can do that, so a compromised renderer can switch
 * desktop audio off but never on.
 */
export async function revokeSystemAudioGrant(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('revoke_system_audio_grant');
}
