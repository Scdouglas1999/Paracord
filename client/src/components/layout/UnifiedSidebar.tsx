import { useState, useEffect, useRef, useCallback } from 'react';
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
  Compass,
  PanelLeftClose,
  Video,
  Globe,
  Clipboard,
  Calendar,
  ArchiveRestore,
  GripVertical,
  MessageSquare,
  Bot,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { cn } from '../../lib/utils';
import { isSafeImageDataUrl } from '../../lib/security';
import { SkeletonChannel } from '../ui/Skeleton';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { toast } from '../../stores/toastStore';

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

function getChannelType(channel: Channel): number {
  return channel.channel_type ?? channel.type;
}

function isThreadChannel(channel: Channel): boolean {
  return getChannelType(channel) === 6;
}

interface SortableChannelItemProps {
  channel: Channel;
  isSelected: boolean;
  isVoice: boolean;
  canDrag: boolean;
  guildId: string;
  categoryId: string | null;
  onChannelClick: (channel: Channel, guildId: string) => void;
  onContextMenu: (e: React.MouseEvent, channel: Channel, guildId: string) => void;
  canManageChannels: boolean;
  voiceMembers: Array<{ user_id: string; username?: string; self_mute?: boolean; self_deaf?: boolean; self_video?: boolean; self_stream?: boolean }>;
  speakingUsers: Set<string>;
  userId?: string;
  selfStream: boolean;
  watchedStreamerId: string | null;
  setWatchedStreamer: (id: string | null) => void;
  setPreviewStreamer: (id: string | null) => void;
  setHoverPreview: React.Dispatch<React.SetStateAction<{ userId: string; name: string; x: number; y: number } | null>>;
  connected: boolean;
  activeVoiceChannelId: string | null;
  joinChannel: (channelId: string, guildId: string) => void;
  selectChannel: (id: string) => void;
  navigate: ReturnType<typeof useNavigate>;
  children?: React.ReactNode;
}

