import { useEffect, useId, useState } from 'react';

import { assessNewPassword, type PasswordAssessment } from '../../lib/credential/password';
import { useFirstRunStore } from '../../stores/firstRunStore';
import { BackButton, Field, FrGlyph, GoButton } from './primitives';
import { Screen, type ScreenState } from './Screen';

/**
 * A username a new account may take, mirroring the server's
 * `paracord_util::validation::is_valid_new_username`: 2 to 32 ASCII letters,
 * digits and `_ . -`, a separator never first, last or twice in a row.
 * Returns the reason, or null.
 */
export function usernameProblem(username: string): string | null {
  const name = username.trim();
  if (name.length < 2) return 'At least 2 characters.';
  if (name.length > 32) return 'At most 32 characters.';
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return 'Use letters, numbers, dots, dashes or underscores.';
  if (/^[_.-]|[_.-]$/.test(name) || /[_.-]{2}/.test(name)) return "A username can't start or end with a dot, dash or underscore, or have two in a row.";
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Account (docs/setup-spec.md §1.6): name, username, the one password, and an
 * email only when the server asks for one. Continue makes no network call; the
 * account is made during Setup, which sends the flow back here with the reason
 * under the field if the server refuses it.
 */
export function AccountStep({
  state,
  path,
  ownerOf,
  joining,
  onContinue,
  onBack,
  onSignIn,
}: {
  state: ScreenState;
  path: 'host' | 'join';
  /** Host: the server's name ("You'll be the owner of …"). */
  ownerOf: string;
  /** Join: the server's name ("You're joining …"). */
  joining: string;
  onContinue: () => void;
  onBack: () => void;
  onSignIn: () => void;
}) {
  const account = useFirstRunStore((s) => s.account);
  const requireEmail = useFirstRunStore((s) => s.requireEmail);
  const errors = useFirstRunStore((s) => s.errors);
  const setAccount = useFirstRunStore((s) => s.setAccount);
  const [assessment, setAssessment] = useState<PasswordAssessment | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({ username: false, email: false });
  const ids = { name: useId(), user: useId(), email: useId(), pw: useId(), pwHelp: useId(), userErr: useId(), emailErr: useId() };

  useEffect(() => {
    let current = true;
    void assessNewPassword(account.password, { username: account.username, displayName: account.displayName }).then((result) => {
      if (current) setAssessment(result);
    });
    return () => {
      current = false;
    };
  }, [account.password, account.username, account.displayName]);

  const userProblem = usernameProblem(account.username);
  const emailProblem = requireEmail && !EMAIL.test(account.email.trim()) ? 'Enter the email address this server should know you by.' : null;
  const passwordOk = assessment?.acceptable === true && assessment.bytes > 0;
  const canContinue = !userProblem && passwordOk && !emailProblem;

  const userError = errors.username ?? (touched.username && account.username ? userProblem : null);
  const emailError = errors.email ?? (touched.email && account.email ? emailProblem : null);
  const help = assessment?.help ?? 'Use a phrase you’ll remember, like three or four unrelated words.';

  return (
    <Screen
      step="account"
      state={state}
      title="Make your account"
      sub={
        path === 'host' ? (
          <>
            You&rsquo;ll be the owner of <b>{ownerOf || 'your server'}</b>.
          </>
        ) : (
          <>
            You&rsquo;re joining <b>{joining}</b>. Already have an account there?{' '}
            <button type="button" className="fr-link" onClick={onSignIn}>
              Sign in
            </button>
          </>
        )
      }
      onSubmit={() => canContinue && onContinue()}
      footer={
        <>
          <BackButton onClick={onBack} />
          <GoButton disabled={!canContinue}>Continue</GoButton>
        </>
      }
    >
      {errors.form && (
        <div className="fr-fielderr" role="alert">
          {errors.form}
        </div>
      )}
      <div className="fr-row2">
        <Field label="Your name" htmlFor={ids.name} error={errors.displayName}>
          <input
            id={ids.name}
            className="fr-inp"
            value={account.displayName}
            onChange={(e) => setAccount({ displayName: e.target.value })}
            placeholder="Sam"
            autoComplete="name"
            maxLength={32}
            data-testid="fr-display-name"
          />
        </Field>
        <Field label="Username" htmlFor={ids.user} error={userError} errorId={ids.userErr}>
          <div className="fr-handle">
            <span aria-hidden="true">@</span>
            <input
              id={ids.user}
              className="fr-inp"
              value={account.username}
              onChange={(e) => setAccount({ username: e.target.value, usernameEdited: true })}
              onBlur={() => setTouched((t) => ({ ...t, username: true }))}
              placeholder="sam"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={32}
              aria-invalid={userError ? true : undefined}
              aria-describedby={userError ? ids.userErr : undefined}
              data-testid="fr-username"
            />
          </div>
        </Field>
      </div>
      {requireEmail && (
        <Field label="Email" htmlFor={ids.email} error={emailError} errorId={ids.emailErr}>
          <input
            id={ids.email}
            className="fr-inp"
            type="email"
            value={account.email}
            onChange={(e) => setAccount({ email: e.target.value })}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            placeholder="sam@example.com"
            autoComplete="email"
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? ids.emailErr : undefined}
            data-testid="fr-email"
          />
        </Field>
      )}
      <Field label="Password" htmlFor={ids.pw} error={errors.password}>
        <div className="fr-pw">
          <input
            id={ids.pw}
            className="fr-inp"
            type={showPassword ? 'text' : 'password'}
            value={account.password}
            onChange={(e) => setAccount({ password: e.target.value })}
            placeholder="At least 10 characters"
            autoComplete="new-password"
            aria-describedby={ids.pwHelp}
            data-testid="fr-password"
          />
          <button
            type="button"
            className="fr-eye"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((v) => !v)}
          >
            <FrGlyph name={showPassword ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>
        <div className="fr-meter" data-s={assessment?.score ?? 0} data-easy={assessment?.tooEasy ? '' : undefined} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="fr-help" id={ids.pwHelp} aria-live="polite" data-testid="fr-password-help">
          {help}
        </div>
      </Field>
      <div className="fr-note">
        <FrGlyph name="lock" size={18} />
        <span>
          <b>One password does it all.</b> It signs you in and locks your private messages. Your device turns it into separate keys, so the server can never read what it locks.
        </span>
      </div>
    </Screen>
  );
}
