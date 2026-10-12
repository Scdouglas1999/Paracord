import { useEffect } from 'react';
import { Navigate } from 'react-router';

import { openAddServer } from '../components/ix/dock/addServerStore';
import { BrandSplash } from '../components/brand/BrandSplash';
import { getStoredServerUrl } from '../lib/config/apiBaseUrl';
import { isTauri } from '../lib/tauriEnv';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';

/**
 * The target server is up and answering, but its CORS allowlist does not
 * include this page's origin.
 *
 * Carried as its own error type rather than a string so the wording lives in
 * exactly one place (`corsBlockedMessage`) and can be asserted on directly.
 */
export class CorsBlockedError extends Error {
  readonly host: string;
  readonly origin: string;

  constructor(host: string, origin: string) {
    super(corsBlockedMessage(host, origin));
    this.name = 'CorsBlockedError';
    this.host = host;
    this.origin = origin;
  }
}

/**
 * What to tell someone whose browser was refused by the *other* server.
 *
 * Nothing they can do on this page fixes it — the allowlist belongs to the
 * server they are connecting to — so the message names the host, the exact
 * setting its operator needs, and the fact that the desktop app is unaffected.
 * Credentialed CORS cannot reflect an arbitrary origin (that would let any
 * website drive a signed-in user's Paracord server), so an allowlist is the
 * only safe answer and the operator has to say the word.
 */
export function corsBlockedMessage(host: string, origin: string): string {
  return (
    `${host} doesn't allow browser connections from this origin. ` +
    `Its operator can allow it with PARACORD_CORS_ALLOWED_ORIGINS=${origin}; ` +
    `the desktop app is not affected.`
  );
}

/**
 * What to tell someone when the `no-cors` probe could not settle the question
 * either.
 *
 * The probe only works against a server that lets an opaque response through.
 * Paracord does not: every response carries
 * `Cross-Origin-Resource-Policy: same-origin`, `/health` included, so the
 * browser discards the opaque answer after it arrives and the probe rejects
 * exactly as an unreachable host does. Against another Paracord server — the
 * only kind this page connects to — the question is therefore unanswerable
 * from here, and the honest message is both possibilities rather than a
 * confident "check DNS" for what is usually a one-line setting on the other
 * end. The allowlist is still named, because the operator cannot act on a
 * cause nobody mentions.
 */
export function unreachableOrCorsBlockedMessage(host: string, origin: string): string {
  return (
    `Couldn't reach ${host} from this page. Either it is offline or blocked on ` +
    `the network, or it is running and does not allow browser connections from ` +
    `this origin. Its operator allows them with ` +
    // No sentence-ending punctuation after the origin: this is the value an
    // operator copies, and a full stop rides along with it.
    `PARACORD_CORS_ALLOWED_ORIGINS=${origin} — the desktop app is not affected.`
  );
}

/**
 * Decide whether a failed `fetch` was a CORS refusal rather than the server
 * being unreachable.
 *
 * The browser reports both as the same opaque `TypeError: Failed to fetch` on
 * purpose — leaking the difference would let any page probe private networks.
 * The one legitimate way to tell them apart is to repeat the request in
 * `no-cors` mode: the response is opaque and unreadable, but the promise only
 * *resolves* if the request actually reached a server and got an answer back.
 * A resolve therefore means the host is up and it was the allowlist that
 * refused us; a reject means DNS, TLS, the firewall, or the server being down.
 */
export async function probeRespondsWithoutCors(serverUrl: string): Promise<boolean> {
  try {
    await fetch(`${serverUrl}/health`, {
      method: 'GET',
      mode: 'no-cors',
      signal: AbortSignal.timeout(10_000),
    });
    return true;
  } catch {
    return false;
  }
}

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

function currentOrigin(): string {
  return typeof window !== 'undefined' && window.location ? window.location.origin : '';
}

/**
 * The server's own sentence when it refused to create an account for this
 * device: an invite-only server without a usable invite. `null` for anything
 * else, which the generic handling below explains.
 */
export function accountRefusalMessage(err: unknown): string | null {
  const data = (err as { response?: { data?: { code?: unknown; message?: unknown } } } | null)
    ?.response?.data;
  if (data?.code === 'INVITE_REQUIRED' && typeof data.message === 'string' && data.message) {
    return data.message;
  }
  return null;
}

