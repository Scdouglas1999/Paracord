import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import {
  Home,
  Plus,
  ChevronDown,
  ChevronRight,
  Settings,
  Hash,
  Volume2,
  Search,
  Shield,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Command,
  PanelLeftClose,
  Video,
  Globe,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { useServerListStore } from '../../stores/serverListStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import { VoiceControls } from '../voice/VoiceControls';
import { StreamHoverPreview } from '../voice/StreamHoverPreview';
import { CreateGuildModal } from '../guild/CreateGuildModal';
import { InviteModal } from '../guild/InviteModal';
import { usePermissions } from '../../hooks/usePermissions';
import { useVoice } from '../../hooks/useVoice';
import { Permissions, hasPermission, isAdmin, type Channel } from '../../types/index';
import { channelApi } from '../../api/channels';
import { dmApi } from '../../api/dms';
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

const EMPTY_CHANNELS: Channel[] = [];

interface CategoryGroup {
  id: string | null;
  name: string;
  channels: Channel[];
}

export function UnifiedSidebar() {
  const guilds = useGuildStore((s) => s.guilds);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const setDmChannels = useChannelStore((s) => s.setDmChannels);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const user = useAuthStore((s) => s.user);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const navigate = useNavigate();
  const location = useLocation();
  const { guildId } = useParams();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedGuilds, setExpandedGuilds] = useState<Set<string>>(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guildId: string } | null>(null);
  const [inviteForGuild, setInviteForGuild] = useState<{ guildName: string; channelId: string } | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [dmSearch, setDmSearch] = useState('');
  const [showDmPicker, setShowDmPicker] = useState(false);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const { connected, channelId: activeVoiceChannelId, joinChannel, selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoice();
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const selfStream = useVoiceStore((s) => s.selfStream);
  const watchedStreamerId = useVoiceStore((s) => s.watchedStreamerId);
  const setWatchedStreamer = useVoiceStore((s) => s.setWatchedStreamer);
  const setPreviewStreamer = useVoiceStore((s) => s.setPreviewStreamer);
  const [hoverPreview, setHoverPreview] = useState<{
    userId: string;
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [mutedGuildIds, setMutedGuildIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('paracord:muted-guilds');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const servers = useServerListStore((s) => s.servers);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const setActiveServer = useServerListStore((s) => s.setActive);

  const effectiveGuildId = guildId || selectedGuildId;
  const currentGuild = guilds.find(g => g.id === effectiveGuildId);
  const { permissions: currentGuildPermissions, isAdmin: currentGuildIsAdmin } = usePermissions(effectiveGuildId || null);
  const canManageChannels = currentGuildIsAdmin || hasPermission(currentGuildPermissions, Permissions.MANAGE_CHANNELS);
  const canManageGuild = currentGuildIsAdmin || hasPermission(currentGuildPermissions, Permissions.MANAGE_GUILD);

  const isHome = location.pathname === '/app' || location.pathname === '/app/friends';
  const isSettingsRoute = location.pathname === '/app/settings';
  const isAdminRoute = location.pathname === '/app/admin';

  // Auto-expand the currently selected guild
  useEffect(() => {
    if (effectiveGuildId && !expandedGuilds.has(effectiveGuildId)) {
      setExpandedGuilds(prev => {
        const next = new Set(prev);
        next.add(effectiveGuildId);
        return next;
      });
    }
  }, [effectiveGuildId]);

  useEffect(() => {
    if (!currentGuild) {
      dmApi
        .list()
        .then(({ data }) => setDmChannels(data))
        .catch(() => { /* ignore */ });
    }
  }, [currentGuild, setDmChannels]);

  useEffect(() => {
    if (showDmPicker) {
      void fetchRelationships();
    }
  }, [showDmPicker, fetchRelationships]);

  useEffect(() => {
    if (!hoverPreview) return;
    if (watchedStreamerId === hoverPreview.userId) return;
    setPreviewStreamer(hoverPreview.userId);
  }, [hoverPreview, watchedStreamerId, setPreviewStreamer]);

  useEffect(() => {
    if (!hoverPreview) {
      setPreviewStreamer(null);
    }
    return () => {
      setPreviewStreamer(null);
    };
  }, [hoverPreview, setPreviewStreamer]);

  const handleGuildClick = async (guild: { id: string }) => {
    // Toggle expand/collapse for guild
    setExpandedGuilds(prev => {
      const next = new Set(prev);
      if (next.has(guild.id) && selectedGuildId === guild.id) {
        next.delete(guild.id);
      } else {
        next.add(guild.id);
      }
      return next;
    });

    selectGuild(guild.id);
    await useChannelStore.getState().selectGuild(guild.id);
    await useChannelStore.getState().fetchChannels(guild.id);
    const guildChannels = useChannelStore.getState().channelsByGuild[guild.id] || [];
    const firstChannel = guildChannels.find(c => c.type === 0) || guildChannels.find(c => c.type !== 4) || guildChannels[0];
    if (firstChannel) {
      useChannelStore.getState().selectChannel(firstChannel.id);
      navigate(`/app/guilds/${guild.id}/channels/${firstChannel.id}`);
    } else {
      navigate(`/app/guilds/${guild.id}/settings`);
    }
  };

  const handleChannelClick = (channel: Channel, channelGuildId: string) => {
    selectChannel(channel.id);
    if ((channel.type === 2 || channel.channel_type === 2) && channelGuildId) {
      // If already connected to this voice channel, just navigate to it
      // (don't toggle leave/join). This lets users return to the voice
      // view after browsing text channels.
      if (connected && activeVoiceChannelId === channel.id) {
        navigate(`/app/guilds/${channelGuildId}/channels/${channel.id}`);
        return;
      }
      void joinChannel(channel.id, channelGuildId);
    }
    navigate(`/app/guilds/${channelGuildId}/channels/${channel.id}`);
  };

  const handleContextMenu = (e: React.MouseEvent, contextGuildId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, guildId: contextGuildId });
  };

  const toggleGuildExpand = (guildIdToToggle: string) => {
    setExpandedGuilds(prev => {
      const next = new Set(prev);
      if (next.has(guildIdToToggle)) next.delete(guildIdToToggle);
      else next.add(guildIdToToggle);
      return next;
    });
  };

  const toggleCategory = (catId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const getChannelGroups = (guildChannels: Channel[]): CategoryGroup[] => {
    const categoryGroups: CategoryGroup[] = [];
    const uncategorized: CategoryGroup = { id: null, name: '', channels: [] };
    const categoryMap = new Map<string, CategoryGroup>();

    guildChannels.forEach(ch => {
      if (ch.type === 4) {
        categoryMap.set(ch.id, { id: ch.id, name: ch.name ?? 'Unknown', channels: [] });
      }
    });

    guildChannels.forEach(ch => {
      if (ch.type === 4) return;
      if (ch.parent_id != null && categoryMap.has(ch.parent_id)) {
        categoryMap.get(ch.parent_id)!.channels.push(ch);
      } else {
        uncategorized.channels.push(ch);
      }
    });

    if (uncategorized.channels.length > 0) categoryGroups.push(uncategorized);
    categoryMap.forEach(cat => categoryGroups.push(cat));
    return categoryGroups;
  };

  const { permissions: contextPermissions, isAdmin: contextIsAdmin } = usePermissions(contextMenu?.guildId || null);
  const canCreateInviteInContext = contextIsAdmin || hasPermission(contextPermissions, Permissions.CREATE_INSTANT_INVITE);

  const inviteChannelId =
    channels.find((c) => c.type === 0)?.id ??
    channels.find((c) => c.type !== 4)?.id ??
    null;

  // Filtered DMs
  const filteredDms = dmChannels.filter((dm) =>
    (dm.recipient?.username || 'Direct Message').toLowerCase().includes(dmSearch.toLowerCase())
  );

  const showServerRail = servers.length > 1;

  return (
    <>
      <div className="flex h-full">
        {/* Server rail — only shown when connected to multiple servers */}
        {showServerRail && !sidebarCollapsed && (
          <div className="flex h-full w-[52px] shrink-0 flex-col items-center gap-1.5 border-r border-border-subtle/40 py-3 px-1.5">
            {servers.map((server) => {
              const isActive = activeServerId === server.id;
              return (
                <Tooltip key={server.id} side="right" content={`${server.name}${server.connected ? '' : ' (disconnected)'}`}>
                  <button
                    onClick={() => setActiveServer(server.id)}
                    className={cn(
                      'group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[11px] font-bold text-white transition-all duration-200',
                      isActive
                        ? 'rounded-xl bg-accent-primary shadow-md shadow-accent-primary/25'
                        : 'bg-bg-mod-strong/80 hover:rounded-xl hover:bg-accent-primary/70'
                    )}
                  >
                    {/* Active indicator pip */}
                    {isActive && (
                      <div className="absolute -left-1.5 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-text-primary" />
                    )}
                    {server.iconUrl ? (
                      <img src={server.iconUrl} alt={server.name} className="h-full w-full rounded-inherit object-cover" />
                    ) : (
                      <Globe size={16} className={server.connected ? '' : 'opacity-50'} />
                    )}
                    {/* Connection status dot */}
                    <div
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-secondary',
                        server.connected ? 'bg-accent-success' : 'bg-text-muted'
                      )}
                    />
                  </button>
                </Tooltip>
              );
            })}

            {/* Add server button */}
            <Tooltip side="right" content="Add Server">
              <button
                onClick={() => navigate('/connect')}
                className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-bg-mod-subtle/60 text-text-muted transition-all duration-200 hover:rounded-xl hover:bg-accent-success/20 hover:text-accent-success"
              >
                <Plus size={18} />
              </button>
            </Tooltip>
          </div>
        )}

        {/* Main sidebar content */}
        <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Sidebar header - branding + collapse */}
        <div className="panel-divider flex h-[60px] shrink-0 items-center justify-between border-b px-5">
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-primary/20 text-accent-primary">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <span className="truncate text-[15px] font-bold text-text-primary tracking-tight">Paracord</span>
            </div>
          )}
          <Tooltip side="right" content={sidebarCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}>
            <button
              onClick={toggleSidebarCollapsed}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
            >
              <PanelLeftClose size={16} className={cn('transition-transform', sidebarCollapsed && 'rotate-180')} />
            </button>
          </Tooltip>
        </div>

        {/* Home button - prominent, above search */}
        <div className="px-3 pt-2 pb-1">
          <button
            onClick={() => {
              selectGuild(null);
              useChannelStore.getState().selectGuild(null);
              navigate('/app/friends');
            }}
            className={cn(
              'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14.5px] font-medium transition-all',
              isHome
                ? 'bg-accent-primary text-white shadow-md shadow-accent-primary/20'
                : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
            )}
          >
            <div className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
              isHome
                ? 'text-white'
                : 'bg-bg-mod-subtle text-text-muted group-hover:text-text-secondary'
            )}>
              <Home size={19} />
            </div>
            {!sidebarCollapsed && <span>Home</span>}
          </button>
        </div>

        {/* Quick search trigger - subtle, below home */}
        {!sidebarCollapsed && (
          <div className="px-4 pb-1">
            <button
              onClick={() => setCommandPaletteOpen(true)}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 text-text-muted transition-all hover:bg-bg-mod-subtle"
              style={{ height: '22px', fontSize: '10px', opacity: 0.45 }}
            >
              <Search size={9} />
              <span className="flex-1 text-left">Search</span>
              <kbd className="hidden rounded bg-bg-primary/50 px-1 py-0.5 font-mono sm:inline-block" style={{ fontSize: '8px', opacity: 0.5 }}>
                <Command size={7} className="inline -mt-px" />K
              </kbd>
            </button>
          </div>
        )}

        {/* Navigation area */}
        <div className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">

          {/* DM channels when at home */}
          {isHome && !sidebarCollapsed && (
            <div className="mb-3">
              <div className="group mb-2 mt-6 flex items-center justify-between px-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted/70">
                  Direct Messages
                </span>
                <button
                  className="rounded p-0.5 text-text-muted opacity-0 transition-all group-hover:opacity-100 hover:text-text-primary"
                  onClick={() => setShowDmPicker(true)}
                >
                  <Plus size={14} />
                </button>
              </div>

              {/* DM search */}
              <div className="px-1 mb-1">
                <div className="relative">
                  <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
                  <input
                    type="text"
                    placeholder="Find..."
                    className="h-7 w-full rounded-lg border border-border-subtle/60 bg-bg-mod-subtle/40 py-1 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-muted outline-none transition-all focus:border-border-strong focus:bg-bg-mod-strong"
                    value={dmSearch}
                    onChange={(e) => setDmSearch(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-0.5">
                {filteredDms.map((dm) => (
                  <button
                    key={dm.id}
                    onClick={() => {
                      selectChannel(dm.id);
                      navigate(`/app/dms/${dm.id}`);
                    }}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-xl px-3 py-2 transition-all',
                      selectedChannelId === dm.id
                        ? 'bg-bg-mod-strong text-text-primary shadow-sm'
                        : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                    )}
                  >
                    <div className="relative shrink-0">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary text-[13px] font-bold text-white shadow-sm">
                        {(dm.recipient?.username || 'D').charAt(0).toUpperCase()}
                      </div>
                      <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-status-online border-[3px] border-bg-secondary" />
                    </div>
                    <span className="truncate text-[14.5px] font-medium">{dm.recipient?.username || 'Direct Message'}</span>
                  </button>
                ))}
                {filteredDms.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-text-muted">No conversations found</div>
                )}
              </div>
            </div>
          )}

          {/* Divider between home and spaces */}
          <div className="mx-3 my-2 h-px bg-border-subtle/60" />

          {/* Spaces (guilds) header */}
          {!sidebarCollapsed && (
            <div className="group mb-2 flex items-center justify-between px-3 mt-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted/70">
                Spaces
              </span>
              <button
                onClick={() => setShowCreateModal(true)}
                className="rounded p-0.5 text-text-muted opacity-0 transition-all group-hover:opacity-100 hover:text-accent-success"
              >
                <Plus size={14} />
              </button>
            </div>
          )}

          {/* Guild tree */}
          <div className="space-y-0.5">
            {guilds.map((guild) => {
              const isActive = selectedGuildId === guild.id;
              const isExpanded = expandedGuilds.has(guild.id);
              const iconSrc = guild.icon_hash
                ? guild.icon_hash.startsWith('data:')
                  ? (isSafeImageDataUrl(guild.icon_hash) ? guild.icon_hash : null)
                  : `/api/v1/guilds/${guild.id}/icon`
                : null;
              const guildChannels = useChannelStore.getState().channelsByGuild[guild.id] || [];
              const categoryGroups = getChannelGroups(guildChannels);

              return (
                <div key={guild.id}>
                  {/* Guild row */}
                  <div
                    className={cn(
                      'group flex w-full items-center rounded-xl transition-all',
                      isActive
                        ? 'bg-bg-mod-subtle'
                        : 'hover:bg-bg-mod-subtle/60'
                    )}
                    onContextMenu={(e) => handleContextMenu(e, guild.id)}
                  >
                    {/* Expand/collapse toggle */}
                    {!sidebarCollapsed && (
                      <button
                        onClick={() => toggleGuildExpand(guild.id)}
                        className="flex h-9 w-7 shrink-0 items-center justify-center text-text-muted hover:text-text-secondary"
                      >
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    )}

                    <button
                      onClick={() => handleGuildClick(guild)}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-3 py-2 pr-2 transition-all',
                        sidebarCollapsed && 'justify-center px-2'
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl overflow-hidden transition-all shadow-sm',
                          isActive && 'ring-2 ring-accent-primary ring-offset-2 ring-offset-bg-secondary'
                        )}
                        style={{ backgroundColor: iconSrc ? 'transparent' : getGuildColor(guild.id) }}
                      >
                        {iconSrc ? (
                          <img src={iconSrc} alt={guild.name} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[12px] font-bold text-white">
                            {guild.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>
                      {!sidebarCollapsed && (
                        <span className={cn(
                          'truncate text-[14.5px]',
                          isActive ? 'font-bold text-text-primary' : 'font-medium text-text-secondary group-hover:text-text-primary'
                        )}>
                          {guild.name}
                        </span>
                      )}
                    </button>

                    {/* Guild actions (settings gear) on hover */}
                    {!sidebarCollapsed && isActive && canManageGuild && (
                      <Tooltip content="Space Settings" side="right">
                        <button
                          onClick={() => navigate(`/app/guilds/${guild.id}/settings`)}
                          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all group-hover:opacity-100 hover:text-text-primary"
                        >
                          <Settings size={13} />
                        </button>
                      </Tooltip>
                    )}
                  </div>

                  {/* Channel tree (expanded) */}
                  {!sidebarCollapsed && (
                    <AnimatePresence initial={false}>
                      {isExpanded && guildChannels.length > 0 && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="ml-[18px] border-l border-border-subtle/25 pl-3 py-1 space-y-3">
                            {categoryGroups.map((cat) => (
                              <div key={cat.id || '__uncategorized'} className="mb-1">
                                {cat.id && (
                                  <button
                                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-text-muted transition-colors hover:text-text-secondary"
                                    onClick={() => toggleCategory(cat.id!)}
                                  >
                                    {collapsedCategories.has(cat.id) ? <ChevronRight size={9} /> : <ChevronDown size={9} />}
                                    <span className="truncate">{cat.name}</span>
                                  </button>
                                )}
                                {!collapsedCategories.has(cat.id || '') && cat.channels.sort((a, b) => a.position - b.position).map(ch => {
                                  const isSelected = selectedChannelId === ch.id;
                                  const isVoice = ch.type === 2 || ch.channel_type === 2;
                                  const voiceMembers = isVoice ? (channelParticipants.get(ch.id) || []) : [];
                                  return (
                                    <div key={ch.id} style={{ marginTop: '6px' }}>
                                      <button
                                        onClick={() => handleChannelClick(ch, guild.id)}
                                        className={cn(
                                          'group/ch flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-all border',
                                          isSelected
                                            ? 'bg-accent-primary/12 text-white font-medium shadow-sm border-accent-primary/25'
                                            : isVoice
                                              ? 'bg-bg-mod-subtle/30 border-border-subtle/40 text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary hover:border-border-subtle/60'
                                              : 'bg-bg-mod-subtle/20 border-transparent text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary hover:border-border-subtle/40'
                                        )}
                                      >
                                        {isVoice ? (
                                          <Volume2 size={15} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-text-muted')} />
                                        ) : (
                                          <Hash size={15} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-text-muted')} />
                                        )}
                                        <span className="truncate">{ch.name || 'unknown'}</span>
                                        {!isVoice && canManageChannels && (
                                          <span
                                            role="button"
                                            tabIndex={0}
                                            className="ml-auto shrink-0 rounded p-0.5 text-text-muted opacity-0 transition-all group-hover/ch:opacity-100 hover:text-text-primary"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              navigate(`/app/guilds/${guild.id}/settings?section=channels&channelId=${ch.id}`);
                                            }}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                navigate(`/app/guilds/${guild.id}/settings?section=channels&channelId=${ch.id}`);
                                              }
                                            }}
                                          >
                                            <Settings size={11} />
                                          </span>
                                        )}
                                      </button>
                                      {isVoice && voiceMembers.length > 0 && (
                                        <div className="ml-4 mt-1 mb-1.5 p-1.5 space-y-0.5">
                                          {voiceMembers.map((vs) => {
                                            const isSpeaking = speakingUsers.has(vs.user_id);
                                            const isSelfUser = user?.id === vs.user_id;
                                            const isStreaming = Boolean(vs.self_stream) || (isSelfUser && selfStream);
                                            const isWatched = watchedStreamerId === vs.user_id;
                                            const displayName = vs.username || `User ${vs.user_id.slice(0, 6)}`;
                                            return (
                                              <div
                                                key={vs.user_id}
                                                className="relative flex items-center gap-2.5 rounded-md px-2 py-1 hover:bg-bg-mod-subtle/60 transition-colors"
                                              >
                                                <div
                                                  className={cn(
                                                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white transition-shadow',
                                                    isSpeaking && 'ring-2 ring-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]'
                                                  )}
                                                  style={{ backgroundColor: 'var(--accent-primary)' }}
                                                >
                                                  {displayName.charAt(0).toUpperCase()}
                                                </div>
                                                <span
                                                  className="truncate text-[12px] text-text-secondary font-medium"
                                                  onMouseEnter={(e) => {
                                                    if (!isStreaming) return;
                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                    setHoverPreview({
                                                      userId: vs.user_id,
                                                      name: displayName,
                                                      x: rect.right + 10,
                                                      y: rect.top + rect.height / 2,
                                                    });
                                                  }}
                                                  onMouseLeave={() => {
                                                    if (!isStreaming) return;
                                                    setHoverPreview((current) =>
                                                      current?.userId === vs.user_id ? null : current
                                                    );
                                                    if (watchedStreamerId !== vs.user_id) {
                                                      setPreviewStreamer(null);
                                                    }
                                                  }}
                                                >
                                                  {displayName}
                                                </span>
                                                <div className="ml-auto flex items-center gap-1">
                                                  {vs.self_video && (
                                                    <Video size={11} className="text-accent-primary" />
                                                  )}
                                                  {isStreaming && (
                                                    <button
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        const nextWatched = isWatched ? null : vs.user_id;
                                                        setWatchedStreamer(nextWatched);
                                                        setPreviewStreamer(null);
                                                        setHoverPreview(null);

                                                        if (!connected || activeVoiceChannelId !== ch.id) {
                                                          void joinChannel(ch.id, guild.id);
                                                        }
                                                        selectChannel(ch.id);
                                                        navigate(`/app/guilds/${guild.id}/channels/${ch.id}`);
                                                      }}
                                                      className={cn(
                                                        'inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[10px] font-semibold leading-none transition-all duration-200',
                                                        isWatched
                                                          ? 'border-accent-danger/70 bg-accent-danger/18 text-accent-danger shadow-[0_0_10px_rgba(237,66,69,0.25)]'
                                                          : 'border-accent-danger/45 bg-accent-danger/10 text-accent-danger/95 hover:border-accent-danger/65 hover:bg-accent-danger/16'
                                                      )}
                                                      title={isWatched ? 'Watching this stream' : 'Watch stream'}
                                                    >
                                                      <span className="relative flex h-1.5 w-1.5">
                                                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
                                                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                                                      </span>
                                                      <span className="uppercase tracking-[0.06em]">Live</span>
                                                    </button>
                                                  )}
                                                  {vs.self_mute && <MicOff size={11} className="text-text-muted" />}
                                                  {vs.self_deaf && <HeadphoneOff size={11} className="text-text-muted" />}
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

                            {guildChannels.filter(c => c.type !== 4).length === 0 && (
                              <div className="px-2 py-3 text-center text-[11px] text-text-muted">
                                No channels yet
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  )}
                </div>
              );
            })}

            {/* Add space button */}
            {sidebarCollapsed ? (
              <Tooltip side="right" content="Create Space">
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="flex w-full items-center justify-center rounded-xl py-2 text-text-muted transition-all hover:bg-bg-mod-subtle hover:text-accent-success"
                >
                  <Plus size={16} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>

        {/* Voice controls */}
        <VoiceControls />

        {/* User panel */}
        <div className="panel-divider flex h-[60px] shrink-0 items-center border-t px-3">
          <div
            className="mr-1 flex min-w-0 flex-1 cursor-pointer items-center rounded-xl p-2 transition-colors hover:bg-bg-mod-subtle"
            onClick={() => navigator.clipboard?.writeText(user?.username || '')}
          >
            <div className="relative mr-2.5 shrink-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary text-[12px] font-bold text-white shadow-sm">
                {user?.username?.charAt(0).toUpperCase() || 'U'}
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-online border-[2.5px] border-bg-tertiary" />
            </div>
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold leading-tight text-text-primary">
                  {user?.username || 'User'}
                </div>
                <div className="truncate text-[10px] leading-tight text-text-muted">
                  Online
                </div>
              </div>
            )}
          </div>

          {!sidebarCollapsed && (
            <div className="flex items-center gap-0.5">
              <Tooltip content={selfMute ? 'Unmute' : 'Mute'}>
                <button
                  onClick={toggleMute}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary',
                    selfMute && 'text-accent-danger'
                  )}
                >
                  {selfMute ? <MicOff size={14} /> : <Mic size={14} />}
                </button>
              </Tooltip>
              <Tooltip content={selfDeaf ? 'Undeafen' : 'Deafen'}>
                <button
                  onClick={toggleDeaf}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary',
                    selfDeaf && 'text-accent-danger'
                  )}
                >
                  {selfDeaf ? <HeadphoneOff size={14} /> : <Headphones size={14} />}
                </button>
              </Tooltip>
              <Tooltip content="Settings">
                <button
                  onClick={() => navigate('/app/settings')}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary',
                    isSettingsRoute && 'text-text-primary bg-bg-mod-subtle'
                  )}
                >
                  <Settings size={14} />
                </button>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Admin button (bottom) */}
        {user && isAdmin(user.flags) && !sidebarCollapsed && (
          <div className="px-2 pb-2">
            <button
              onClick={() => navigate('/app/admin')}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all',
                isAdminRoute
                  ? 'bg-accent-primary/15 text-accent-primary'
                  : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary'
              )}
            >
              <Shield size={13} />
              Admin
            </button>
          </div>
        )}
      </div>
      </div>

      {/* Context menu */}
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
                const ctxChannels = useChannelStore.getState().channelsByGuild[gid] || [];
                await Promise.all(
                  ctxChannels
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
                } catch { /* ignore */ }
                setContextMenu(null);
              }}
            >
              {mutedGuildIds.includes(contextMenu.guildId) ? 'Unmute Space' : 'Mute Space'}
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
                if (!guild || !canCreateInviteInContext) {
                  setContextMenu(null);
                  return;
                }
                if (!useChannelStore.getState().channelsByGuild[guild.id]?.length) {
                  await useChannelStore.getState().fetchChannels(guild.id);
                }
                const guildChs = useChannelStore.getState().channelsByGuild[guild.id] || [];
                const firstText = guildChs.find((c) => c.type === 0);
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
                  Leave Space
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Modals */}
      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
      {inviteForGuild && (
        <InviteModal
          guildName={inviteForGuild.guildName}
          channelId={inviteForGuild.channelId}
          onClose={() => setInviteForGuild(null)}
        />
      )}
      {showInviteModal && inviteChannelId && currentGuild && (
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

      {hoverPreview &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[70]"
            style={{
              left: hoverPreview.x,
              top: hoverPreview.y,
              transform: 'translateY(-50%)',
            }}
          >
            <StreamHoverPreview streamerId={hoverPreview.userId} streamerName={hoverPreview.name} />
          </div>,
          document.body
        )}
    </>
  );
}
