import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { useSelectedGuildId } from '../../hooks/useGuilds';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { MessageSquare, UserPlus, Ban, Users, CalendarDays, Link2, ShieldCheck, ShieldAlert, ShieldQuestion, QrCode, Copy, Flag, Radio, BadgeCheck, StickyNote, UserCheck, UserX, UserMinus } from 'lucide-react';
import { isAdmin, type User } from '../../types/index';
import { extractApiError } from '../../api/client';
import { activateChannel } from '../../lib/channelNavigation';
import { relationshipApi } from '../../api/relationships';
import { userApi } from '../../api/users';
import { keysApi } from '../../api/keys';
import { guildApi } from '../../api/guilds';
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
import { resolveBannerUrl } from '../../lib/userAvatar';
import { accentCssColor } from './bannerCrop';
import { ResourceImage } from '../ui/ResourceImage';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { presenceLight } from '../../lib/presence';
import { personLight } from '../../lib/attention/light';
import { LitAvatar } from '../light';
import { usePresence, type Presence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import {
  buildIdentityVerificationPayload,
  formatIdentityFingerprint,
  getIdentityTrustState,
  IdentityTrustLockedError,
  markIdentityVerified,
  observeIdentityFingerprint,
  parseIdentityVerificationPayload,
} from '../../lib/keyVerification';
import { writeClipboardText } from '../../lib/clipboard';
import { Modal } from '../ui/Modal';
import QRCode from 'qrcode';

import type { PublicUserProfile } from '../../api/generated/PublicUserProfile';

/** The popup needs only an identity anchor; richer fields render when present. */
type ProfileSubject = Pick<User, 'id' | 'username'> & Partial<User>;

interface UserProfilePopupProps {
  /** The subject — `null` closes the card (the presence window plays its leave). */
  user: ProfileSubject | null;
  position: { x: number; y: number } | null;
  onClose: () => void;
  roles?: Array<{ id: string; name: string; color: number }>;
}

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
    <div className="mb-2 text-section" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

/**
 * The popup's own presence (§5.1 — a contextual surface slides in from the
 * edge it opened against and slides back out on --ease-in). `usePresence`
 * keeps the card mounted for the leave; `last` holds the subject through it
 * so the surface never exits empty. Callers render this unconditionally and
 * pass `null` to close — same contract `Modal` and the shell overlays have.
 */
export function UserProfilePopup({ user, position, onClose, roles = [] }: UserProfilePopupProps) {
  const { mounted, exiting, scenery } = usePresence(user !== null);
  // Remembered during render (not in an effect) so the exit keeps its subject.
  const [last, setLast] = useState<{
    user: ProfileSubject;
    position: { x: number; y: number };
  } | null>(null);
  if (
    user !== null &&
    position !== null &&
    (last === null || last.user !== user || last.position.x !== position.x || last.position.y !== position.y)
  ) {
    setLast({ user, position });
  }
  if (!mounted || last === null) return null;
  return (
    <UserProfileCard
      user={last.user}
      position={last.position}
      onClose={onClose}
      roles={roles}
      exiting={exiting}
      scenery={scenery}
    />
  );
}

function UserProfileCard({
  user,
  position,
  onClose,
  roles = [],
  exiting,
  scenery,
}: {
  user: ProfileSubject;
  position: { x: number; y: number };
  onClose: () => void;
  roles?: Array<{ id: string; name: string; color: number }>;
  exiting: boolean;
  scenery: Presence['scenery'];
}) {
  const navigate = useNavigate();
  const channelScope = useCurrentAccountScope();
  // The card is a dialog over a click-away catcher, and the catcher swallows
  // every pointer event underneath it — so somebody who opened this from the
  // keyboard had no way to put it down again. Escape closes it, like every
  // other dismissible surface in the app.
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [onClose]);
  const popupWidth = Math.min(21.5 * 16, window.innerWidth - 16);
  const estimatedHeight = Math.min(32.5 * 16, window.innerHeight - 16);
  const fitsLeft = position.x - popupWidth - 16 > 0;
  const left = fitsLeft
    ? Math.max(8, position.x - popupWidth - 12)
    : Math.min(position.x + 12, window.innerWidth - popupWidth - 8);
  const top = Math.max(8, Math.min(position.y, window.innerHeight - estimatedHeight - 8));
  // `top` is clamped against an ESTIMATE of the card's height, so a card that
  // outgrows it — every profile carrying an identity fingerprint does — used to
  // hang past the bottom of the window with its actions (Message, Add friend,
  // Block, Report) off-screen and unreachable: the card's own max-height was an
  // absolute `100dvh - 1rem` that ignored where the card actually starts. Cap it
  // by the room left BELOW `top` instead, so the overflow scrolls inside the
  // card rather than off the screen.
  const maxHeight = `calc(100dvh - ${Math.round(top) + 8}px)`;
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportEvidence, setReportEvidence] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const activeGuildId = useSelectedGuildId();
  const [now, setNow] = useState(() => Date.now());
  const [profileData, setProfileData] = useState<PublicUserProfile | null>(null);
  const [identityFingerprint, setIdentityFingerprint] = useState<string | null>(null);
  // Verified / not verified / unknown. "Unknown" is what a locked account vault
  // can honestly say: the decision is stored there, this device just cannot
  // read it yet. Calling that "not verified" would invite the user to redo a
  // check they already made.
  const [identityTrust, setIdentityTrust] = useState<'verified' | 'unverified' | 'unknown'>('unknown');
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
    userApi
      .getProfile(user.id)
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
      if (cancelled) return;
      setIdentityFingerprint(fingerprint);

      let observed: Awaited<ReturnType<typeof observeIdentityFingerprint>> | null = null;
      try {
        observed = await observeIdentityFingerprint(user.id, fingerprint);
      } catch (error) {
        if (!(error instanceof IdentityTrustLockedError)) throw error;
      }
      if (cancelled) return;

      setIdentityTrust(await getIdentityTrustState(user.id, fingerprint));
      if (observed?.rotated && observed.previousFingerprint) {
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
  const displayRoles: Array<{ id: string; name: string; color: number }> =
    profileData?.roles && profileData.roles.length > 0 ? profileData.roles : roles;

  const mutualGuilds = profileData?.mutual_guilds ?? [];
  const mutualFriends = profileData?.mutual_friends ?? [];
  const bannerHash = profileData ? profileData.user.banner_hash : user.banner_hash;
  // Subscribing to the ticket re-renders, and so re-resolves the URL, once it is minted.
  useDownloadTicket();
  const bannerSrc = resolveBannerUrl(bannerHash);
  const accent = accentCssColor(profileData ? profileData.user.accent_color : user.accent_color);
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
  const isStaffUser = isAdmin(profileData?.user?.flags ?? user.flags ?? 0);
  const isStreaming = activity ? getActivityType(activity) === 1 : false;
  const statusLight = presenceLight(isStreaming ? 'streaming' : status);
  const displayName = user.display_name || user.username;
  // The profile's face is WP1's avatar: the rim IS their light, the initials
  // fallback is their identity hue, and the label says it in words (§1.5, §9).
  const person = personLight({
    userId: user.id,
    name: displayName,
    status: isStreaming ? 'streaming' : status,
    avatar: profileData?.user?.avatar_hash ?? user.avatar_hash ?? user.avatar ?? null,
  });

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
      if (!channelScope) throw new Error('Sign in to this instance before messaging.');
      const data = await useChannelStore.getState().createDm(user.id, channelScope);
      activateChannel(data);
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
    try {
      await markIdentityVerified(user.id, identityFingerprint);
    } catch (error) {
      // A verification that cannot be written down is not a verification.
      setActionError(error instanceof IdentityTrustLockedError
        ? 'Unlock this account’s encryption to record a verification. It is stored with your encrypted messages, not in the browser.'
        : `Failed to record this verification: ${extractApiError(error)}`);
      return;
    }
    setIdentityTrust('verified');
    setIdentityRotationWarning(null);
    setActionError(null);
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
    try {
      await markIdentityVerified(user.id, identityFingerprint);
    } catch (error) {
      setActionError(error instanceof IdentityTrustLockedError
        ? 'Unlock this account’s encryption to record a verification. It is stored with your encrypted messages, not in the browser.'
        : `Failed to record this verification: ${extractApiError(error)}`);
      return;
    }
    setIdentityTrust('verified');
    setIdentityRotationWarning(null);
    setIdentityVerifyPayload('');
    setShowIdentityVerifyModal(false);
    toast.success(`Verified ${user.username}'s identity key.`);
  };

  return (
    <>
      {/* The click-away catcher is not a surface — it leaves with the close,
          so nothing swallows a click while the card is still sliding out. */}
      {!exiting && <div className="fixed inset-0 z-50" onClick={onClose} />}
      {/* §5.1: the card slides in from the edge it was opened against — from
          the anchor's side — and slides back out that way on --ease-in. */}
      <div
        className={cn(
          'pc-dialog fixed z-50 w-[min(21.5rem,calc(100vw-1rem))] overflow-hidden',
          fitsLeft
            ? exiting ? 'pc-drawer-out-right' : 'pc-drawer-in-right'
            : exiting ? 'pc-drawer-out-left' : 'pc-drawer-in-left',
        )}
        style={{
          left,
          top,
          maxHeight,
          overflowY: 'auto',
        }}
        {...scenery}
      >
        {/* The banner at the 3:1 its owner cropped it to, fading into the card;
            without one, a shorter strip of their accent colour. */}
        <div
          className={cn('relative shrink-0', bannerSrc ? 'aspect-[3/1]' : 'h-20')}
          style={{ background: accent ?? 'var(--accent-tint-strong)' }}
        >
          {bannerSrc && (
            <ResourceImage src={bannerSrc} alt="" draggable={false} className="h-full w-full object-cover" />
          )}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--bg-floating))' }}
          />
        </div>

        {/* Identity header — avatar overlaps the banner */}
        <div className="px-5 pb-4">
          <div className="relative -mt-9 mb-3 w-max">
            <LitAvatar person={person} size={72} hideLabel title={`Status: ${statusLight.label}`} />
            <span className="sr-only">{statusLight.label}</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="pc-display text-title leading-none" style={{ color: 'var(--text-primary)' }}>
              {displayName}
            </h2>
            {isBotUser && (
              <span
                className="inline-flex items-center rounded-[var(--radius-chip)] px-1.5 py-0.5 text-meta font-semibold"
                style={{ background: 'var(--bg-mod-strong)', color: 'var(--text-secondary)' }}
              >
                Bot
              </span>
            )}
            {isStaffUser && (
              <span
                className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] px-1.5 py-0.5 text-meta font-semibold"
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
              style={{ color: isStreaming ? 'var(--light-white)' : 'var(--text-secondary)' }}
            >
              {isStreaming && <Radio size={12} />}
              <span>{activityElapsed ? `${activityLabel} · ${activityElapsed}` : activityLabel}</span>
            </div>
          )}
        </div>

        {bio && (
          <div className="px-5 pb-4">
            <SectionLabel>About</SectionLabel>
            <div className="pc-well px-3.5 py-3 text-body text-text-secondary">
              {parseMarkdown(bio)}
            </div>
          </div>
        )}

        {identityFingerprint && (
          <div className="px-5 pb-4">
            <SectionLabel>Identity verification</SectionLabel>
            <div className="rounded-well px-3.5 py-3" style={{ background: 'var(--bg-well)' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex items-center gap-1.5 text-meta font-semibold">
                  {identityTrust === 'verified' ? (
                    <>
                      <ShieldCheck size={13} className="text-accent-success" />
                      <span className="text-accent-success">Verified</span>
                    </>
                  ) : identityTrust === 'unknown' ? (
                    <>
                      <ShieldQuestion size={13} className="text-text-muted" />
                      <span className="text-text-secondary">Unknown until you unlock encryption</span>
                    </>
                  ) : (
                    <>
                      <ShieldAlert size={13} className="text-accent-warning" />
                      <span className="text-accent-warning">Not verified</span>
                    </>
                  )}
                </div>
                <button
                  className={`inline-flex items-center gap-1.5 rounded-chip bg-bg-mod-subtle px-2 py-1 text-meta font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary ${FOCUS_RING}`}
                  onClick={() => setShowIdentityVerifyModal(true)}
                >
                  <QrCode size={12} />
                  Verify
                </button>
              </div>
              <div
                className="mt-2 break-all rounded-chip px-2 py-1.5 font-code text-[11px]"
                style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)' }}
              >
                {identityFingerprint}
              </div>
              {identityRotationWarning && (
                <div
                  className="mt-2 rounded-chip px-2 py-1.5 text-[11px]"
                  style={{ background: 'var(--danger-tint)', color: 'var(--accent-danger)' }}
                >
                  {identityRotationWarning}
                </div>
              )}
              {identityTrust !== 'verified' && (
                <button
                  className={`mt-2 inline-flex items-center gap-1.5 rounded-chip bg-success-tint px-2 py-1 text-meta font-medium text-accent-success transition-colors hover:bg-accent-success/20 ${FOCUS_RING}`}
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
            <SectionLabel>Member since</SectionLabel>
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
                  className="inline-flex items-center gap-1.5 rounded-window px-2 py-0.5 text-meta font-medium"
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
            <SectionLabel>Mutual servers — {mutualGuilds.length}</SectionLabel>
            <div className="flex flex-col">
              {mutualGuilds.slice(0, 5).map((guild) => (
                <div
                  key={guild.id}
                  className="flex items-center gap-2.5 rounded-chip px-1.5 py-1.5 transition-colors hover:bg-bg-mod-subtle"
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
                    className="flex items-center gap-2.5 rounded-chip px-1.5 py-1.5 transition-colors hover:bg-bg-mod-subtle"
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
            <SectionLabel>Linked accounts</SectionLabel>
            <div className="flex flex-col gap-1">
              {linkedAccounts.map((account) => (
                <a
                  key={`${account.label}-${account.url}`}
                  href={account.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`flex items-center justify-between gap-2 rounded-chip px-2 py-1.5 text-meta text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary ${FOCUS_RING}`}
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
            className={`h-10 w-full rounded-chip border border-border-subtle bg-bg-well px-3 text-body text-text-primary transition-colors placeholder:text-text-muted focus:border-accent-primary ${FOCUS_RING}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* Actions — primary emerald message, ghost add-friend, danger block/report */}
        <div className="flex flex-col gap-2 px-5 pb-5 pt-1">
          <button
            className={`flex h-9 w-full items-center justify-center gap-2 rounded-chip bg-accent-primary text-label font-semibold text-text-on-accent shadow-[var(--shadow-chip)] transition-[transform,background-color] duration-150 hover:bg-accent-primary-hover active:scale-[.97] active:bg-accent-primary-active ${FOCUS_RING}`}
            onClick={() => void handleMessage()}
          >
            <MessageSquare size={16} />
            Message
          </button>
          <div className="flex items-center gap-2">
            {!isBotUser && relationshipType === 1 && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-chip border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                aria-label={`Remove ${user.username} as a friend`}
                onClick={() => void handleRemoveRelationship(`Removed ${user.username} from friends.`)}
              >
                <UserMinus size={16} />
                Remove friend
              </button>
            )}
            {!isBotUser && relationshipType === 2 && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-chip border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
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
                  className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-chip border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                  aria-label={`Accept friend request from ${user.username}`}
                  onClick={() => void handleAcceptFriend()}
                >
                  <UserCheck size={16} />
                  Accept
                </button>
                <button
                  className={`flex h-9 items-center justify-center gap-2 rounded-chip border border-border-subtle px-3 text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                  aria-label={`Decline friend request from ${user.username}`}
                  onClick={() => void handleRemoveRelationship(`Declined friend request from ${user.username}.`)}
                >
                  <UserX size={16} />
                </button>
              </>
            )}
            {!isBotUser && relationshipType === 4 && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-chip border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                aria-label={`Cancel friend request to ${user.username}`}
                onClick={() => void handleRemoveRelationship(`Cancelled friend request to ${user.username}.`)}
              >
                <UserX size={16} />
                Cancel request
              </button>
            )}
            {!isBotUser && relationshipType == null && (
              <button
                className={`flex h-9 flex-1 items-center justify-center gap-2 rounded-chip border border-border-subtle text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
                aria-label={`Add ${user.username} as a friend`}
                onClick={() => void handleAddFriend()}
              >
                <UserPlus size={16} />
                Add friend
              </button>
            )}
            {relationshipType !== 2 && (
              <button
                className={`flex h-9 items-center justify-center gap-2 rounded-chip border border-accent-danger/30 px-3 text-label font-medium text-accent-danger transition-colors duration-150 hover:bg-danger-tint active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-danger focus-visible:ring-offset-2 focus-visible:ring-offset-bg-floating ${isBotUser || relationshipType != null && relationshipType !== 1 ? 'flex-1' : ''}`}
                aria-label={`Block ${user.username}`}
                onClick={() => void handleBlock()}
              >
                <Ban size={16} />
                Block
              </button>
            )}
            {!isBotUser && activeGuildId && (
              <button
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-chip text-accent-danger transition-colors duration-150 hover:bg-danger-tint active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-danger focus-visible:ring-offset-2 focus-visible:ring-offset-bg-floating"
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
            <h3 id="report-user-title" className="font-display text-heading text-text-primary">Report user</h3>
            <p className="mt-1.5 text-meta text-text-muted">
              Reports go to this server's moderators. Add concise, verifiable evidence to speed up review.
            </p>
            <div className="mt-3 rounded-chip border border-border-subtle bg-bg-well px-3 py-2 text-meta text-text-secondary">
              <span className="font-semibold text-text-primary">{user.username}</span>
              <span className="ml-1 text-text-muted">({user.id})</span>
            </div>
            <label className="mt-4 block">
              <span className="text-section text-text-faint">Reason</span>
              <textarea
                className="input-field mt-2 min-h-[96px] resize-y"
                value={reportReason}
                maxLength={512}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Explain why this user should be reviewed..."
              />
            </label>
            <label className="mt-3 block">
              <span className="text-section text-text-faint">Evidence (optional)</span>
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
                {reportSubmitting ? 'Submitting...' : 'Submit report'}
              </button>
              <button
                className={`rounded-chip px-3.5 py-2 text-label font-medium text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary ${FOCUS_RING}`}
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
            <h3 id="identity-verification-title" className="font-display text-heading text-text-primary">Cross-device identity verification</h3>
            <p className="mt-1.5 mb-4 text-meta text-text-muted">
              Scan this code on your other signed-in device, confirm the fingerprints match, then mark it verified.
            </p>
            <div className="mb-4 flex justify-center rounded-well p-3" style={{ background: 'var(--bg-well)' }}>
              {identityQrDataUrl ? (
                <img src={identityQrDataUrl} alt="Identity verification QR code" className="h-52 w-52 rounded-chip" />
              ) : (
                <div className="flex h-52 w-52 items-center justify-center text-meta text-text-muted">Generating code…</div>
              )}
            </div>
            <div className="mb-2 text-section text-text-muted">Payload</div>
            <div className="mb-3 break-all rounded-chip px-2 py-1.5 font-code text-[11px] text-text-secondary" style={{ background: 'var(--bg-well)' }}>
              {verificationPayload}
            </div>
            <button
              className={`mb-5 inline-flex items-center gap-1.5 rounded-chip bg-bg-mod-subtle px-2.5 py-1.5 text-meta font-medium text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary ${FOCUS_RING}`}
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
            <div className="mb-2 text-section text-text-muted">Verify from scanned payload</div>
            <input
              type="text"
              className={`mb-4 h-10 w-full rounded-chip border border-border-subtle bg-bg-well px-3 text-body text-text-primary transition-colors placeholder:text-text-muted focus:border-accent-primary ${FOCUS_RING}`}
              placeholder="Paste scanned payload JSON"
              value={identityVerifyPayload}
              onChange={(e) => setIdentityVerifyPayload(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                className={`rounded-chip px-3 py-1.5 text-label font-medium text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary ${FOCUS_RING}`}
                onClick={() => setShowIdentityVerifyModal(false)}
              >
                Close
              </button>
              <button
                className={`rounded-chip bg-success-tint px-3 py-1.5 text-label font-medium text-accent-success transition-colors hover:bg-accent-success/20 ${FOCUS_RING}`}
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
