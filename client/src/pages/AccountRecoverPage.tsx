import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAccountStore } from '../stores/accountStore';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { AuthCanvas, AuthCard, AuthHeading, Field } from './authScaffold';

export function AccountRecoverPage() {
  const [phrase, setPhrase] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const recover = useAccountStore((s) => s.recover);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const words = phrase.trim().split(/\s+/);
    const normalizedUsername = username.trim();
    if (words.length !== 24) {
      setError('Recovery phrase must be exactly 24 words.');
      return;
    }
    if (normalizedUsername.length < 2 || normalizedUsername.length > 32) {
      setError('Username must be between 2 and 32 characters.');
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

    setLoading(true);
    try {
      await recover(phrase.trim(), normalizedUsername, password);
      navigate('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery failed. Check your phrase and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCanvas>
      <AuthCard className="max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6 p-8">
          <AuthHeading
            title="Recover your account"
            subtitle="Enter your 24-word recovery phrase to restore your identity on this device."
          />

          {error && <ErrorBanner message={error} />}

          <div className="flex flex-col gap-5">
            <Field label="Recovery Phrase" required hint="All 24 words, in order, separated by spaces.">
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                required
                rows={4}
                className="input-field resize-none font-code text-body"
                placeholder="ridge harbor velvet … (24 words)"
              />
            </Field>

            <Field label="Username" required>
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

            <Field label="New Password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
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

            <Field label="Confirm Password" required>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="input-field"
                placeholder="Type your password again"
                autoComplete="new-password"
              />
            </Field>
          </div>

          <Button type="submit" loading={loading} disabled={loading} className="w-full">
            Recover Account
          </Button>

          <p className="text-label text-text-secondary">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
            >
              Go back
            </button>
          </p>
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}
