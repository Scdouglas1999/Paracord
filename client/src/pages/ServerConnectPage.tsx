import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerListStore } from '../stores/serverListStore';
import { gateway } from '../gateway/manager';
import { setStoredServerUrl } from '../lib/config/apiBaseUrl';
import { isPortableLink, decodePortableLink } from '../lib/portableLinks';
import { confirm } from '../stores/confirmStore';
import { OnboardingWizard, hasCompletedOnboarding } from '../components/onboarding/OnboardingWizard';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { syncTrustedHosts } from '../lib/trustedHosts';
import { isTauri } from '../lib/tauriEnv';

const PUBLIC_DEMO_SERVER_URL = (
  import.meta.env.VITE_PUBLIC_DEMO_SERVER_URL || 'https://demo.paracord.chat'
).trim();

/**
 * Normalise a raw server address into a full URL with protocol.
 * Defaults to https:// for all non-localhost addresses.
 */
function normaliseServerUrl(raw: string): string {
  let serverUrl = raw.trim();
  if (!/^https?:\/\//i.test(serverUrl)) {
    const hostAndPort = serverUrl.split('/')[0];
    const hostPart = hostAndPort.split(':')[0];
    const hasExplicitPort = /:\d+$/.test(hostAndPort);
    if (
      typeof window !== 'undefined' &&
      hostPart.toLowerCase() === window.location.hostname.toLowerCase() &&
      !hasExplicitPort
    ) {
      return window.location.origin.replace(/\/+$/, '');
    }

    const isLocalhost =
      hostPart === 'localhost' || hostPart === '127.0.0.1' || hostPart === '[::1]';
    serverUrl = (isLocalhost ? 'http://' : 'https://') + serverUrl;
  }
  return serverUrl.replace(/\/+$/, '');
}

function canonicalServerBaseFromResolvedUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return normaliseServerUrl(value);
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
    return { serverUrl: normaliseServerUrl(decoded.serverUrl), inviteCode: decoded.inviteCode };
  }

  // 2. Regular URL containing /invite/<code>
  const inviteMatch = trimmed.match(/^(https?:\/\/.+?)\/invite\/([A-Za-z0-9_-]+)\/?$/i);
  if (inviteMatch) {
    return { serverUrl: normaliseServerUrl(inviteMatch[1]), inviteCode: inviteMatch[2] };
  }

  // Also handle without protocol: host:port/invite/CODE
  const inviteMatchNoProto = trimmed.match(/^([^/]+)\/invite\/([A-Za-z0-9_-]+)\/?$/i);
  if (inviteMatchNoProto) {
    return { serverUrl: normaliseServerUrl(inviteMatchNoProto[1]), inviteCode: inviteMatchNoProto[2] };
  }

  // 3. Plain server URL / address
  return { serverUrl: normaliseServerUrl(trimmed) };
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
  const [url, setUrl] = useState('');
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
    <div className="auth-shell">
      <div className="mx-auto w-full max-w-md space-y-8">
        <form onSubmit={handleSubmit} className="auth-card space-y-8 p-10">
          <div className="text-center">
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Add Server</h1>
            <p className="mt-3 text-sm text-text-muted">
              Enter a server URL, invite link, or portable link to connect.
            </p>
          </div>

          {error && <ErrorBanner message={error} />}

          <div className="card-stack-roomy">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Server URL or Invite Link <span className="text-accent-danger">*</span>
              </span>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                className="input-field mt-2"
                placeholder="paracord://invite/... or 73.45.123.99:8080"
                autoFocus
              />
            </label>
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-4 py-3.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Accepted formats
            </span>
            <div className="mt-2 text-sm leading-6 text-text-muted">
              paracord://invite/aBcDeFgH...<br />
              http://192.168.1.5:8090/invite/abc123<br />
              192.168.1.5:8090 or chat.example.com
            </div>
          </div>

          <Button
            type="button"
            onClick={() => setUrl(PUBLIC_DEMO_SERVER_URL)}
            variant="outline"
            className="w-full border-accent-primary/40 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20"
          >
            Try a public demo server
          </Button>

          {status && (
            <div className="text-center text-sm text-text-muted">
              {status}
            </div>
          )}

          <Button type="submit" disabled={loading} className="mt-10 w-full">
            {loading ? 'Connecting...' : 'Add Server'}
          </Button>
        </form>

        {/* Existing servers */}
        {servers.length > 0 && (
          <div className="auth-card mt-2">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-secondary">
              Your Servers
            </h2>
            <div className="space-y-4">
              {servers.map((server) => (
                <div
                  key={server.id}
                  className="card-surface flex items-center justify-between rounded-xl border border-border-subtle/60 bg-bg-mod-subtle/40 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text-primary">
                      {server.name}
                    </div>
                    <div className="truncate text-xs text-text-muted">
                      {server.url}
                    </div>
                  </div>
                  <div className="ml-3 flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        server.connected
                          ? 'bg-accent-success'
                          : server.token
                            ? 'bg-accent-warning'
                            : 'bg-text-muted'
                      }`}
                    />
                    {!server.connected && (
                      <button
                        onClick={() => void handleReconnectServer(server.id)}
                        disabled={reconnectingId === server.id}
                        className="text-xs text-accent-primary transition-colors hover:text-accent-primary-hover disabled:opacity-60"
                      >
                        {reconnectingId === server.id ? 'Reconnecting...' : 'Reconnect'}
                      </button>
                    )}
                    <button
                      onClick={() => handleRemoveServer(server.id)}
                      className="text-xs text-text-muted transition-colors hover:text-accent-danger"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {servers.length > 0 && (
              <Button
                onClick={() => navigate('/app')}
                className="mt-4 w-full"
              >
                Continue to App
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


