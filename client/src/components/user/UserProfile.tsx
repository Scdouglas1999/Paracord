import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { MessageSquare, UserPlus, Ban, Users, CalendarDays, Link2, ShieldCheck, ShieldAlert, QrCode, Copy, Flag, Radio, BadgeCheck, StickyNote, UserCheck, UserX, UserMinus } from 'lucide-react';
import { isAdmin, type User } from '../../types/index';
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
import { useRelationshipStore } from '../../stores/relationshipStore';
import { toast } from '../../stores/toastStore';
import {
  formatActivityElapsed,
  formatActivityLabel,
  getActivityType,
  getPrimaryActivity,
} from '../../lib/activityPresence';
import { roleColorToHex } from '../../lib/colors';
import { parseMarkdown } from '../../lib/markdown';
import { safeExternalUrl, safeStoredImageDataUrl } from '../../lib/security';
import { resolveUserAvatarUrl } from '../../lib/userAvatar';
import {
  buildIdentityVerificationPayload,
  formatIdentityFingerprint,
  isIdentityVerified,
  markIdentityVerified,
  observeIdentityFingerprint,
  parseIdentityVerificationPayload,
} from '../../lib/keyVerification';
import { writeClipboardText } from '../../lib/clipboard';
import { Modal } from '../ui/Modal';
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

// Shared focus ring against the floating popover surface.
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-floating';

// UPPERCASE category label — the Section type step, muted for hierarchy.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-section uppercase" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

