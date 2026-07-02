import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowRight, Sparkles, Users } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { inviteApi } from '../api/invites';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useUIStore } from '../stores/uiStore';
import { extractApiError } from '../api/client';
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

  return (
    <div className="auth-shell">
      <div className="auth-card text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-mod-subtle px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          <Sparkles size={14} />
          Invite Link
        </div>
        <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-3xl border border-border-subtle bg-accent-primary text-3xl font-bold text-white shadow-[0_16px_40px_rgba(78,102,232,0.38)]">
          <Users size={30} />
        </div>
        <h1 className="mb-1 text-2xl font-bold text-text-primary">You've been invited</h1>
        {loadingPreview ? (
          <p className="mb-2 text-sm text-text-secondary">Loading invite details...</p>
        ) : (
          <p className="mb-2 text-sm text-text-secondary">
            {invitePreview?.guild?.name
              ? `Join ${invitePreview.guild.name} and start chatting.`
              : 'Join this server and chat, stream, and hang out live.'}
          </p>
        )}
        <div className="mb-6 inline-flex items-center rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-1.5 text-xs font-semibold tracking-wide text-text-muted">
          Code: <span className="ml-1 font-mono text-text-secondary">{code}</span>
        </div>
        {invitePreview?.guild && (
          <div className="mb-4 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
            <div className="font-semibold text-text-primary">{invitePreview.guild.name}</div>
            {typeof invitePreview.guild.member_count === 'number' && (
              <div className="mt-1 text-xs text-text-muted">
                {invitePreview.guild.member_count.toLocaleString()} members
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-3 py-2.5 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

        <div className="mb-4 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 p-3 text-left">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={verificationAck}
              onChange={(e) => setVerificationAck(e.target.checked)}
            />
            I acknowledge this server's rules and verification requirements.
          </label>
          <textarea
            className="input-field mt-2 min-h-[72px] text-sm"
            placeholder="Verification answers (one per line, if required by this server)"
            value={verificationAnswers}
            onChange={(e) => setVerificationAnswers(e.target.value)}
          />
        </div>

        <button
          onClick={handleAccept}
          disabled={loading || loadingPreview || !invitePreview}
          aria-label={loading ? 'Joining server' : 'Accept invite'}
          className="btn-primary w-full"
        >
          {loading ? 'Joining...' : 'Accept Invite'}
          {!loading && <ArrowRight size={16} />}
        </button>

        {!token && (
          <p className="mt-3 text-xs leading-5 text-text-muted">
            You need to log in first to accept this invite.
          </p>
        )}
      </div>
    </div>
  );
}
