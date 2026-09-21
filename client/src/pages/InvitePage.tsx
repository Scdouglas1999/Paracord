import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { guildLandingPath } from '../lib/guildNavigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Hash, Users } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { inviteApi } from '../api/invites';
import { useGuildStore } from '../stores/guildStore';
import { useUIStore } from '../stores/uiStore';
import { isTauri } from '../lib/tauriEnv';
import { toPortableUri } from '../lib/portableLinks';
import { getDatabaseHistoryEpoch, subscribeDatabaseHistory } from '../lib/databaseHistory';
import { extractApiError } from '../api/client';
import { safeStoredImageDataUrl } from '../lib/security';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Divider } from '../components/ui/Divider';
import { AUTH_FORM, AuthCanvas, AuthCard, AuthScroll, Field } from './authScaffold';
import type { InvitePreview } from '../api/generated/InvitePreview';

/** Where the desktop installers live. */
const APP_DOWNLOAD_URL = 'https://github.com/Scdouglas1999/Paracord/releases/latest';

export function InvitePage() {
  const guildScope = useCurrentAccountScope();
  const { code } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore(s => s.token);
  const [loading, setLoading] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState('');
  // Most servers ask a newcomer for nothing, and then this page asks for
  // nothing: no box to tick, no answers to give. When the owner HAS turned the
  // gate on, the preview says so (`join_gate`) and carries the questions, so
  // they can be shown rather than guessed at. An acknowledgement that arrives
  // already ticked is not an acknowledgement, so it starts empty.
  const [verificationAck, setVerificationAck] = useState(false);
  const [verificationAnswers, setVerificationAnswers] = useState<string[]>([]);
  const [searchParams] = useSearchParams();
  const autoJoinTried = useRef(false);

  useEffect(() => {
    if (!code) return;
    setLoadingPreview(true);
    setError('');
    inviteApi
      .get(code)
      .then(({ data }) => setInvitePreview(data))
      .catch((err) => setError(`Failed to load invite: ${extractApiError(err)}`))
      .finally(() => setLoadingPreview(false));
  }, [code]);

  const gate = invitePreview?.join_gate ?? null;
  const questions = gate?.questions ?? [];
  const gateSatisfied =
    (!gate?.require_ack || verificationAck) &&
    questions.every((_, index) => (verificationAnswers[index] ?? '').trim().length > 0);

  /** Remember the invite, then send a signed-out person to make or use an account. */
  const continueSignedOut = (destination: '/register' | '/login') => {
    if (code) {
      try {
        sessionStorage.setItem('paracord:pending-invite', code);
      } catch {
        /* ignore quota / private mode */
      }
    }
    navigate(destination);
  };

  const handleAccept = async () => {
    if (!token || !guildScope) {
      continueSignedOut('/register');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const answers = questions.map((_, index) => (verificationAnswers[index] ?? '').trim());
      const guild = await useGuildStore.getState().acceptInvite(code!, guildScope, {
        verification_ack: gate?.require_ack ? verificationAck : undefined,
        verification_answers: answers.length ? answers : undefined,
      });
      navigate(await guildLandingPath(guild));
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to accept invite');
    } finally {
      setLoading(false);
    }
  };

  // Somebody who came back here from creating an account (or signing in) to
  // use this invite has already said yes. If the server asks them nothing, do
  // not make them say it again.
  //
  // It waits for the realtime connection. A brand-new session learns which
  // database history it is talking to when that connection comes up, and any
  // action begun before then is cancelled on purpose ("Database history
  // changed…") — which is what a join fired the instant sign-up finished got.
  const cameBackToJoin = searchParams.get('joining') === '1';
  const connected = useUIStore((state) => state.connectionStatus) === 'connected';
  // "Connected" is the stream opening; the history identity arrives with the
  // first event on it, a few milliseconds later. That is the thing to wait for.
  const historyKnown = useSyncExternalStore(
    subscribeDatabaseHistory,
    () => (guildScope ? getDatabaseHistoryEpoch(guildScope) != null : false),
  );
  useEffect(() => {
    if (!cameBackToJoin || autoJoinTried.current) return;
    if (!token || !guildScope || !invitePreview || gate || !connected || !historyKnown) return;
    autoJoinTried.current = true;
    void handleAccept();
    // handleAccept is recreated every render; the guards above make this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameBackToJoin, token, guildScope, invitePreview, gate, connected, historyKnown]);

  const joiningSoon =
    cameBackToJoin && !autoJoinTried.current && Boolean(token) && !gate && !error && (!connected || !historyKnown || !invitePreview);

  const guild = invitePreview?.guild;
  const iconSrc = safeStoredImageDataUrl(guild?.icon_hash);
  const guildInitial = (guild?.name ?? '?').trim().charAt(0).toUpperCase() || '?';
  const memberCount = typeof guild?.member_count === 'number' ? guild.member_count : null;

  return (
    <AuthCanvas>
      <AuthCard className="max-w-md">
        <div className={AUTH_FORM}>
          {/* Who is inviting you — one identity row, no gradient banner and no
              floating circle (spec §6.1, §6.2). */}
          <div>
            <p className="text-section text-text-faint">You’re invited</p>
            <div className="mt-4 flex items-center gap-4">
              <div className="pc-well flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-card)]">
                {iconSrc ? (
                  <img src={iconSrc} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="pc-display text-heading text-text-secondary">{guildInitial}</span>
                )}
              </div>
              <div className="min-w-0">
                <h1 className="truncate pc-display text-title text-text-primary">
                  {loadingPreview ? 'Loading invite…' : guild?.name ?? 'Join this server'}
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-faint">
                  {memberCount !== null && (
                    <span className="inline-flex items-center gap-1.5">
                      <Users size={13} aria-hidden />
                      {memberCount.toLocaleString()} {memberCount === 1 ? 'member' : 'members'}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 pc-mono">
                    <Hash size={12} aria-hidden />
                    {code}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <Divider />

          {error && (
            <div className="flex flex-col gap-3">
              <ErrorBanner multiline message={error} />
              <button
                type="button"
                onClick={() => navigate('/app')}
                className="pc-focusable self-start rounded-[var(--radius-chip)] text-label font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Back to Paracord
              </button>
            </div>
          )}

          <AuthScroll>
          {!error && (
            <p className="text-body text-text-secondary">
              {guild?.name
                ? `Join ${guild.name} to chat, hop into voice, and stream together.`
                : 'Accept to join this community and start chatting, streaming, and hanging out.'}
            </p>
          )}

          {gate && (
            <div className="flex flex-col gap-3">
              <p className="text-label text-text-secondary">
                {guild?.name ?? 'This server'} asks new people for the following before they join.
              </p>
              {questions.map((question, index) => (
                <Field key={index} label={question || `Question ${index + 1}`} required>
                  <Input
                    type="text"
                    value={verificationAnswers[index] ?? ''}
                    onChange={(e) =>
                      setVerificationAnswers((previous) => {
                        const next = [...previous];
                        next[index] = e.target.value;
                        return next;
                      })
                    }
                    autoComplete="off"
                  />
                </Field>
              ))}
              {gate.require_ack && (
                <label className="flex cursor-pointer items-start gap-2.5 text-label leading-relaxed text-text-secondary">
                  <input
                    type="checkbox"
                    checked={verificationAck}
                    onChange={(e) => setVerificationAck(e.target.checked)}
                    className="pc-checkbox mt-0.5"
                  />
                  I have read this server’s rules and agree to follow them.
                </label>
              )}
            </div>
          )}
          </AuthScroll>

          <Button
            onClick={handleAccept}
            size="lg"
            loading={loading || joiningSoon}
            disabled={loading || joiningSoon || loadingPreview || !invitePreview || (Boolean(token) && !gateSatisfied)}
            aria-label={loading ? 'Joining server' : token ? 'Accept invite' : 'Create an account to join'}
            className="w-full"
          >
            {loading || joiningSoon ? 'Joining…' : token ? 'Accept invite' : 'Create an account to join'}
            {!loading && <ArrowRight size={16} aria-hidden />}
          </Button>

          {!token && (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => continueSignedOut('/login')}
              className="w-full"
            >
              I already have an account
            </Button>
          )}

          {/* In a browser, the desktop app is one click away for somebody who
              has it, and one download away for somebody who does not. Inside
              the app there is nothing to offer. */}
          {!isTauri() && code && (
            <p className="text-meta leading-relaxed text-text-faint">
              Prefer the desktop app?{' '}
              <a className="text-text-link hover:underline" href={toPortableUri(window.location.origin, code)}>
                Open this invite in it
              </a>
              , or{' '}
              <a
                className="text-text-link hover:underline"
                href={APP_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                get the app
              </a>
              .
            </p>
          )}
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
