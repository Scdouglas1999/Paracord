import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Hash, Volume2, ChevronDown, ChevronRight, Settings, Plus, MessageSquare, Home, Loader2, Bell } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { VoiceControls } from '../voice/VoiceControls';
import { ConnectionStatusBar } from './ConnectionStatusBar';
import { InviteModal } from '../guild/InviteModal';
import { Permissions, hasPermission, isAdmin as isGlobalAdmin, ChannelType, type Channel } from '../../types/index';
import { buildChannelGroups, isVirtualGroup } from '../../lib/features/channelGroups';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import { useVoice } from '../../hooks/useVoice';
import { usePermissions } from '../../hooks/usePermissions';
import { useUnreadCounts } from '../../hooks/useUnreadCounts';
import { VoiceParticipants } from './VoiceParticipants';
import { UserPanel } from './UserPanel';
import { Tooltip } from '../ui/Tooltip';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { writeClipboardText } from '../../lib/clipboard';
import {
  getVersionedJson,
  removeVersionedStorageItem,
  setVersionedJson,
} from '../../lib/versionedStorage';


function loadCollapsedCategories(guildId: string): Set<string> {
  try {
    const value = getVersionedJson<string[]>(
      `collapsed-cats:${guildId}`,
      [],
      [`collapsed-cats:${guildId}`],
    );
    return new Set(value);
  } catch { /* ignore */ }
  return new Set();
}

function saveCollapsedCategories(guildId: string, set: Set<string>) {
  setVersionedJson(`collapsed-cats:${guildId}`, [...set]);
}

interface GuildChannelListProps {
  guildId: string;
}

