import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, UserPlus, Ban, Users, CalendarDays, Link2, ShieldCheck, ShieldAlert, QrCode, Copy, Flag } from 'lucide-react';
import type { User } from '../../types/index';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { dmApi } from '../../api/dms';
import { relationshipApi } from '../../api/relationships';
import { keysApi } from '../../api/keys';
import { guildApi } from '../../api/guilds';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useServerListStore } from '../../stores/serverListStore';
import { toast } from '../../stores/toastStore';
import {
  formatActivityElapsed,
  formatActivityLabel,
  getPrimaryActivity,
} from '../../lib/activityPresence';
import { parseMarkdown } from '../../lib/markdown';
import { safeExternalUrl, safeStoredImageDataUrl } from '../../lib/security';
import {
  buildIdentityVerificationPayload,
  formatIdentityFingerprint,
  isIdentityVerified,
  markIdentityVerified,
  observeIdentityFingerprint,
  parseIdentityVerificationPayload,
} from '../../lib/keyVerification';
import { writeClipboardText } from '../../lib/clipboard';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import QRCode from 'qrcode';

interface MutualGuild {
  id: string;
  name: string;
  icon_url?: string | null;
}

interface MutualFriend {
  id: string;
  username: string;
  discriminator: number | string;
  avatar_hash?: string | null;
}

interface ProfileData {
  user: {
    id: string;
    username: string;
    discriminator: number | string;
    display_name?: string | null;
    avatar_hash?: string | null;
    banner_hash?: string | null;
    bio?: string | null;
    pronouns?: string | null;
    linked_accounts?: Array<{ label: string; url: string }> | null;
    flags: number;
    created_at: string;
  };
  roles: Array<{ id: string; name: string; color: number }>;
  mutual_guilds: MutualGuild[];
  mutual_friends: MutualFriend[];
  created_at: string;
}

interface UserProfilePopupProps {
  user: User;
  position: { x: number; y: number };
  onClose: () => void;
  roles?: Array<{ id: string; name: string; color: number }>;
}

function intToHex(color: number): string {
  if (color === 0) return 'var(--text-secondary)';
  return '#' + color.toString(16).padStart(6, '0');
}