function SortableChannelItem({
  channel,
  isSelected,
  isVoice,
  canDrag,
  guildId,
  categoryId,
  onChannelClick,
  onContextMenu,
  canManageChannels,
  voiceMembers,
  speakingUsers,
  userId,
  selfStream,
  watchedStreamerId,
  setWatchedStreamer,
  setPreviewStreamer,
  setHoverPreview,
  connected,
  activeVoiceChannelId,
  joinChannel,
  selectChannel,
  navigate,
  children,
}: SortableChannelItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: channel.id,
    disabled: !canDrag,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    marginTop: '6px',
  };

  return (
    <div ref={setNodeRef} style={style} role="treeitem" aria-selected={isSelected}>
      <div className="flex items-center">
        {canDrag && (
          <button
            {...attributes}
            {...listeners}
            className="mr-0.5 flex h-7 w-4 shrink-0 cursor-grab items-center justify-center text-text-muted/50 opacity-0 transition-opacity hover:text-text-muted group-hover/ch:opacity-100"
            style={{ touchAction: 'none' }}
            tabIndex={-1}
          >
            <GripVertical size={12} />
          </button>
        )}
        <button
          data-channel-id={channel.id}
          data-parent-category={categoryId || undefined}
          onClick={() => onChannelClick(channel, guildId)}
          onContextMenu={(e) => onContextMenu(e, channel, guildId)}
          className={cn(
            'group/ch flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-[13.5px] transition-all border',
            isSelected
              ? 'bg-accent-primary/12 text-white font-medium shadow-sm border-accent-primary/25'
              : isVoice
                ? 'bg-bg-mod-subtle/30 border-border-subtle/40 text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary hover:border-border-subtle/60'
                : 'bg-bg-mod-subtle/20 border-transparent text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary hover:border-border-subtle/40'
          )}
        >
          {isVoice ? (
            <Volume2 size={15} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-text-muted')} />
          ) : getChannelType(channel) === 7 ? (
            <MessageSquare size={15} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-text-muted')} />
          ) : (
            <Hash size={15} className={cn('shrink-0', isSelected ? 'text-accent-primary' : 'text-text-muted')} />
          )}
          <span className="truncate">{channel.name || 'unknown'}</span>
          {!isVoice && canManageChannels && (
            <span
              role="button"
              tabIndex={0}
              className="ml-auto shrink-0 rounded p-0.5 text-text-muted opacity-100 transition-all sm:opacity-0 sm:group-hover/ch:opacity-100 hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/app/guilds/${guildId}/settings?section=channels&channelId=${channel.id}`);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  navigate(`/app/guilds/${guildId}/settings?section=channels&channelId=${channel.id}`);
                }
              }}
            >
              <Settings size={11} />
            </span>
          )}
        </button>
      </div>
      {isVoice && voiceMembers.length > 0 && (
        <div
          className={cn(
            'mt-1 mb-1.5 space-y-0.5 border-l pl-2.5',
            canDrag ? 'ml-12' : 'ml-10'
          )}
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {voiceMembers.map((vs) => {
            const isSpeaking = speakingUsers.has(vs.user_id);
            const isSelfUser = userId === vs.user_id;
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

                        if (!connected || activeVoiceChannelId !== channel.id) {
                          void joinChannel(channel.id, guildId);
                        }
                        selectChannel(channel.id);
                        navigate(`/app/guilds/${guildId}/channels/${channel.id}`);
                      }}
                      className={cn(
                        'inline-flex items-center gap-0.5 rounded-full border py-0 px-1.5 text-[10px] font-semibold leading-[1] transition-all duration-200',
                        isWatched
                          ? 'border-accent-danger/70 bg-accent-danger/18 text-accent-danger shadow-[0_0_10px_rgba(237,66,69,0.25)]'
                          : 'border-accent-danger/45 bg-accent-danger/10 text-accent-danger/95 hover:border-accent-danger/65 hover:bg-accent-danger/16'
                      )}
                      title={isWatched ? 'Watching this stream' : 'Watch stream'}
                    >
                      <span className="relative flex h-[3px] w-[3px] shrink-0">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
                        <span className="relative inline-flex h-full w-full rounded-full bg-current" />
                      </span>
                      <span className="uppercase tracking-[0.04em]">Live</span>
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
      {children}
    </div>
  );
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
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const navigate = useNavigate();
  const location = useLocation();
  const { guildId } = useParams();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedGuilds, setExpandedGuilds] = useState<Set<string>>(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [expandedArchivedParents, setExpandedArchivedParents] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guildId: string } | null>(null);
  const { contextMenu: channelCtxMenu, onContextMenu: onChannelContextMenu, closeContextMenu: closeChannelCtxMenu } = useContextMenu();
  const [inviteForGuild, setInviteForGuild] = useState<{ guildName: string; channelId: string } | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [dmSearch, setDmSearch] = useState('');
  const [showDmPicker, setShowDmPicker] = useState(false);
  const dmPickerRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });
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
  const [mutedChannelIds, setMutedChannelIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('paracord:muted-channels');
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

  const [dragActiveId, setDragActiveId] = useState<string | null>(null);

  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragActiveId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDragActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id || !effectiveGuildId) return;

      const guildChannels = useChannelStore.getState().channelsByGuild[effectiveGuildId] || [];
      const nonThreadNonCategory = guildChannels
        .filter((c) => getChannelType(c) !== 4 && getChannelType(c) !== 6)
        .sort((a, b) => a.position - b.position);

      const activeChannel = nonThreadNonCategory.find((c) => c.id === active.id);
      const overChannel = nonThreadNonCategory.find((c) => c.id === over.id);
      if (!activeChannel || !overChannel) return;

      // Build the new order by removing the active channel and inserting at the over position
      const ordered = nonThreadNonCategory.filter((c) => c.id !== active.id);
      const overIndex = ordered.findIndex((c) => c.id === over.id);
      ordered.splice(overIndex, 0, activeChannel);

      // If dropped onto a channel in a different category, adopt that category
      const newParentId = overChannel.parent_id;

      const positions = ordered.map((ch, idx) => ({
        id: ch.id,
        position: idx,
        parent_id: ch.id === active.id ? (newParentId ?? null) : undefined,
      }));

      // Optimistic update via store
      for (const posEntry of positions) {
        const ch = guildChannels.find((c) => c.id === posEntry.id);
        if (!ch) continue;
        useChannelStore.getState().updateChannel({
          ...ch,
          position: posEntry.position,
          parent_id: posEntry.parent_id !== undefined ? posEntry.parent_id : ch.parent_id,
        });
      }

      try {
        await channelApi.updatePositions(effectiveGuildId, positions);
      } catch {
        // Revert on failure
        toast.error('Failed to reorder channels.');
        await useChannelStore.getState().fetchChannels(effectiveGuildId);
      }
    },
    [effectiveGuildId],
  );

  useFocusTrap(dmPickerRef, showDmPicker, () => setShowDmPicker(false));

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
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);
    updateIsMobile();
    mediaQuery.addEventListener('change', updateIsMobile);
    return () => mediaQuery.removeEventListener('change', updateIsMobile);
  }, []);

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

  const collapseSidebarOnPhone = () => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
      setSidebarCollapsed(true);
    }
  };

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
    const firstChannel =
      guildChannels.find((c) => getChannelType(c) === 0) ||
      guildChannels.find((c) => getChannelType(c) === 2) ||
      guildChannels.find((c) => getChannelType(c) !== 4 && getChannelType(c) !== 6) ||
      guildChannels.find((c) => !isThreadChannel(c));
    if (firstChannel) {
      useChannelStore.getState().selectChannel(firstChannel.id);
      navigate(`/app/guilds/${guild.id}/channels/${firstChannel.id}`);
    } else {
      navigate(`/app/guilds/${guild.id}/settings`);
    }
    collapseSidebarOnPhone();
  };

  const handleChannelClick = (channel: Channel, channelGuildId: string) => {
    selectChannel(channel.id);
    if (getChannelType(channel) === 2 && channelGuildId) {
      // If already connected to this voice channel, just navigate to it
      // (don't toggle leave/join). This lets users return to the voice
      // view after browsing text channels.
      if (connected && activeVoiceChannelId === channel.id) {
        navigate(`/app/guilds/${channelGuildId}/channels/${channel.id}`);
        collapseSidebarOnPhone();
        return;
      }
      void joinChannel(channel.id, channelGuildId);
    }
    navigate(`/app/guilds/${channelGuildId}/channels/${channel.id}`);
    collapseSidebarOnPhone();
  };

  const handleContextMenu = (e: React.MouseEvent, contextGuildId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, guildId: contextGuildId });
  };

  const toggleChannelMute = (channelIdToToggle: string) => {
    const next = mutedChannelIds.includes(channelIdToToggle)
      ? mutedChannelIds.filter((id) => id !== channelIdToToggle)
      : [...mutedChannelIds, channelIdToToggle];
    setMutedChannelIds(next);
    try {
      localStorage.setItem('paracord:muted-channels', JSON.stringify(next));
      window.dispatchEvent(new CustomEvent('paracord-muted-channels-updated'));
    } catch {
      // ignore storage write errors
    }
  };

  const handleChannelContextMenu = (e: React.MouseEvent, ch: Channel, chGuildId: string) => {
    const items: ContextMenuItem[] = [];
    if (canManageChannels) {
      items.push({
        label: 'Edit Channel',
        icon: <Settings size={14} />,
        action: () => navigate(`/app/guilds/${chGuildId}/settings?section=channels&channelId=${ch.id}`),
      });
    }
    const isChannelMuted = mutedChannelIds.includes(ch.id);
    items.push({
      label: isChannelMuted ? 'Unmute Channel' : 'Mute Channel',
      icon: <Volume2 size={14} />,
      action: () => toggleChannelMute(ch.id),
    });
    items.push({
      label: 'Copy Channel ID',
      icon: <Clipboard size={14} />,
      action: () => {
        navigator.clipboard?.writeText(ch.id);
      },
    });
    onChannelContextMenu(e, items);
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

  const toggleArchivedThreads = (parentChannelId: string) => {
    setExpandedArchivedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentChannelId)) next.delete(parentChannelId);
      else next.add(parentChannelId);
      return next;
    });
  };

  const getChannelGroups = (guildChannels: Channel[]): CategoryGroup[] => {
    const categoryGroups: CategoryGroup[] = [];
    const uncategorized: CategoryGroup = { id: null, name: '', channels: [] };
    const categoryMap = new Map<string, CategoryGroup>();

    guildChannels.forEach(ch => {
      if (getChannelType(ch) === 4) {
        categoryMap.set(ch.id, { id: ch.id, name: ch.name ?? 'Unknown', channels: [] });
      }
    });

    guildChannels.forEach(ch => {
      if (getChannelType(ch) === 4 || isThreadChannel(ch)) return;
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
    channels.find((c) => getChannelType(c) === 0)?.id ??
    channels.find((c) => getChannelType(c) !== 4 && getChannelType(c) !== 6)?.id ??
    null;

  // Filtered DMs
  const filteredDms = dmChannels.filter((dm) =>
    (dm.recipient?.username || 'Direct Message').toLowerCase().includes(dmSearch.toLowerCase())
  );

  const showServerRail = servers.length >= 1;

  return (
    <>
      <div className="flex h-full">
        {/* Server rail — only shown when connected to multiple servers */}
        {showServerRail && !sidebarCollapsed && (
          <div className="hidden h-full w-[52px] shrink-0 flex-col items-center gap-1.5 border-r border-border-subtle/40 px-1.5 py-3 md:flex">
            {servers.map((server) => {
              const isActive = activeServerId === server.id;
              const serverOnline = server.connected || server.apiReachable === true;
              const statusSuffix = serverOnline ? '' : ' (disconnected)';
              return (
                <Tooltip key={server.id} side="right" content={`${server.name}${statusSuffix}`}>
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
                      <Globe size={16} className={serverOnline ? '' : 'opacity-50'} />
                    )}
                    {/* Connection status dot */}
                    <div
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-secondary',
                        serverOnline ? 'bg-accent-success' : 'bg-text-muted'
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
        <div className="panel-divider flex h-[60px] shrink-0 items-center justify-between border-b px-3 sm:px-5">
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

        {showServerRail && !sidebarCollapsed && isMobile && (
          <div className="panel-divider border-b px-2.5 py-2">
            <div className="scrollbar-thin flex items-center gap-2 overflow-x-auto pb-1">
              {servers.map((server) => {
                const isActive = activeServerId === server.id;
                const serverOnline = server.connected || server.apiReachable === true;
                const statusSuffix = serverOnline ? '' : ' (disconnected)';
                return (
                  <button
                    key={server.id}
                    onClick={() => setActiveServer(server.id)}
                    title={`${server.name}${statusSuffix}`}
                    className={cn(
                      'group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-white transition-all duration-200',
                      isActive
                        ? 'bg-accent-primary shadow-md shadow-accent-primary/25'
                        : 'bg-bg-mod-strong/80'
                    )}
                  >
                    {server.iconUrl ? (
                      <img src={server.iconUrl} alt={server.name} className="h-full w-full rounded-xl object-cover" />
                    ) : (
                      <Globe size={16} className={serverOnline ? '' : 'opacity-50'} />
                    )}
                    <div
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-secondary',
                        serverOnline ? 'bg-accent-success' : 'bg-text-muted'
                      )}
                    />
                  </button>
                );
              })}
              <button
                onClick={() => navigate('/connect')}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle/70 text-text-muted transition-colors hover:bg-accent-success/20 hover:text-accent-success"
                title="Add Server"
              >
                <Plus size={17} />
              </button>
            </div>
          </div>
        )}

        {/* Home button - prominent, above search */}
        <div className="px-3 pt-3 pb-2">
          <button
            onClick={() => {
              selectGuild(null);
              useChannelStore.getState().selectGuild(null);
              navigate('/app/friends');
              collapseSidebarOnPhone();
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

        {/* Discover button */}
        <div className="px-3 pt-1 pb-1">
          <button
            onClick={() => {
              navigate('/app/discovery');
              collapseSidebarOnPhone();
            }}
            className={cn(
              'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14.5px] font-medium transition-all',
              location.pathname === '/app/discovery'
                ? 'bg-accent-primary text-white shadow-md shadow-accent-primary/20'
                : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
            )}
          >
            <div className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
              location.pathname === '/app/discovery'
                ? 'text-white'
                : 'bg-bg-mod-subtle text-text-muted group-hover:text-text-secondary'
            )}>
              <Compass size={19} />
            </div>
            {!sidebarCollapsed && <span>Discover</span>}
          </button>
        </div>

        {/* Quick search trigger - subtle, below home */}
        {!sidebarCollapsed && (
          <div className="px-3 pt-1 pb-2">
            <button
              onClick={() => setCommandPaletteOpen(true)}
              className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14.5px] font-medium text-text-secondary transition-all hover:bg-bg-mod-subtle hover:text-text-primary"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-mod-subtle text-text-muted transition-colors group-hover:text-text-secondary">
                <Search size={19} />
              </div>
              <span className="flex-1 text-left">Search</span>
              <kbd className="hidden rounded bg-bg-primary/50 px-1.5 py-0.5 font-mono text-[10px] opacity-60 sm:inline-block">
                <Command size={9} className="inline -mt-px" />K
              </kbd>
            </button>
          </div>
        )}

        {/* Navigation area */}
        <div
          className="scrollbar-thin flex-1 overflow-y-auto px-3 py-2"
          onKeyDown={(e) => {
            if (!['ArrowUp', 'ArrowDown', 'Enter', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
            const container = e.currentTarget;
            const buttons = Array.from(
              container.querySelectorAll<HTMLButtonElement>('[data-channel-id]'),
            );
            if (buttons.length === 0) return;
            const focusedIndex = buttons.findIndex((b) => b === document.activeElement);

            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const next = focusedIndex < buttons.length - 1 ? focusedIndex + 1 : 0;
              buttons[next]?.focus();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              const prev = focusedIndex > 0 ? focusedIndex - 1 : buttons.length - 1;
              buttons[prev]?.focus();
            } else if (e.key === 'Enter' && focusedIndex >= 0) {
              e.preventDefault();
              buttons[focusedIndex]?.click();
            } else if (e.key === 'ArrowRight') {
              const btn = buttons[focusedIndex];
              const catId = btn?.getAttribute('data-parent-category');
              if (catId && collapsedCategories.has(catId)) {
                e.preventDefault();
                toggleCategory(catId);
              }
            } else if (e.key === 'ArrowLeft') {
              const btn = buttons[focusedIndex];
              const catId = btn?.getAttribute('data-parent-category');
              if (catId && !collapsedCategories.has(catId)) {
                e.preventDefault();
                toggleCategory(catId);
              }
            }
          }}
        >

          {/* DM channels when at home */}
          {isHome && !sidebarCollapsed && (
            <div className="mb-2">
              <div className="group mt-2 mb-2 flex items-center justify-between px-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted/70">
                  Direct Messages
                </span>
                <button
                  className="rounded p-0.5 text-text-muted opacity-100 transition-all sm:opacity-0 sm:group-hover:opacity-100 hover:text-text-primary"
                  onClick={() => setShowDmPicker(true)}
                >
                  <Plus size={14} />
                </button>
              </div>

              {/* DM search */}
              <div className="px-1 pb-2">
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

              <div className="space-y-1.5">
                {filteredDms.map((dm) => (
                  <button
                    key={dm.id}
                    onClick={() => {
                      selectChannel(dm.id);
                      navigate(`/app/dms/${dm.id}`);
                      collapseSidebarOnPhone();
                    }}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-xl px-3 py-3 transition-all',
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
          <div className="my-2 h-px bg-border-subtle/60" />

          {/* Spaces (guilds) header */}
          {!sidebarCollapsed && (
            <div className="group mt-2 mb-3 flex items-center justify-between px-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted/70">
                Spaces
              </span>
              <button
                onClick={() => setShowCreateModal(true)}
                className="rounded p-0.5 text-text-muted opacity-100 transition-all sm:opacity-0 sm:group-hover:opacity-100 hover:text-accent-success"
              >
                <Plus size={14} />
              </button>
            </div>
          )}

          {/* Guild tree */}
          <div className="space-y-1.5">
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

                    {/* Guild actions */}
                    {!sidebarCollapsed && isActive && (
                      <div className="mr-1 flex items-center gap-0.5">
                        <Tooltip content="Events" side="right">
                          <button
                            onClick={() => navigate(`/app/guilds/${guild.id}/settings?section=events`)}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-100 transition-all sm:opacity-0 sm:group-hover:opacity-100 hover:text-text-primary"
                          >
                            <Calendar size={13} />
                          </button>
                        </Tooltip>
                        {canManageGuild && (
                          <Tooltip content="Space Settings" side="right">
                            <button
                              onClick={() => navigate(`/app/guilds/${guild.id}/settings`)}
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-100 transition-all sm:opacity-0 sm:group-hover:opacity-100 hover:text-text-primary"
                            >
                              <Settings size={13} />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Channel tree (expanded) */}
                  {!sidebarCollapsed && (
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          {guildChannels.length === 0 ? (
                            <div className="ml-[18px] border-l border-border-subtle/25 pl-3 pt-2 pb-1" aria-label="Loading channels">
                              {Array.from({ length: 5 }, (_, i) => (
                                <SkeletonChannel key={i} />
                              ))}
                            </div>
                          ) : (
                          <DndContext
                            sensors={dndSensors}
                            collisionDetection={closestCenter}
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                          >
                          <div role="tree" aria-label={`Channels for ${guild.name}`} className="ml-[18px] border-l border-border-subtle/25 pl-3 pt-2 pb-1 space-y-4">
                            {categoryGroups.map((cat) => {
                              const sortedChannels = [...cat.channels].sort((a, b) => a.position - b.position);
                              const channelIds = sortedChannels.map((ch) => ch.id);
                              return (
                              <div key={cat.id || '__uncategorized'} className="mb-4" role={cat.id ? 'group' : undefined}>
                                {cat.id && (
                                  <button
                                    className="flex w-full items-center gap-1.5 px-2 py-2 mt-4 text-[10px] font-bold uppercase tracking-wider text-text-muted transition-colors hover:text-text-secondary"
                                    onClick={() => toggleCategory(cat.id!)}
                                    aria-expanded={!collapsedCategories.has(cat.id)}
                                    aria-label={`${cat.name} category`}
                                  >
                                    {collapsedCategories.has(cat.id) ? <ChevronRight size={9} /> : <ChevronDown size={9} />}
                                    <span className="truncate">{cat.name}</span>
                                  </button>
                                )}
                                {!collapsedCategories.has(cat.id || '') && (
                                  <SortableContext items={channelIds} strategy={verticalListSortingStrategy}>
                                {sortedChannels.map(ch => {
                                  const isSelected = selectedChannelId === ch.id;
                                  const isVoice = getChannelType(ch) === 2;
                                  const voiceMembers = isVoice ? (channelParticipants.get(ch.id) || []) : [];
                                  const activeThreads = [...guildChannels]
                                    .filter((child) =>
                                      isThreadChannel(child) &&
                                      child.parent_id === ch.id &&
                                      !child.thread_metadata?.archived
                                    )
                                    .sort((a, b) => {
                                      const left = new Date(a.created_at || 0).getTime();
                                      const right = new Date(b.created_at || 0).getTime();
                                      return right - left;
                                    });
                                  const archivedThreads = [...guildChannels]
                                    .filter((child) =>
                                      isThreadChannel(child) &&
                                      child.parent_id === ch.id &&
                                      Boolean(child.thread_metadata?.archived)
                                    )
                                    .sort((a, b) => {
                                      const left = new Date(a.created_at || 0).getTime();
                                      const right = new Date(b.created_at || 0).getTime();
                                      return right - left;
                                    });
                                  const showArchivedThreads = expandedArchivedParents.has(ch.id);
                                  return (
                                    <SortableChannelItem
                                      key={ch.id}
                                      channel={ch}
                                      isSelected={isSelected}
                                      isVoice={isVoice}
                                      canDrag={canManageChannels}
                                      guildId={guild.id}
                                      categoryId={cat.id}
                                      onChannelClick={handleChannelClick}
                                      onContextMenu={handleChannelContextMenu}
                                      canManageChannels={canManageChannels}
                                      voiceMembers={voiceMembers}
                                      speakingUsers={speakingUsers}
                                      userId={user?.id}
                                      selfStream={selfStream}
                                      watchedStreamerId={watchedStreamerId}
                                      setWatchedStreamer={setWatchedStreamer}
                                      setPreviewStreamer={setPreviewStreamer}
                                      setHoverPreview={setHoverPreview}
                                      connected={connected}
                                      activeVoiceChannelId={activeVoiceChannelId}
                                      joinChannel={joinChannel}
                                      selectChannel={selectChannel}
                                      navigate={navigate}
                                    >
                                      {!isVoice && activeThreads.length > 0 && (
                                        <div className="ml-7 mt-1.5 mb-1 flex flex-col gap-1.5 pr-1">
                                          {activeThreads.map((thread) => {
                                            const isThreadSelected = selectedChannelId === thread.id;
                                            return (
                                              <button
                                                key={thread.id}
                                                data-channel-id={thread.id}
                                                data-parent-category={cat.id || undefined}
                                                onClick={() => handleChannelClick(thread, guild.id)}
                                                onContextMenu={(e) => handleChannelContextMenu(e, thread, guild.id)}
                                                className={cn(
                                                  'group/thread flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                                                  isThreadSelected
                                                    ? 'border-accent-primary/30 bg-accent-primary/10 text-text-primary'
                                                    : 'border-transparent bg-bg-mod-subtle/25 text-text-muted hover:border-border-subtle/50 hover:bg-bg-mod-subtle/45 hover:text-text-secondary'
                                                )}
                                              >
                                                <Hash size={12} className="shrink-0 opacity-80" />
                                                <span className="min-w-0 flex-1 truncate">{thread.name || 'thread'}</span>
                                                <span className="shrink-0 rounded border border-border-subtle px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                                                  Thread
                                                </span>
                                              </button>
                                            );
                                          })}
                                        </div>
                                      )}
                                      {!isVoice && archivedThreads.length > 0 && (
                                        <div className="ml-7 mt-1 mb-1 flex flex-col gap-1.5 pr-1">
                                          <button
                                            type="button"
                                            onClick={() => toggleArchivedThreads(ch.id)}
                                            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border-subtle/50 bg-bg-mod-subtle/35 px-2 py-1 text-[11px] font-semibold text-text-muted transition-colors hover:border-border-subtle/70 hover:bg-bg-mod-subtle/55 hover:text-text-secondary"
                                            aria-expanded={showArchivedThreads}
                                          >
                                            <ArchiveRestore size={11} />
                                            Archived ({archivedThreads.length})
                                          </button>
                                          {showArchivedThreads && (
                                            <div className="mt-0.5 flex flex-col gap-1.5">
                                              {archivedThreads.map((thread) => {
                                                const isThreadSelected = selectedChannelId === thread.id;
                                                const canRestore =
                                                  user?.id === thread.owner_id ||
                                                  (effectiveGuildId === guild.id && canManageChannels);
                                                return (
                                                  <div
                                                    key={thread.id}
                                                    className={cn(
                                                      'flex items-center gap-1.5 rounded-md border px-2 py-1.5',
                                                      isThreadSelected
                                                        ? 'border-accent-primary/30 bg-accent-primary/10'
                                                        : 'border-border-subtle/40 bg-bg-mod-subtle/20'
                                                    )}
                                                  >
                                                    <button
                                                      type="button"
                                                      data-channel-id={thread.id}
                                                      data-parent-category={cat.id || undefined}
                                                      onClick={() => handleChannelClick(thread, guild.id)}
                                                      onContextMenu={(e) => handleChannelContextMenu(e, thread, guild.id)}
                                                      className="group/thread flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] text-text-muted transition-colors hover:text-text-secondary"
                                                    >
                                                      <Hash size={12} className="shrink-0 opacity-70" />
                                                      <span className="min-w-0 flex-1 truncate">{thread.name || 'thread'}</span>
                                                    </button>
                                                    {canRestore && (
                                                      <button
                                                        type="button"
                                                        onClick={async (e) => {
                                                          e.stopPropagation();
                                                          try {
                                                            const { data: updated } = await channelApi.updateThread(ch.id, thread.id, { archived: false });
                                                            useChannelStore.getState().updateChannel(updated);
                                                          } catch {
                                                            toast.error('Failed to restore thread.');
                                                          }
                                                        }}
                                                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-subtle/70 px-1.5 py-1 text-[10px] font-semibold text-text-muted transition-colors hover:border-border-subtle hover:text-text-primary"
                                                        aria-label={`Restore archived thread ${thread.name || thread.id}`}
                                                        title="Restore thread"
                                                      >
                                                        <ArchiveRestore size={10} />
                                                        Restore
                                                      </button>
                                                    )}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </SortableChannelItem>
                                  );
                                })}
                                  </SortableContext>
                                )}
                              </div>
                              );
                            })}

                            {guildChannels.filter((c) => getChannelType(c) !== 4 && getChannelType(c) !== 6).length === 0 && (
                              <div className="px-2 py-3 text-center text-[11px] text-text-muted">
                                No channels yet
                              </div>
                            )}
                          </div>
                          <DragOverlay>
                            {dragActiveId && (() => {
                              const dragCh = guildChannels.find((c) => c.id === dragActiveId);
                              if (!dragCh) return null;
                              const isVoice = getChannelType(dragCh) === 2;
                              return (
                                <div className="rounded-lg border border-accent-primary/40 bg-bg-secondary/95 px-3 py-3 text-[13.5px] shadow-lg backdrop-blur-sm">
                                  <div className="flex items-center gap-2.5">
                                    {isVoice ? (
                                      <Volume2 size={15} className="shrink-0 text-accent-primary" />
                                    ) : (
                                      <Hash size={15} className="shrink-0 text-accent-primary" />
                                    )}
                                    <span className="text-text-primary">{dragCh.name || 'unknown'}</span>
                                  </div>
                                </div>
                              );
                            })()}
                          </DragOverlay>
                          </DndContext>
                          )}
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

        {/* Developer & Admin buttons (bottom) */}
        {!sidebarCollapsed && (
          <div className="px-2 pb-2 space-y-0.5">
            <button
              onClick={() => navigate('/app/developers')}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all',
                location.pathname === '/app/developers'
                  ? 'bg-accent-primary/15 text-accent-primary'
                  : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary'
              )}
            >
              <Bot size={13} />
              Developers
            </button>
            {user && isAdmin(user.flags) && (
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
            )}
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
                const firstText = guildChs.find((c) => getChannelType(c) === 0);
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
          <div ref={dmPickerRef} role="dialog" aria-modal="true" aria-labelledby="dm-picker-title" tabIndex={-1} className="glass-modal fixed left-1/2 top-1/2 z-50 max-h-[min(80dvh,34rem)] w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl sm:rounded-2xl">
            <div id="dm-picker-title" className="panel-divider border-b px-5 py-4 text-lg font-semibold text-text-primary">Start Direct Message</div>
            <div className="max-h-[min(62dvh,24rem)] overflow-y-auto p-3">
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
                    collapseSidebarOnPhone();
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

      {channelCtxMenu.isOpen && (
        <ContextMenu
          items={channelCtxMenu.items}
          position={channelCtxMenu.position}
          onClose={closeChannelCtxMenu}
        />
      )}
    </>
  );
}
