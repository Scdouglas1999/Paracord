import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useServerListStore } from '../stores/serverListStore';
import { useAuthStore } from '../stores/authStore';
import { hasAccount } from '../lib/account';
import { getStoredServerUrl, getCurrentOriginServerUrl, setStoredServerUrl } from '../lib/config/apiBaseUrl';
import { gateway } from '../gateway/manager';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { AuthCanvas, AuthCard, AuthHeading, Field } from './authScaffold';

export function AccountUnlockPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const navigate = useNavigate();
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

      const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();
      if (serverUrl) {
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

        const server = useServerListStore.getState().getServer(serverId);
        if (!server?.token) {
          try {
            await gateway.connectServer(serverId);
          } catch {
            // Non-fatal. User can still proceed and add/fix server details manually.
          }
        }
      }

      navigate('/app');
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
        <form onSubmit={handleSubmit} className="flex flex-col gap-6 p-8">
          <AuthHeading title="Welcome back" subtitle="Unlock your local identity to pick up where you left off." />

          {username && (
            <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-tertiary/50 px-4 py-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-tint text-heading font-display font-semibold text-accent-primary">
                {username[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-label font-semibold text-text-primary">{username}</p>
                <p className="truncate font-code text-meta text-text-muted">{shortKey}</p>
              </div>
            </div>
          )}

          {error && <ErrorBanner message={error} />}

          <Field label="Password" required>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="input-field"
              placeholder="Enter your password"
              autoComplete="current-password"
              autoFocus
            />
          </Field>

          <Button
            type="submit"
            loading={loading}
            disabled={loading || Date.now() < cooldownUntil}
            className="w-full"
          >
            Unlock
          </Button>

          <div className="flex flex-col gap-2 border-t border-border-subtle pt-5 text-label text-text-secondary">
            <button
              type="button"
              onClick={() => navigate('/recover')}
              className="self-start font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
            >
              Forgot password? Recover from phrase
            </button>
            <button
              type="button"
              onClick={() => navigate('/app?settings=identity')}
              className="self-start font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
            >
              Import account from file
            </button>
          </div>
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}