const STATUS_COLORS: Record<'online' | 'idle' | 'dnd' | 'offline', string> = {
  online: 'var(--status-online)',
  idle: 'var(--status-idle)',
  dnd: 'var(--status-dnd)',
  offline: 'var(--status-offline)',
};

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export function UserProfilePopup({ user, position, onClose, roles = [] }: UserProfilePopupProps) {
  const navigate = useNavigate();
  const popupWidth = 344;
  const estimatedHeight = 520;
  const fitsLeft = position.x - popupWidth - 16 > 0;
  const left = fitsLeft
    ? Math.max(8, position.x - popupWidth - 12)
    : Math.min(position.x + 12, window.innerWidth - popupWidth - 8);
  const top = Math.max(8, Math.min(position.y, window.innerHeight - estimatedHeight - 8));
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportEvidence, setReportEvidence] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const activeGuildId = useGuildStore((s) => s.selectedGuildId);
  const [now, setNow] = useState(() => Date.now());
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [identityFingerprint, setIdentityFingerprint] = useState<string | null>(null);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [identityRotationWarning, setIdentityRotationWarning] = useState<string | null>(null);
  const [showIdentityVerifyModal, setShowIdentityVerifyModal] = useState(false);
  const [identityVerifyPayload, setIdentityVerifyPayload] = useState('');
  const [identityQrDataUrl, setIdentityQrDataUrl] = useState<string | null>(null);
  const reportDialogRef = useRef<HTMLDivElement>(null);
  const identityDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(reportDialogRef, showReportDialog, () => { setShowReportDialog(false); setActionError(null); });
  useFocusTrap(identityDialogRef, showIdentityVerifyModal, () => setShowIdentityVerifyModal(false));
  const verificationPayload = useMemo(
    () =>
      identityFingerprint
        ? buildIdentityVerificationPayload(user.id, user.username, identityFingerprint)
        : null,
    [identityFingerprint, user.id, user.username],
  );
  const activeServerId = useServerListStore((state) => state.activeServerId);
  const presence = usePresenceStore((state) =>
    state.getPresence(user.id, activeServerId ?? undefined)
  );
  const status = (presence?.status as 'online' | 'idle' | 'dnd' | 'offline') || 'offline';
  const activity = useMemo(() => getPrimaryActivity(presence), [presence]);
  const activityLabel = useMemo(() => formatActivityLabel(activity), [activity]);
  const activityElapsed = useMemo(
    () => formatActivityElapsed(activity?.started_at, now),
    [activity?.started_at, now]
  );

  // Fetch profile data from API
  useEffect(() => {
    let cancelled = false;
    getApi()
      .get<ProfileData>(`/users/${user.id}/profile`)
      .then(({ data }) => {
        if (!cancelled) setProfileData(data);
      })
      .catch(() => {
        // Profile fetch is optional; popup still works without it
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  useEffect(() => {
    let cancelled = false;
    const loadIdentityFingerprint = async () => {
      let identityKeyHex: string | null = null;
      try {
        const { data } = await keysApi.getBundle(user.id);
        if (typeof data.identity_key === 'string' && data.identity_key.trim().length > 0) {
          identityKeyHex = data.identity_key;
        }
      } catch {
        // Not all users will expose a prekey bundle yet.
      }

      if (!identityKeyHex && typeof user.public_key === 'string' && user.public_key.trim().length > 0) {
        identityKeyHex = user.public_key;
      }

      if (!identityKeyHex || cancelled) {
        return;
      }

      const fingerprint = formatIdentityFingerprint(identityKeyHex);
      const observed = await observeIdentityFingerprint(user.id, fingerprint);

      if (cancelled) return;

      setIdentityFingerprint(fingerprint);
      setIdentityVerified(await isIdentityVerified(user.id, fingerprint));
      if (observed.rotated && observed.previousFingerprint) {
        const warning = `Identity key changed. Previous fingerprint: ${observed.previousFingerprint}`;
        setIdentityRotationWarning(warning);
        toast.error(`${user.username}'s identity key changed. Verify before sharing sensitive info.`);
      } else {
        setIdentityRotationWarning(null);
      }
    };

    void loadIdentityFingerprint();
    return () => {
      cancelled = true;
    };
  }, [user.id, user.public_key, user.username]);

  useEffect(() => {
    if (!showIdentityVerifyModal || !verificationPayload) {
      setIdentityQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(verificationPayload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    })
      .then((url: string) => {
        if (!cancelled) {
          setIdentityQrDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIdentityQrDataUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showIdentityVerifyModal, verificationPayload]);

  // Merge roles: prefer API profile roles over passed-in roles
  const displayRoles = profileData?.roles && profileData.roles.length > 0
    ? profileData.roles
    : roles;

  const mutualGuilds = profileData?.mutual_guilds ?? [];
  const mutualFriends = profileData?.mutual_friends ?? [];
  const bannerHash = profileData?.user?.banner_hash ?? user.banner;
  const bannerSrc = safeStoredImageDataUrl(bannerHash);
  const bio = profileData?.user?.bio ?? user.bio;
  const pronouns = profileData?.user?.pronouns ?? user.pronouns;
  const linkedAccounts = (
    profileData?.user?.linked_accounts ??
    user.linked_accounts ??
    []
  )
    .map((entry) => {
      if (
        !entry ||
        typeof entry.label !== 'string' ||
        entry.label.trim().length === 0 ||
        typeof entry.url !== 'string'
      ) {
        return null;
      }
      const url = safeExternalUrl(entry.url);
      return url ? { label: entry.label.trim(), url } : null;
    })
    .filter((entry): entry is { label: string; url: string } => Boolean(entry));
  const createdAt = profileData?.created_at ?? profileData?.user?.created_at ?? user.created_at;
  const isBotUser = user.bot;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`paracord:note:${user.id}`);
      if (saved) setNote(saved);
    } catch {
      /* ignore */
    }
  }, [user.id]);

  useEffect(() => {
    try {
      localStorage.setItem(`paracord:note:${user.id}`, note);
    } catch {
      /* ignore */
    }
  }, [user.id, note]);

  useEffect(() => {
    if (!activity?.started_at) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity?.started_at]);

  const handleMessage = async () => {
    try {
      setActionError(null);
      const { data } = await dmApi.create(user.id);
      const dmChannels = useChannelStore.getState().channelsByGuild[''] || [];
      if (!dmChannels.some((c) => c.id === data.id)) {
        useChannelStore.getState().setDmChannels([...dmChannels, data]);
      }
      useChannelStore.getState().selectChannel(data.id);
      onClose();
      navigate(`/app/dms/${data.id}`);
    } catch (err) {
      setActionError(`Could not start a DM: ${extractApiError(err)}`);
    }
  };

  const handleAddFriend = async () => {
    try {
      setActionError(null);
      await relationshipApi.addFriend(user.username);
      onClose();
    } catch (err) {
      setActionError(`Could not send a friend request: ${extractApiError(err)}`);
    }
  };

  const handleBlock = async () => {
    try {
      setActionError(null);
      await relationshipApi.block(user.id);
      onClose();
    } catch (err) {
      setActionError(`Could not block this user: ${extractApiError(err)}`);
    }
  };

  const handleReportUser = async () => {
    const reason = reportReason.trim();
    if (!reason) {
      setActionError('Please provide a reason for the report.');
      return;
    }
    if (!activeGuildId) {
      setActionError('Reports must be submitted from within a server.');
      return;
    }
    const evidence = reportEvidence
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    setReportSubmitting(true);
    try {
      await guildApi.createReport(activeGuildId, {
        target_type: 'user',
        target_id: user.id,
        reported_user_id: user.id,
        reason,
        evidence: evidence.length > 0 ? evidence : undefined,
      });
      setShowReportDialog(false);
      setReportReason('');
      setReportEvidence('');
      setActionError(null);
    } catch (err) {
      setActionError(`Failed to submit report: ${extractApiError(err)}`);
    } finally {
      setReportSubmitting(false);
    }
  };

  const handleMarkIdentityVerified = async () => {
    if (!identityFingerprint) return;
    await markIdentityVerified(user.id, identityFingerprint);
    setIdentityVerified(true);
    setIdentityRotationWarning(null);
    toast.success(`Marked ${user.username}'s identity key as verified.`);
  };

  const handleVerifyIdentityPayload = async () => {
    if (!identityFingerprint) return;
    const parsed = parseIdentityVerificationPayload(identityVerifyPayload.trim());
    if (!parsed) {
      setActionError('Invalid verification payload.');
      return;
    }
    if (parsed.userId !== user.id) {
      setActionError('Verification payload is for a different user.');
      return;
    }
    if (parsed.fingerprint !== identityFingerprint) {
      setActionError('Verification payload fingerprint does not match the current key.');
      return;
    }
    await markIdentityVerified(user.id, identityFingerprint);
    setIdentityVerified(true);
    setIdentityRotationWarning(null);
    setIdentityVerifyPayload('');
    setShowIdentityVerifyModal(false);
    toast.success(`Verified ${user.username}'s identity key.`);
  };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        className="glass-modal fixed z-50 overflow-hidden rounded-2xl border popup-enter"
        style={{
          left,
          top,
          width: '344px',
          maxHeight: 'calc(100vh - 16px)',
          overflowY: 'auto',
        }}
      >
        {/* Banner */}
        {bannerSrc ? (
          <div
            className="h-20 bg-cover bg-center"
            style={{
              backgroundImage: `linear-gradient(135deg, rgba(20, 24, 38, 0.2) 0%, rgba(20, 24, 38, 0.45) 100%), url(${bannerSrc})`,
            }}
          />
        ) : (
          <div
            className="h-16"
            style={{
              background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-primary-hover) 100%)',
            }}
          />
        )}

        {/* Avatar + name */}
        <div className="px-7 pb-4">
          <div className="relative -mt-8 mb-3">
            <div
              className="flex h-16 w-16 items-center justify-center rounded-full border-4 text-xl font-bold text-white"
              style={{
                backgroundColor: 'var(--accent-primary)',
                borderColor: 'var(--bg-floating)',
              }}
            >
              {user.username.charAt(0).toUpperCase()}
            </div>
            <div
              className="absolute bottom-0 right-0 w-5 h-5 rounded-full"
              style={{
                backgroundColor: STATUS_COLORS[status],
                borderColor: 'var(--bg-floating)',
                borderWidth: '3px',
                borderStyle: 'solid',
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <div className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>
              {user.display_name || user.username}
            </div>
            {isBotUser && (
              <span className="rounded-md border border-accent-primary/35 bg-accent-primary/12 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-primary">
                Bot
              </span>
            )}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {user.username}
          </div>
          {activityLabel && (
            <div className="mt-1 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              {activityElapsed ? `${activityLabel} for ${activityElapsed}` : activityLabel}
            </div>
          )}
        </div>

        <div className="mx-7 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />

        {activityLabel && (
          <div className="px-7 pt-4 pb-2">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Activity
            </div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {activityLabel}
              {activityElapsed ? ` (${activityElapsed})` : ''}
            </div>
          </div>
        )}

        {pronouns && (
          <div className="px-7 pt-4 pb-2">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Pronouns
            </div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {pronouns}
            </div>
          </div>
        )}

        {/* About Me */}
        <div className="px-7 py-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
            About Me
          </div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {bio ? parseMarkdown(bio) : 'No bio set.'}
          </div>
        </div>

        {identityFingerprint && (
          <div className="px-7 pb-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Identity Verification
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
                  {identityVerified ? (
                    <>
                      <ShieldCheck size={13} className="text-accent-success" />
                      <span className="text-accent-success">Verified</span>
                    </>
                  ) : (
                    <>
                      <ShieldAlert size={13} className="text-accent-warning" />
                      <span className="text-accent-warning">Not verified</span>
                    </>
                  )}
                </div>
                <button
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-secondary px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                  onClick={() => setShowIdentityVerifyModal(true)}
                >
                  <QrCode size={12} />
                  Verify
                </button>
              </div>
              <div className="mt-2 break-all rounded-md border border-border-subtle bg-bg-secondary px-2 py-1.5 font-mono text-[11px] text-text-secondary">
                {identityFingerprint}
              </div>
              {identityRotationWarning && (
                <div className="mt-2 rounded-md border border-accent-danger/35 bg-accent-danger/10 px-2 py-1.5 text-[11px] text-accent-danger">
                  {identityRotationWarning}
                </div>
              )}
              {!identityVerified && (
                <button
                  className="mt-2 inline-flex items-center gap-1 rounded-md border border-accent-success/35 bg-accent-success/10 px-2 py-1 text-xs font-medium text-accent-success transition-colors hover:bg-accent-success/20"
                  onClick={() => void handleMarkIdentityVerified()}
                >
                  <ShieldCheck size={12} />
                  Mark Verified
                </button>
              )}
            </div>
          </div>
        )}

        {/* Member Since */}
        {createdAt && (
          <div className="px-7 pb-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Member Since
            </div>
            <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <CalendarDays size={13} />
              {formatDate(createdAt)}
            </div>
          </div>
        )}

        {/* Roles */}
        {displayRoles.length > 0 && (
          <div className="px-7 pb-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Roles
            </div>
            <div className="flex flex-wrap gap-1.5">
              {displayRoles.map(role => (
                <span
                  key={role.id}
                  className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--bg-mod-subtle)',
                    color: intToHex(role.color),
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: intToHex(role.color) }}
                  />
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Mutual Servers */}
        {mutualGuilds.length > 0 && (
          <div className="px-7 pb-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Mutual Servers - {mutualGuilds.length}
            </div>
            <div className="flex flex-wrap gap-2">
              {mutualGuilds.slice(0, 6).map(guild => (
                <div
                  key={guild.id}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--bg-mod-subtle)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-subtle)',
                  }}
                  title={guild.name}
                >
                  <div
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: 'var(--accent-primary)' }}
                  >
                    {guild.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="max-w-[100px] truncate">{guild.name}</span>
                </div>
              ))}
              {mutualGuilds.length > 6 && (
                <span className="self-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  +{mutualGuilds.length - 6} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Mutual Friends */}
        {mutualFriends.length > 0 && (
          <div className="px-7 pb-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              <span className="inline-flex items-center gap-1.5">
                <Users size={12} />
                Mutual Friends - {mutualFriends.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {mutualFriends.slice(0, 6).map(friend => (
                <div
                  key={friend.id}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--bg-mod-subtle)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-subtle)',
                  }}
                  title={friend.username}
                >
                  <div
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: 'var(--accent-primary)' }}
                  >
                    {friend.username.charAt(0).toUpperCase()}
                  </div>
                  <span className="max-w-[100px] truncate">{friend.username}</span>
                </div>
              ))}
              {mutualFriends.length > 6 && (
                <span className="self-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  +{mutualFriends.length - 6} more
                </span>
              )}
            </div>
          </div>
        )}

        {linkedAccounts.length > 0 && (
          <div className="px-7 pb-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Linked Accounts
            </div>
            <div className="space-y-2">
              {linkedAccounts.map((account) => (
                <a
                  key={`${account.label}-${account.url}`}
                  href={account.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                >
                  <span className="truncate">{account.label}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                    <Link2 size={12} />
                    Open
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Note */}
        <div className="px-7 pb-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
            Note
          </div>
          <input
            type="text"
            placeholder="Click to add a note"
            className="h-10 w-full rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 text-sm text-text-secondary outline-none transition-colors focus:border-border-strong focus:bg-bg-mod-strong"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-4 px-7 pb-5">
          <button className="btn-primary flex-1 items-center justify-center gap-1.5" onClick={() => void handleMessage()}>
            <MessageSquare size={14} />
            Message
          </button>
          {!isBotUser && (
            <button
              className="icon-btn border-border-subtle bg-bg-mod-subtle"
              title="Add Friend"
              aria-label={`Add ${user.username} as a friend`}
              onClick={() => void handleAddFriend()}
            >
              <UserPlus size={18} />
            </button>
          )}
          <button
            className="icon-btn border-border-subtle bg-bg-mod-subtle"
            title="Block"
            aria-label={`Block ${user.username}`}
            onClick={() => void handleBlock()}
          >
            <Ban size={18} />
          </button>
          {!isBotUser && activeGuildId && (
            <button
              className="icon-btn border-border-subtle bg-bg-mod-subtle text-accent-danger hover:border-accent-danger/40 hover:bg-accent-danger/10"
              title="Report User"
              aria-label={`Report ${user.username}`}
              onClick={() => { setShowReportDialog(true); setActionError(null); }}
            >
              <Flag size={16} />
            </button>
          )}
        </div>
        {actionError && !showReportDialog && (
          <div
            className="px-7 pb-5 text-xs font-medium"
            style={{ color: 'var(--accent-danger)' }}
            role="alert"
          >
            {actionError}
          </div>
        )}
      </div>
      {showReportDialog && (
        <>
          <div
            className="fixed inset-0 z-[60] modal-backdrop"
            onClick={() => { setShowReportDialog(false); setActionError(null); }}
          />
          <div
            ref={reportDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-user-title"
            tabIndex={-1}
            className="glass-modal fixed left-1/2 top-1/2 z-[61] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-5"
          >
            <h3 id="report-user-title" className="text-base font-semibold text-text-primary">Report User</h3>
            <p className="mt-1 text-xs text-text-muted">
              Reports are reviewed by moderators. Include concise evidence when possible.
            </p>
            <div className="mt-3 rounded-lg border border-border-subtle bg-bg-mod-subtle/50 px-3 py-2 text-xs text-text-secondary">
              <span className="font-semibold text-text-primary">{user.username}</span>
              <span className="ml-1 text-text-muted">({user.id})</span>
            </div>
            <label className="mt-4 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Reason</span>
              <textarea
                className="input-field mt-2 min-h-[96px] resize-y"
                value={reportReason}
                maxLength={512}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Explain why this user should be reviewed..."
              />
            </label>
            <label className="mt-3 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Evidence (Optional)</span>
              <textarea
                className="input-field mt-2 min-h-[72px] resize-y"
                value={reportEvidence}
                onChange={(e) => setReportEvidence(e.target.value)}
                placeholder="Add one link or note per line"
              />
            </label>
            {actionError && (
              <div
                className="mt-2 text-xs font-medium"
                style={{ color: 'var(--accent-danger)' }}
                role="alert"
              >
                {actionError}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button
                className="btn-primary"
                onClick={() => void handleReportUser()}
                disabled={reportSubmitting}
              >
                {reportSubmitting ? 'Submitting...' : 'Submit Report'}
              </button>
              <button
                className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                onClick={() => { setShowReportDialog(false); setActionError(null); setReportReason(''); setReportEvidence(''); }}
                disabled={reportSubmitting}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}

      {showIdentityVerifyModal && identityFingerprint && (
        <>
          <div
            className="fixed inset-0 z-[60] modal-backdrop"
            onClick={() => setShowIdentityVerifyModal(false)}
          />
          <div
            ref={identityDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="identity-verification-title"
            tabIndex={-1}
            className="glass-modal fixed left-1/2 top-1/2 z-[61] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-5"
          >
            <div id="identity-verification-title" className="mb-3 text-sm font-semibold text-text-primary">Cross-Device Identity Verification</div>
            <div className="mb-3 text-xs text-text-muted">
              Scan this QR code on your other device, compare fingerprints, then confirm verification.
            </div>
            <div className="mb-3 flex justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle p-3">
              {identityQrDataUrl ? (
                <img src={identityQrDataUrl} alt="Identity verification QR code" className="h-52 w-52 rounded-lg" />
              ) : (
                <div className="flex h-52 w-52 items-center justify-center text-xs text-text-muted">Generating QR...</div>
              )}
            </div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Payload</div>
            <div className="mb-3 break-all rounded-md border border-border-subtle bg-bg-mod-subtle px-2 py-1.5 font-mono text-[11px] text-text-muted">
              {verificationPayload}
            </div>
            <button
              className="mb-4 inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-secondary px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              onClick={() => {
                if (!verificationPayload) return;
                void writeClipboardText(verificationPayload)
                  .then(() => toast.success('Verification payload copied.'))
                  .catch((err) => toast.error(`Failed to copy verification payload: ${err instanceof Error ? err.message : String(err)}`));
              }}
            >
              <Copy size={12} />
              Copy payload
            </button>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Verify from scanned payload</div>
            <input
              type="text"
              className="mb-3 h-10 w-full rounded-md border border-border-subtle bg-bg-mod-subtle px-3 text-sm text-text-primary outline-none focus:border-border-strong"
              placeholder="Paste scanned payload JSON"
              value={identityVerifyPayload}
              onChange={(e) => setIdentityVerifyPayload(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                onClick={() => setShowIdentityVerifyModal(false)}
              >
                Close
              </button>
              <button
                className="rounded-md border border-accent-success/35 bg-accent-success/10 px-3 py-1.5 text-xs font-medium text-accent-success transition-colors hover:bg-accent-success/20"
                onClick={() => void handleVerifyIdentityPayload()}
              >
                Verify payload
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
