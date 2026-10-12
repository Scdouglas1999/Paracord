import type { InvitePreview } from '../../api/generated/InvitePreview';
import type { InviteLink } from '../../lib/inviteLinks';
import { isPinMismatch } from '../../lib/trustedHosts';
import { trustWords } from '../../lib/trustWords';
import { isTauri } from '../../lib/tauriEnv';
import type { InviteCheck } from '../../stores/firstRunStore';

/**
 * Resolving an invite for the Join step's card (docs/setup-spec.md §1.5, §6.1,
 * §7.3). On the desktop the shell fetches the public preview on a connection of
 * its own and reports the certificate it saw on that same connection
 * (`preview_invite`): the server is not trusted yet, so `native_fetch` would
 * refuse it, and the words the card shows must be the certificate the preview
 * came over. In a browser the page is the server's own (§6.6) and the browser
 * already did TLS.
 */

interface ShellPreview {
  status: number;
  body: unknown;
  fingerprint: string | null;
  ca_verified: boolean;
}

export function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return serverUrl;
  }
}

/** One-password sign-up needs a server that speaks it (§3.12): `instance` absent or older is an older server. */
export function isOlderServer(preview: InvitePreview): boolean {
  return !preview.instance || !(Number(preview.instance.credential_version) >= 2);
}

async function fetchFromShell(link: InviteLink): Promise<ShellPreview> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ShellPreview>('preview_invite', { serverUrl: link.serverUrl, code: link.code });
}

async function fetchFromPage(link: InviteLink): Promise<ShellPreview> {
  const response = await fetch(`${link.serverUrl}/api/v1/invites/${encodeURIComponent(link.code)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, fingerprint: null, ca_verified: false };
}

/** What the card shows for `link`. Never throws: every outcome is a state the step draws. */
export async function checkInvite(link: InviteLink): Promise<InviteCheck> {
  const host = hostOf(link.serverUrl);
  const desktop = isTauri();
  let answer: ShellPreview;
  try {
    answer = desktop ? await fetchFromShell(link) : await fetchFromPage(link);
  } catch (error) {
    if (isPinMismatch(error)) return { state: 'identity-changed', link, preview: null, identity: null, host };
    return { state: 'unreachable', link, preview: null, identity: null, host };
  }
  if (answer.status === 404 || answer.status === 410) return { state: 'invalid', link, preview: null, identity: null, host };
  const preview = answer.body as InvitePreview | null;
  if (answer.status < 200 || answer.status >= 300 || !preview || typeof preview !== 'object' || !preview.guild) {
    return { state: answer.status === 200 ? 'invalid' : 'unreachable', link, preview: null, identity: null, host };
  }
  if (isOlderServer(preview)) return { state: 'old-server', link, preview, identity: null, host };
  const fingerprint = desktop ? answer.fingerprint : null;
  const caVerified = answer.ca_verified === true;
  const words = fingerprint && !caVerified ? await trustWords(fingerprint) : [];
  return { state: 'card', link, preview, identity: { fingerprint, caVerified, words }, host };
}
