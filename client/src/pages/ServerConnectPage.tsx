import { useState } from 'react';
import { setStoredServerUrl } from '../lib/apiBaseUrl';
import { isPortableLink, decodePortableLink } from '../lib/portableLinks';

/**
 * Normalise a raw server address into a full URL with protocol.
 * Uses http:// for IP addresses / localhost, https:// for domain names.
 */
function normaliseServerUrl(raw: string): string {
  let serverUrl = raw.trim();
  if (!/^https?:\/\//i.test(serverUrl)) {
    const hostPart = serverUrl.split(':')[0].split('/')[0];
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostPart) || hostPart === 'localhost';
    serverUrl = (isIp ? 'http://' : 'https://') + serverUrl;
  }
  return serverUrl.replace(/\/+$/, '');
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

/** Probe /health and verify this is a Paracord server. */
async function probeServer(serverUrl: string): Promise<void> {
  const resp = await fetch(`${serverUrl}/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error('Server returned an error');
  const data = await resp.json();
  if (data.service !== 'paracord') {
    throw new Error('Not a Paracord server');
  }
}

export function ServerConnectPage() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const input = url.trim();
    if (!input) {
      setError('Please enter a server URL or invite link.');
      setLoading(false);
      return;
    }

    try {
      const { serverUrl, inviteCode } = parseInput(input);

      await probeServer(serverUrl);

      setStoredServerUrl(serverUrl);

      if (inviteCode) {
        // Redirect to the invite acceptance page so the user can join
        window.location.href = `/invite/${inviteCode}`;
      } else {
        // Plain server connection - go to login
        window.location.href = '/login';
      }
    } catch {
      setError('Could not connect. Check the URL and ensure the server is running.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <form onSubmit={handleSubmit} className="auth-card mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold leading-tight text-text-primary">Connect to Server</h1>
          <p className="mt-2 text-sm text-text-muted">
            Enter a server URL, invite link, or portable link to connect.
          </p>
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

        <label className="mb-2 block">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
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

        <div className="mb-6 rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-3.5 py-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Accepted formats
          </span>
          <div className="mt-1.5 text-sm leading-6 text-text-muted">
            paracord://invite/aBcDeFgH...<br />
            http://192.168.1.5:8090/invite/abc123<br />
            192.168.1.5:8090 or chat.example.com
          </div>
        </div>

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'Connecting...' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
