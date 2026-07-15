import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, Users } from 'lucide-react';
import type { Role } from '../../types/index';
import { UserProfilePopup } from '../user/UserProfile';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useGuildStore } from '../../stores/guildStore';
import { useServerListStore } from '../../stores/serverListStore';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { formatActivityLabel, getPrimaryActivity } from '../../lib/activityPresence';
import { SkeletonMember } from '../ui/Skeleton';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import { writeClipboardText } from '../../lib/clipboard';
import { getHighestRoleColor } from '../../lib/colors';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { displayName } from '../../lib/displayName';

interface MemberWithUser {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_hash: string | null;
  nick: string | null;
  roles: string[];
  bot?: boolean;
  status?: 'online' | 'idle' | 'dnd' | 'offline';
  activityText?: string | null;
  streaming?: boolean;
}

interface MemberListProps {
  members?: MemberWithUser[];
  roles?: Role[];
  compact?: boolean;
  /**
   * Suppress the top-level "Members" total-count subheader. Used when a host
   * chrome (e.g. ContextPanel) already supplies the "Members" title, so the
   * per-role group headers are not stacked under a redundant duplicate label.
   */
  hideStatsHeader?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  online: 'var(--status-online)',
  idle: 'var(--status-idle)',
  dnd: 'var(--status-dnd)',
  offline: 'var(--status-offline)',
};

export function resolveMemberStatus(
  presenceStatus: MemberWithUser['status'] | undefined,
  inCurrentGuildVoice: boolean,
  isAuthenticatedSelfMember: boolean,
): MemberWithUser['status'] {
  if (presenceStatus) return presenceStatus;
  if (isAuthenticatedSelfMember || inCurrentGuildVoice) return 'online';
  return 'offline';
}

