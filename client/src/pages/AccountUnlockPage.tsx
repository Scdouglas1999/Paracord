import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAccountStore } from '../stores/accountStore';
import { normalizeServerUrl, useServerListStore } from '../stores/serverListStore';
import { useAuthStore } from '../stores/authStore';
import { hasAccount } from '../lib/account';
import { getStoredServerUrl, getCurrentOriginServerUrl, setStoredServerUrl } from '../lib/config/apiBaseUrl';
import { gateway } from '../gateway/manager';
import { ErrorBanner } from '../components/ui/Feedback';
import { Divider } from '../components/ui/Divider';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { AUTH_FORM, AuthCanvas, AuthCard, AuthHeading, AuthScroll, Field } from './authScaffold';

export function AccountUnlockPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo');
  const destination = returnTo?.startsWith('/app/') && !returnTo.includes('\\') ? returnTo : '/app';
  const unlock = useAccountStore((s) => s.unlock);
  const publicKey = useAccountStore((s) => s.publicKey);
  const username = useAccountStore((s) => s.username);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!hasAccount()) {
      navigate('/login');
    }
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const now = Date.now();
    if (now < cooldownUntil) {
      const waitSeconds = Math.ceil((cooldownUntil - now) / 1000);
      setError(`Too many attempts. Try again in ${waitSeconds}s.`);
      return;
    }
    setLoading(true);
    try {
      await unlock(password);
      setFailedAttempts(0);
      setCooldownUntil(0);

      const originUrl = getCurrentOriginServerUrl();
      const serverUrl = getStoredServerUrl() || originUrl;
      // The embedded web UI *is* its server: `__local__` already owns this
      // origin's session, its API client and its event stream. Registering the
      // same origin a second time as a "remote" entry — and making that entry
      // the active server — hands every request to a connection that can never
      // get a stream of its own: the duplicate-SSE guard in connectionManager
      // sees `__local__` already streaming to that URL, marks the newcomer
      // connected and returns. READY then never reaches the account's message
      // runtime for the new scope, so the conversation sat on "Waiting for this
      // server's authenticated connection" until the page was loaded again.
      const isOwnOrigin = !!originUrl && !!serverUrl
        && normalizeServerUrl(serverUrl) === normalizeServerUrl(originUrl);
      if (serverUrl && !isOwnOrigin) {
        setStoredServerUrl(serverUrl);
        const serverStore = useServerListStore.getState();
        const existingServer = serverStore.getServerByUrl(serverUrl);
        const tokenForServer = token || undefined;

        let serverName = serverUrl;
        try {
          serverName = new URL(serverUrl).host;
        } catch {
          // Keep raw URL as name if parsing fails.
        }

        const serverId = existingServer
          ? existingServer.id
          : serverStore.addServer(serverUrl, serverName, tokenForServer);

        // What decides this is whether a LIVE connection exists, not whether the
        // entry carries a token. `addServer` is handed the session token above,
        // so a freshly created entry always has one — and the old `!server.token`
        // test therefore skipped the connect on exactly the load that created
        // the entry and made it active. `getApi()` then resolved the active
        // server to a connection that was never opened and threw "This server is
        // not connected", so the first unlock after enrolment left the composer
        // unable to send or save a draft until the page was loaded again.
        if (!gateway.getApiClient(serverId)) {
          try {
            await gateway.connectServer(serverId);
          } catch {
            // Non-fatal. User can still proceed and add/fix server details manually.
          }
        }
      }

      navigate(destination);
    } catch {
      const nextFailures = failedAttempts + 1;
      setFailedAttempts(nextFailures);
      if (nextFailures >= 3) {
        const backoffSeconds = Math.min(30, 2 ** Math.min(5, nextFailures - 3));
        setCooldownUntil(Date.now() + backoffSeconds * 1000);
      }
      setError('Unlock failed. Check your password and try again.');
    } finally {
      setLoading(false);
    }
  };

  const shortKey = publicKey ? `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}` : '';

  return (
    <AuthCanvas>
      <AuthCard className="max-w-md">
        <form onSubmit={handleSubmit} className={AUTH_FORM}>
          <AuthHeading title="Welcome back" subtitle="Unlock your local identity to pick up where you left off." />

          {username && (
            <div className="pc-well flex items-center gap-3 px-4 py-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-full)] bg-bg-raised pc-display text-heading font-semibold text-text-primary">
                {username[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate pc-display text-name text-text-primary">{username}</p>
                <p className="truncate pc-mono text-meta text-text-faint">{shortKey}</p>
              </div>
            </div>
          )}

          {error && <ErrorBanner multiline message={error} />}

          <AuthScroll>
            <Field label="Password" required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Enter your password"
                autoComplete="current-password"
                autoFocus
              />
            </Field>
          </AuthScroll>

          <Button
            type="submit"
            size="lg"
            loading={loading}
            disabled={loading || Date.now() < cooldownUntil}
            className="w-full"
          >
            Unlock
          </Button>

          <Divider />

          <div className="flex flex-col items-start gap-2 text-meta text-text-secondary">
            <button
              type="button"
              onClick={() => navigate('/recover')}
              className="pc-focusable rounded-[var(--radius-chip)] font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
            >
              Forgot password? Recover from phrase
            </button>
            <button
              type="button"
              onClick={() => navigate('/app?settings=identity')}
              className="pc-focusable rounded-[var(--radius-chip)] font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
            >
              Import account from file
            </button>
            {/* This screen is now where a device with an identity starts, so it
                must not be the only door: signing in as someone else, or as
                this account by password, has to stay possible. */}
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="pc-focusable rounded-[var(--radius-chip)] font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
            >
              Sign in with a password instead
            </button>
          </div>
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}


