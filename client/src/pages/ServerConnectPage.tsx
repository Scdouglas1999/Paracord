import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw, Server, Sparkles, X } from 'lucide-react';
import { useServerListStore, resolveDefaultServerTarget } from '../stores/serverListStore';
import { gateway } from '../gateway/manager';
import { setStoredServerUrl, normalizeConnectInput } from '../lib/config/apiBaseUrl';
import { isPortableLink, decodePortableLink } from '../lib/portableLinks';
import { confirm } from '../stores/confirmStore';
import { OnboardingWizard, hasCompletedOnboarding } from '../components/onboarding/OnboardingWizard';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { syncTrustedHosts } from '../lib/trustedHosts';
import { isTauri } from '../lib/tauriEnv';
import { AuthCanvas, AuthCard, AuthHeading, Field } from './authScaffold';

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

function toFriendlyConnectionError(err: unknown): string {
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

    try {
      const { serverUrl, inviteCode } = parseInput(input);
      const parsedUrl = new URL(serverUrl);
      if (parsedUrl.protocol === 'http:' && !isLocalhostHost(parsedUrl.hostname)) {
        const proceed = await confirm({
          title: 'Insecure connection',
          description: 'This server uses unencrypted HTTP. Credentials and tokens can be intercepted. Continue anyway?',
          confirmLabel: 'Continue',
          variant: 'danger',
        });
        if (!proceed) {
          setLoading(false);
          return;
        }
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
      setError(toFriendlyConnectionError(err));
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
      setError(toFriendlyConnectionError(err));
    } finally {
      setReconnectingId(null);
    }
  };

  return (
    <AuthCanvas>
      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        <AuthCard>
          <form onSubmit={handleSubmit} className="flex flex-col gap-6 p-8">
            <AuthHeading
              title="Connect to a server"
              subtitle="Paste a server address, invite, or portable link. Paracord probes it before you sign in."
            />

            {error && <ErrorBanner message={error} />}

            <Field label="Server URL or Invite Link" required>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                className="input-field font-code"
                placeholder="chat.example.com or paracord://invite/…"
                autoFocus
              />
            </Field>

            <div className="rounded-md border border-border-subtle bg-bg-tertiary/50 px-4 py-3">
              <span className="text-section uppercase text-text-muted">Accepted formats</span>
              <ul className="mt-2 space-y-1 font-code text-meta leading-relaxed text-text-secondary">
                <li>paracord://invite/aBcDeFgH…</li>
                <li>http://192.168.1.5:8090/invite/abc123</li>
                <li>192.168.1.5:8090 · chat.example.com</li>
              </ul>
            </div>

            {status && (
              <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-tertiary/40 px-4 py-2.5 text-label text-text-secondary">
                <Loader2 size={15} className="shrink-0 animate-spin text-accent-primary" />
                <span>{status}</span>
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              <Button type="submit" loading={loading} disabled={loading} className="w-full">
                Add Server
              </Button>
              <button
                type="button"
                onClick={() => setUrl(PUBLIC_DEMO_SERVER_URL)}
                className="inline-flex items-center justify-center gap-1.5 rounded-sm px-3 py-2 text-label font-semibold text-text-link transition-colors hover:bg-accent-tint"
              >
                <Sparkles size={15} />
                Try a public demo server
              </button>
            </div>
          </form>
        </AuthCard>

        {/* Recent servers — selectable rows, grouped by dividers rather than tiled cards. */}
        {servers.length > 0 && (
          <AuthCard>
            <div className="flex items-center justify-between px-6 pt-5">
              <h2 className="text-section uppercase text-text-secondary">Your servers</h2>
              <span className="text-meta text-text-muted">{servers.length}</span>
            </div>
            <ul className="mt-2 flex flex-col divide-y divide-border-subtle px-3 pb-3">
              {servers.map((server) => {
                const state = server.connected
                  ? { dot: 'bg-accent-success', label: 'Connected', tone: 'text-accent-success' }
                  : server.token
                    ? { dot: 'bg-accent-warning', label: 'Saved — not connected', tone: 'text-accent-warning' }
                    : { dot: 'bg-status-offline', label: 'Sign-in required', tone: 'text-text-muted' };
                const reconnecting = reconnectingId === server.id;
                return (
                  <li
                    key={server.id}
                    className="flex items-center gap-3 rounded-sm px-3 py-3 transition-colors hover:bg-bg-mod-subtle"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
                      <Server size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-label font-semibold text-text-primary">
                        {server.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${state.dot}`} />
                        <span className={`text-meta ${state.tone}`}>{state.label}</span>
                        <span className="truncate font-code text-meta text-text-muted">· {server.url}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {!server.connected && (
                        <button
                          onClick={() => void handleReconnectServer(server.id)}
                          disabled={reconnecting}
                          className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-meta font-semibold text-accent-primary transition-colors hover:bg-accent-tint disabled:opacity-60"
                        >
                          <RefreshCw size={13} className={reconnecting ? 'animate-spin' : ''} />
                          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
                        </button>
                      )}
                      <button
                        onClick={() => handleRemoveServer(server.id)}
                        aria-label={`Remove ${server.name}`}
                        className="flex h-8 w-8 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-danger-tint hover:text-accent-danger"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-border-subtle p-4">
              <Button onClick={() => navigate('/app')} className="w-full">
                Continue to app
              </Button>
            </div>
          </AuthCard>
        )}
      </div>
    </AuthCanvas>
  );
}


