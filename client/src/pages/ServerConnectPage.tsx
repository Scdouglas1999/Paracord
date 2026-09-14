import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Loader2, RefreshCw, Server, Sparkles, X } from 'lucide-react';
import { useServerListStore, resolveDefaultServerTarget } from '../stores/serverListStore';
import { gateway } from '../gateway/manager';
import { setStoredServerUrl, normalizeConnectInput } from '../lib/config/apiBaseUrl';
import { isPortableLink, decodePortableLink } from '../lib/portableLinks';
import { OnboardingWizard, hasCompletedOnboarding } from '../components/onboarding/OnboardingWizard';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { Input } from '../components/ui/Input';
import { Divider } from '../components/ui/Divider';
import { syncTrustedHosts } from '../lib/trustedHosts';
import { isTauri } from '../lib/tauriEnv';
import { AUTH_FORM, AuthCanvas, AuthCard, AuthHeading, AuthScroll, Field } from './authScaffold';

const PUBLIC_DEMO_SERVER_URL = (
  import.meta.env.VITE_PUBLIC_DEMO_SERVER_URL || 'https://demo.paracord.chat'
).trim();

function canonicalServerBaseFromResolvedUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // normalizeConnectInput is the single source of truth for connect-input
    // normalisation (shared with the data layer), used only as a fallback here.
    return normalizeConnectInput(value);
  }
}

/**
 * Parse user input to detect server URL + optional invite code.
 *
 * Accepted formats:
 *   1. Portable link:  paracord://invite/<token>
 *   2. Regular invite URL:  http(s)://host(:port)/invite/CODE
 *   3. Plain server address:  host:port  or  http(s)://host(:port)
 */
function parseInput(input: string): { serverUrl: string; inviteCode?: string } {
  const trimmed = input.trim();

  // 1. Portable link (paracord://invite/...)
  if (isPortableLink(trimmed)) {
    const decoded = decodePortableLink(trimmed);
    return { serverUrl: normalizeConnectInput(decoded.serverUrl), inviteCode: decoded.inviteCode };
  }

  // 2. Regular URL containing /invite/<code>
  const inviteMatch = trimmed.match(/^(https?:\/\/.+?)\/invite\/([A-Za-z0-9_-]+)\/?$/i);
  if (inviteMatch) {
    return { serverUrl: normalizeConnectInput(inviteMatch[1]), inviteCode: inviteMatch[2] };
  }

  // Also handle without protocol: host:port/invite/CODE
  const inviteMatchNoProto = trimmed.match(/^([^/]+)\/invite\/([A-Za-z0-9_-]+)\/?$/i);
  if (inviteMatchNoProto) {
    return { serverUrl: normalizeConnectInput(inviteMatchNoProto[1]), inviteCode: inviteMatchNoProto[2] };
  }

  // 3. Plain server URL / address
  return { serverUrl: normalizeConnectInput(trimmed) };
}

function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** Probe /health via Tauri's Rust-side HTTP client (bypasses WebView2 TLS restrictions). */
async function probeServerViaTauri(serverUrl: string): Promise<{ name: string; canonicalServerUrl: string }> {
  const { invoke } = await import('@tauri-apps/api/core');
  const data = await invoke<{ service?: string; name?: string }>('probe_server', { serverUrl });
  if (data.service !== 'paracord') {
    throw new Error('Not a Paracord server');
  }
  const canonicalServerUrl = canonicalServerBaseFromResolvedUrl(serverUrl);
  let fallbackName = canonicalServerUrl;
  try {
    fallbackName = new URL(canonicalServerUrl).host;
  } catch {
    // keep canonical URL as fallback
  }
  return {
    name: data.name || fallbackName,
    canonicalServerUrl,
  };
}

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

