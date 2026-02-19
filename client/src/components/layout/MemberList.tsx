import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
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

interface MemberWithUser {
  user_id: string;
  username: string;
  avatar_hash: string | null;
  nick: string | null;
  roles: string[];
  bot?: boolean;
  status?: 'online' | 'idle' | 'dnd' | 'offline';
  activityText?: string | null;
}

interface MemberListProps {
  members?: MemberWithUser[];
  roles?: Role[];
  compact?: boolean;
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

export function MemberList({ members: propMembers, roles = [], compact = false }: MemberListProps) {
  const selectedGuildId = useGuildStore(s => s.selectedGuildId);
  const activeServerId = useServerListStore(s => s.activeServerId);
  const activeServer = useServerListStore((s) =>
    s.activeServerId ? s.servers.find((server) => server.id === s.activeServerId) : undefined
  );
  const authUserId = useAuthStore((s) => s.user?.id);
  const authToken = useAuthStore((s) => s.token);
  const storeMembers = useMemberStore(s => selectedGuildId ? s.members.get(selectedGuildId) : undefined);
  const fetchMembers = useMemberStore(s => s.fetchMembers);
  // Subscribe so presence updates trigger recomputation.
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const voiceParticipants = useVoiceStore((s) => s.participants);
  const selfUserId = activeServer?.userId ?? authUserId;
  const isAuthenticated = Boolean(authToken && selfUserId);

  useEffect(() => {
    if (selectedGuildId && !storeMembers) {
      fetchMembers(selectedGuildId);
    }
  }, [selectedGuildId]);

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
        avatar_hash: m.user.avatar || null,
        nick: m.nick || null,
        roles: m.roles ?? [],
        bot: m.user.bot,
        status: derivedStatus,
        activityText: formatActivityLabel(activity),
      };
    });
  }, [propMembers, storeMembers, presences, getPresence, activeServerId, voiceParticipants, selectedGuildId, isAuthenticated, selfUserId]);
  const [showOffline, setShowOffline] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberWithUser | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

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

  if (compact) {
    const compactMembers = [...members].sort((a, b) => {
      const leftOnline = a.status !== 'offline' ? 1 : 0;
      const rightOnline = b.status !== 'offline' ? 1 : 0;
      return rightOnline - leftOnline;
    });

    return (
      <div
        className="flex h-full flex-col items-center overflow-y-auto px-2 py-5 scrollbar-thin"
        role="complementary"
        aria-label="Member list"
      >
        <div className="mb-4 text-center">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Members</div>
          <div className="mt-1 text-sm font-semibold text-text-primary">{members.length}</div>
        </div>

        <div className="flex w-full flex-1 flex-col items-center gap-2">
          {isMemberListLoading ? (
            Array.from({ length: 7 }, (_, i) => (
              <div
                key={i}
                className="h-10 w-10 animate-pulse rounded-xl border border-border-subtle bg-bg-mod-subtle"
              />
            ))
          ) : compactMembers.length > 0 ? (
            compactMembers.map((member) => (
              <button
                key={member.user_id}
                title={member.nick || member.username}
                className="group relative flex h-10 w-10 items-center justify-center rounded-xl border border-transparent bg-bg-mod-subtle/65 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:border-border-subtle hover:bg-bg-mod-strong"
                style={{ opacity: member.status === 'offline' ? 0.45 : 1 }}
                onClick={(e) => handleMemberClick(e, member)}
              >
                {(member.nick || member.username).charAt(0).toUpperCase()}
                <span
                  className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2"
                  style={{
                    backgroundColor: getStatusColor(member.status),
                    borderColor: 'var(--bg-secondary)',
                  }}
                />
              </button>
            ))
          ) : (
            <div className="pt-2 text-center text-[11px] text-text-muted">No members</div>
          )}
        </div>

        {selectedMember && createPortal(
          <UserProfilePopup
            user={{
              id: selectedMember.user_id,
              username: selectedMember.username,
              discriminator: '0000',
              avatar_hash: selectedMember.avatar_hash,
              display_name: selectedMember.nick,
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

  const renderMember = (member: MemberWithUser) => (
    <button
      key={member.user_id}
      className="group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-all hover:border-border-subtle hover:bg-bg-mod-subtle"
      onClick={(e) => handleMemberClick(e, member)}
    >
      <div className="relative flex-shrink-0">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{
            backgroundColor: 'var(--accent-primary)',
            opacity: member.status === 'offline' ? 0.4 : 1,
          }}
        >
          {(member.nick || member.username).charAt(0).toUpperCase()}
        </div>
        <div
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2"
          style={{
            backgroundColor: getStatusColor(member.status),
            borderColor: 'var(--bg-secondary)',
          }}
        />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <div
            className="truncate text-sm font-semibold text-text-secondary transition-colors group-hover:text-text-primary"
            style={{
              opacity: member.status === 'offline' ? 0.4 : 1,
            }}
          >
            {member.nick || member.username}
          </div>
          {member.bot && (
            <span className="shrink-0 rounded-md border border-accent-primary/35 bg-accent-primary/12 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-primary">
              Bot
            </span>
          )}
        </div>
        {member.activityText && member.status !== 'offline' && (
          <div className="truncate text-xs text-text-muted">{member.activityText}</div>
        )}
      </div>
    </button>
  );

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
    rows.push({ type: 'stats' });

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
  }, [roleGroups, noRoleGroup, offlineMems, showOffline, members.length, roles, isMemberListLoading]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const estimateSize = useCallback((index: number) => {
    const row = virtualRows[index];
    if (!row) return 52;
    switch (row.type) {
      case 'stats': return 76;
      case 'header': return 38;
      case 'offlineToggle': return 42;
      case 'empty': return 80;
      case 'member': return 52;
      default: return 52;
    }
  }, [virtualRows]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 10,
  });

  return (
    <div
      ref={scrollRef}
      className="flex flex-col overflow-y-auto scrollbar-thin"
      role="complementary"
      aria-label="Member list"
      style={{
        width: 'var(--member-list-width)',
        minWidth: 'var(--member-list-width)',
      }}
    >
      {isMemberListLoading ? (
        <div className="px-3 pt-4.5" aria-label="Loading members">
          {Array.from({ length: 7 }, (_, i) => (
            <SkeletonMember key={i} />
          ))}
        </div>
      ) : (
        <div
          className="relative px-3 pt-4.5"
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
                  <div className="mb-6 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-3.5 py-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Members</div>
                    <div className="mt-0.5 text-base font-semibold text-text-primary">{members.length}</div>
                  </div>
                )}
                {row.type === 'header' && (
                  <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {row.label} — {row.count}
                  </div>
                )}
                {row.type === 'member' && renderMember(row.member)}
                {row.type === 'offlineToggle' && (
                  <button
                    className="category-header w-full rounded-lg px-3 py-2 hover:bg-bg-mod-subtle"
                    onClick={() => setShowOffline(!showOffline)}
                  >
                    <ChevronDown
                      size={12}
                      className="transition-transform"
                      style={{ transform: showOffline ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                    />
                    Offline — {row.count}
                  </button>
                )}
                {row.type === 'empty' && (
                  <div className="flex flex-col items-center justify-center py-8 px-4">
                    <p className="text-xs text-center text-text-muted">No members to display</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selectedMember && createPortal(
        <UserProfilePopup
          user={{
            id: selectedMember.user_id,
            username: selectedMember.username,
            discriminator: '0000',
            avatar_hash: selectedMember.avatar_hash,
            display_name: selectedMember.nick,
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
