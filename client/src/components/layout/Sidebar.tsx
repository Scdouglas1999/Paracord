import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Plus, PanelLeftClose, PanelLeftOpen, Shield } from 'lucide-react';

import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { channelApi } from '../../api/channels';
import { CreateGuildModal } from '../guild/CreateGuildModal';
import { InviteModal } from '../guild/InviteModal';
import { usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission, isAdmin } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { isSafeImageDataUrl } from '../../lib/security';

const GUILD_COLORS = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245',
  '#3ba55c', '#faa61a', '#e67e22', '#e91e63', '#1abc9c',
];

function getGuildColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return GUILD_COLORS[Math.abs(hash) % GUILD_COLORS.length];
}

export function Sidebar() {
  const guilds = useGuildStore((s) => s.guilds);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const user = useAuthStore((s) => s.user);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const navigate = useNavigate();
  const location = useLocation();
  const [showCreateModal, setShowCreateModal] = useState(false);
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

  const isHome = location.pathname === '/app' || location.pathname === '/app/friends';
  const { permissions: contextPermissions, isAdmin: contextIsAdmin } = usePermissions(contextMenu?.guildId || null);
  const canCreateInviteInContext =
    contextIsAdmin || hasPermission(contextPermissions, Permissions.CREATE_INSTANT_INVITE);

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

  return (
    <>
      <nav className="glass-sidebar fixed left-0 top-0 z-30 flex h-full w-[var(--sidebar-width)] flex-col items-center gap-4 py-4 pt-[var(--spacing-header-height)]">
        {/* Home Button */}
        <div className="flex w-full justify-center px-2">
          <Tooltip side="right" content="Direct Messages">
            <button
              onClick={() => {
                selectGuild(null);
                useChannelStore.getState().selectGuild(null);
                navigate('/app/friends');
              }}
              className={cn(
                'group flex h-[var(--sidebar-item-size)] w-[var(--sidebar-item-size)] items-center justify-center rounded-xl transition-all duration-300',
                isHome
                  ? 'bg-accent-primary text-white shadow-[0_0_20px_rgba(111,134,255,0.3)] ring-1 ring-accent-primary/50'
                  : 'bg-white/5 text-text-secondary hover:-translate-y-0.5 hover:bg-white/10 hover:text-white'
              )}
            >
              <Home size={26} className={cn("transition-transform duration-300", isHome ? "scale-100" : "group-hover:scale-110")} />
            </button>
          </Tooltip>
        </div>

        <div className="h-px w-10 shrink-0 bg-white/10" />

        {/* Guild List */}
        <div className="flex w-full flex-1 flex-col items-center gap-3 overflow-y-auto px-2 pb-4 scrollbar-none">
          {guilds.map((guild) => {
            const isActive = selectedGuildId === guild.id;
            const iconSrc = guild.icon_hash
              ? guild.icon_hash.startsWith('data:')
                ? (isSafeImageDataUrl(guild.icon_hash) ? guild.icon_hash : null)
                : `/api/v1/guilds/${guild.id}/icon`
              : null;
            return (
              <div key={guild.id} className="relative flex items-center justify-center">
                <Tooltip side="right" content={guild.name}>
                  <button
                    onClick={() => handleGuildClick(guild)}
                    onContextMenu={(e) => handleContextMenu(e, guild.id)}
                    className={cn(
                      'group relative flex h-[var(--sidebar-item-size)] w-[var(--sidebar-item-size)] items-center justify-center overflow-hidden rounded-xl transition-all duration-300',
                      isActive
                        ? 'sidebar-item-active z-10 ring-1 ring-white/20'
                        : 'bg-white/5 hover:-translate-y-0.5 hover:bg-white/10 hover:shadow-lg hover:shadow-black/20'
                    )}
                    style={!iconSrc && !isActive ? { backgroundColor: 'rgba(255,255,255,0.05)' } : undefined}
                  >
                    {!iconSrc && isActive && (
                      <div className="absolute inset-0 opacity-20" style={{ backgroundColor: getGuildColor(guild.id) }} />
                    )}

                    {iconSrc ? (
                      <img
                        src={iconSrc}
                        alt={guild.name}
                        className={cn(
                          "h-full w-full object-cover transition-transform duration-500",
                          isActive ? "scale-110" : "group-hover:scale-110"
                        )}
                      />
                    ) : (
                      <span
                        className={cn(
                          "text-[13px] font-bold transition-colors duration-200",
                          isActive ? "text-white" : "text-text-secondary group-hover:text-white"
                        )}
                        style={isActive ? { color: getGuildColor(guild.id) } : undefined}
                      >
                        {guild.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
                      </span>
                    )}
                  </button>
                </Tooltip>
              </div>
            );
          })}

          <div className="mt-auto flex flex-col items-center gap-3 pt-2">
            <Tooltip side="right" content="Add a Server">
              <button
                onClick={() => setShowCreateModal(true)}
                className="group flex h-[var(--sidebar-item-size)] w-[var(--sidebar-item-size)] items-center justify-center rounded-xl border border-dashed border-white/20 bg-transparent text-accent-success transition-all duration-300 hover:-translate-y-0.5 hover:border-accent-success/50 hover:bg-accent-success/10 hover:text-accent-success"
              >
                <Plus size={24} className="transition-transform duration-300 group-hover:rotate-90" />
              </button>
            </Tooltip>

            <Tooltip side="right" content={sidebarOpen ? 'Collapse Channels' : 'Expand Channels'}>
              <button
                onClick={toggleSidebar}
                className="group flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-text-secondary transition-all duration-200 hover:bg-white/10 hover:text-white"
              >
                {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
              </button>
            </Tooltip>

            {user && isAdmin(user.flags) && (
              <Tooltip side="right" content="Admin Dashboard">
                <button
                  onClick={() => navigate('/app/admin')}
                  className={cn(
                    'flex h-[var(--sidebar-item-size)] w-[var(--sidebar-item-size)] items-center justify-center rounded-xl transition-all duration-200',
                    location.pathname === '/app/admin'
                      ? 'bg-accent-primary text-white shadow-lg ring-1 ring-accent-primary/50'
                      : 'bg-white/5 text-text-secondary hover:-translate-y-0.5 hover:bg-white/10 hover:text-white'
                  )}
                >
                  <Shield size={22} />
                </button>
              </Tooltip>
            )}

            <Tooltip side="right" content="User Settings">
              <button
                onClick={() => navigate('/app/settings')}
                className="group relative flex h-[var(--sidebar-item-size)] w-[var(--sidebar-item-size)] items-center justify-center overflow-hidden rounded-xl bg-white/5 transition-all duration-300 hover:ring-2 hover:ring-white/20"
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
          </div>
        </div>
      </nav>

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
                      navigate('/app/friends');
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