/** Probe /health via browser fetch (works in web builds). */
async function probeServerViaFetch(serverUrl: string): Promise<{ name: string; canonicalServerUrl: string }> {
  let resp: Response;
  try {
    resp = await fetch(`${serverUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Connection timed out while probing server health endpoint.');
    }
    if (err instanceof TypeError) {
      // Reachable but refused => the peer's CORS allowlist, not the network.
      if (await probeRespondsWithoutCors(serverUrl)) {
        throw new CorsBlockedError(hostOf(serverUrl), currentOrigin());
      }
      throw new Error('Network request failed. Check DNS, protocol, CORS, and TLS certificate settings.');
    }
    throw err;
  }
  if (!resp.ok) throw new Error('Server returned an error');
  const data = await resp.json();
  if (data.service !== 'paracord') {
    throw new Error('Not a Paracord server');
  }
  const canonicalServerUrl = canonicalServerBaseFromResolvedUrl(resp.url || serverUrl);
  let fallbackName = canonicalServerUrl;
  try {
    fallbackName = new URL(canonicalServerUrl).host;
  } catch {
    // keep canonical URL as fallback
  }
  return {
    name: data.name || fallbackName,
    canonicalServerUrl,
  };
}

/** Probe /health and verify this is a Paracord server. Uses Rust-side HTTP in Tauri, fetch in browser. */
async function probeServer(serverUrl: string): Promise<{ name: string; canonicalServerUrl: string }> {
  if (isTauri()) {
    return probeServerViaTauri(serverUrl);
  }
  return probeServerViaFetch(serverUrl);
}

export function toFriendlyConnectionError(err: unknown): string {
  if (err instanceof CorsBlockedError) {
    // Already the specific, actionable sentence — never fold it into the
    // generic "network request failed" branch below.
    return err.message;
  }
  if (!(err instanceof Error)) {
    return 'Could not connect. Check the URL and ensure the server is running.';
  }

  const msg = err.message.trim();
  const lower = msg.toLowerCase();
  if (!msg) {
    return 'Could not connect. Check the URL and ensure the server is running.';
  }
  if (lower.includes('not a paracord server')) {
    return 'Connected endpoint is reachable, but it does not identify as a Paracord server.';
  }
  if (lower.includes('timed out')) {
    return 'Connection timed out. The server may be offline, blocked by firewall, or too slow to respond.';
  }
  if (lower.includes('network request failed') || lower.includes('failed to fetch')) {
    return 'Network request failed. Verify DNS, protocol (http/https), CORS configuration, and TLS certificate trust.';
  }
  if (lower.includes('certificate') || lower.includes('tls') || lower.includes('ssl')) {
    return 'TLS handshake failed. Verify server certificate chain and hostname.';
  }
  if (lower.includes('account not unlocked')) {
    return 'Unlock your local account before connecting to this server.';
  }
  if (lower.includes('authentication failed') || lower.includes('challenge-response')) {
    return 'Server authentication failed. Ensure this server supports challenge-response auth and your account exists.';
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

export function ServerConnectPage() {
  // Prefill the sensible default (the current origin in browser builds), sourced
  // from the data layer so URL logic isn't duplicated on the connect screen.
  const [url, setUrl] = useState(() => resolveDefaultServerTarget());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(() => !hasCompletedOnboarding());
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const navigate = useNavigate();
  const servers = useServerListStore((s) => s.servers);

  // Show onboarding wizard for first-time users with no servers
  if (showOnboarding && servers.length === 0) {
    return (
      <OnboardingWizard
        onComplete={() => setShowOnboarding(false)}
        onTryDemo={() => {
          setUrl(PUBLIC_DEMO_SERVER_URL);
          setShowOnboarding(false);
        }}
      />
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setStatus('');

    const input = url.trim();
    if (!input) {
      setError('Please enter a server URL or invite link.');
      setLoading(false);
      return;
    }

    // Remembered across the try/catch so a failure late in the flow can still
    // ask whether the target server is up and merely refusing this origin.
    let probedServerUrl: string | undefined;

    try {
      const { serverUrl, inviteCode } = parseInput(input);
      probedServerUrl = serverUrl;
      const parsedUrl = new URL(serverUrl);
      if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLocalhostHost(parsedUrl.hostname))) {
        throw new Error(
          'Remote Paracord servers must use HTTPS. Plain HTTP is allowed only for localhost development servers.',
        );
      }

      // Ask Rust to verify/trust the host so WebView2 allows self-signed certs during probe.
      const existingUrls = useServerListStore.getState().servers.map((s) => s.url);
      await syncTrustedHosts([...existingUrls, serverUrl]);

      setStatus('Probing server...');
      const probe = await probeServer(serverUrl);
      const canonicalServerUrl = probe.canonicalServerUrl;
      const serverName = probe.name;

      // Add server to the multi-server list
      const serverId = useServerListStore.getState().addServer(canonicalServerUrl, serverName);
      setStoredServerUrl(canonicalServerUrl);

      // Try challenge-response auth if the local account is set up.
      // If not, just save the server and redirect to login for password auth.
      setStatus('Authenticating...');
      try {
        await gateway.connectServer(serverId);
      } catch (authErr) {
        gateway.disconnectServer(serverId);
        const msg = authErr instanceof Error ? authErr.message : '';
        if (msg.includes('not unlocked') || msg.includes('No server token')) {
          // Account not set up for challenge-response — fall through to login
          if (inviteCode) {
            navigate(`/invite/${inviteCode}`);
          } else {
            navigate('/login');
          }
          return;
        }
        useServerListStore.getState().removeServer(serverId);
        throw new Error(
          msg || 'Server authentication failed.',
        );
      }

      if (inviteCode) {
        navigate(`/invite/${inviteCode}`);
      } else {
        navigate('/app');
      }
    } catch (err) {
      setError(await explainConnectionFailure(err, probedServerUrl));
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

  const handleRemoveServer = (serverId: string) => {
    gateway.disconnectServer(serverId);
    useServerListStore.getState().removeServer(serverId);
  };

  const handleReconnectServer = async (serverId: string) => {
    const server = servers.find((entry) => entry.id === serverId);
    if (!server) return;
    setError('');
    setStatus('');
    setReconnectingId(serverId);
    try {
      useServerListStore.getState().setActive(serverId);
      setStoredServerUrl(server.url);
      await gateway.connectServer(serverId);
      navigate('/app');
    } catch (err) {
      setError(await explainConnectionFailure(err, server.url));
    } finally {
      setReconnectingId(null);
    }
  };

  return (
    <AuthCanvas>
      <div className="mx-auto flex w-full min-h-0 max-w-md flex-col gap-5 sm:max-h-full short-window:max-w-2xl">
        <AuthCard>
          <form onSubmit={handleSubmit} className={AUTH_FORM}>
            <AuthHeading
              title="Connect to a server"
              subtitle="Paste a server address, invite, or portable link. Paracord probes it before you sign in."
            />

            {error && <ErrorBanner multiline message={error} />}

            {/* The accepted formats are reference material, so on a short,
                wide window they sit beside the box they describe rather than
                below it. */}
            <AuthScroll paired>
            <Field label="Server URL or Invite link" required>
              <Input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                className="pc-mono"
                placeholder="chat.example.com or paracord://invite/…"
                autoFocus
              />
            </Field>

            <div className="pc-well px-4 py-3">
              <span className="text-section text-text-faint">Accepted formats</span>
              {/* URLs have no spaces to break at: without this they run out
                  of the well rather than wrapping inside it. */}
              <ul className="mt-2 space-y-1 break-all pc-mono text-meta leading-relaxed text-text-secondary">
                <li>paracord://invite/aBcDeFgH…</li>
                <li>http://192.168.1.5:8090/invite/abc123</li>
                <li>192.168.1.5:8090 · chat.example.com</li>
              </ul>
            </div>
            </AuthScroll>

            {status && (
              <div
                className="pc-well flex items-center gap-2 px-4 py-2.5 text-label text-text-secondary"
                aria-live="polite"
              >
                <Loader2 size={15} className="shrink-0 animate-spin text-accent-primary" />
                <span>{status}</span>
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              <Button type="submit" size="lg" loading={loading} disabled={loading} className="w-full">
                Add server
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="lg"
                onClick={() => setUrl(PUBLIC_DEMO_SERVER_URL)}
                className="w-full"
              >
                <Sparkles size={15} aria-hidden />
                Try a public demo server
              </Button>
            </div>
          </form>
        </AuthCard>

        {/* Recent servers — selectable rows on their own plate, divided by a
            hairline rather than tiled as identical cards (spec §6.8). */}
        {servers.length > 0 && (
          <AuthCard>
            <div className="flex min-h-0 flex-col p-4 sm:p-5">
              <div className="flex items-center justify-between px-2 pb-1">
                <h2 className="pc-display text-heading text-text-primary">Your servers</h2>
                <span className="pc-mono text-meta text-text-faint">{servers.length}</span>
              </div>
              <ul className="mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
                {servers.map((server, index) => {
                  // Presence here is a word, never a coloured dot (spec §1.5, §6.6).
                  const stateLabel = server.connected
                    ? 'Connected'
                    : server.token
                      ? 'Saved — not connected'
                      : 'Sign-in required';
                  const reconnecting = reconnectingId === server.id;
                  return (
                    <li key={server.id}>
                      {index > 0 && <Divider className="mx-2" />}
                      <div className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-3 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle">
                        <span
                          className="pc-well flex h-9 w-9 shrink-0 items-center justify-center text-text-secondary"
                          aria-hidden
                        >
                          <Server size={17} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate pc-display text-name text-text-primary">
                            {server.name}
                          </div>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                            <span className="shrink-0 text-meta text-text-secondary">{stateLabel}</span>
                            <span className="truncate pc-mono text-meta text-text-faint">
                              · {server.url}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {!server.connected && (
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => void handleReconnectServer(server.id)}
                              disabled={reconnecting}
                            >
                              <RefreshCw size={13} className={reconnecting ? 'animate-spin' : ''} aria-hidden />
                              {reconnecting ? 'Reconnecting…' : 'Reconnect'}
                            </Button>
                          )}
                          <IconButton
                            label={`Remove ${server.name}`}
                            onClick={() => handleRemoveServer(server.id)}
                          >
                            <X size={15} />
                          </IconButton>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <Divider className="mx-2 mt-1" />
              <div className="px-2 pt-4">
                <Button size="lg" onClick={() => navigate('/app')} className="w-full">
                  Continue to app
                </Button>
              </div>
            </div>
          </AuthCard>
        )}
      </div>
    </AuthCanvas>
  );
}
