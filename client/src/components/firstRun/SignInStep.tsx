import { useEffect, useId, useRef, useState } from 'react';

import { normalizeConnectInput } from '../../lib/config/apiBaseUrl';
import { parseInviteLink } from '../../lib/inviteLinks';
import { isPinMismatch, probeServerIdentity } from '../../lib/trustedHosts';
import { trustWords } from '../../lib/trustWords';
import { CordSpinner } from '../brand/CordMark';
import { BackButton, Field, FrGlyph, GoButton } from './primitives';
import { Screen, type ScreenState } from './Screen';
import { TrustRow } from './InviteStep';

export interface ProbedServer {
  /** The server's base URL. */
  url: string;
  host: string;
  name: string;
  /** From an invite link in the Server field. */
  inviteCode: string | null;
  fingerprint: string | null;
  caVerified: boolean;
  words: string[];
}

export type SignInView = 'form' | 'mfa' | 'legacy';

export interface SignInSubmit {
  server: ProbedServer;
  identifier: string;
  password: string;
  code: string;
  view: SignInView;
}

/** The Server field: an invite link or an address, as a base URL and an optional invite code. */
export function serverFromInput(input: string): { url: string; inviteCode: string | null } | null {
  const text = input.trim();
  if (!text) return null;
  const link = parseInviteLink(text);
  if (link) return { url: link.serverUrl, inviteCode: link.code };
  const url = normalizeConnectInput(text);
  try {
    const parsed = new URL(url);
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return { url: `${parsed.protocol}//${parsed.host}`, inviteCode: null };
  } catch {
    return null;
  }
}

/**
 * Sign in (docs/setup-spec.md §1.12, not in the prototype; the same frame).
 * The Server field takes an address or an invite; once the server answers, the
 * trust row shows its identity (§7.3). MFA slides in a code field; an account
 * that still uses two passwords gets the distinct §3.11 screen first.
 */
