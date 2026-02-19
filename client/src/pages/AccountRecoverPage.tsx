import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';

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
    if (words.length !== 24) {
      setError('Recovery phrase must be exactly 24 words.');
      return;
    }
    if (username.length < 2 || username.length > 32) {
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
      await recover(phrase.trim(), username, password);
      navigate('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery failed. Check your phrase and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <form onSubmit={handleSubmit} className="auth-card mx-auto w-full max-w-md">
        <div className="mb-7 text-center">
          <h1 className="text-3xl font-bold leading-tight text-text-primary">Recover Account</h1>
          <p className="mt-1.5 text-sm text-text-muted">
            Enter your 24-word recovery phrase to restore your account.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-3 py-2.5 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

        <div className="card-stack-roomy">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Recovery Phrase <span className="text-accent-danger">*</span>
            </span>
            <textarea
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              required
              rows={4}
              className="input-field mt-2 resize-none"
              placeholder="Enter your 24 words separated by spaces"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Username <span className="text-accent-danger">*</span>
            </span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="input-field mt-2"
              placeholder="Choose a username"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              New Password <span className="text-accent-danger">*</span>
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              className="input-field mt-2"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Confirm Password <span className="text-accent-danger">*</span>
            </span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="input-field mt-2"
              placeholder="Type your password again"
            />
          </label>
        </div>

        <button type="submit" disabled={loading} className="btn-primary mt-8 w-full min-h-[2.9rem]">
          {loading ? 'Recovering...' : 'Recover Account'}
        </button>

        <p className="mt-5 text-center text-sm text-text-muted">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="font-semibold text-text-link hover:underline"
          >
            Go back
          </button>
        </p>
      </form>
    </div>
  );
}
