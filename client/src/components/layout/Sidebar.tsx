import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Plus, PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronRight, FolderPlus } from 'lucide-react';

import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { useServerListStore } from '../../stores/serverListStore';
import { useFolderStore } from '../../stores/folderStore';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import { CreateGuildModal } from '../guild/CreateGuildModal';
import { InviteModal } from '../guild/InviteModal';
import { usePermissions } from '../../hooks/usePermissions';
import { useUnreadCounts } from '../../hooks/useUnreadCounts';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Permissions, hasPermission } from '../../types';
import type { Guild } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { safeStoredImageDataUrl } from '../../lib/security';
import { writeClipboardText } from '../../lib/clipboard';
import { getVersionedJson, setVersionedJson } from '../../lib/versionedStorage';
import { toast } from '../../stores/toastStore';

export function Sidebar() {
  const guilds = useGuildStore((s) => s.guilds);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const user = useAuthStore((s) => s.user);
  const dockPinned = useUIStore((s) => s.dockPinned);
  const toggleDockPinned = useUIStore((s) => s.toggleDockPinned);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const navigate = useNavigate();
  const location = useLocation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [dockHover, setDockHover] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guildId: string } | null>(null);
  const [inviteForGuild, setInviteForGuild] = useState<{ guildName: string; channelId: string } | null>(null);
  const [mutedGuildIds, setMutedGuildIds] = useState<string[]>(() => {
    try {
      return getVersionedJson<string[]>('muted-guilds', [], ['muted-guilds']);
    } catch {
      return [];
    }
  });

  const folders = useFolderStore((s) => s.folders);
  const createFolder = useFolderStore((s) => s.createFolder);
  const addGuildToFolder = useFolderStore((s) => s.addGuildToFolder);
  const removeGuildFromFolder = useFolderStore((s) => s.removeGuildFromFolder);
  const toggleCollapsed = useFolderStore((s) => s.toggleCollapsed);
  const [folderSubmenuOpen, setFolderSubmenuOpen] = useState(false);
  const [createFolderName, setCreateFolderName] = useState('');
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const folderSubmenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const folderChoiceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const serverMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const createFolderDialogRef = useRef<HTMLDivElement | null>(null);

  const servers = useServerListStore((s) => s.servers);
  const isHome = location.pathname === '/app' || location.pathname === '/app/friends';
  const dockExpanded = dockPinned || dockHover;
  const { guildUnreads } = useUnreadCounts(mutedGuildIds);
  const { permissions: contextPermissions, isAdmin: contextIsAdmin } = usePermissions(contextMenu?.guildId || null);
  const canCreateInviteInContext =
    contextIsAdmin || hasPermission(contextPermissions, Permissions.CREATE_INSTANT_INVITE);

  // Group guilds by server when connected to multiple servers
  const serverGroups = useMemo(() => {
    const urlSet = new Set(guilds.map((g) => g.server_url || '').filter(Boolean));
    const isMultiServer = urlSet.size > 1;
    if (!isMultiServer) return null; // single server; no grouping needed

    const groups: { label: string; url: string; guilds: Guild[] }[] = [];
    const byUrl = new Map<string, Guild[]>();
    for (const g of guilds) {
      const url = g.server_url || '';
      const list = byUrl.get(url) || [];
      list.push(g);
      byUrl.set(url, list);
    }
    for (const [url, guildList] of byUrl) {
      // Look up friendly name from serverListStore, fall back to hostname
      const server = servers.find((s) => s.url === url);
      let label = server?.name || '';
      if (!label) {
        try { label = new URL(url).host; } catch { label = url || 'Local'; }
      }
      groups.push({ label, url, guilds: guildList });
    }
    return groups;
  }, [guilds, servers]);

  const handleGuildClick = async (guild: { id: string }) => {
    selectGuild(guild.id);
    await useChannelStore.getState().selectGuild(guild.id);
    await useChannelStore.getState().fetchChannels(guild.id);
    // Route to the new Server Hub layout instead of auto-selecting the first text channel
    navigate(`/app/guilds/${guild.id}`);
  };

  const handleContextMenu = (e: React.MouseEvent, guildId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, guildId });
  };

  const handleGuildContextMenuKey = (e: React.KeyboardEvent<HTMLButtonElement>, guildId: string) => {
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      setContextMenu({ x: rect.left, y: rect.bottom, guildId });
    }
  };

  const copyServerIdToClipboard = useCallback(async (guildId: string) => {
    try {
      await writeClipboardText(guildId);
      toast.success('Server ID copied.');
    } catch (err) {
      toast.error(`Failed to copy server ID: ${extractApiError(err)}`);
    }
  }, []);

  const closeCreateFolderDialog = useCallback(() => {
    setShowCreateFolder(false);
    setCreateFolderName('');
  }, []);

  useFocusTrap(createFolderDialogRef, showCreateFolder, closeCreateFolderDialog);

  const focusFolderChoice = (index: number) => {
    const choices = folderChoiceRefs.current.filter((item): item is HTMLButtonElement => item != null);
    if (choices.length === 0) return;
    const nextIndex = (index + choices.length) % choices.length;
    choices[nextIndex]?.focus();
  };

  const openFolderSubmenu = () => {
    setFolderSubmenuOpen(true);
    window.setTimeout(() => focusFolderChoice(0), 0);
  };

  const closeFolderSubmenu = (focusTrigger = false) => {
    setFolderSubmenuOpen(false);
    if (focusTrigger) {
      window.setTimeout(() => folderSubmenuTriggerRef.current?.focus(), 0);
    }
  };

  const handleFolderSubmenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const choices = folderChoiceRefs.current.filter((item): item is HTMLButtonElement => item != null);
    const activeIndex = choices.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      closeFolderSubmenu(true);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      focusFolderChoice(activeIndex >= 0 ? activeIndex + 1 : 0);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      focusFolderChoice(activeIndex >= 0 ? activeIndex - 1 : choices.length - 1);
      return;
    }

    if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      focusFolderChoice(0);
      return;
    }

    if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      focusFolderChoice(choices.length - 1);
    }
  };

  const focusServerMenuItem = (index: number) => {
    const items = serverMenuItemRefs.current.filter(
      (item): item is HTMLButtonElement => item != null && !item.disabled,
    );
    if (items.length === 0) return;
    const nextIndex = (index + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const handleServerMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = serverMenuItemRefs.current.filter(
      (item): item is HTMLButtonElement => item != null && !item.disabled,
    );
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === 'Escape') {
      e.preventDefault();
      setContextMenu(null);
      setFolderSubmenuOpen(false);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusServerMenuItem(activeIndex >= 0 ? activeIndex + 1 : 0);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusServerMenuItem(activeIndex >= 0 ? activeIndex - 1 : items.length - 1);
      return;
    }

    if (e.key === 'Home') {
      e.preventDefault();
      focusServerMenuItem(0);
      return;
    }

    if (e.key === 'End') {
      e.preventDefault();
      focusServerMenuItem(items.length - 1);
    }
  };

  const renderGuildIcon = (guild: Guild) => {
    const isActive = selectedGuildId === guild.id;
    const unreadInfo = guildUnreads.get(guild.id);
    const hasUnread = Boolean(unreadInfo && unreadInfo.unreadCount > 0);
    const hasMentions = Boolean(unreadInfo && unreadInfo.mentionCount > 0);
    const iconSrc = safeStoredImageDataUrl(guild.icon_hash);
    return (
      <div key={guild.id} className="relative flex shrink-0 items-center justify-center">
        {/* Left-edge indicator: teal pill when active, emerald dot when unread (§7). */}
        {isActive ? (
          <span className="absolute -left-2 h-6 w-1 rounded-r-full bg-accent-secondary transition-all duration-[180ms]" />
        ) : hasUnread ? (
          <span
            className={cn(
              'absolute -left-2 w-1 rounded-r-full bg-accent-primary transition-all duration-[180ms]',
              hasMentions ? 'h-5' : 'h-2.5'
            )}
          />
        ) : null}
        <Tooltip side="right" content={guild.name}>
          <button
            onClick={() => handleGuildClick(guild)}
            onContextMenu={(e) => handleContextMenu(e, guild.id)}
            onKeyDown={(e) => handleGuildContextMenuKey(e, guild.id)}
            aria-label={guild.name}
            className={cn(
              // Guild icon recipe: 48px, idle radius-full morphing to radius-md
              // squircle on hover/active over 180ms; press scales, never lifts.
              'group relative flex h-12 w-12 items-center justify-center overflow-hidden outline-none transition-[border-radius,background-color,color,box-shadow] duration-[180ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]',
              isActive
                ? 'z-10 rounded-md ring-2 ring-accent-primary'
                : 'rounded-full hover:rounded-md',
              !iconSrc &&
                (isActive
                  ? 'bg-accent-tint text-accent-primary'
                  : 'bg-white/10 text-white/80 hover:bg-accent-tint hover:text-accent-primary')
            )}
          >
            {iconSrc ? (
              <img
                src={iconSrc}
                alt={guild.name}
                className={cn(
                  'h-full w-full object-cover transition-transform duration-[180ms] ease-[var(--ease-out)]',
                  isActive ? 'scale-105' : 'group-hover:scale-105'
                )}
              />
            ) : (
              <span className="text-meta font-bold">
                {guild.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
              </span>
            )}
            {hasMentions && !isActive && (
              <span className="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-primary px-1 text-[9px] font-semibold tabular-nums text-text-on-accent ring-2 ring-bg-tertiary">
                {unreadInfo!.mentionCount > 99 ? '99+' : unreadInfo!.mentionCount}
              </span>
            )}
          </button>
        </Tooltip>
      </div>
    );
  };

  return (
    <>
      <div
        className="flex h-full items-center justify-center py-2"
        onMouseEnter={() => { if (!dockPinned) setDockHover(true); }}
        onMouseLeave={() => { if (!dockPinned) setDockHover(false); }}
        onFocus={(e) => {
          // Expand dock when keyboard focus enters
          if (!dockPinned && e.currentTarget.contains(e.target as Node)) {
            setDockHover(true);
          }
        }}
        onBlur={(e) => {
          // Collapse when keyboard focus leaves the dock
          if (!dockPinned && !e.currentTarget.contains(e.relatedTarget as Node)) {
            setDockHover(false);
          }
        }}
      >
        <nav
          aria-label="Server dock"
          aria-expanded={dockExpanded}
          className={cn(
            'dock-surface relative z-30 flex h-full max-h-[780px] flex-col items-center gap-4 px-2 py-4 transition-[width,transform] duration-200',
            dockExpanded ? 'w-[60px]' : 'w-[18px] translate-x-1'
          )}
        >
          {!dockExpanded && (
            <div className="mt-2 h-10 w-1.5 rounded-full bg-white/28" />
          )}
          {dockExpanded && (
            <>
              {/* Home Button — active destination gets a solid emerald squircle (§1.2). */}
              <div className="relative flex shrink-0 items-center justify-center">
                {isHome && (
                  <span className="absolute -left-2 h-6 w-1 rounded-r-full bg-accent-secondary transition-all duration-[180ms]" />
                )}
                <Tooltip side="right" content="Home">
                  <button
                    aria-label="Home"
                    onClick={() => {
                      selectGuild(null);
                      useChannelStore.getState().selectGuild(null);
                      navigate('/app');
                    }}
                    className={cn(
                      'group flex h-12 w-12 shrink-0 items-center justify-center outline-none transition-[border-radius,background-color,color] duration-[180ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]',
                      isHome
                        ? 'rounded-md bg-accent-primary text-text-on-accent shadow-sm'
                        : 'rounded-full bg-white/10 text-white/80 hover:rounded-md hover:bg-accent-tint hover:text-accent-primary'
                    )}
                  >
                    <Home size={20} />
                  </button>
                </Tooltip>
              </div>

              <div className="h-px w-6 shrink-0 bg-white/15" />

              {/* Guild List */}
              <div className="flex w-full flex-1 flex-col items-center gap-2 overflow-x-visible overflow-y-auto pb-1 pt-1.5 scrollbar-none">
                {serverGroups ? (
                  // Multi-server: group guilds under server labels
                  serverGroups.map((group, gi) => (
                    <div key={group.url} className="flex w-full flex-col items-center gap-2">
                      {gi > 0 && <div className="h-px w-6 shrink-0 bg-white/15" />}
                      <Tooltip side="right" content={group.label}>
                        <div className="w-10 truncate text-center text-[9px] font-bold uppercase tracking-wider text-white/40">
                          {group.label}
                        </div>
                      </Tooltip>
                      {group.guilds.map((guild) => renderGuildIcon(guild))}
                    </div>
                  ))
                ) : (
                  // Single server: folder-grouped + ungrouped guilds
                  (() => {
                    const folderedIds = new Set(folders.flatMap((f) => f.guildIds));
                    const ungrouped = guilds.filter((g) => !folderedIds.has(g.id));
                    return (
                      <>
                        {folders.map((folder) => {
                          const folderGuilds = folder.guildIds
                            .map((id) => guilds.find((g) => g.id === id))
                            .filter((g): g is Guild => g != null);
                          if (folderGuilds.length === 0) return null;
                          return (
                            <div key={folder.id} className="flex w-full flex-col items-center gap-1">
                              <Tooltip side="right" content={folder.name}>
                                <button
                                  aria-label={`${folder.collapsed ? 'Expand' : 'Collapse'} folder ${folder.name}`}
                                  onClick={() => toggleCollapsed(folder.id)}
                                  className="flex w-11 items-center justify-center gap-0.5 rounded-lg py-0.5 transition-colors hover:bg-white/10"
                                >
                                  {folder.color && (
                                    <div
                                      className="h-2 w-2 shrink-0 rounded-full"
                                      style={{ backgroundColor: folder.color }}
                                    />
                                  )}
                                  {folder.collapsed ? (
                                    <ChevronRight size={12} className="shrink-0 text-white/50" />
                                  ) : (
                                    <ChevronDown size={12} className="shrink-0 text-white/50" />
                                  )}
                                </button>
                              </Tooltip>
                              {folder.collapsed ? (
                                // Stacked icons preview
                                <Tooltip side="right" content={`${folder.name} (${folderGuilds.length} servers)`}>
                                  <button
                                    aria-label={`Expand folder ${folder.name} with ${folderGuilds.length} servers`}
                                    onClick={() => toggleCollapsed(folder.id)}
                                    className="relative flex h-11 w-11 items-center justify-center"
                                  >
                                    {folderGuilds.slice(0, 4).map((g, i) => (
                                      <div
                                        key={g.id}
                                        className="absolute rounded-md bg-white/15 border border-white/10"
                                        style={{
                                          width: 20,
                                          height: 20,
                                          top: i < 2 ? 2 : 22,
                                          left: i % 2 === 0 ? 4 : 24,
                                          overflow: 'hidden',
                                        }}
                                      >
                                        {g.icon_hash ? (
                                          (() => {
                                            const iconSrc = safeStoredImageDataUrl(g.icon_hash);
                                            return iconSrc ? (
                                              <img
                                                src={iconSrc}
                                                alt=""
                                                className="h-full w-full object-cover"
                                              />
                                            ) : (
                                              <span className="flex h-full w-full items-center justify-center text-[7px] font-bold text-white/80">
                                                {g.name.charAt(0).toUpperCase()}
                                              </span>
                                            );
                                          })()
                                        ) : (
                                          <span className="flex h-full w-full items-center justify-center text-[7px] font-bold text-white/80">
                                            {g.name.charAt(0).toUpperCase()}
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </button>
                                </Tooltip>
                              ) : (
                                folderGuilds.map((guild) => renderGuildIcon(guild))
                              )}
                              <div className="h-px w-6 shrink-0 bg-white/10" />
                            </div>
                          );
                        })}
                        {ungrouped.map((guild) => renderGuildIcon(guild))}
                      </>
                    );
                  })()
                )}

                <div className="mt-auto flex flex-col items-center gap-2 pt-1">
                  {/* Multi-server count indicator */}
                  {serverGroups && serverGroups.length > 1 && (
                    <Tooltip side="right" content={`Connected to ${serverGroups.length} servers`}>
                      <div className="flex items-center justify-center rounded-xs bg-white/8 px-2 py-1">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-white/50">
                          {serverGroups.length} srv
                        </span>
                      </div>
                    </Tooltip>
                  )}

                  <Tooltip side="right" content="Add a Server">
                    <button
                      aria-label="Add a server"
                      onClick={() => setShowCreateModal(true)}
                      className="group flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-dashed border-white/30 text-status-online outline-none transition-[border-radius,background-color,border-color] duration-[180ms] ease-[var(--ease-out)] hover:rounded-md hover:border-accent-primary hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]"
                    >
                      <Plus size={20} />
                    </button>
                  </Tooltip>

                  <Tooltip
                    side="right"
                    content={
                      connectionStatus === 'reconnecting'
                        ? 'Reconnecting...'
                        : connectionStatus === 'disconnected'
                        ? 'Disconnected'
                        : 'User Settings'
                    }
                  >
                    <button
                      onClick={() => useUIStore.getState().setUserSettingsOpen(true)}
                      aria-label="Open user settings"
                      className="group relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full outline-none transition-[border-radius] duration-[180ms] ease-[var(--ease-out)] hover:rounded-md focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]"
                    >
                      {user?.username ? (
                        <div className="flex h-full w-full items-center justify-center bg-accent-primary text-sm font-semibold text-text-on-accent">
                          {user.username.charAt(0).toUpperCase()}
                        </div>
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-bg-mod-strong text-sm font-semibold text-text-muted">U</div>
                      )}
                      {(connectionStatus === 'reconnecting' || connectionStatus === 'disconnected') && (
                        <span
                          className={cn(
                            'absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full ring-2 ring-bg-tertiary',
                            connectionStatus === 'reconnecting'
                              ? 'animate-pulse bg-accent-warning'
                              : 'bg-accent-danger'
                          )}
                        />
                      )}
                    </button>
                  </Tooltip>

                  <Tooltip side="right" content={dockPinned ? 'Unpin server dock (hover to reveal)' : 'Pin server dock'}>
                    <button
                      onClick={toggleDockPinned}
                      aria-label={dockPinned ? 'Unpin server dock' : 'Pin server dock'}
                      className={cn(
                        'mt-1 flex h-7 w-7 items-center justify-center rounded-sm text-white/45 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-white/12 hover:text-white/85 focus-visible:shadow-[var(--focus-ring)]',
                        dockPinned && 'bg-white/12 text-white/80'
                      )}
                    >
                      {dockPinned ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
                    </button>
                  </Tooltip>
                </div>
              </div>
            </>
          )}
        </nav>
      </div>

      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => { setContextMenu(null); setFolderSubmenuOpen(false); }} />
          <div
            className="glass-modal fixed z-50 min-w-[200px] rounded-xl p-1.5"
            style={{ left: contextMenu.x + 10, top: contextMenu.y }}
            role="menu"
            aria-label="Server actions"
            tabIndex={-1}
            onKeyDown={handleServerMenuKeyDown}
          >
            <button
              ref={(node) => {
                serverMenuItemRefs.current[0] = node;
              }}
              autoFocus
              role="menuitem"
              className="w-full rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
              onClick={async () => {
                const gid = contextMenu.guildId;
                if (!useChannelStore.getState().channelsByGuild[gid]?.length) {
                  await useChannelStore.getState().fetchChannels(gid);
                }
                const channels = useChannelStore.getState().channelsByGuild[gid] || [];
                await Promise.all(
                  channels
                    .filter((c) => c.type !== 4)
                    .map((c) => channelApi.updateReadState(c.id, c.last_message_id || undefined).catch(() => undefined))
                );
                setContextMenu(null);
              }}
            >
              Mark As Read
            </button>
            <button
              ref={(node) => {
                serverMenuItemRefs.current[1] = node;
              }}
              role="menuitem"
              className="w-full rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
              onClick={() => {
                const gid = contextMenu.guildId;
                const next = mutedGuildIds.includes(gid)
                  ? mutedGuildIds.filter((id) => id !== gid)
                  : [...mutedGuildIds, gid];
                setMutedGuildIds(next);
                try {
                  setVersionedJson('muted-guilds', next);
                  window.dispatchEvent(new CustomEvent('paracord-muted-guilds-updated'));
                } catch {
                  /* ignore */
                }
                setContextMenu(null);
              }}
            >
              {mutedGuildIds.includes(contextMenu.guildId) ? 'Unmute Server' : 'Mute Server'}
            </button>
            <button
              ref={(node) => {
                serverMenuItemRefs.current[2] = node;
              }}
              role="menuitem"
              className={cn(
                'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                canCreateInviteInContext
                  ? 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                  : 'cursor-not-allowed text-text-muted opacity-60'
              )}
              disabled={!canCreateInviteInContext}
              title={canCreateInviteInContext ? 'Invite People' : 'You need Create Invite permission'}
              onClick={async () => {
                const guild = guilds.find((g) => g.id === contextMenu.guildId);
                if (!guild) return;
                if (!canCreateInviteInContext) {
                  setContextMenu(null);
                  return;
                }
                if (!useChannelStore.getState().channelsByGuild[guild.id]?.length) {
                  await useChannelStore.getState().fetchChannels(guild.id);
                }
                const guildChannels = useChannelStore.getState().channelsByGuild[guild.id] || [];
                const firstText = guildChannels.find((c) => c.type === 0);
                if (firstText) {
                  setInviteForGuild({ guildName: guild.name, channelId: firstText.id });
                }
                setContextMenu(null);
              }}
            >
              Invite People
            </button>
            <div className="my-1.5 mx-2 h-px bg-border-subtle" />
            {/* Folder options */}
            {(() => {
              const gid = contextMenu.guildId;
              const containingFolder = folders.find((f) => f.guildIds.includes(gid));
              return (
                <>
                  {containingFolder ? (
                    <button
                      ref={(node) => {
                        serverMenuItemRefs.current[3] = node;
                      }}
                      role="menuitem"
                      className="w-full rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                      onClick={() => {
                        removeGuildFromFolder(containingFolder.id, gid);
                        setContextMenu(null);
                      }}
                    >
                      Remove from {containingFolder.name}
                    </button>
                  ) : null}
                  <div className="relative">
                    <button
                      ref={(node) => {
                        folderSubmenuTriggerRef.current = node;
                        serverMenuItemRefs.current[4] = node;
                      }}
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={folderSubmenuOpen}
                      className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                      onClick={() => {
                        if (folderSubmenuOpen) {
                          closeFolderSubmenu();
                        } else {
                          openFolderSubmenu();
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openFolderSubmenu();
                        }
                      }}
                    >
                      <span>Add to Folder</span>
                      <ChevronRight size={14} className="text-text-muted" />
                    </button>
                    {folderSubmenuOpen && (
                      <div
                        className="glass-modal absolute left-full top-0 z-50 ml-1 min-w-[160px] rounded-xl p-1.5"
                        role="menu"
                        aria-label="Folder choices"
                        tabIndex={-1}
                        onKeyDown={handleFolderSubmenuKeyDown}
                      >
                        {folders.map((f, folderIndex) => (
                          <button
                            key={f.id}
                            ref={(node) => {
                              folderChoiceRefs.current[folderIndex] = node;
                            }}
                            role="menuitem"
                            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                            onClick={() => {
                              addGuildToFolder(f.id, gid);
                              closeFolderSubmenu();
                              setContextMenu(null);
                            }}
                          >
                            {f.color && (
                              <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: f.color }} />
                            )}
                            <span className="truncate">{f.name}</span>
                          </button>
                        ))}
                        {folders.length > 0 && <div className="my-1 mx-2 h-px bg-border-subtle" />}
                        <button
                          ref={(node) => {
                            folderChoiceRefs.current[folders.length] = node;
                          }}
                          role="menuitem"
                          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                          onClick={() => {
                            closeFolderSubmenu();
                            setShowCreateFolder(true);
                          }}
                        >
                          <FolderPlus size={14} />
                          <span>New Folder</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    ref={(node) => {
                      serverMenuItemRefs.current[5] = node;
                    }}
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                    onClick={() => {
                      setShowCreateFolder(true);
                      setContextMenu(null);
                    }}
                  >
                    <FolderPlus size={14} />
                    <span>Create Folder</span>
                  </button>
                </>
              );
            })()}
            <div className="my-1.5 mx-2 h-px bg-border-subtle" />
            <button
              ref={(node) => {
                serverMenuItemRefs.current[6] = node;
              }}
              role="menuitem"
              className="w-full rounded-md px-3 py-2 text-left text-sm text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
              onClick={() => {
                void copyServerIdToClipboard(contextMenu.guildId);
                setContextMenu(null);
              }}
            >
              Copy ID
            </button>
            {user && guilds.find(g => g.id === contextMenu.guildId)?.owner_id !== user.id && (
              <>
                <div className="my-1.5 mx-2 h-px bg-border-subtle" />
                <button
                  ref={(node) => {
                    serverMenuItemRefs.current[7] = node;
                  }}
                  role="menuitem"
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-accent-danger transition-colors hover:bg-accent-danger hover:text-white"
                  onClick={async () => {
                    try {
                      await useGuildStore.getState().leaveGuild(contextMenu.guildId);
                      setContextMenu(null);
                      navigate('/app');
                    } catch (err) {
                      toast.error(`Failed to leave server: ${extractApiError(err)}`);
                      setContextMenu(null);
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

      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
      {inviteForGuild && (
        <InviteModal
          guildName={inviteForGuild.guildName}
          channelId={inviteForGuild.channelId}
          onClose={() => setInviteForGuild(null)}
        />
      )}
      {showCreateFolder && (
        <>
          <div className="fixed inset-0 z-50 bg-black/50" onClick={closeCreateFolderDialog} />
          <div
            ref={createFolderDialogRef}
            className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-strong bg-bg-accent p-5 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-folder-title"
            tabIndex={-1}
          >
            <h3 id="create-folder-title" className="mb-3 text-subhead text-text-primary">Create Folder</h3>
            <input
              autoFocus
              type="text"
              placeholder="Folder name"
              value={createFolderName}
              onChange={(e) => setCreateFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && createFolderName.trim()) {
                  createFolder(createFolderName.trim());
                  setCreateFolderName('');
                  setShowCreateFolder(false);
                }
              }}
              className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] placeholder:text-text-muted focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)]"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-sm px-3 py-1.5 text-label text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                onClick={closeCreateFolderDialog}
              >
                Cancel
              </button>
              <button
                disabled={!createFolderName.trim()}
                className="rounded-sm bg-accent-primary px-3 py-1.5 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                onClick={() => {
                  if (createFolderName.trim()) {
                    createFolder(createFolderName.trim());
                    setCreateFolderName('');
                    setShowCreateFolder(false);
                  }
                }}
              >
                Create
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
