import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { guildLandingPath } from '../lib/guildNavigation';
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowRight, Hash, Users } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { inviteApi } from '../api/invites';
import { useGuildStore } from '../stores/guildStore';
import { extractApiError } from '../api/client';
import { safeStoredImageDataUrl } from '../lib/security';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Textarea } from '../components/ui/Input';
import { Divider } from '../components/ui/Divider';
import { AuthCanvas, AuthCard } from './authScaffold';
import type { InvitePreview } from '../api/generated/InvitePreview';

export function InvitePage() {
  const guildScope = useCurrentAccountScope();
  const { code } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore(s => s.token);
  const [loading, setLoading] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState('');
  const [verificationAck, setVerificationAck] = useState(true);
  const [verificationAnswers, setVerificationAnswers] = useState('');

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

  const handleAccept = async () => {
    if (!token || !guildScope) {
      if (code) {
        try {
          sessionStorage.setItem('paracord:pending-invite', code);
        } catch {
          /* ignore quota / private mode */
        }
      }
      navigate('/login');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const answers = verificationAnswers
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const guild = await useGuildStore.getState().acceptInvite(code!, guildScope, {
        verification_ack: verificationAck,
        verification_answers: answers.length ? answers : undefined,
      });
      navigate(await guildLandingPath(guild));
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to accept invite');
    } finally {
      setLoading(false);
    }
  };

  const guild = invitePreview?.guild;
  const iconSrc = safeStoredImageDataUrl(guild?.icon_hash);
  const guildInitial = (guild?.name ?? '?').trim().charAt(0).toUpperCase() || '?';
  const memberCount = typeof guild?.member_count === 'number' ? guild.member_count : null;

  return (
    <AuthCanvas>
      <AuthCard className="max-w-md">
        <div className="flex flex-col gap-6 p-7 sm:p-8">
          {/* Who is inviting you — one identity row, no gradient banner and no
              floating circle (spec §6.1, §6.2). */}
          <div>
            <p className="text-section text-accent-primary">You’re invited</p>
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
                  {loadingPreview ? 'Loading invite…' : guild?.name ?? 'Join this space'}
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

          {!error && (
            <p className="text-body text-text-secondary">
              {guild?.name
                ? `Join ${guild.name} to chat, hop into voice, and stream together.`
                : 'Accept to join this community and start chatting, streaming, and hanging out.'}
            </p>
          )}

          {invitePreview && (
            <div className="flex flex-col gap-3">
              <label className="flex cursor-pointer items-start gap-2.5 text-label leading-relaxed text-text-secondary">
                <input
                  type="checkbox"
                  checked={verificationAck}
                  onChange={(e) => setVerificationAck(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--accent-primary)]"
                />
                I acknowledge this space’s rules and verification requirements.
              </label>
              <Textarea
                className="min-h-[72px] resize-y"
                placeholder="Verification answers (one per line, if this space requires them)"
                value={verificationAnswers}
                onChange={(e) => setVerificationAnswers(e.target.value)}
              />
            </div>
          )}

          <Button
            onClick={handleAccept}
            size="lg"
            loading={loading}
            disabled={loading || loadingPreview || !invitePreview}
            aria-label={loading ? 'Joining server' : 'Accept invite'}
            className="w-full"
          >
            {loading ? 'Joining…' : 'Accept invite'}
            {!loading && <ArrowRight size={16} aria-hidden />}
          </Button>

          {!token && (
            <p className="text-meta leading-relaxed text-text-faint">
              You’ll be asked to sign in first — your invite is saved and applied right after.
            </p>
          )}
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
