import { useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { useServerListStore } from '../../stores/serverListStore';
import { channelApi } from '../../api/channels';
import { CreateGuildModal } from '../guild/CreateGuildModal';
import { InviteModal } from '../guild/InviteModal';
import { usePermissions } from '../../hooks/usePermissions';
import { useUnreadCounts } from '../../hooks/useUnreadCounts';
import { Permissions, hasPermission } from '../../types';
import type { Guild } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { isSafeImageDataUrl } from '../../lib/security';
import { getGuildColor } from '../../lib/colors';

export function Sidebar() {
  const guilds = useGuildStore((s) => s.guilds);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const user = useAuthStore((s) => s.user);
  const dockPinned = useUIStore((s) => s.dockPinned);
  const toggleDockPinned = useUIStore((s) => s.toggleDockPinned);
  const navigate = useNavigate();
  const location = useLocation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [dockHover, setDockHover] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guildId: string } | null>(null);
  const [inviteForGuild, setInviteForGuild] = useState<{ guildName: string; channelId: string } | null>(null);
  const [mutedGuildIds, setMutedGuildIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('paracord:muted-guilds');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

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
    if (!isMultiServer) return null; // single server — no grouping needed

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
    const channels = useChannelStore.getState().channelsByGuild[guild.id] || [];
    const firstChannel = channels.find(c => c.type === 0) || channels.find(c => c.type !== 4) || channels[0];
    if (firstChannel) {
      useChannelStore.getState().selectChannel(firstChannel.id);
      navigate(`/app/guilds/${guild.id}/channels/${firstChannel.id}`);
    } else {
      navigate(`/app/guilds/${guild.id}/settings`);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, guildId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, guildId });
  };

  const renderGuildIcon = (guild: Guild) => {
    const isActive = selectedGuildId === guild.id;
    const unreadInfo = guildUnreads.get(guild.id);
    const hasUnread = Boolean(unreadInfo && unreadInfo.unreadCount > 0);
    const hasMentions = Boolean(unreadInfo && unreadInfo.mentionCount > 0);
    const iconSrc = guild.icon_hash
      ? guild.icon_hash.startsWith('data:')
        ? (isSafeImageDataUrl(guild.icon_hash) ? guild.icon_hash : null)
        : `/api/v1/guilds/${guild.id}/icon`
      : null;
    return (
      <div key={guild.id} className="relative flex shrink-0 items-center justify-center">
        {!isActive && hasUnread && (
          <div
            className={cn(
              'absolute -left-1 rounded-r-full bg-white transition-all duration-200',
              hasMentions ? 'h-5 w-1.5' : 'h-2.5 w-1.5'
            )}
          />
        )}
        <Tooltip side="right" content={guild.name}>
          <button
            onClick={() => handleGuildClick(guild)}
            onContextMenu={(e) => handleContextMenu(e, guild.id)}
            className={cn(
              'group relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl transition-all duration-200',
              isActive
                ? 'sidebar-item-active z-10 bg-accent-primary text-white'
                : 'bg-white/10 text-white/75 hover:-translate-y-0.5 hover:bg-white/20 hover:text-white'
            )}
            style={!iconSrc && !isActive ? { backgroundColor: 'rgba(255,255,255,0.1)' } : undefined}
          >
            {!iconSrc && isActive && (
              <div className="absolute inset-0 opacity-25" style={{ backgroundColor: getGuildColor(guild.id) }} />
            )}
            {iconSrc ? (
              <img
                src={iconSrc}
                alt={guild.name}
                className={cn(
                  'h-full w-full object-cover transition-transform duration-300',
                  isActive ? 'scale-105' : 'group-hover:scale-105'
                )}
              />
            ) : (
              <span
                className={cn(
                  'text-[12px] font-bold transition-colors duration-150',
                  isActive ? 'text-white' : 'text-white/80 group-hover:text-white'
                )}
              >
                {guild.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
              </span>
            )}
            {hasMentions && !isActive && (
              <span className="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-danger px-1 text-[9px] font-bold text-white shadow-sm">
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
            'dock-surface relative z-30 flex h-full max-h-[780px] flex-col items-center gap-3 px-1.5 py-3 transition-[width,transform] duration-200',
            dockExpanded ? 'w-[60px]' : 'w-[18px] translate-x-1'
          )}
        >
          {!dockExpanded && (
            <div className="mt-2 h-10 w-1.5 rounded-full bg-white/28" />
          )}
          {dockExpanded && (
            <>
          {/* Home Button */}
          <Tooltip side="right" content="Home">
            <button
              onClick={() => {
                selectGuild(null);
                useChannelStore.getState().selectGuild(null);
                navigate('/app');
              }}
              className={cn(
                'group flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-all duration-200',
                isHome
                  ? 'bg-accent-primary text-white shadow-[0_10px_24px_rgba(var(--accent-primary-rgb),0.35)]'
                  : 'bg-white/10 text-white/75 hover:-translate-y-0.5 hover:bg-white/20 hover:text-white'
              )}
            >
              <Home size={20} className={cn('transition-transform duration-200', isHome ? 'scale-100' : 'group-hover:scale-105')} />
            </button>
          </Tooltip>

          <div className="h-px w-6 shrink-0 bg-white/20" />

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
              // Single server: flat list
              guilds.map((guild) => renderGuildIcon(guild))
            )}

            <div className="mt-auto flex flex-col items-center gap-2 pt-1">
              {/* Multi-server count indicator */}
              {serverGroups && serverGroups.length > 1 && (
                <Tooltip side="right" content={`Connected to ${serverGroups.length} servers`}>
                  <div className="flex items-center justify-center rounded-lg bg-white/8 px-2 py-1">
                    <span className="text-[9px] font-bold uppercase tracking-wider text-white/50">
                      {serverGroups.length} srv
                    </span>
                  </div>
                </Tooltip>
              )}

              <Tooltip side="right" content="Add a Server">
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-dashed border-white/35 bg-white/5 text-white/75 transition-all duration-200 hover:-translate-y-0.5 hover:border-white hover:bg-white/20 hover:text-white"
                >
                  <Plus size={19} className="transition-transform duration-200 group-hover:rotate-90" />
                </button>
              </Tooltip>

              <Tooltip side="right" content="User Settings">
                <button
                  onClick={() => navigate('/app/settings')}
                  className="group relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white/10 transition-all duration-200 hover:-translate-y-0.5 hover:bg-white"
                >
                  {user?.username ? (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent-primary to-accent-primary-hover text-sm font-bold text-white">
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-bg-mod-strong text-sm font-bold text-text-muted">U</div>
                  )}
                </button>
              </Tooltip>

              <Tooltip side="right" content={dockPinned ? 'Unpin server dock (hover to reveal)' : 'Pin server dock'}>
                <button
                  onClick={toggleDockPinned}
                  className={cn(
                    'mt-1 flex h-7 w-7 items-center justify-center rounded-lg border border-transparent text-white/45 transition-all duration-200 hover:bg-white/12 hover:text-white/85',
                    dockPinned && 'bg-white/12 text-white/80'
                  )}
                >
                  {dockPinned ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
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
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="glass-modal fixed z-50 min-w-[200px] rounded-xl p-1.5"
            style={{ left: contextMenu.x + 10, top: contextMenu.y }}
          >
            <button
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
              className="w-full rounded-md px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
              onClick={() => {
                const gid = contextMenu.guildId;
                const next = mutedGuildIds.includes(gid)
                  ? mutedGuildIds.filter((id) => id !== gid)
                  : [...mutedGuildIds, gid];
                setMutedGuildIds(next);
                try {
                  localStorage.setItem('paracord:muted-guilds', JSON.stringify(next));
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
            {user && guilds.find(g => g.id === contextMenu.guildId)?.owner_id !== user.id && (
              <>
                <div className="my-1.5 mx-2 h-px bg-border-subtle" />
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-accent-danger transition-colors hover:bg-accent-danger hover:text-white"
                  onClick={async () => {
                    try {
                      await useGuildStore.getState().leaveGuild(contextMenu.guildId);
                      setContextMenu(null);
                      navigate('/app');
                    } catch {
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
    </>
  );
}