export function SignInStep({
  state,
  web,
  initialServer,
  view,
  busy,
  error,
  onProbed,
  onSubmit,
  onBack,
  onForgot,
  sub,
}: {
  state: ScreenState;
  /** On a server's own web page the server is the page (§6.6). */
  web: boolean;
  initialServer: string;
  view: SignInView;
  busy: boolean;
  error: string | null;
  onProbed: (server: ProbedServer | null) => void;
  onSubmit: (submit: SignInSubmit) => void;
  onBack: () => void;
  onForgot: (server: ProbedServer | null) => void;
  /** The line under the title (after a restore it says the server is back). */
  sub?: string;
}) {
  const [serverText, setServerText] = useState(initialServer);
  const [server, setServer] = useState<ProbedServer | null>(null);
  const [probe, setProbe] = useState<'idle' | 'checking' | 'error'>('idle');
  const [probeError, setProbeError] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [legacyPassword, setLegacyPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const ids = { server: useId(), user: useId(), pw: useId(), code: useId(), legacy: useId() };
  const onProbedRef = useRef(onProbed);
  useEffect(() => {
    onProbedRef.current = onProbed;
  }, [onProbed]);

  useEffect(() => setServerText(initialServer), [initialServer]);

  useEffect(() => {
    const target = serverFromInput(serverText);
    setServer(null);
    onProbedRef.current(null);
    setProbeError(null);
    if (!target) {
      setProbe('idle');
      return;
    }
    setProbe('checking');
    let current = true;
    const timer = window.setTimeout(async () => {
      const host = new URL(target.url).hostname;
      try {
        let found: ProbedServer;
        if (web) {
          found = { url: target.url, host, name: host, inviteCode: target.inviteCode, fingerprint: null, caVerified: true, words: [] };
        } else {
          const answer = await probeServerIdentity(target.url);
          if (answer.service !== 'paracord') throw new Error(`Something answered at ${host}, but it is not a Paracord server. Check the address.`);
          const words = answer.fingerprint && !answer.caVerified ? await trustWords(answer.fingerprint) : [];
          found = {
            url: target.url,
            host,
            name: typeof answer.name === 'string' && answer.name ? answer.name : host,
            inviteCode: target.inviteCode,
            fingerprint: answer.fingerprint,
            caVerified: answer.caVerified,
            words,
          };
        }
        if (!current) return;
        setServer(found);
        setProbe('idle');
        onProbedRef.current(found);
      } catch (err) {
        if (!current) return;
        setProbe('error');
        setProbeError(
          isPinMismatch(err)
            ? `${host} has a new identity. Paracord won't sign in to it until you check with whoever runs it.`
            : err instanceof Error && err.message.startsWith('Something answered')
              ? err.message
              : `Can't reach ${host}. Check the address, or ask whoever runs it whether it is running.`,
        );
      }
    }, 400);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [serverText, web]);

  const ready =
    !!server &&
    !busy &&
    (view === 'form' ? identifier.trim().length > 0 && password.length > 0 : view === 'mfa' ? /^\d{6}$/.test(code.trim()) || code.trim().length >= 8 : legacyPassword.length > 0);

  const submit = () => {
    if (!ready || !server) return;
    onSubmit({ server, identifier: identifier.trim(), password: view === 'legacy' ? legacyPassword : password, code: code.trim(), view });
  };

  if (view === 'legacy') {
    return (
      <Screen
        step="sign-in-legacy"
        state={state}
        title="Enter your old sign-in password"
        sub="This account still uses two passwords. Enter your current sign-in password."
        onSubmit={submit}
        footer={
          <>
            <BackButton onClick={onBack} />
            <GoButton disabled={!ready}>Continue</GoButton>
          </>
        }
      >
        <Field label="Sign-in password" htmlFor={ids.legacy} error={error} help={<div className="fr-help">After this, Paracord moves the account to one password. Use your sign-in password here, not your encryption password.</div>}>
          <input
            id={ids.legacy}
            className="fr-inp"
            type="password"
            value={legacyPassword}
            onChange={(e) => setLegacyPassword(e.target.value)}
            autoComplete="current-password"
            data-testid="fr-legacy-password"
          />
        </Field>
      </Screen>
    );
  }

  return (
    <Screen
      step="sign-in"
      state={state}
      title="Sign in"
      sub={sub ?? 'Use the server address or an invite link from your server.'}
      onSubmit={submit}
      footer={
        <>
          <BackButton onClick={onBack} />
          <GoButton disabled={!ready} data-testid="fr-sign-in-submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </GoButton>
        </>
      }
    >
      <Field label="Server" htmlFor={ids.server}>
        <input
          id={ids.server}
          className="fr-inp"
          value={serverText}
          onChange={(e) => setServerText(e.target.value)}
          placeholder="chat.example.com or an invite link"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={web}
          data-testid="fr-sign-in-server"
        />
      </Field>
      {probe === 'checking' && (
        <div className="fr-checking" role="status">
          <CordSpinner size={18} />
          Finding the server…
        </div>
      )}
      {probe === 'error' && probeError && (
        <div className="fr-fielderr" role="alert">
          {probeError}
        </div>
      )}
      {server && <TrustRow host={server.host} words={server.words} caVerified={server.caVerified} web={web} bare />}
      {view === 'mfa' ? (
        <Field label="Code" htmlFor={ids.code} error={error} help={<div className="fr-help">Enter the code from your authenticator app.</div>}>
          <input
            id={ids.code}
            className="fr-inp"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            data-testid="fr-mfa-code"
          />
        </Field>
      ) : (
        <>
          <Field label="Username or email" htmlFor={ids.user}>
            <input
              id={ids.user}
              className="fr-inp"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="fr-sign-in-user"
            />
          </Field>
          <Field label="Password" htmlFor={ids.pw} error={error}>
            <div className="fr-pw">
              <input
                id={ids.pw}
                className="fr-inp"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                data-testid="fr-sign-in-password"
              />
              <button type="button" className="fr-eye" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}>
                <FrGlyph name={showPassword ? 'eyeOff' : 'eye'} size={18} />
              </button>
            </div>
          </Field>
          <p className="fr-sub fr-forgot">
            Forgot your password?{' '}
            <button type="button" className="fr-link" onClick={() => onForgot(server)}>
              Use your recovery phrase
            </button>
          </p>
        </>
      )}
    </Screen>
  );
}