export function toFriendlyConnectionError(err: unknown): string {
  if (err instanceof CorsBlockedError) {
    // Already the specific, actionable sentence — never fold it into the
    // generic "network request failed" branch below.
    return err.message;
  }
  if (!(err instanceof Error)) {
    return 'Could not connect. Check the link, and ask whoever runs the server whether it is up.';
  }

  const msg = err.message.trim();
  const lower = msg.toLowerCase();
  if (!msg) {
    return 'Could not connect. Check the link, and ask whoever runs the server whether it is up.';
  }
  if (lower.includes('not a paracord instance')) {
    return 'Something answered at that address, but it is not a Paracord server. Check the link for a typo.';
  }
  if (lower.includes('timed out')) {
    return 'The server did not answer. It may be switched off, or not reachable from your network. Ask whoever runs it, then try again.';
  }
  if (lower.includes('network request failed') || lower.includes('failed to fetch')) {
    return 'Could not reach that server. Check the link and your internet connection, then try again.';
  }
  if (lower.includes('certificate') || lower.includes('tls') || lower.includes('ssl')) {
    return 'The connection to that server could not be secured. If you typed the address by hand, check it; otherwise tell whoever runs the server that its certificate was refused.';
  }
  if (lower.includes('account not unlocked')) {
    return 'Unlock your account on this device first, then join.';
  }
  if (lower.includes('authentication failed') || lower.includes('challenge-response')) {
    return 'That server did not accept your sign-in. Try again, or sign in with a password instead.';
  }
  return msg;
}

/**
 * Whether an error is the browser's deliberately-opaque "something went wrong
 * on the wire" — the shape a CORS refusal takes once it reaches JavaScript.
 *
 * The per-server axios client surfaces a refused preflight as `ERR_NETWORK`,
 * exactly as it surfaces an unreachable host, so the code alone cannot tell
 * them apart; that is what `probeRespondsWithoutCors` is for. In Tauri there
 * is no CORS at all, so the question is never worth asking.
 */
function looksLikeOpaqueNetworkFailure(err: unknown): boolean {
  if (isTauri()) return false;
  if ((err as { code?: unknown } | null)?.code === 'ERR_NETWORK') return true;
  if (!(err instanceof Error)) return false;
  const lower = err.message.toLowerCase();
  return (
    lower.includes('network error') ||
    lower.includes('network request failed') ||
    lower.includes('failed to fetch')
  );
}

/**
 * `toFriendlyConnectionError` plus the one question a synchronous formatter
 * cannot ask: when an opaque network failure came from a server whose URL we
 * know, is that server actually up and merely refusing this origin?
 *
 * Without this, only the `/health` probe explains a CORS refusal and every
 * later step of the connect flow (challenge-response auth, reconnecting a saved
 * server) falls back to the generic "network request failed", which sends the
 * operator looking at DNS and TLS for a problem that is a one-line setting on
 * the other end.
 */
export async function explainConnectionFailure(err: unknown, serverUrl?: string): Promise<string> {
  if (err instanceof CorsBlockedError) return err.message;
  if (serverUrl && looksLikeOpaqueNetworkFailure(err)) {
    if (await probeRespondsWithoutCors(serverUrl)) {
      return corsBlockedMessage(hostOf(serverUrl), currentOrigin());
    }
    // The probe rejecting proves nothing against a server that sends CORP, so
    // an opaque failure in a browser keeps both causes on screen.
    return unreachableOrCorsBlockedMessage(hostOf(serverUrl), currentOrigin());
  }
  return toFriendlyConnectionError(err);
}

/**
 * `/connect` (docs/setup-spec.md §1.14). Its first-run role went to the first
 * run (`/welcome`): with no servers and no session, that is where it sends
 * you. Otherwise adding a server is the dock's Add server sheet, Join tab, over
 * the app. The connection-error helpers above are kept for the pages that
 * still explain a failed connection.
 */
export function ConnectRedirect() {
  const tokensHydrated = useServerListStore((s) => s.tokensHydrated);
  const servers = useServerListStore((s) => s.servers.length);
  const token = useAuthStore((s) => s.token);
  const firstRun = servers === 0 && !token && !getStoredServerUrl();

  useEffect(() => {
    if (tokensHydrated && !firstRun) openAddServer('join');
  }, [tokensHydrated, firstRun]);

  if (!tokensHydrated) return <BrandSplash label="Just a moment..." />;
  if (firstRun) return <Navigate to={isTauri() ? '/welcome' : '/login'} replace />;
  return <Navigate to="/app" replace />;
}