export function GuildChannelList({ guildId }: GuildChannelListProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const channels = useChannelStore((s) => s.channels);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const createChannel = useChannelStore((s) => s.createChannel);
  const guilds = useGuildStore((s) => s.guilds);
  const user = useAuthStore((s) => s.user);
  const currentGuild = guilds.find((g) => g.id === guildId);

  const { permissions, isAdmin: hasGuildAdminRole } = usePermissions(guildId);
  const canManageGuild = hasGuildAdminRole || hasPermission(permissions, Permissions.MANAGE_GUILD);
  const canCreateInvite = hasGuildAdminRole || hasPermission(permissions, Permissions.CREATE_INSTANT_INVITE);
  const canManageChannels = hasGuildAdminRole || hasPermission(permissions, Permissions.MANAGE_CHANNELS);
  const showAdminDashboardShortcut = Boolean(user && isGlobalAdmin(user.flags ?? 0));

  const { connected, channelId: activeVoiceChannelId, joinChannel, selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoice();
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);

  const mutedGuildIds = (() => {
    try {
      return getVersionedJson<string[]>('muted-guilds', [], ['muted-guilds']);
    } catch {
      return [];
    }
  })();
  const { isChannelUnread, channelMentionCounts } = useUnreadCounts(mutedGuildIds);

  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showGuildMenu, setShowGuildMenu] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [createInCategoryId, setCreateInCategoryId] = useState<string | null>(null);
  const [inlineName, setInlineName] = useState('');
  const [inlineType, setInlineType] = useState<'text' | 'voice'>('text');
  const [isInlineCreating, setIsInlineCreating] = useState(false);
  const [channelContextMenu, setChannelContextMenu] = useState<{ x: number; y: number; channelId: string } | null>(null);

  // Server-computed visible channel IDs (null = show all / not yet fetched)
  const [visibleChannelIds, setVisibleChannelIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!currentGuild) {
      setVisibleChannelIds(null);
      return;
    }
    if (hasGuildAdminRole || String(currentGuild.owner_id) === String(user?.id)) {
      setVisibleChannelIds(null);
      return;
    }

    let cancelled = false;
    channelApi
      .getVisibleChannels(guildId)
      .then(({ data }) => {
        if (cancelled) return;
        setVisibleChannelIds(new Set(data.channel_ids));
      })
      .catch(() => {
        if (!cancelled) setVisibleChannelIds(null);
      });

    return () => { cancelled = true; };
  }, [currentGuild, guildId, hasGuildAdminRole, user?.id]);

  useEffect(() => {
    if (guildId) {
      setCollapsedCategories(loadCollapsedCategories(guildId));
    }
  }, [guildId]);

  const toggleCategory = useCallback((catId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      saveCollapsedCategories(guildId, next);
      return next;
    });
  }, [guildId]);

  const handleInlineCreate = useCallback(async (parentId: string | null) => {
    if (!inlineName.trim() || isInlineCreating) return;
    setIsInlineCreating(true);
    try {
      await createChannel(guildId, {
        name: inlineName.trim(),
        channel_type: inlineType === 'voice' ? 2 : 0,
        parent_id: parentId && !isVirtualGroup(parentId) ? parentId : null,
      });
      setInlineName('');
      setCreateInCategoryId(null);
    } catch (err) {
      toast.error(`Failed to create channel: ${extractApiError(err)}`);
    } finally {
      setIsInlineCreating(false);
    }
  }, [createChannel, inlineName, inlineType, guildId, isInlineCreating]);

  const copyIdToClipboard = useCallback(async (id: string, label: string) => {
    try {
      await writeClipboardText(id);
      toast.success(`${label} ID copied.`);
    } catch (err) {
      toast.error(`Failed to copy ${label.toLowerCase()} ID: ${extractApiError(err)}`);
    }
  }, []);

  const handleChannelClick = useCallback((channel: Channel) => {
    selectChannel(channel.id);
    if ((channel.type === 2 || channel.channel_type === 2)) {
      if (!connected || activeVoiceChannelId !== channel.id) {
        void joinChannel(channel.id, guildId);
      }
    }
    navigate(`/app/guilds/${guildId}/channels/${channel.id}`);
  }, [selectChannel, connected, activeVoiceChannelId, joinChannel, guildId, navigate]);

  const visibleChannels = useMemo(() => {
    if (!visibleChannelIds) return channels;
    return channels.filter((ch) => visibleChannelIds.has(ch.id));
  }, [channels, visibleChannelIds]);

  const categoryGroups = useMemo(() => buildChannelGroups(visibleChannels), [visibleChannels]);

  const inviteChannelId =
    channels.find((c) => c.type === 0)?.id ??
    channels.find((c) => c.type !== 4)?.id ??
    null;

  if (!currentGuild) return null;

  const getTreeItems = (currentTarget: HTMLElement) => {
    const tree = currentTarget.closest('[role="tree"]');
    return Array.from(tree?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []).filter((item) => {
      if ('disabled' in item && Boolean((item as HTMLButtonElement).disabled)) return false;
      return item.tabIndex >= 0;
    });
  };

  const focusTreeItem = (currentTarget: HTMLElement, index: number) => {
    const items = getTreeItems(currentTarget);
    if (items.length === 0) return;
    const nextIndex = (index + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const handleTreeNavigation = (e: React.KeyboardEvent<HTMLElement>) => {
    const items = getTreeItems(e.currentTarget);
    const currentIndex = items.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      focusTreeItem(e.currentTarget, currentIndex >= 0 ? currentIndex + 1 : 0);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      focusTreeItem(e.currentTarget, currentIndex >= 0 ? currentIndex - 1 : items.length - 1);
      return true;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      focusTreeItem(e.currentTarget, 0);
      return true;
    }
    if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      focusTreeItem(e.currentTarget, items.length - 1);
      return true;
    }
    return false;
  };

  const handleTreeContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = getTreeItems(e.currentTarget);
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    if (activeIndex < 0) return;

    e.preventDefault();
    if (e.key === 'ArrowDown') {
      focusTreeItem(e.currentTarget, activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      focusTreeItem(e.currentTarget, activeIndex - 1);
    } else if (e.key === 'Home') {
      focusTreeItem(e.currentTarget, 0);
    } else if (e.key === 'End') {
      focusTreeItem(e.currentTarget, items.length - 1);
    }
  };

  return (
    <div className="flex h-full flex-col bg-transparent text-text-secondary">
      <div className="panel-divider shrink-0 border-b px-4 pb-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <button
            className="min-w-0 rounded-sm text-left outline-none focus-visible:shadow-[var(--focus-ring)]"
            onClick={() => setShowGuildMenu(!showGuildMenu)}
          >
            <div className="text-section uppercase text-text-muted">
              {(() => {
                if (!currentGuild.server_url) return 'Current Server';
                try { return new URL(currentGuild.server_url).host; } catch { return 'Current Server'; }
              })()}
            </div>
            <div className="mt-1 truncate text-heading text-text-primary">
              {currentGuild.name}
            </div>
          </button>
          <button
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            onClick={() => setShowGuildMenu(!showGuildMenu)}
            aria-label="Open server menu"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>

      {showGuildMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowGuildMenu(false)} />
          <div className="glass-modal animation-scale-in absolute left-5 top-[88px] z-50 w-56 origin-top-left rounded-md p-1.5">
            <button
              className={cn(
                'group flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors',
                canManageGuild
                  ? 'text-text-secondary hover:bg-accent-tint hover:text-text-primary'
                  : 'cursor-not-allowed text-text-muted opacity-60'
              )}
              disabled={!canManageGuild}
              title={canManageGuild ? 'Server Settings' : 'You need Manage Server permission'}
              onClick={() => { setShowGuildMenu(false); useUIStore.getState().setGuildSettingsId(currentGuild.id); }}
            >
              Server Settings
              <Settings size={14} className="opacity-0 group-hover:opacity-100" />
            </button>
            <button
              className={cn(
                'flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors',
                inviteChannelId && canCreateInvite
                  ? 'text-accent-primary hover:bg-accent-tint hover:text-text-primary'
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
              className="group flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-accent-tint hover:text-text-primary"
              onClick={() => {
                setShowGuildMenu(false);
                removeVersionedStorageItem(
                  `guild-welcomed:${guildId}`,
                  [`guild-welcomed:${guildId}`],
                );
                window.dispatchEvent(new CustomEvent('paracord:show-welcome', { detail: { guildId } }));
              }}
            >
              Welcome Screen
            </button>
            <div className="my-1 mx-2 h-px bg-border-subtle" />
            <button
              className="w-full rounded-sm px-3 py-2 text-left text-sm text-text-muted transition-colors hover:bg-accent-tint hover:text-text-primary"
              onClick={() => {
                void copyIdToClipboard(currentGuild.id, 'Server');
                setShowGuildMenu(false);
              }}
            >
              Copy ID
            </button>
            {user && currentGuild.owner_id !== user.id && (
              <>
                <div className="my-1 mx-2 h-px bg-border-subtle" />
                <button
                  className="w-full rounded-sm px-3 py-2 text-left text-sm text-accent-danger transition-colors hover:bg-accent-danger hover:text-white"
                  onClick={async () => {
                    setShowGuildMenu(false);
                    try {
                      await useGuildStore.getState().leaveGuild(currentGuild.id);
                      navigate('/app/friends');
                    } catch (err) {
                      toast.error(`Failed to leave server: ${extractApiError(err)}`);
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

      <div
        className="flex-1 overflow-y-auto px-2 pt-3 scrollbar-thin"
        role="tree"
        aria-label={`${currentGuild.name} channels`}
        onKeyDown={handleTreeContainerKeyDown}
      >
        {(() => {
          const isHubActive = location.pathname === `/app/guilds/${currentGuild.id}`;
          return (
            <button
              role="treeitem"
              aria-level={1}
              onClick={() => navigate(`/app/guilds/${currentGuild.id}`)}
              onKeyDown={(e) => {
                if (handleTreeNavigation(e)) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/app/guilds/${currentGuild.id}`);
                }
              }}
              className={cn(
                'group relative mb-3 mt-0.5 flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-sm px-2 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                isHubActive
                  ? 'bg-accent-tint text-text-primary'
                  : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
              )}
            >
              {isHubActive && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary" />
              )}
              <Home size={18} className={isHubActive ? 'text-accent-primary' : 'text-channel-icon'} />
              <span className={cn('truncate text-label', isHubActive ? 'font-semibold' : 'font-medium')}>
                Server Hub
              </span>
            </button>
          );
        })()}

        {categoryGroups.map((cat) => (
          <div key={cat.id} className="mb-3">
            {cat.id !== '__uncategorized__' && (
              <div className="group/cat flex w-full items-center gap-1 px-2 pb-0.5 pt-4">
                {(() => {
                  const isExpanded = !collapsedCategories.has(cat.id);
                  return (
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-section uppercase text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]"
                  onClick={() => toggleCategory(cat.id)}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={isExpanded}
                  onKeyDown={(e) => {
                    if (handleTreeNavigation(e)) return;
                    if (e.key === 'ArrowRight') {
                      e.preventDefault();
                      if (!isExpanded) toggleCategory(cat.id);
                      else {
                        const items = getTreeItems(e.currentTarget);
                        const currentIndex = items.indexOf(e.currentTarget);
                        focusTreeItem(e.currentTarget, currentIndex + 1);
                      }
                      return;
                    }
                    if (e.key === 'ArrowLeft') {
                      e.preventDefault();
                      if (isExpanded) toggleCategory(cat.id);
                      return;
                    }
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleCategory(cat.id);
                    }
                  }}
                >
                  <div>
                    {collapsedCategories.has(cat.id) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  </div>
                  <span className="truncate">{cat.name}</span>
                </button>
                  );
                })()}
                {cat.isReal && canManageChannels && (
                  <Tooltip content="Create Channel" side="top">
                    <button
                      className="flex h-5 w-5 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover/cat:opacity-100"
                      aria-label={`Create channel in ${cat.name}`}
                      title={`Create channel in ${cat.name}`}
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
            {createInCategoryId === cat.id && (
              <div className="mx-2 mb-2 mt-1 space-y-2 rounded-md border border-border-subtle bg-bg-mod-subtle p-2.5">
                <label htmlFor={`channel-name-${cat.id}`} className="sr-only">
                  Channel name
                </label>
                <input
                  id={`channel-name-${cat.id}`}
                  className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 py-1.5 text-body text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)] disabled:opacity-50"
                  placeholder="Channel name"
                  value={inlineName}
                  onChange={(e) => setInlineName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleInlineCreate(cat.id); if (e.key === 'Escape') setCreateInCategoryId(null); }}
                  autoFocus
                  disabled={isInlineCreating}
                />
                <div className="flex items-center gap-2">
                  <label htmlFor={`channel-type-${cat.id}`} className="sr-only">
                    Channel type
                  </label>
                  <select
                    id={`channel-type-${cat.id}`}
                    className="rounded-sm border border-border-subtle bg-bg-tertiary px-2 py-1.5 text-meta text-text-secondary outline-none focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)] disabled:opacity-50"
                    value={inlineType}
                    onChange={(e) => setInlineType(e.target.value as 'text' | 'voice')}
                    disabled={isInlineCreating}
                  >
                    <option value="text">Text</option>
                    <option value="voice">Voice</option>
                  </select>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-sm bg-accent-primary px-3 py-1.5 text-meta font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void handleInlineCreate(cat.id)}
                    disabled={isInlineCreating}
                  >
                    {isInlineCreating && <Loader2 size={11} className="animate-spin" />}
                    {isInlineCreating ? 'Creating...' : 'Create'}
                  </button>
                  <button
                    type="button"
                    className="rounded-sm px-2 py-1.5 text-meta text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-primary focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                    onClick={() => setCreateInCategoryId(null)}
                    disabled={isInlineCreating}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!collapsedCategories.has(cat.id) && (
              <div
                role={cat.id !== '__uncategorized__' ? 'group' : undefined}
                aria-label={cat.id !== '__uncategorized__' ? `${cat.name} channels` : undefined}
              >
                {cat.channels.map((ch) => {
                  const isSelected = selectedChannelId === ch.id;
                  const isVoice = ch.type === 2 || ch.channel_type === 2;
                  const isForum = ch.type === 7 || ch.channel_type === 7;
                  const isAnnouncement = ch.type === ChannelType.Announcement || ch.channel_type === 5;
                  const voiceMembers = isVoice ? (channelParticipants.get(ch.id) || []) : [];
                  const hasUnread = !isSelected && isChannelUnread.has(ch.id);
                  const mentionCount = channelMentionCounts.get(ch.id) || 0;
                  return (
                    <div key={ch.id}>
                      <div
                        role="treeitem"
                        tabIndex={0}
                        aria-level={cat.id === '__uncategorized__' ? 1 : 2}
                        aria-selected={isSelected}
                        onClick={() => handleChannelClick(ch)}
                        onKeyDown={(e) => {
                          if (handleTreeNavigation(e)) return;
                          if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
                            e.preventDefault();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setChannelContextMenu({
                              x: rect.left,
                              y: rect.bottom,
                              channelId: ch.id,
                            });
                            return;
                          }
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            void handleChannelClick(ch);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setChannelContextMenu({ x: e.clientX, y: e.clientY, channelId: ch.id });
                        }}
                        className={cn(
                          'group relative mb-0.5 flex h-[34px] cursor-pointer items-center gap-2 rounded-sm px-2 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                          isSelected
                            ? 'bg-accent-tint text-text-primary'
                            : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                        )}
                      >
                        {isSelected && (
                          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary" />
                        )}
                        {hasUnread && (
                          <span className="absolute -left-0.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-accent-primary" />
                        )}
                        {isVoice ? (
                          <Volume2 size={18} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-channel-icon')} />
                        ) : isForum ? (
                          <MessageSquare size={18} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-channel-icon')} />
                        ) : isAnnouncement ? (
                          <Bell size={18} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-channel-icon')} />
                        ) : (
                          <Hash size={18} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-channel-icon')} />
                        )}
                        <span className={cn(
                          'truncate text-label',
                          isSelected ? 'font-semibold' : hasUnread ? 'font-semibold text-text-primary' : 'font-medium'
                        )}>
                          {ch.name || 'unknown'}
                        </span>
                        {mentionCount > 0 && (
                          <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent-primary px-1 text-[11px] font-semibold tabular-nums text-text-on-accent">
                            {mentionCount}
                          </span>
                        )}
                        {!isVoice && canManageChannels && (
                          <div className={cn('opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100', mentionCount === 0 && 'ml-auto')}>
                            <Tooltip content="Edit Channel" side="top">
                              <span
                                role="button"
                                tabIndex={0}
                                className={cn(
                                  'inline-flex rounded-sm p-1 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]',
                                  isSelected ? 'text-accent-primary hover:bg-accent-tint-strong' : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-primary'
                                )}
                                aria-label={`Edit ${ch.name || 'channel'}`}
                                title={`Edit ${ch.name || 'channel'}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  useUIStore.getState().openGuildSettings(guildId, 'channels', ch.id);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    useUIStore.getState().openGuildSettings(guildId, 'channels', ch.id);
                                  }
                                }}
                              >
                                <Settings size={14} />
                              </span>
                            </Tooltip>
                          </div>
                        )}
                      </div>
                      <VoiceParticipants
                        channel={ch}
                        participants={voiceMembers}
                        speakingUsers={speakingUsers}
                        guildId={guildId}
                        selectedGuildId={guildId}
                        navigate={navigate}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {channels.length === 0 && (
          <EmptyState
            className="px-2"
            icon={<Hash size={20} />}
            title="No channels yet"
            description={
              canManageChannels
                ? 'Create your first channel to give this server a place to talk.'
                : 'An admin hasn’t set up any channels here yet — check back soon.'
            }
            action={
              canManageChannels ? (
                <Button
                  size="sm"
                  onClick={() => useUIStore.getState().openGuildSettings(guildId, 'channels')}
                >
                  <Plus size={16} className="mr-1.5" />
                  Create a channel
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      <ConnectionStatusBar />
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
      {channelContextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setChannelContextMenu(null)} />
          <div
            className="glass-modal fixed z-50 min-w-[160px] rounded-md p-1.5"
            style={{ left: channelContextMenu.x + 10, top: channelContextMenu.y }}
            role="menu"
            aria-label="Channel actions"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setChannelContextMenu(null);
              }
            }}
          >
            <button
              autoFocus
              role="menuitem"
              className="w-full rounded-sm px-3 py-2 text-left text-sm text-text-muted transition-colors hover:bg-accent-tint hover:text-text-primary"
              onClick={() => {
                void copyIdToClipboard(channelContextMenu.channelId, 'Channel');
                setChannelContextMenu(null);
              }}
            >
              Copy ID
            </button>
          </div>
        </>
      )}
    </div>
  );
}
