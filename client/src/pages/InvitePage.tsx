import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowRight, Hash, Users } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { inviteApi } from '../api/invites';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useUIStore } from '../stores/uiStore';
import { extractApiError } from '../api/client';
import { safeStoredImageDataUrl } from '../lib/security';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { AuthCanvas, AuthCard } from './authScaffold';
import type { Invite } from '../types';

export function InvitePage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore(s => s.token);
  const [loading, setLoading] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [invitePreview, setInvitePreview] = useState<Invite | null>(null);
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
    if (!token) {
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
      const { data } = await inviteApi.accept(code!, {
        verification_ack: verificationAck,
        verification_answers: answers.length ? answers : undefined,
      });
      const guild = 'guild' in data ? data.guild : data;
      useGuildStore.getState().addGuild(guild);
      // Fetch channels so the sidebar isn't empty
      await useChannelStore.getState().fetchChannels(guild.id);
      const channels = useChannelStore.getState().channelsByGuild[guild.id] || [];
      const firstChannelId =
        guild.default_channel_id ||
        channels.find(c => c.type === 0)?.id ||
        channels.find(c => c.type !== 4)?.id ||
        channels[0]?.id;
      if (firstChannelId) {
        useChannelStore.getState().selectGuild(guild.id);
        useChannelStore.getState().selectChannel(firstChannelId);
        navigate(`/app/guilds/${guild.id}/channels/${firstChannelId}`);
      } else {
        useUIStore.getState().setGuildSettingsId(guild.id);
        navigate(`/app`);
      }
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
      <AuthCard className="max-w-md overflow-hidden">
        {/* Solid framed identity header — no gradient banner, no floating circle. */}
        <div className="border-b border-border-subtle bg-bg-tertiary/40 px-8 py-7">
          <p className="text-section uppercase text-accent-primary">You’re invited</p>
          <div className="mt-4 flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-secondary">
              {iconSrc ? (
                <img src={iconSrc} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="font-display text-heading text-text-secondary">{guildInitial}</span>
              )}
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-display text-title text-text-primary">
                {loadingPreview ? 'Loading invite…' : guild?.name ?? 'Join this server'}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-muted">
                {memberCount !== null && (
                  <span className="inline-flex items-center gap-1.5">
                    <Users size={13} />
                    {memberCount.toLocaleString()} {memberCount === 1 ? 'member' : 'members'}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 font-code">
                  <Hash size={12} />
                  {code}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-5 p-8">
          {error && (
            <div className="flex flex-col gap-3">
              <ErrorBanner message={error} />
              <button
                type="button"
                onClick={() => navigate('/app')}
                className="self-start text-label font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
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
            <div className="rounded-md border border-border-subtle bg-bg-tertiary/40 p-4">
              <label className="flex cursor-pointer items-start gap-2.5 text-label text-text-secondary">
                <input
                  type="checkbox"
                  checked={verificationAck}
                  onChange={(e) => setVerificationAck(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--accent-primary)]"
                />
                I acknowledge this server’s rules and verification requirements.
              </label>
              <textarea
                className="input-field mt-3 min-h-[72px] resize-y text-body"
                placeholder="Verification answers (one per line, if this server requires them)"
                value={verificationAnswers}
                onChange={(e) => setVerificationAnswers(e.target.value)}
              />
            </div>
          )}

          <Button
            onClick={handleAccept}
            loading={loading}
            disabled={loading || loadingPreview || !invitePreview}
            aria-label={loading ? 'Joining server' : 'Accept invite'}
            className="w-full"
          >
            {loading ? 'Joining…' : 'Accept invite'}
            {!loading && <ArrowRight size={16} className="ml-1.5" />}
          </Button>

          {!token && (
            <p className="text-meta leading-relaxed text-text-muted">
              You’ll be asked to sign in first — your invite is saved and applied right after.
            </p>
          )}
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
