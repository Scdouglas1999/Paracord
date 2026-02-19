import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Hash, Volume2, ChevronDown, ChevronRight, Settings, Mic, MicOff, Headphones, HeadphoneOff, Search, Plus, Video, MessageSquare, Home } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { VoiceControls } from '../voice/VoiceControls';
import { InviteModal } from '../guild/InviteModal';
import { Permissions, hasPermission, isAdmin as isGlobalAdmin, type Channel } from '../../types/index';
import { buildChannelGroups, isVirtualGroup } from '../../lib/channelGroups';
import { guildApi } from '../../api/guilds';
import { dmApi } from '../../api/dms';
import { useVoice } from '../../hooks/useVoice';
import { usePermissions } from '../../hooks/usePermissions';
import { useUnreadCounts } from '../../hooks/useUnreadCounts';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';

const EMPTY_CHANNELS: Channel[] = [];

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  offline: 'bg-status-offline',
};

function loadCollapsedCategories(guildId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`paracord:collapsed-cats:${guildId}`);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveCollapsedCategories(guildId: string, set: Set<string>) {
  localStorage.setItem(`paracord:collapsed-cats:${guildId}`, JSON.stringify([...set]));
}

interface ChannelSidebarProps {
  collapsed?: boolean;
}

export function ChannelSidebar({ collapsed = false }: ChannelSidebarProps) {
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

  const mutedGuildIds = (() => {
    try {
      return JSON.parse(localStorage.getItem('paracord:muted-guilds') || '[]') as string[];
    } catch {
      return [];
    }
  })();
  const { isChannelUnread, channelMentionCounts } = useUnreadCounts(mutedGuildIds);

  const effectiveGuildId = guildId || selectedGuildId;
  const currentGuild = guilds.find(g => g.id === effectiveGuildId);
  const { permissions, isAdmin: hasGuildAdminRole } = usePermissions(effectiveGuildId || null);
  const canManageGuild = hasGuildAdminRole || hasPermission(permissions, Permissions.MANAGE_GUILD);
  const canCreateInvite = hasGuildAdminRole || hasPermission(permissions, Permissions.CREATE_INSTANT_INVITE);
  const canManageChannels = hasGuildAdminRole || hasPermission(permissions, Permissions.MANAGE_CHANNELS);
  const showAdminDashboardShortcut = Boolean(user && isGlobalAdmin(user.flags ?? 0));

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

  const [createInCategoryId, setCreateInCategoryId] = useState<string | null>(null);
  const [inlineName, setInlineName] = useState('');
  const [inlineType, setInlineType] = useState<'text' | 'voice'>('text');

  const categoryGroups = useMemo(() => buildChannelGroups(channels), [channels]);

  const inviteChannelId =
    channels.find((c) => c.type === 0)?.id ??
    channels.find((c) => c.type !== 4)?.id ??
    null;

  // Load collapsed categories from localStorage when guild changes
  useEffect(() => {
    if (effectiveGuildId) {
      setCollapsedCategories(loadCollapsedCategories(effectiveGuildId));
    }
  }, [effectiveGuildId]);

  const toggleCategory = useCallback((catId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      if (effectiveGuildId) saveCollapsedCategories(effectiveGuildId, next);
      return next;
    });
  }, [effectiveGuildId]);

  const handleInlineCreate = useCallback(async (parentId: string | null) => {
    if (!inlineName.trim() || !effectiveGuildId) return;
    try {
      await guildApi.createChannel(effectiveGuildId, {
        name: inlineName.trim(),
        channel_type: inlineType === 'voice' ? 2 : 0,
        parent_id: parentId && !isVirtualGroup(parentId) ? parentId : null,
      });
      setInlineName('');
      setCreateInCategoryId(null);
      // Channel will appear via gateway event
    } catch {
      // ignore
    }
  }, [inlineName, inlineType, effectiveGuildId]);

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

  if (!currentGuild && collapsed) {
    const compactDms = dmChannels.slice(0, 32);
    return (
      <div className="flex h-full flex-col items-center px-1.5 py-3">
        <Tooltip content="Home" side="right">
          <button
            onClick={() => navigate('/app')}
            className={cn(
              'mb-1.5 flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-semibold transition-colors',
              location.pathname === '/app'
                ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
            )}
          >
            <Home size={15} />
          </button>
        </Tooltip>
        <Tooltip content="Friends" side="right">
          <button
            onClick={() => navigate('/app/friends')}
            className={cn(
              'mb-2 flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-semibold transition-colors',
              location.pathname === '/app/friends'
                ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
            )}
          >
            <Hash size={15} />
          </button>
        </Tooltip>

        <div className="mb-2 h-px w-6 bg-border-subtle" />

        <div className="flex w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto px-0.5 scrollbar-thin">
          {compactDms.map((dm) => {
            const isSelected = selectedChannelId === dm.id;
            return (
              <Tooltip key={dm.id} content={dm.recipient?.username || 'Direct Message'} side="right">
                <button
                  onClick={() => {
                    selectChannel(dm.id);
                    navigate(`/app/dms/${dm.id}`);
                  }}
                  className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-xl border text-xs font-semibold transition-colors',
                    isSelected
                      ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                      : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
                  )}
                >
                  {(dm.recipient?.username || 'D').charAt(0).toUpperCase()}
                  <PresenceStatusDot userId={dm.recipient?.id} className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 border border-bg-secondary" />
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  if (!currentGuild) {
    const filteredDms = dmChannels.filter((dm) =>
      (dm.recipient?.username || 'Direct Message').toLowerCase().includes(dmSearch.toLowerCase())
    );

    return (
      <div className="flex h-full flex-col bg-transparent text-text-secondary">
        <div className="panel-divider shrink-0 border-b border-white/8 px-5 pb-6 pt-6">
          <div className="architect-eyebrow">Direct Messages</div>
          <div className="mt-2 mb-3 pl-px text-[1.5rem] font-bold leading-[1.2] tracking-normal text-text-primary">Paracord</div>
          <div className="relative w-full">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Find a conversation"
              className="h-10 w-full rounded-xl border border-border-subtle bg-bg-mod-subtle py-2 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-all focus:border-border-strong focus:bg-bg-mod-strong"
              value={dmSearch}
              onChange={(e) => setDmSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
          <button
            onClick={() => navigate('/app')}
            className={cn(
              'architect-nav-item px-3 py-2.5 text-[15px] font-semibold',
              location.pathname === '/app' ? 'architect-nav-item-active text-black' : 'text-text-secondary hover:text-text-primary'
            )}
          >
            <div className="w-6 flex justify-center">
              <Home size={20} className="opacity-70" />
            </div>
            Home
          </button>
          <button
            onClick={() => navigate('/app/friends')}
            className={cn(
              'architect-nav-item px-3 py-2.5 text-[15px] font-semibold',
              location.pathname === '/app/friends' ? 'architect-nav-item-active text-black' : 'text-text-secondary hover:text-text-primary'
            )}
          >
            <div className="w-6 flex justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="opacity-70">
                <path d="M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-2 2a7 7 0 0 0-7 7 1 1 0 0 0 1 1h16a1 1 0 0 0 1-1 7 7 0 0 0-7-7h-4Z" />
              </svg>
            </div>
            Friends
          </button>

          <div className="group mb-3 mt-5 flex items-center justify-between px-2.5">
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
                    'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition-all',
                    selectedChannelId === dm.id
                      ? 'architect-nav-item-active text-black'
                      : 'architect-nav-item text-text-secondary hover:text-text-primary'
                  )}
                >
                  <div className="relative">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-bg-mod-strong text-sm font-semibold text-text-primary">
                      {(dm.recipient?.username || 'D').charAt(0).toUpperCase()}
                    </div>
                    <PresenceStatusDot userId={dm.recipient?.id} className="absolute -bottom-0.5 -right-0.5 h-3 w-3 border-[2px] border-bg-secondary" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="truncate font-semibold text-[15px]">{dm.recipient?.username || 'Direct Message'}</span>
                    <PresenceStatusText userId={dm.recipient?.id} className="truncate text-xs text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
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
          showAdminDashboard={showAdminDashboardShortcut}
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

  if (collapsed) {
    const compactChannels = channels
      .filter((ch) => ch.type !== 4)
      .sort((a, b) => a.position - b.position)
      .slice(0, 80);

    return (
      <div className="flex h-full flex-col items-center px-1.5 py-3">
        <Tooltip content={currentGuild.name} side="right">
          <button
            className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-xs font-bold text-text-primary transition-colors hover:bg-bg-mod-strong"
            onClick={() => navigate(`/app/guilds/${currentGuild.id}/settings`)}
          >
            {currentGuild.name.slice(0, 2).toUpperCase()}
          </button>
        </Tooltip>
        <div className="mb-2 h-px w-6 bg-border-subtle" />
        <div className="flex w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto px-0.5 scrollbar-thin">
          {compactChannels.map((ch) => {
            const isSelected = selectedChannelId === ch.id;
            const isVoice = ch.type === 2 || ch.channel_type === 2;
            const isForum = ch.type === 7 || ch.channel_type === 7;
            const hasUnread = !isSelected && isChannelUnread.has(ch.id);
            const mentionCount = channelMentionCounts.get(ch.id) || 0;
            return (
              <Tooltip key={ch.id} content={ch.name || 'unknown'} side="right">
                <button
                  onClick={() => handleChannelClick(ch)}
                  className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-xl border transition-colors',
                    isSelected
                      ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                      : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
                  )}
                >
                  {isVoice ? <Volume2 size={14} /> : isForum ? <MessageSquare size={14} /> : <Hash size={14} />}
                  {hasUnread && (
                    <div className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-text-primary" />
                  )}
                  {mentionCount > 0 && (
                    <div className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-danger text-[8px] font-bold text-white">
                      {mentionCount}
                    </div>
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-transparent text-text-secondary">
      <div className="panel-divider shrink-0 border-b border-white/8 px-5 pb-5 pt-6">
        <div className="flex items-start justify-between gap-3">
          <button
            className="min-w-0 text-left"
            onClick={() => setShowGuildMenu(!showGuildMenu)}
          >
            <div className="architect-eyebrow">
              {(() => {
                if (!currentGuild.server_url) return 'Current Server';
                try { return new URL(currentGuild.server_url).host; } catch { return 'Current Server'; }
              })()}
            </div>
            <div className="mt-1.5 truncate text-[1.42rem] font-bold leading-[1.15] tracking-tight text-text-primary">
              {currentGuild.name}
            </div>
          </button>
          <button
            className="architect-top-icon mt-0.5"
            onClick={() => setShowGuildMenu(!showGuildMenu)}
            aria-label="Open server menu"
          >
            <ChevronDown size={16} className="text-text-muted" />
          </button>
        </div>
      </div>

      {showGuildMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowGuildMenu(false)} />
          <div className="glass-modal animation-scale-in absolute left-5 top-[88px] z-50 w-56 origin-top-left rounded-xl p-1.5">
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
            <button
              className="group flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
              onClick={() => {
                setShowGuildMenu(false);
                if (effectiveGuildId) {
                  localStorage.removeItem(`paracord:guild-welcomed:${effectiveGuildId}`);
                  window.dispatchEvent(new CustomEvent('paracord:show-welcome', { detail: { guildId: effectiveGuildId } }));
                }
              }}
            >
              Welcome Screen
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
          <div key={cat.id} className="mb-4">
            {/* Category header — shown for both real and virtual groups (except __uncategorized__) */}
            {cat.id !== '__uncategorized__' && (
              <div className="group/cat flex w-full items-center gap-1 px-2 py-2 mt-3.5">
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-text-muted transition-colors hover:text-text-secondary"
                  onClick={() => toggleCategory(cat.id)}
                >
                  <div>
                    {collapsedCategories.has(cat.id) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  </div>
                  <span className="truncate">{cat.name}</span>
                </button>
                {cat.isReal && canManageChannels && (
                  <Tooltip content="Create Channel" side="top">
                    <button
                      className="rounded p-0.5 text-text-muted opacity-0 transition-all group-hover/cat:opacity-100 hover:text-text-primary"
                      onClick={() => {
                        setCreateInCategoryId(createInCategoryId === cat.id ? null : cat.id);
                        setInlineName('');
                        setInlineType('text');
                      }}
                    >
                      <Plus size={14} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
            {/* Inline create popover */}
            {createInCategoryId === cat.id && (
              <div className="mx-2 mb-2 rounded-lg border border-border-subtle bg-bg-mod-subtle p-2.5 space-y-2">
                <input
                  className="w-full rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-border-strong"
                  placeholder="Channel name"
                  value={inlineName}
                  onChange={(e) => setInlineName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleInlineCreate(cat.id); if (e.key === 'Escape') setCreateInCategoryId(null); }}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <select
                    className="rounded-md border border-border-subtle bg-bg-primary px-2 py-1 text-xs text-text-secondary"
                    value={inlineType}
                    onChange={(e) => setInlineType(e.target.value as 'text' | 'voice')}
                  >
                    <option value="text">Text</option>
                    <option value="voice">Voice</option>
                  </select>
                  <button
                    className="rounded-md bg-accent-primary px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent-primary/80"
                    onClick={() => void handleInlineCreate(cat.id)}
                  >
                    Create
                  </button>
                  <button
                    className="rounded-md px-2 py-1 text-xs text-text-muted hover:text-text-primary"
                    onClick={() => setCreateInCategoryId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!collapsedCategories.has(cat.id) && cat.channels.map(ch => {
              const isSelected = selectedChannelId === ch.id;
              const isVoice = ch.type === 2 || ch.channel_type === 2;
              const isForum = ch.type === 7 || ch.channel_type === 7;
              const voiceMembers = isVoice ? (channelParticipants.get(ch.id) || []) : [];
              const hasUnread = !isSelected && isChannelUnread.has(ch.id);
              const mentionCount = channelMentionCounts.get(ch.id) || 0;
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
                      'architect-nav-item group relative mb-1 cursor-pointer px-3 py-2.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary',
                      isSelected
                        ? 'architect-nav-item-active text-black'
                        : 'text-text-secondary hover:text-text-primary'
                    )}
                  >
                    {hasUnread && (
                      <div
                        className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-text-primary"
                      />
                    )}
                    {isVoice ? (
                      <Volume2 size={16} className={cn('mr-1.5', isSelected ? 'text-black/70' : 'text-text-muted group-hover:text-text-secondary')} />
                    ) : isForum ? (
                      <MessageSquare size={16} className={cn('mr-1.5', isSelected ? 'text-black/70' : 'text-text-muted group-hover:text-text-secondary')} />
                    ) : (
                      <Hash size={16} className={cn('mr-1.5', isSelected ? 'text-black/70' : 'text-text-muted group-hover:text-text-secondary')} />
                    )}
                    <span className={cn(
                      'truncate text-[15px]',
                      isSelected ? 'text-black' : hasUnread ? 'font-bold text-text-primary' : 'font-semibold text-text-secondary group-hover:text-text-primary'
                    )}>
                      {ch.name || 'unknown'}
                    </span>
                    {mentionCount > 0 && (
                      <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-danger px-1 text-[10px] font-bold text-white">
                        {mentionCount}
                      </span>
                    )}
                    {!isVoice && canManageChannels && (
                      <div className={cn('opacity-0 transition-opacity group-hover:opacity-100', mentionCount === 0 && 'ml-auto')}>
                        <Tooltip content="Edit Channel" side="top">
                          <span
                            role="button"
                            tabIndex={0}
                            className={cn(
                              'inline-flex rounded p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary',
                              isSelected ? 'text-black/70 hover:bg-black/10 hover:text-black' : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-primary'
                            )}
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
                    <div
                      className="mb-2 mt-0.5 ml-10 space-y-1 border-l pl-2.5"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
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
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    useVoiceStore.getState().setWatchedStreamer(vs.user_id);
                                    const gId = guildId || selectedGuildId;
                                    if (gId) {
                                      navigate(`/app/guilds/${gId}/channels/${ch.id}`);
                                    }
                                  }}
                                  className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wider text-accent-danger transition-colors hover:bg-accent-danger/20 cursor-pointer"
                                  style={{ backgroundColor: 'rgba(255, 93, 114, 0.15)' }}
                                  title={`Watch ${vs.username || 'user'}'s stream`}
                                >
                                  Live
                                </button>
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
        showAdminDashboard={showAdminDashboardShortcut}
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

/** Status dot that resolves real presence for a given user ID. */
function PresenceStatusDot({ userId, className = '' }: { userId?: string; className?: string }) {
  const status = usePresenceStore((s) => {
    if (!userId) return 'offline';
    return s.getPresence(userId)?.status ?? 'offline';
  });
  const colorClass = STATUS_COLORS[status] || STATUS_COLORS.offline;
  return <div className={cn('rounded-full', colorClass, className)} />;
}

/** Status text label that resolves real presence for a given user ID. */
function PresenceStatusText({ userId, className = '' }: { userId?: string; className?: string }) {
  const status = usePresenceStore((s) => {
    if (!userId) return 'offline';
    return s.getPresence(userId)?.status ?? 'offline';
  });
  const label = status === 'dnd' ? 'Do Not Disturb' : status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={className}>{label}</span>;
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
  showAdminDashboard,
}: {
  user: { id: string; username: string; email?: string } | null;
  navigate: (path: string) => void;
  muted: boolean;
  deafened: boolean;
  onToggleMute: () => void;
  onToggleDeaf: () => void;
  showAdminDashboard: boolean;
}) {
  return (
    <div className="panel-divider shrink-0 border-t px-2.5 py-2.5">
      <div className="flex items-center">
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
      {showAdminDashboard && (
        <div className="mt-1.5 flex justify-center">
          <button
            type="button"
            onClick={() => navigate('/app/admin')}
            className="inline-flex h-7 items-center rounded-full border border-border-subtle/90 bg-bg-mod-subtle px-3 text-[10px] font-semibold tracking-[0.05em] text-text-secondary transition-colors hover:border-border-strong hover:bg-bg-mod-strong hover:text-text-primary"
          >
            Admin Dashboard
          </button>
        </div>
      )}
    </div>
  );
}
