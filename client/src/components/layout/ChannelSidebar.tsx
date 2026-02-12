import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Hash, Volume2, ChevronDown, ChevronRight, Settings, Mic, MicOff, Headphones, HeadphoneOff, Search, Plus, Video } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { VoiceControls } from '../voice/VoiceControls';
import { InviteModal } from '../guild/InviteModal';
import { Permissions, hasPermission, type Channel } from '../../types/index';
import { dmApi } from '../../api/dms';
import { useVoice } from '../../hooks/useVoice';
import { usePermissions } from '../../hooks/usePermissions';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';

const EMPTY_CHANNELS: Channel[] = [];

interface CategoryGroup {
  id: string | null;
  name: string;
  channels: Channel[];
}

export function ChannelSidebar() {
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const setDmChannels = useChannelStore((s) => s.setDmChannels);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const guilds = useGuildStore((s) => s.guilds);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const location = useLocation();
  const { guildId } = useParams();
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showGuildMenu, setShowGuildMenu] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [dmSearch, setDmSearch] = useState('');
  const [showDmPicker, setShowDmPicker] = useState(false);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const { connected, channelId: activeVoiceChannelId, joinChannel, leaveChannel, selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoice();
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);

  const effectiveGuildId = guildId || selectedGuildId;
  const currentGuild = guilds.find(g => g.id === effectiveGuildId);
  const { permissions, isAdmin } = usePermissions(effectiveGuildId || null);
  const canManageGuild = isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD);
  const canCreateInvite = isAdmin || hasPermission(permissions, Permissions.CREATE_INSTANT_INVITE);
  const canManageChannels = isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS);

  useEffect(() => {
    if (currentGuild) return;
    dmApi
      .list()
      .then(({ data }) => setDmChannels(data))
      .catch(() => {
        // ignore
      });
  }, [currentGuild, setDmChannels]);

  useEffect(() => {
    if (showDmPicker) {
      void fetchRelationships();
    }
  }, [showDmPicker, fetchRelationships]);

  const categoryGroups: CategoryGroup[] = [];
  const uncategorized: CategoryGroup = { id: null, name: '', channels: [] };
  const categoryMap = new Map<string, CategoryGroup>();

  channels.forEach(ch => {
    if (ch.type === 4) {
      categoryMap.set(ch.id, { id: ch.id, name: ch.name ?? 'Unknown', channels: [] });
    }
  });

  const inviteChannelId =
    channels.find((c) => c.type === 0)?.id ??
    channels.find((c) => c.type !== 4)?.id ??
    null;

  channels.forEach(ch => {
    if (ch.type === 4) return;
    if (ch.parent_id != null && categoryMap.has(ch.parent_id)) {
      categoryMap.get(ch.parent_id)!.channels.push(ch);
    } else {
      uncategorized.channels.push(ch);
    }
  });

  if (uncategorized.channels.length > 0) categoryGroups.push(uncategorized);
  categoryMap.forEach(cat => categoryGroups.push(cat));

  const toggleCategory = (catId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const handleChannelClick = (channel: Channel) => {
    selectChannel(channel.id);
    const gId = guildId || selectedGuildId;
    if (gId) {
      if ((channel.type === 2 || channel.channel_type === 2) && gId) {
        if (connected && activeVoiceChannelId === channel.id) {
          void leaveChannel();
        } else {
          // Do not block navigation on RTC connect attempts, which can take
          // a long time or fail in degraded network environments.
          void joinChannel(channel.id, gId);
        }
      }
      navigate(`/app/guilds/${gId}/channels/${channel.id}`);
    }
  };

  if (!currentGuild) {
    const filteredDms = dmChannels.filter((dm) =>
      (dm.recipient?.username || 'Direct Message').toLowerCase().includes(dmSearch.toLowerCase())
    );

    return (
      <div className="flex h-full flex-col bg-transparent">
        <div className="panel-divider flex h-[var(--spacing-header-height)] items-center border-b px-4 shrink-0">
          <div className="relative w-full">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Find a conversation"
              className="h-11 w-full rounded-xl border border-border-subtle bg-bg-mod-subtle py-2.5 pl-10 pr-3.5 text-sm text-text-primary placeholder:text-text-muted outline-none transition-all focus:border-border-strong focus:bg-bg-mod-strong"
              value={dmSearch}
              onChange={(e) => setDmSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3.5 scrollbar-thin">
          <button
            onClick={() => navigate('/app/friends')}
            className={cn(
              'flex w-full items-center gap-3.5 rounded-xl border px-3.5 py-3 text-[15px] font-semibold transition-colors hover:bg-bg-mod-subtle hover:text-text-primary',
              location.pathname === '/app/friends' && "bg-bg-mod-subtle text-text-primary"
            )}
            style={
              location.pathname === '/app/friends'
                ? { borderColor: 'var(--border-strong)' }
                : { borderColor: 'transparent', color: 'var(--text-secondary)' }
            }
          >
            <div className="w-6 flex justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="opacity-70">
                <path d="M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-2 2a7 7 0 0 0-7 7 1 1 0 0 0 1 1h16a1 1 0 0 0 1-1 7 7 0 0 0-7-7h-4Z" />
              </svg>
            </div>
            Friends
          </button>

          <div className="group mb-1 mt-6 flex items-center justify-between px-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted transition-colors group-hover:text-text-secondary">
              Direct Messages
            </span>
            <Tooltip content="Create DM" side="top">
              <button
                className="rounded-lg border border-transparent p-1.5 text-text-muted opacity-0 transition-all group-hover:opacity-100 hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary"
                onClick={() => setShowDmPicker(true)}
              >
                <PlusIconSmall />
              </button>
            </Tooltip>
          </div>

          {filteredDms.length === 0 ? (
            <div className="mt-2 flex flex-col items-center justify-center px-4 py-10 opacity-70">
              <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
                <Search size={24} className="text-text-muted" />
              </div>
              <span className="text-sm text-center text-text-muted">No direct messages found</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {filteredDms.map((dm) => (
                <button
                  key={dm.id}
                  onClick={() => {
                    selectChannel(dm.id);
                    navigate(`/app/dms/${dm.id}`);
                  }}
                  className={cn(
                    'group flex w-full items-center gap-3.5 rounded-xl border px-3.5 py-3 transition-all',
                    selectedChannelId === dm.id
                      ? 'bg-bg-mod-subtle text-text-primary border-border-strong'
                      : 'text-text-secondary border-transparent hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary'
                  )}
                >
                  <div className="relative">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-primary text-sm font-semibold text-white">
                      {(dm.recipient?.username || 'D').charAt(0).toUpperCase()}
                    </div>
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-online border-[2px] border-bg-secondary" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="truncate font-semibold text-[15px]">{dm.recipient?.username || 'Direct Message'}</span>
                    <span className="truncate text-xs text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">Online</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <UserPanel
          user={user}
          navigate={navigate}
          muted={selfMute}
          deafened={selfDeaf}
          onToggleMute={toggleMute}
          onToggleDeaf={toggleDeaf}
        />
        {showDmPicker && (
          <>
            <div
              className="fixed inset-0 z-50"
              style={{ backgroundColor: 'var(--overlay-backdrop)' }}
              onClick={() => setShowDmPicker(false)}
            />
            <div className="glass-modal fixed left-1/2 top-1/2 z-50 max-h-[70vh] w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl">
              <div className="panel-divider border-b px-5 py-4 text-lg font-semibold text-text-primary">Start Direct Message</div>
              <div className="max-h-[50vh] overflow-y-auto p-3">
                {relationships.filter((r) => r.type === 1).map((rel) => (
                  <button
                    key={rel.id}
                    className="w-full rounded-lg px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-bg-mod-subtle"
                    onClick={async () => {
                      const { data } = await dmApi.create(rel.user.id);
                      const current = useChannelStore.getState().channelsByGuild[''] || [];
                      const next = current.some((c) => c.id === data.id) ? current : [...current, data];
                      setDmChannels(next);
                      selectChannel(data.id);
                      setShowDmPicker(false);
                      navigate(`/app/dms/${data.id}`);
                    }}
                  >
                    <div className="text-sm text-text-primary">{rel.user.username}</div>
                  </button>
                ))}
                {relationships.filter((r) => r.type === 1).length === 0 && (
                  <div className="p-5 text-sm text-text-muted text-center">No friends available for DM.</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-transparent">
      <button
        className="panel-divider relative flex h-[var(--spacing-header-height)] w-full items-center justify-between border-b px-5 text-left transition-colors hover:bg-bg-mod-subtle shrink-0"
        onClick={() => setShowGuildMenu(!showGuildMenu)}
      >
        <span className="truncate text-[15px] font-semibold text-text-primary">
          {currentGuild.name}
        </span>
        <ChevronDown size={18} className="text-text-primary" />
      </button>

      {showGuildMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowGuildMenu(false)} />
          <div className="glass-modal animation-scale-in absolute left-6 top-[58px] z-50 w-56 origin-top-left rounded-xl p-1.5">
            <button
              className={cn(
                'group flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors',
                canManageGuild
                  ? 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                  : 'cursor-not-allowed text-text-muted opacity-60'
              )}
              disabled={!canManageGuild}
              title={canManageGuild ? 'Server Settings' : 'You need Manage Server permission'}
              onClick={() => { setShowGuildMenu(false); navigate(`/app/guilds/${currentGuild.id}/settings`); }}
            >
              Server Settings
              <Settings size={14} className="opacity-0 group-hover:opacity-100" />
            </button>
            <button
              className={cn(
                'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors',
                inviteChannelId && canCreateInvite
                  ? 'text-accent-primary hover:bg-bg-mod-subtle hover:text-text-primary'
                  : 'cursor-not-allowed text-text-muted opacity-60'
              )}
              disabled={!inviteChannelId || !canCreateInvite}
              title={
                !canCreateInvite
                  ? 'You need Create Invite permission'
                  : inviteChannelId
                    ? 'Invite People'
                    : 'Create a text channel first to invite people'
              }
              onClick={() => {
                setShowGuildMenu(false);
                if (inviteChannelId && canCreateInvite) {
                  setShowInviteModal(true);
                }
              }}
            >
              Invite People
              <Plus size={14} />
            </button>
            {user && currentGuild.owner_id !== user.id && (
              <>
                <div className="my-1 mx-2 h-px bg-border-subtle" />
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-accent-danger transition-colors hover:bg-accent-danger hover:text-white"
                  onClick={async () => {
                    setShowGuildMenu(false);
                    try {
                      await useGuildStore.getState().leaveGuild(currentGuild.id);
                      navigate('/app/friends');
                    } catch {
                      // Server returned an error (e.g. owner can't leave)
                    }
                  }}
                >
                  Leave Server
                </button>
              </>
            )}
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto px-3 pt-4 scrollbar-thin">
        {categoryGroups.map((cat) => (
          <div key={cat.id || '__uncategorized'} className="mb-2">
            {cat.id && (
              <button
                className="flex w-full items-center gap-0.5 px-1.5 py-1 text-xs font-semibold uppercase tracking-wide text-text-muted transition-colors hover:text-text-secondary"
                onClick={() => toggleCategory(cat.id!)}
              >
                <div>
                  {collapsedCategories.has(cat.id) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                </div>
                {cat.name}
              </button>
            )}
            {!collapsedCategories.has(cat.id || '') && cat.channels.sort((a, b) => a.position - b.position).map(ch => {
              const isSelected = selectedChannelId === ch.id;
              const isVoice = ch.type === 2 || ch.channel_type === 2;
              const voiceMembers = isVoice ? (channelParticipants.get(ch.id) || []) : [];
              return (
                <div key={ch.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleChannelClick(ch)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void handleChannelClick(ch);
                      }
                    }}
                    className={cn(
                      'group mb-0.5 flex w-full cursor-pointer items-center rounded-xl border px-3.5 py-2.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary',
                      isSelected
                        ? 'border-border-strong bg-bg-mod-subtle text-text-primary'
                        : 'border-transparent text-text-secondary hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary'
                    )}
                  >
                    {isVoice ? (
                      <Volume2 size={16} className="mr-1.5 text-text-muted group-hover:text-text-secondary" />
                    ) : (
                      <Hash size={16} className="mr-1.5 text-text-muted group-hover:text-text-secondary" />
                    )}
                    <span className={cn('truncate text-[15px] font-medium', isSelected ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary')}>
                      {ch.name || 'unknown'}
                    </span>
                    {!isVoice && canManageChannels && (
                      <div className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
                        <Tooltip content="Edit Channel" side="top">
                          <span
                            role="button"
                            tabIndex={0}
                            className="inline-flex rounded p-1 text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              const gid = guildId || selectedGuildId;
                              if (gid) {
                                navigate(`/app/guilds/${gid}/settings?section=channels&channelId=${ch.id}`);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                const gid = guildId || selectedGuildId;
                                if (gid) {
                                  navigate(`/app/guilds/${gid}/settings?section=channels&channelId=${ch.id}`);
                                }
                              }
                            }}
                          >
                            <Settings size={14} />
                          </span>
                        </Tooltip>
                      </div>
                    )}
                  </div>
                  {isVoice && voiceMembers.length > 0 && (
                    <div className="mb-2 ml-8 mt-0.5 space-y-1">
                      {voiceMembers.map((vs) => {
                        const isSpeaking = speakingUsers.has(vs.user_id);
                        return (
                          <div
                            key={vs.user_id}
                            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5"
                          >
                            <div
                              className={cn(
                                'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white transition-shadow duration-200',
                                isSpeaking
                                  ? 'ring-2 ring-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
                                  : ''
                              )}
                              style={{ backgroundColor: 'var(--accent-primary)' }}
                            >
                              {(vs.username || vs.user_id).charAt(0).toUpperCase()}
                            </div>
                            <span className="truncate text-[13px] font-medium text-text-secondary">
                              {vs.username || `User ${vs.user_id.slice(0, 6)}`}
                            </span>
                            <div className="ml-auto flex items-center gap-1">
                              {vs.self_video && (
                                <Video size={13} className="text-accent-primary" />
                              )}
                              {vs.self_stream && (
                                <span className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wider text-accent-primary" style={{ backgroundColor: 'rgba(var(--accent-primary-rgb, 88, 101, 242), 0.15)' }}>
                                  Live
                                </span>
                              )}
                              {vs.self_mute && <MicOff size={13} className="text-text-muted" />}
                              {vs.self_deaf && <HeadphoneOff size={13} className="text-text-muted" />}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {channels.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 px-4">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
              <Hash size={24} className="text-text-muted" />
            </div>
            <p className="text-xs text-center text-text-muted">
              No channels yet.
            </p>
          </div>
        )}
      </div>

      <VoiceControls />
      <UserPanel
        user={user}
        navigate={navigate}
        muted={selfMute}
        deafened={selfDeaf}
        onToggleMute={toggleMute}
        onToggleDeaf={toggleDeaf}
      />
      {showInviteModal && inviteChannelId && (
        <InviteModal
          guildName={currentGuild.name}
          channelId={inviteChannelId}
          onClose={() => setShowInviteModal(false)}
        />
      )}
      {showDmPicker && (
        <>
          <div
            className="fixed inset-0 z-50"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowDmPicker(false)}
          />
          <div className="glass-modal fixed left-1/2 top-1/2 z-50 max-h-[70vh] w-[480px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl">
            <div className="panel-divider border-b px-5 py-4 text-lg font-semibold text-text-primary">Start Direct Message</div>
            <div className="max-h-[50vh] overflow-y-auto p-3">
              {relationships.filter((r) => r.type === 1).map((rel) => (
                <button
                  key={rel.id}
                  className="w-full rounded-lg px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-bg-mod-subtle"
                  onClick={async () => {
                    const { data } = await dmApi.create(rel.user.id);
                    const current = useChannelStore.getState().channelsByGuild[''] || [];
                    const next = current.some((c) => c.id === data.id) ? current : [...current, data];
                    setDmChannels(next);
                    selectChannel(data.id);
                    setShowDmPicker(false);
                    navigate(`/app/dms/${data.id}`);
                  }}
                >
                  <div className="text-sm text-text-primary">{rel.user.username}</div>
                </button>
              ))}
              {relationships.filter((r) => r.type === 1).length === 0 && (
                <div className="p-5 text-sm text-text-muted text-center">No friends available for DM.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PlusIconSmall() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  )
}

function UserPanel({
  user,
  navigate,
  muted,
  deafened,
  onToggleMute,
  onToggleDeaf,
}: {
  user: { id: string; username: string; email?: string } | null;
  navigate: (path: string) => void;
  muted: boolean;
  deafened: boolean;
  onToggleMute: () => void;
  onToggleDeaf: () => void;
}) {
  return (
    <div className="panel-divider flex h-[62px] items-center border-t px-2.5 shrink-0">
      <div className="mr-2 flex min-w-0 flex-1 cursor-pointer items-center rounded-xl p-2 transition-colors hover:bg-bg-mod-subtle" onClick={() => navigator.clipboard?.writeText(user?.username || '')}>
        <div className="relative mr-2 shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary text-sm font-semibold text-white shadow-sm">
            {user?.username?.charAt(0).toUpperCase() || 'U'}
          </div>
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-online border-[2px] border-bg-tertiary" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight text-text-primary">
            {user?.username || 'User'}
          </div>
          <div className="truncate text-[11px] leading-tight text-text-muted">
            #{user?.id?.slice(0, 4) || '0000'}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Tooltip content={muted ? "Unmute" : "Mute"}>
          <button
            onClick={onToggleMute}
            className={cn(
              'relative flex h-10 w-10 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary',
              muted && "text-accent-danger"
            )}
          >
            {muted ? <MicOff size={20} /> : <Mic size={20} />}
            {muted && <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-accent-danger"><div className="w-6 h-0.5 bg-accent-danger rotate-45 transform" /></div>}
          </button>
        </Tooltip>
        <Tooltip content={deafened ? "Undeafen" : "Deafen"}>
          <button
            onClick={onToggleDeaf}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary',
              deafened && "text-accent-danger"
            )}
          >
            {deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
          </button>
        </Tooltip>
        <Tooltip content="User Settings">
          <button onClick={() => navigate('/app/settings')} className="flex h-10 w-10 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary">
            <Settings size={20} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