export function MemberList({ members: propMembers, roles: propRoles = [], compact = false, hideStatsHeader = false }: MemberListProps) {
  const selectedGuildId = useGuildStore(s => s.selectedGuildId);
  const activeServerId = useServerListStore(s => s.activeServerId);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );
  const authUserId = useAuthStore((s) => s.user?.id);
  const authToken = useAuthStore((s) => s.token);
  const storeMembers = useMemberStore(s => selectedGuildId ? s.members.get(selectedGuildId) : undefined);
  const fetchMembers = useMemberStore(s => s.fetchMembers);
  // Fingerprint presence writes for visible members only (any scope), so
  // unrelated presence Map updates don't re-render the whole list.
  const memberIdsKey = useMemo(() => {
    if (!storeMembers?.length) return '';
    return storeMembers.map((m) => String(m.user.id)).sort().join(',');
  }, [storeMembers]);
  const presenceFingerprint = usePresenceStore(
    useCallback(
      (s) => {
        if (!memberIdsKey) return 0;
        const ids = new Set(memberIdsKey.split(','));
        let hash = 0;
        for (const [key, order] of s.presenceOrder) {
          const colon = key.indexOf(':');
          const uid = colon >= 0 ? key.slice(colon + 1) : key;
          if (!ids.has(uid)) continue;
          hash = (hash * 31 + order) | 0;
        }
        return hash;
      },
      [memberIdsKey],
    ),
  );
  const getPresence = usePresenceStore((s) => s.getPresence);
  const voiceParticipants = useVoiceStore((s) => s.participants);
  const selfUserId = activeServer?.userId ?? authUserId;
  const isAuthenticated = Boolean(authToken && selfUserId);
  const [fetchedRoles, setFetchedRoles] = useState<Role[]>([]);

  // Use prop roles if provided, otherwise use fetched roles
  const roles = propRoles.length > 0 ? propRoles : fetchedRoles;

  useEffect(() => {
    if (selectedGuildId && !storeMembers) {
      fetchMembers(selectedGuildId);
    }
  }, [selectedGuildId]);

  useEffect(() => {
    if (!selectedGuildId || propRoles.length > 0) return;
    guildApi.getRoles(selectedGuildId).then(({ data }) => {
      setFetchedRoles(data);
    }).catch(() => {
      // non-fatal
    });
  }, [selectedGuildId, propRoles.length]);

  const members: MemberWithUser[] = useMemo(() => {
    if (propMembers) return propMembers;
    return (storeMembers || []).map(m => {
      const presence = getPresence(m.user.id, activeServerId ?? undefined);
      const voiceState = voiceParticipants.get(m.user.id);
      const inCurrentGuildVoice =
        Boolean(voiceState?.channel_id) &&
        (!selectedGuildId || voiceState?.guild_id === selectedGuildId);
      const isAuthenticatedSelfMember = isAuthenticated && m.user.id === selfUserId;
      const derivedStatus = resolveMemberStatus(
        presence?.status as MemberWithUser['status'] | undefined,
        inCurrentGuildVoice,
        isAuthenticatedSelfMember,
      );
      const activity = getPrimaryActivity(presence);
      return {
        user_id: m.user.id,
        username: m.user.username,
        display_name: m.user.display_name,
        avatar_hash: m.user.avatar || null,
        nick: m.nick || null,
        roles: m.roles ?? [],
        bot: m.user.bot,
        status: derivedStatus,
        activityText: formatActivityLabel(activity),
        streaming: Boolean(voiceState?.self_stream),
      };
    });
  }, [propMembers, storeMembers, presenceFingerprint, getPresence, activeServerId, voiceParticipants, selectedGuildId, isAuthenticated, selfUserId]);
  const [showOffline, setShowOffline] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberWithUser | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [contextMenuMember, setContextMenuMember] = useState<{ userId: string; x: number; y: number } | null>(null);

  const copyMemberIdToClipboard = useCallback(async (userId: string) => {
    try {
      await writeClipboardText(userId);
      toast.success('Member ID copied.');
    } catch (err) {
      toast.error(`Failed to copy member ID: ${extractApiError(err)}`);
    }
  }, []);

  const onlineMems = members.filter(m => m.status !== 'offline');
  const offlineMems = members.filter(m => m.status === 'offline');

  const roleGroups = new Map<string, MemberWithUser[]>();
  const noRoleGroup: MemberWithUser[] = [];

  onlineMems.forEach(m => {
    if (m.roles.length > 0 && roles.length > 0) {
      const highestRole = roles
        .filter(r => m.roles.includes(r.id))
        .sort((a, b) => b.position - a.position)[0];
      if (highestRole) {
        if (!roleGroups.has(highestRole.id)) roleGroups.set(highestRole.id, []);
        roleGroups.get(highestRole.id)!.push(m);
        return;
      }
    }
    noRoleGroup.push(m);
  });

  const handleMemberClick = (e: React.MouseEvent, member: MemberWithUser) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopupPos({ x: rect.left, y: rect.top });
    setSelectedMember(member);
  };

  const getStatusColor = (status?: string) => STATUS_COLORS[status || 'offline'];
  const isMemberListLoading = !propMembers && !storeMembers && !!selectedGuildId;

  const renderMember = (member: MemberWithUser) => {
    const roleColor = getHighestRoleColor(member.roles, roles);
    const offline = member.status === 'offline';
    return (
    <button
      key={member.user_id}
      className="group flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
      onClick={(e) => handleMemberClick(e, member)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenuMember({ userId: member.user_id, x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          setContextMenuMember({ userId: member.user_id, x: rect.left, y: rect.bottom });
        }
      }}
    >
      <div className="relative shrink-0" style={{ opacity: offline ? 0.55 : 1 }}>
        <span
          className="block rounded-full"
          style={
            member.streaming
              ? {
                  padding: '2px',
                  background:
                    'linear-gradient(135deg, var(--accent-secondary), var(--accent-primary))',
                }
              : undefined
          }
        >
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full text-label font-semibold text-white"
            style={{ backgroundColor: roleColor ?? 'var(--accent-primary)' }}
          >
            {displayName(member, member.nick).charAt(0).toUpperCase()}
          </span>
        </span>
        <span
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full"
          style={{
            backgroundColor: getStatusColor(member.status),
            boxShadow: '0 0 0 2px var(--bg-secondary)',
          }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-label font-medium',
              offline && 'text-text-muted',
            )}
            style={offline ? undefined : { color: roleColor ?? 'var(--text-secondary)' }}
          >
            {displayName(member, member.nick)}
          </span>
          {member.bot && (
            <span className="shrink-0 rounded-xs bg-accent-tint px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-primary">
              Bot
            </span>
          )}
        </div>
        {member.activityText && !offline && (
          <div className="truncate text-meta text-text-muted">{member.activityText}</div>
        )}
      </div>
    </button>
  );
  };

  // Flatten all sections into a single virtual row list for virtualization
  type VirtualRow =
    | { type: 'stats' }
    | { type: 'header'; label: string; count: number }
    | { type: 'member'; member: MemberWithUser }
    | { type: 'offlineToggle'; count: number }
    | { type: 'empty' };

  const virtualRows = useMemo<VirtualRow[]>(() => {
    if (isMemberListLoading) return [];
    const rows: VirtualRow[] = [];
    if (!hideStatsHeader) rows.push({ type: 'stats' });

    for (const [roleId, groupMembers] of roleGroups.entries()) {
      const role = roles.find(r => r.id === roleId);
      rows.push({ type: 'header', label: role?.name || 'Members', count: groupMembers.length });
      for (const m of groupMembers) rows.push({ type: 'member', member: m });
    }

    if (noRoleGroup.length > 0) {
      rows.push({ type: 'header', label: 'Online', count: noRoleGroup.length });
      for (const m of noRoleGroup) rows.push({ type: 'member', member: m });
    }

    if (offlineMems.length > 0) {
      rows.push({ type: 'offlineToggle', count: offlineMems.length });
      if (showOffline) {
        for (const m of offlineMems) rows.push({ type: 'member', member: m });
      }
    }

    if (members.length === 0) {
      rows.push({ type: 'empty' });
    }

    return rows;
  }, [roleGroups, noRoleGroup, offlineMems, showOffline, members.length, roles, isMemberListLoading, hideStatsHeader]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const estimateSize = useCallback((index: number) => {
    const row = virtualRows[index];
    if (!row) return 52;
    switch (row.type) {
      case 'stats': return 46;
      case 'header': return 30;
      case 'offlineToggle': return 34;
      case 'empty': return 104;
      case 'member': return 50;
      default: return 50;
    }
  }, [virtualRows]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 10,
    paddingStart: 18,
  });

  if (compact) {
    const compactMembers = [...members].sort((a, b) => {
      const leftOnline = a.status !== 'offline' ? 1 : 0;
      const rightOnline = b.status !== 'offline' ? 1 : 0;
      return rightOnline - leftOnline;
    });

    return (
      <div
        className="flex h-full flex-col items-center overflow-y-auto px-3 py-6 scrollbar-thin"
        role="complementary"
        aria-label="Member list"
      >
        <div className="mb-4 flex flex-col items-center">
          <div className="text-section uppercase text-text-muted">Members</div>
          <div className="mt-0.5 font-code text-meta tabular-nums text-text-secondary">{members.length}</div>
        </div>

        <div className="flex w-full flex-1 flex-col items-center gap-2.5">
          {isMemberListLoading ? (
            Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="h-9 w-9 animate-pulse rounded-full bg-bg-mod-subtle" />
            ))
          ) : compactMembers.length > 0 ? (
            compactMembers.map((member) => {
              const roleColor = getHighestRoleColor(member.roles, roles);
              return (
              <button
                key={member.user_id}
                title={displayName(member, member.nick)}
                className="group relative flex h-9 w-9 items-center justify-center rounded-full text-label font-semibold text-white outline-none transition-transform duration-[140ms] ease-[var(--ease-out)] hover:brightness-110 active:scale-95 focus-visible:shadow-[var(--focus-ring)]"
                style={{
                  backgroundColor: roleColor ?? 'var(--accent-primary)',
                  opacity: member.status === 'offline' ? 0.5 : 1,
                }}
                onClick={(e) => handleMemberClick(e, member)}
              >
                {displayName(member, member.nick).charAt(0).toUpperCase()}
                <span
                  className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full"
                  style={{
                    backgroundColor: getStatusColor(member.status),
                    boxShadow: '0 0 0 2px var(--bg-secondary)',
                  }}
                />
              </button>
              );
            })
          ) : (
            <p className="px-1 pt-2 text-center text-meta text-text-muted">No one online yet</p>
          )}
        </div>

        {selectedMember && createPortal(
          <UserProfilePopup
            user={{
              id: selectedMember.user_id,
              username: selectedMember.username,
              discriminator: '0000',
              avatar_hash: selectedMember.avatar_hash,
              display_name: displayName(selectedMember, selectedMember.nick),
              bot: selectedMember.bot ?? false,
              system: false,
              flags: 0,
              created_at: '',
            }}
            roles={roles.filter((role) => selectedMember.roles.includes(role.id))}
            position={popupPos}
            onClose={() => setSelectedMember(null)}
          />,
          document.body
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex min-w-0 w-full flex-col overflow-y-auto scrollbar-thin"
      role="complementary"
      aria-label="Member list"
    >
      {isMemberListLoading ? (
        <div className="px-3 pt-4.5" aria-label="Loading members">
          {Array.from({ length: 7 }, (_, i) => (
            <SkeletonMember key={i} />
          ))}
        </div>
      ) : (
        <div
          className="relative px-3"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const row = virtualRows[virtualItem.index];
            if (!row) return null;
            return (
              <div
                key={virtualItem.index}
                className="absolute left-0 right-0 px-3"
                style={{
                  top: virtualItem.start,
                  height: virtualItem.size,
                }}
              >
                {row.type === 'stats' && (
                  <div className="mb-3 flex items-baseline justify-between border-b border-border-subtle px-2 pb-2.5">
                    <span className="text-section uppercase text-text-muted">Members</span>
                    <span className="font-code text-meta tabular-nums text-text-secondary">{members.length}</span>
                  </div>
                )}
                {row.type === 'header' && (
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-section uppercase text-text-muted">
                    <span className="truncate">{row.label}</span>
                    <span className="font-code tabular-nums text-text-muted">{row.count}</span>
                  </div>
                )}
                {row.type === 'member' && renderMember(row.member)}
                {row.type === 'offlineToggle' && (
                  <button
                    className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-section uppercase text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]"
                    onClick={() => setShowOffline(!showOffline)}
                  >
                    <ChevronDown
                      size={12}
                      className="shrink-0 transition-transform duration-[140ms] ease-[var(--ease-out)]"
                      style={{ transform: showOffline ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                    />
                    <span className="truncate">Offline</span>
                    <span className="font-code tabular-nums text-text-muted">{row.count}</span>
                  </button>
                )}
                {row.type === 'empty' && (
                  <div className="flex items-start gap-3 px-2 py-6">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                      <Users size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-label font-semibold text-text-primary">Nobody&apos;s here yet</p>
                      <p className="mt-0.5 text-meta text-text-secondary">
                        Members show up as they join and come online.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {contextMenuMember && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenuMember(null)} />
          <div
            className="glass-modal fixed z-50 min-w-[min(12.5rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] rounded-md p-1"
            style={{ left: contextMenuMember.x + 10, top: contextMenuMember.y }}
            role="menu"
            aria-label="Member actions"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setContextMenuMember(null);
              }
            }}
          >
            <button
              autoFocus
              role="menuitem"
              className="w-full rounded-sm px-2.5 py-1.5 text-left text-label text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint hover:text-text-primary focus-visible:bg-accent-tint focus-visible:text-text-primary"
              onClick={() => {
                void copyMemberIdToClipboard(contextMenuMember.userId);
                setContextMenuMember(null);
              }}
            >
              Copy ID
            </button>
          </div>
        </>
      )}

      {selectedMember && createPortal(
        <UserProfilePopup
          user={{
            id: selectedMember.user_id,
            username: selectedMember.username,
            discriminator: '0000',
            avatar_hash: selectedMember.avatar_hash,
            display_name: displayName(selectedMember, selectedMember.nick),
            bot: selectedMember.bot ?? false,
            system: false,
            flags: 0,
            created_at: '',
          }}
          roles={roles.filter((role) => selectedMember.roles.includes(role.id))}
          position={popupPos}
          onClose={() => setSelectedMember(null)}
        />,
        document.body
      )}
    </div>
  );
}
