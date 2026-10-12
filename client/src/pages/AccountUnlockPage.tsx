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
import { Avatar } from '../components/ix/identity';
import { AUTH_FORM, AuthCanvas, AuthCard, AuthHeading, AuthScroll, Field } from './authScaffold';
import {
  completeMfaSignIn,
  confirmRecoverySaved,
  credentialErrorMessage,
  currentRecoveryPhrase,
  pinForAccount,
  unlockWithPassword,
  type PendingMfaSignIn,
} from '../lib/oneCredential';
import { RecoveryPhraseCard } from './RecoveryPhraseCard';

/**
 * Whether this device unlocks with the one password (docs/setup-spec.md §3.5):
 * it holds the v2 keystore, or it is signed in to an account it has pinned as
 * one-password and has not fetched the keys yet.
 */
export function unlocksWithOnePassword(identityVersion: 1 | 2 | null | undefined, signedInUserId: string | null): boolean {
  if (identityVersion === 2) return true;
  if (identityVersion === 1 || !signedInUserId) return false;
  return pinForAccount(signedInUserId) !== null;
}

export function AccountUnlockPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const guardReturnTo = useAccountStore((s) => s.unlockReturnTo);
  const returnTo = params.get('returnTo') ?? guardReturnTo;
  const destination = returnTo && /^\/app(\/|\?|$)/.test(returnTo) && !returnTo.includes('\\') ? returnTo : '/app';
  const unlock = useAccountStore((s) => s.unlock);
  const identityVersion = useAccountStore((s) => s.identityVersion);
  const setUnlockReturnTo = useAccountStore((s) => s.setUnlockReturnTo);
  const signedInUserId = useAuthStore((s) => (s.token ? s.user?.id ?? null : null));
  const [pendingMfa, setPendingMfa] = useState<PendingMfaSignIn | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const publicKey = useAccountStore((s) => s.publicKey);
  const username = useAccountStore((s) => s.username);
  const token = useAuthStore((s) => s.token);

  const onePassword = unlocksWithOnePassword(identityVersion, signedInUserId);

  useEffect(() => {
    if (!hasAccount() && !onePassword) {
      navigate('/login');
    }
  }, [navigate, onePassword]);

  /** One password: unlock, and when the phrase was never confirmed, show it again (§1.8). */
  const unlockOnePassword = async (): Promise<boolean> => {
    const outcome = pendingMfa
      ? await completeMfaSignIn(pendingMfa, mfaCode).then((result) => {
        if (result.kind !== 'signed-in') throw new Error('Sign in again.');
        return { kind: 'unlocked' as const, recoveryConfirmed: result.recoveryConfirmed };
      })
      : await unlockWithPassword(password);
    if (outcome.kind === 'mfa') {
      setPendingMfa(outcome.pending);
      setMfaCode('');
      return false;
    }
    setPendingMfa(null);
    setPassword('');
    if (outcome.recoveryConfirmed === false) {
      const words = currentRecoveryPhrase();
      if (words) {
        setPhrase(words);
        return false;
      }
    }
    return true;
  };

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
      if (onePassword) {
        if (!await unlockOnePassword()) return;
      } else {
        await unlock(password);
      }
      setFailedAttempts(0);
      setCooldownUntil(0);
      await finishUnlock();
    } catch (err) {
      const nextFailures = failedAttempts + 1;
      setFailedAttempts(nextFailures);
      if (nextFailures >= 3) {
        const backoffSeconds = Math.min(30, 2 ** Math.min(5, nextFailures - 3));
        setCooldownUntil(Date.now() + backoffSeconds * 1000);
      }
      setError(onePassword
        ? credentialErrorMessage(err, "That password doesn't open your keys.")
        : 'Unlock failed. Check your password and try again.');
    } finally {
      setLoading(false);
    }
  };

  const finishUnlock = async () => {
    setUnlockReturnTo?.(null);
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
      // not connected", so the first unlock after enrollment left the composer
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
  };

  const shortKey = publicKey ? `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}` : '';

  if (phrase) {
    return (
      <RecoveryPhraseCard
        phrase={phrase}
        onConfirm={async () => {
          await confirmRecoverySaved();
          setPhrase('');
          await finishUnlock();
        }}
      />
    );
  }

  return (
    <AuthCanvas>
      <AuthCard>
        <form onSubmit={handleSubmit} className={AUTH_FORM}>
          <AuthHeading
            title="Welcome back"
            subtitle={onePassword
              ? 'Enter your password to open your account on this device.'
              : 'Unlock your local identity to pick up where you left off.'}
          />

          {username && (
            <div className="pc-well flex items-center gap-3 px-4 py-3">
              {/* The identity on this device has no account id yet: its key picks the hue. */}
              <Avatar userId={publicKey || username} name={username} size={40} ring="var(--ix-main)" />
              <div className="min-w-0">
                <p className="truncate text-[14.5px] font-semibold text-[var(--ix-ink)]">{username}</p>
                <p className="truncate pc-mono text-[13px] text-[var(--ix-ink-3)]">{shortKey}</p>
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
            {pendingMfa && (
              <Field label="Two-factor code" required hint="Enter the code from your authenticator app.">
                <Input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  required
                  className="pc-mono"
                  autoFocus
                />
              </Field>
            )}
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

          {onePassword ? (
            <div className="flex flex-col items-start gap-2.5">
              <p className="text-[13.5px] text-[var(--ix-ink-3)]">
                Forgot your password?{' '}
                <button
                  type="button"
                  onClick={() => navigate('/recover')}
                  className="pc-focusable ix-auth__link rounded-[6px]"
                >
                  Use your recovery phrase
                </button>
              </p>
              <button
                type="button"
                onClick={() => { void useAuthStore.getState().logout().finally(() => navigate('/login', { replace: true })); }}
                className="pc-focusable ix-auth__link rounded-[6px]"
              >
                Sign out
              </button>
            </div>
          ) : (
          <div className="flex flex-col items-start gap-2.5">
            <button
              type="button"
              onClick={() => navigate('/recover')}
              className="pc-focusable ix-auth__link rounded-[6px]"
            >
              Forgot password? Recover from phrase
            </button>
            <button
              type="button"
              onClick={() => navigate('/app?settings=identity')}
              className="pc-focusable ix-auth__link rounded-[6px]"
            >
              Import account from file
            </button>
            {/* This screen is now where a device with an identity starts, so it
                must not be the only door: signing in as someone else, or as
                this account by password, has to stay possible. */}
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="pc-focusable ix-auth__link rounded-[6px]"
            >
              Sign in with a password instead
            </button>
          </div>
          )}
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}


