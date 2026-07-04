import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useAccountStore } from '../stores/accountStore';
import { useServerListStore } from '../stores/serverListStore';
import { getStoredServerUrl, getCurrentOriginServerUrl, setStoredServerUrl } from '../lib/config/apiBaseUrl';
import { hasAccount } from '../lib/account';
import { authApi } from '../api/auth';
import { extractApiError } from '../api/client';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { AuthCanvas, AuthCard, AuthHeading, AppMark, BrandAside, Field } from './authScaffold';

export function RegisterPage() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [requireEmail, setRequireEmail] = useState(false);
  const navigate = useNavigate();
  const register = useAuthStore((s) => s.register);

  useEffect(() => {
    let cancelled = false;
    authApi
      .options()
      .then(({ data }) => {
        if (cancelled) return;
        setRequireEmail(data.require_email);
      })
      .catch(() => {
        // Keep conservative defaults when options are unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedUsername = username.trim();
    const trimmedDisplayName = displayName.trim();
    if (!trimmedUsername) {
      setError('Username is required.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (!agreed) {
      setError('You must agree to the terms of service');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await register(trimmedEmail, trimmedUsername, password, trimmedDisplayName);

      // If the user already has a local keypair, attach it to this server account.
      if (hasAccount()) {
        const account = useAccountStore.getState();
        if (account.isUnlocked && account.publicKey) {
          try {
            await authApi.attachPublicKey(account.publicKey);
          } catch {
            // Non-fatal
          }
        }
      }

      // Add to server list if not already there
      const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();
      if (serverUrl) {
        setStoredServerUrl(serverUrl);
        const serverStore = useServerListStore.getState();
        const existingServer = serverStore.getServerByUrl(serverUrl);
        const token = useAuthStore.getState().token;
        if (!existingServer) {
          let serverName = serverUrl;
          try {
            serverName = new URL(serverUrl).host;
          } catch {
            // Keep raw URL as name if parsing fails.
          }
          serverStore.addServer(serverUrl, serverName, token || undefined);
        } else if (token) {
          serverStore.updateToken(existingServer.id, token);
        }
      }

      // Go straight to the app — legacy token auth works without a local
      // keypair. Users can set up a local crypto identity later in Settings.
      navigate('/app');
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const trimmedEmail = email.trim();
  const emailError =
    trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
      ? 'That doesn’t look like an email address.'
      : null;
  const confirmError =
    confirmPassword.length > 0 && password !== confirmPassword
      ? 'These passwords don’t match yet.'
      : null;

  return (
    <AuthCanvas>
      <AuthCard className="max-w-4xl overflow-hidden">
        <div className="flex">
          <BrandAside />
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-6 p-8 sm:p-10">
            <div className="mb-1 lg:hidden">
              <AppMark size={40} />
            </div>
            <AuthHeading
              mark={false}
              title="Create your account"
              subtitle="Claim a username, and you’re in — you can add servers and a recovery identity next."
            />

            {error && <ErrorBanner message={error} />}

            <div className="flex flex-col gap-5">
              <Field
                label="Email"
                required={requireEmail}
                error={emailError}
                hint={requireEmail ? undefined : 'Optional — used only for password recovery.'}
              >
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required={requireEmail}
                  className="input-field"
                  placeholder={requireEmail ? 'you@example.com' : 'you@example.com (optional)'}
                  autoComplete="email"
                />
              </Field>

              <Field label="Display Name" hint="How people see you. You can change it anytime.">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="input-field"
                  placeholder="Ada Lovelace"
                />
              </Field>

              <Field label="Username" required hint="Your unique @handle on this server.">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  className="input-field"
                  placeholder="ada"
                  autoComplete="username"
                />
              </Field>

              <Field label="Password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  className="input-field"
                  placeholder="Choose a strong password"
                  autoComplete="new-password"
                />
              </Field>

              <Field label="Confirm Password" required error={confirmError}>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  className="input-field"
                  placeholder="Re-enter your password"
                  autoComplete="new-password"
                />
              </Field>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border-subtle bg-bg-mod-subtle px-4 py-3.5 transition-colors hover:border-border-strong">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent-primary)]"
              />
              <span className="text-meta leading-relaxed text-text-secondary">
                I have read and agree to the{' '}
                <Link to="/terms" className="font-semibold text-text-link hover:text-accent-primary-hover">
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link to="/privacy" className="font-semibold text-text-link hover:text-accent-primary-hover">
                  Privacy Policy
                </Link>
                .
              </span>
            </label>

            <Button type="submit" loading={loading} disabled={loading} className="w-full">
              Continue
            </Button>

            <p className="text-label text-text-secondary">
              Already have an account?{' '}
              <Link
                to="/login"
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Sign in
              </Link>
            </p>
          </form>
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