export function UserProfilePopup({ user, position, onClose, roles = [] }: UserProfilePopupProps) {
  const navigate = useNavigate();
  const popupWidth = Math.min(21.5 * 16, window.innerWidth - 16);
  const estimatedHeight = Math.min(32.5 * 16, window.innerHeight - 16);
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
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const relationship = relationships.find((r) => r.user.id === user.id);
  const relationshipType = relationship?.type ?? null;
  const status = (presence?.status as 'online' | 'idle' | 'dnd' | 'offline') || 'offline';
  const activity = useMemo(() => getPrimaryActivity(presence), [presence]);
  const activityLabel = useMemo(() => formatActivityLabel(activity), [activity]);
  const activityElapsed = useMemo(
    () => formatActivityElapsed(activity?.started_at, now),
    [activity?.started_at, now]
  );

  useEffect(() => {
    void fetchRelationships();
  }, [fetchRelationships, user.id]);

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
  const isStaffUser = isAdmin(profileData?.user?.flags ?? user.flags);
  const isStreaming = activity ? getActivityType(activity) === 1 : false;
  const avatarSrc = resolveUserAvatarUrl(
    profileData?.user?.avatar_hash ?? user.avatar_hash ?? user.avatar,
  );
  const displayName = user.display_name || user.username;

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
      await useRelationshipStore.getState().addFriend(user.username);
      await fetchRelationships();
      const updated = useRelationshipStore.getState().relationships.find((r) => r.user.id === user.id);
      toast.success(
        updated?.type === 1
          ? `You are now friends with ${user.username}.`
          : `Friend request sent to ${user.username}.`,
      );
    } catch (err) {
      setActionError(`Could not send a friend request: ${extractApiError(err)}`);
    }
  };

  const handleAcceptFriend = async () => {
    try {
      setActionError(null);
      await useRelationshipStore.getState().acceptFriend(user.id);
      await fetchRelationships();
      toast.success(`You are now friends with ${user.username}.`);
    } catch (err) {
      setActionError(`Could not accept friend request: ${extractApiError(err)}`);
    }
  };

  const handleRemoveRelationship = async (label: string) => {
    try {
      setActionError(null);
      await useRelationshipStore.getState().removeFriend(user.id);
      await fetchRelationships();
      toast.success(label);
    } catch (err) {
      setActionError(`Could not update relationship: ${extractApiError(err)}`);
    }
  };

  const handleBlock = async () => {
    try {
      setActionError(null);
      await relationshipApi.block(user.id);
      await fetchRelationships();
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
        className="glass-modal popup-enter fixed z-50 w-[min(21.5rem,calc(100vw-1rem))] overflow-hidden rounded-lg"
        style={{
          left,
          top,
          maxHeight: 'calc(100dvh - 1rem)',
          overflowY: 'auto',
        }}
      >
        {/* Banner — a solid accent-tint strip (or the user's image), never a diagonal gradient wash */}
        {bannerSrc ? (
          <div
            className="h-[76px] shrink-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${bannerSrc})` }}
          />
        ) : (
          <div
            className="h-[60px] shrink-0"
            style={{
              background: 'var(--accent-tint-strong)',
              boxShadow: 'inset 0 -1px 0 var(--border-subtle)',
            }}
          />
        )}

        {/* Identity header — avatar overlaps the banner */}
        <div className="px-5 pb-4">
          <div className="relative -mt-9 mb-3 w-max">
            <div
              className="rounded-full p-[3px]"
              style={{
                background: isStreaming
                  ? 'linear-gradient(135deg, var(--accent-secondary), var(--accent-primary))'
                  : 'var(--bg-floating)',
              }}
            >
              {avatarSrc ? (
                <img src={avatarSrc} alt="" className="h-[72px] w-[72px] rounded-full object-cover" />
              ) : (
                <div
                  className="flex h-[72px] w-[72px] items-center justify-center rounded-full font-display text-2xl font-bold"
                  style={{ backgroundColor: 'var(--accent-tint-strong)', color: 'var(--accent-primary)' }}
                >
                  {user.username.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <span
              className="absolute bottom-0.5 right-0.5 h-[18px] w-[18px] rounded-full"
              style={{ backgroundColor: STATUS_COLORS[status], boxShadow: '0 0 0 3px var(--bg-floating)' }}
              title={`Status: ${status}`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="font-display text-title leading-none" style={{ color: 'var(--text-primary)' }}>
              {displayName}
            </h2>
            {isBotUser && (
              <span
                className="inline-flex items-center rounded-xs px-1.5 py-0.5 text-meta font-semibold uppercase"
                style={{ background: 'var(--bg-mod-strong)', color: 'var(--text-secondary)' }}
              >
                Bot
              </span>
            )}
            {isStaffUser && (
              <span
                className="inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-meta font-semibold uppercase"
                style={{ background: 'var(--accent-tint)', color: 'var(--accent-primary)' }}
              >
                <BadgeCheck size={11} />
                Staff
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-code text-sm" style={{ color: 'var(--text-secondary)' }}>
              @{user.username}
            </span>
            {pronouns && (
              <span className="text-meta" style={{ color: 'var(--text-muted)' }}>
                · {pronouns}
              </span>
            )}
          </div>

          {activityLabel && (
            <div
              className="mt-2 inline-flex items-center gap-1.5 text-meta"
              style={{ color: isStreaming ? 'var(--status-streaming)' : 'var(--text-secondary)' }}
            >
              {isStreaming && <Radio size={12} />}
              <span>{activityElapsed ? `${activityLabel} · ${activityElapsed}` : activityLabel}</span>
            </div>
          )}
        </div>

        {bio && (
          <div className="px-5 pb-4">
            <SectionLabel>About</SectionLabel>
            <div
              className="rounded-md px-3.5 py-3 text-body"
              style={{
                background: 'var(--bg-tertiary)',
                boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.02)',
                color: 'var(--text-secondary)',
              }}
            >
              {parseMarkdown(bio)}
            </div>
          </div>
        )}

        {identityFingerprint && (
          <div className="px-5 pb-4">
            <SectionLabel>Identity Verification</SectionLabel>
            <div className="rounded-md px-3.5 py-3" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex items-center gap-1.5 text-meta font-semibold">
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
                  className={`inline-flex items-center gap-1.5 rounded-sm bg-bg-mod-subtle px-2 py-1 text-meta font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary ${FOCUS_RING}`}
                  onClick={() => setShowIdentityVerifyModal(true)}
                >
                  <QrCode size={12} />
                  Verify
                </button>
              </div>
              <div
                className="mt-2 break-all rounded-sm px-2 py-1.5 font-code text-[11px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                {identityFingerprint}
              </div>
              {identityRotationWarning && (
                <div
                  className="mt-2 rounded-sm px-2 py-1.5 text-[11px]"
                  style={{ background: 'var(--danger-tint)', color: 'var(--accent-danger)' }}
                >
                  {identityRotationWarning}
                </div>
              )}
              {!identityVerified && (
                <button
                  className={`mt-2 inline-flex items-center gap-1.5 rounded-sm bg-success-tint px-2 py-1 text-meta font-medium text-accent-success transition-colors hover:bg-accent-success/20 ${FOCUS_RING}`}
                  onClick={() => void handleMarkIdentityVerified()}
                >
                  <ShieldCheck size={12} />
                  Mark verified
                </button>
              )}
            </div>
          </div>
        )}

        {createdAt && (
          <div className="px-5 pb-4">
            <SectionLabel>Member Since</SectionLabel>
            <div className="flex items-center gap-2 text-meta" style={{ color: 'var(--text-secondary)' }}>
              <CalendarDays size={13} style={{ color: 'var(--text-muted)' }} />
              <span className="font-code">{formatDate(createdAt)}</span>
            </div>
          </div>
        )}

        {displayRoles.length > 0 && (
          <div className="px-5 pb-4">
            <SectionLabel>Roles</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {displayRoles.map((role) => (
                <span
                  key={role.id}
                  className="inline-flex items-center gap-1.5 rounded-xs px-2 py-0.5 text-meta font-medium"
                  style={{ background: 'var(--bg-mod-strong)', color: 'var(--text-secondary)' }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: roleColorToHex(role.color) }} />
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {mutualGuilds.length > 0 && (
          <div className="px-5 pb-4">
            <SectionLabel>Mutual Servers — {mutualGuilds.length}</SectionLabel>
            <div className="flex flex-col">
              {mutualGuilds.slice(0, 5).map((guild) => (
                <div
                  key={guild.id}
                  className="flex items-center gap-2.5 rounded-sm px-1.5 py-1.5 transition-colors hover:bg-bg-mod-subtle"
                  title={guild.name}
                >
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{ background: 'var(--accent-tint-strong)', color: 'var(--accent-primary)' }}
                  >
                    {guild.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="truncate text-meta" style={{ color: 'var(--text-secondary)' }}>
                    {guild.name}
                  </span>
                </div>
              ))}
              {mutualGuilds.length > 5 && (
                <span className="px-1.5 pt-1 text-meta" style={{ color: 'var(--text-muted)' }}>
                  +{mutualGuilds.length - 5} more
                </span>
              )}
            </div>
          </div>
        )}

        {mutualFriends.length > 0 && (
          <div className="px-5 pb-4">
            <SectionLabel>
              <span className="inline-flex items-center gap-1.5">
                <Users size={12} />
                Mutual Friends — {mutualFriends.length}
              </span>
            </SectionLabel>
            <div className="flex flex-col">
              {mutualFriends.slice(0, 5).map((friend) => {
                const friendAvatar = safeStoredImageDataUrl(friend.avatar_hash);
                return (
                  <div
                    key={friend.id}
                    className="flex items-center gap-2.5 rounded-sm px-1.5 py-1.5 transition-colors hover:bg-bg-mod-subtle"
                    title={friend.username}
                  >
                    {friendAvatar ? (
                      <img src={friendAvatar} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                    ) : (
                      <div
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                        style={{ background: 'var(--accent-tint-strong)', color: 'var(--accent-primary)' }}
                      >
                        {friend.username.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="truncate text-meta" style={{ color: 'var(--text-secondary)' }}>
                      {friend.username}
                    </span>
                  </div>
                );
              })}
              {mutualFriends.length > 5 && (
                <span className="px-1.5 pt-1 text-meta" style={{ color: 'var(--text-muted)' }}>
                  +{mutualFriends.length - 5} more
                </span>
              )}
            </div>
          </div>
        )}

        {linkedAccounts.length > 0 && (
          <div className="px-5 pb-4">
            <SectionLabel>Linked Accounts</SectionLabel>
            <div className="flex flex-col gap-1">
              {linkedAccounts.map((account) => (
                <a
                  key={`${account.label}-${account.url}`}
                  href={account.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-meta text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary ${FOCUS_RING}`}
                >
                  <span className="truncate">{account.label}</span>
                  <Link2 size={12} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="px-5 pb-4">
          <SectionLabel>
            <span className="inline-flex items-center gap-1.5">
              <StickyNote size={12} />
              Note
            </span>
          </SectionLabel>
          <input
            type="text"
            placeholder="Add a private note — only you can see this"
            className={`h-10 w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 text-body text-text-primary transition-colors placeholder:text-text-muted focus:border-accent-primary ${FOCUS_RING}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* Actions — primary emerald message, ghost add-friend, danger block/report */}
        <div className="flex flex-col gap-2 px-5 pb-5 pt-1">
          <button
            className={`flex h-9 w-full items-center justify-center gap-2 rounded-sm bg-accent-primary text-label font-semibold text-text-on-accent shadow-sm transition-[transform,background-color] duration-150 hover:bg-accent-primary-hover active:scale-[.97] active:bg-accent-primary-active ${FOCUS_RING}`}
            onClick={() => void handleMessage()}
          >
            <MessageSquare size={16} />
            Message
          </button>
          <div className="flex items-center gap-2">
            {!isBotUser && relationshipType === 1 && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-sm border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                aria-label={`Remove ${user.username} as a friend`}
                onClick={() => void handleRemoveRelationship(`Removed ${user.username} from friends.`)}
              >
                <UserMinus size={16} />
                Remove Friend
              </button>
            )}
            {!isBotUser && relationshipType === 2 && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-sm border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                aria-label={`Unblock ${user.username}`}
                onClick={() => void handleRemoveRelationship(`Unblocked ${user.username}.`)}
              >
                <UserCheck size={16} />
                Unblock
              </button>
            )}
            {!isBotUser && relationshipType === 3 && (
              <>
                <button
                  className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-sm border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                  aria-label={`Accept friend request from ${user.username}`}
                  onClick={() => void handleAcceptFriend()}
                >
                  <UserCheck size={16} />
                  Accept
                </button>
                <button
                  className={`flex h-9 items-center justify-center gap-2 rounded-sm border border-border-subtle px-3 text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                  aria-label={`Decline friend request from ${user.username}`}
                  onClick={() => void handleRemoveRelationship(`Declined friend request from ${user.username}.`)}
                >
                  <UserX size={16} />
                </button>
              </>
            )}
            {!isBotUser && relationshipType === 4 && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-sm border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                aria-label={`Cancel friend request to ${user.username}`}
                onClick={() => void handleRemoveRelationship(`Cancelled friend request to ${user.username}.`)}
              >
                <UserX size={16} />
                Cancel Request
              </button>
            )}
            {!isBotUser && relationshipType == null && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-sm border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                aria-label={`Add ${user.username} as a friend`}
                onClick={() => void handleAddFriend()}
              >
                <UserPlus size={16} />
                Add Friend
              </button>
            )}
            {relationshipType !== 2 && (
              <button
                className={`flex h-9 items-center justify-center gap-2 rounded-sm border border-accent-danger/30 px-3 text-label font-medium text-accent-danger transition-colors duration-150 hover:bg-danger-tint active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-danger focus-visible:ring-offset-2 focus-visible:ring-offset-bg-floating ${isBotUser || relationshipType != null && relationshipType !== 1 ? 'flex-1' : ''}`}
                aria-label={`Block ${user.username}`}
                onClick={() => void handleBlock()}
              >
                <Ban size={16} />
                Block
              </button>
            )}
            {!isBotUser && activeGuildId && (
              <button
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-accent-danger transition-colors duration-150 hover:bg-danger-tint active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-danger focus-visible:ring-offset-2 focus-visible:ring-offset-bg-floating"
                title="Report user"
                aria-label={`Report ${user.username}`}
                onClick={() => { setShowReportDialog(true); setActionError(null); }}
              >
                <Flag size={16} />
              </button>
            )}
          </div>
        </div>
        {actionError && !showReportDialog && (
          <div
            className="px-5 pb-5 text-meta font-medium"
            style={{ color: 'var(--accent-danger)' }}
            role="alert"
          >
            {actionError}
          </div>
        )}
      </div>
      {showReportDialog && (
        <Modal
          open
          onClose={() => { setShowReportDialog(false); setActionError(null); }}
          labelledBy="report-user-title"
          panelClassName="w-full max-w-md p-5"
        >
          <div>
            <h3 id="report-user-title" className="font-display text-heading text-text-primary">Report User</h3>
            <p className="mt-1.5 text-meta text-text-muted">
              Reports go to this server's moderators. Add concise, verifiable evidence to speed up review.
            </p>
            <div className="mt-3 rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-meta text-text-secondary">
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
                className={`rounded-sm px-3.5 py-2 text-label font-medium text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary ${FOCUS_RING}`}
                onClick={() => { setShowReportDialog(false); setActionError(null); setReportReason(''); setReportEvidence(''); }}
                disabled={reportSubmitting}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showIdentityVerifyModal && identityFingerprint && (
        <Modal
          open
          onClose={() => setShowIdentityVerifyModal(false)}
          labelledBy="identity-verification-title"
          panelClassName="w-full max-w-md p-5"
        >
          <div>
            <h3 id="identity-verification-title" className="font-display text-heading text-text-primary">Cross-Device Identity Verification</h3>
            <p className="mt-1.5 mb-4 text-meta text-text-muted">
              Scan this code on your other signed-in device, confirm the fingerprints match, then mark it verified.
            </p>
            <div className="mb-4 flex justify-center rounded-md p-3" style={{ background: 'var(--bg-tertiary)' }}>
              {identityQrDataUrl ? (
                <img src={identityQrDataUrl} alt="Identity verification QR code" className="h-52 w-52 rounded-sm" />
              ) : (
                <div className="flex h-52 w-52 items-center justify-center text-meta text-text-muted">Generating code…</div>
              )}
            </div>
            <div className="mb-2 text-section uppercase text-text-muted">Payload</div>
            <div className="mb-3 break-all rounded-sm px-2 py-1.5 font-code text-[11px] text-text-secondary" style={{ background: 'var(--bg-tertiary)' }}>
              {verificationPayload}
            </div>
            <button
              className={`mb-5 inline-flex items-center gap-1.5 rounded-sm bg-bg-mod-subtle px-2.5 py-1.5 text-meta font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary ${FOCUS_RING}`}
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
            <div className="mb-2 text-section uppercase text-text-muted">Verify from scanned payload</div>
            <input
              type="text"
              className={`mb-4 h-10 w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 text-body text-text-primary transition-colors placeholder:text-text-muted focus:border-accent-primary ${FOCUS_RING}`}
              placeholder="Paste scanned payload JSON"
              value={identityVerifyPayload}
              onChange={(e) => setIdentityVerifyPayload(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                className={`rounded-sm px-3 py-1.5 text-label font-medium text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary ${FOCUS_RING}`}
                onClick={() => setShowIdentityVerifyModal(false)}
              >
                Close
              </button>
              <button
                className={`rounded-sm bg-success-tint px-3 py-1.5 text-label font-medium text-accent-success transition-colors hover:bg-accent-success/20 ${FOCUS_RING}`}
                onClick={() => void handleVerifyIdentityPayload()}
              >
                Verify payload
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
