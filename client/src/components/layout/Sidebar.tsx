import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Plus, PanelLeftClose, PanelLeftOpen, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
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
      <nav className="flex h-full w-[var(--spacing-sidebar-width)] min-w-[var(--spacing-sidebar-width)] flex-col items-center gap-2.5 overflow-y-auto px-2.5 py-4 scrollbar-thin">
        <div className="relative flex items-center justify-center">
          {isHome && (
            <motion.div
              layoutId="guild-pill"
              className="absolute -left-4 h-11 w-1 rounded-r-md bg-accent-primary"
              transition={{ type: 'spring', stiffness: 360, damping: 30 }}
            />
          )}
          <Tooltip side="right" content="Direct Messages">
            <button
              onClick={() => {
                selectGuild(null);
                useChannelStore.getState().selectGuild(null);
                navigate('/app/friends');
              }}
              className={cn(
                'relative flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded-2xl border transition-all duration-200',
                isHome
                  ? 'border-accent-primary/60 bg-accent-primary/25 text-white shadow-[0_8px_22px_rgba(111,134,255,0.4)]'
                  : 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:border-border-strong hover:bg-bg-mod-strong hover:text-text-primary'
              )}
            >
              <Home size={24} />
            </button>
          </Tooltip>
        </div>

        <div className="my-1 h-px w-9 rounded-full bg-border-subtle/80" />

        {guilds.map((guild) => {
          const isActive = selectedGuildId === guild.id;
          const iconSrc = guild.icon_hash
            ? guild.icon_hash.startsWith('data:')
              ? (isSafeImageDataUrl(guild.icon_hash) ? guild.icon_hash : null)
              : `/api/v1/guilds/${guild.id}/icon`
            : null;
          return (
            <div key={guild.id} className="relative flex items-center justify-center group">
              {isActive && (
                <motion.div
                  layoutId="guild-pill"
                  className="absolute -left-4 h-11 w-1 rounded-r-md bg-accent-primary"
                  transition={{ type: 'spring', stiffness: 360, damping: 30 }}
                />
              )}
              {!isActive && (
                <div className="absolute -left-4 h-3 w-1 rounded-r-md bg-border-strong opacity-0 transition-all duration-200 group-hover:h-6 group-hover:opacity-100" />
              )}

              <Tooltip side="right" content={guild.name}>
                <button
                  onClick={() => handleGuildClick(guild)}
                  onContextMenu={(e) => handleContextMenu(e, guild.id)}
                  className={cn(
                    'flex h-[3.25rem] w-[3.25rem] items-center justify-center overflow-hidden rounded-2xl border transition-all duration-200',
                    isActive
                      ? 'border-accent-primary/50 shadow-[0_10px_30px_rgba(112,138,255,0.35)]'
                      : 'border-border-subtle hover:-translate-y-0.5 hover:border-border-strong'
                  )}
                  style={{
                    backgroundColor: guild.icon_hash ? 'transparent' : getGuildColor(guild.id),
                  }}
                >
                  {iconSrc ? (
                    <img
                      src={iconSrc}
                      alt={guild.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                      <span className="text-[13px] font-semibold text-white">
                      {guild.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
                    </span>
                  )}
                </button>
              </Tooltip>
            </div>
          );
        })}

        <Tooltip side="right" content="Add a Server">
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle text-accent-success transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-success/50 hover:bg-accent-success hover:text-white"
          >
            <Plus size={22} />
          </button>
        </Tooltip>

        <Tooltip side="right" content={sidebarOpen ? 'Collapse Channels' : 'Expand Channels'}>
          <button
            onClick={toggleSidebar}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-all duration-200 hover:border-border-strong hover:bg-bg-mod-strong hover:text-text-primary"
          >
            {sidebarOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
          </button>
        </Tooltip>

        <div className="flex-1" />

        {user && isAdmin(user.flags) && (
          <Tooltip side="right" content="Admin Dashboard">
            <button
              onClick={() => navigate('/app/admin')}
              className={cn(
                'flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded-2xl border transition-all duration-200',
                location.pathname === '/app/admin'
                  ? 'border-accent-primary/60 bg-accent-primary/25 text-white shadow-[0_8px_22px_rgba(111,134,255,0.4)]'
                  : 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:border-border-strong hover:bg-bg-mod-strong hover:text-text-primary'
              )}
            >
              <Shield size={22} />
            </button>
          </Tooltip>
        )}

        <Tooltip side="right" content="User Settings">
          <button
            onClick={() => navigate('/app/settings')}
            className="flex h-[3.25rem] w-[3.25rem] items-center justify-center overflow-hidden rounded-2xl border border-border-subtle bg-bg-mod-subtle transition-all duration-200 hover:border-border-strong hover:brightness-110"
          >
            {user?.username ? (
              <div className="flex h-full w-full items-center justify-center bg-accent-primary text-sm font-semibold text-white">
                {user.username.charAt(0).toUpperCase()}
              </div>
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-accent-primary text-sm font-semibold text-white">U</div>
            )}
          </button>
        </Tooltip>
      </nav>

      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="glass-modal fixed z-50 min-w-[200px] rounded-xl p-1.5"
            style={{ left: contextMenu.x, top: contextMenu.y }}
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
