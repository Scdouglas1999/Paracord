import { useRef, useEffect, useMemo, useState, useCallback, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowRight, Smile, Reply, MoreHorizontal, Hash, Check, X as XIcon, Pencil, Pin, PinOff, Copy, Clipboard, Trash2, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMessages } from '../../hooks/useMessages';
import { useTypingStore } from '../../stores/typingStore';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore } from '../../stores/messageStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { channelApi } from '../../api/channels';
import { fileApi } from '../../api/files';
import { extractApiError } from '../../api/client';
import { MessageType, Permissions, hasPermission, type Channel, type Message } from '../../types';
import { UserProfilePopup } from '../user/UserProfile';
import { EmojiPicker } from '../ui/EmojiPicker';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { usePermissions } from '../../hooks/usePermissions';
import { resolveResourceUrl } from '../../lib/apiBaseUrl';
import { getAccessToken } from '../../lib/authToken';
import { SkeletonMessage } from '../ui/Skeleton';
import { parseMarkdown } from '../../lib/markdown';
import { useLightboxStore, type LightboxImage } from '../../stores/lightboxStore';
import { confirm } from '../../stores/confirmStore';
import { buildGuildEmojiImageUrl, parseCustomEmojiToken } from '../../lib/customEmoji';
import { MessageEmbedCard, extractUrls } from './MessageEmbed';
import { GitHubEventEmbed, isGitHubWebhookMessage } from './GitHubEventEmbed';
import { PollMessageCard } from './PollMessageCard';
import { toast } from '../../stores/toastStore';

const EMPTY_TYPING: string[] = [];
const EMPTY_CHANNELS: Channel[] = [];
const MAX_REPLY_NEST_DEPTH = 6;
const REPLY_INDENT_PX = 18;
const THREAD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _threadHydratedAt = new Map<string, number>();
const IMAGE_ATTACHMENT_EXTENSION_RE = /\.(png|jpe?g|gif|webp|avif|bmp|heic|heif)$/i;

/**
 * Resolve an attachment URL for use in `<img>` src and similar browser-native
 * fetches.  Uses the dynamic API base and appends a token query parameter for
 * cross-origin requests where cookies won't be sent.
 */
function resolveAttachmentUrl(url: string): string {
  return resolveResourceUrl(url, getAccessToken());
}

function isImageAttachment(att: { content_type?: string; filename: string }): boolean {
  const contentType = (att.content_type || '').toLowerCase();
  if (contentType.startsWith('image/')) return true;
  return IMAGE_ATTACHMENT_EXTENSION_RE.test(att.filename);
}

interface MessageListProps {
  channelId: string;
  onReply?: (message: Message) => void;
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) return `Today at ${time}`;
    if (isYesterday) return `Yesterday at ${time}`;
    return `${date.toLocaleDateString()} ${time}`;
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function getTimestamp(msg: { timestamp?: string; created_at?: string }): string {
  return msg.timestamp || msg.created_at || '';
}

function shouldGroup(prev: { author: { id: string }; timestamp?: string; created_at?: string } | null, curr: { author: { id: string }; timestamp?: string; created_at?: string }): boolean {
  if (!prev) return false;
  if (prev.author.id !== curr.author.id) return false;
  const prevTs = getTimestamp(prev);
  const currTs = getTimestamp(curr);
  if (!prevTs || !currTs) return false;
  const diff = new Date(currTs).getTime() - new Date(prevTs).getTime();
  return diff < 7 * 60 * 1000;
}

function isDifferentDay(a: string, b: string): boolean {
  try {
    return new Date(a).toDateString() !== new Date(b).toDateString();
  } catch {
    return false;
  }
}

function truncateInline(value: string, max = 96): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function getReplyPreviewText(message: Message): string {
  const text = (message.content || '').trim();
  if (text) return truncateInline(text.replace(/\s+/g, ' '));
  if (message.poll) return '[Poll]';
  if (message.attachments?.length) {
    return message.attachments.length === 1 ? '[Attachment]' : `[${message.attachments.length} attachments]`;
  }
  if (message.e2ee) return '[Encrypted message]';
  return '[Message]';
}

function resolveReplyParentId(message: Message): string | null {
  const legacyReferencedId = (message as Message & { referenced_message_id?: string }).referenced_message_id;
  const raw = message.reference_id || message.referenced_message?.id || legacyReferencedId || null;
  if (!raw) return null;
  return String(raw);
}

// Row types for the virtual list
type VirtualRow =
  | { type: 'welcome' }
  | { type: 'date-separator'; date: string }
  | {
      type: 'message';
      message: Message;
      messageIndex: number;
      isGrouped: boolean;
      replyDepth: number;
      replyParentId: string | null;
    }
  | { type: 'typing' }
  | { type: 'bottom-sentinel' };

export function MessageList({ channelId, onReply }: MessageListProps) {
  const navigate = useNavigate();
  const { messages, isLoading, hasMore, loadMore } = useMessages(channelId);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const deleteMessage = useMessageStore((s) => s.deleteMessage);
  const editMessage = useMessageStore((s) => s.editMessage);
  const pinMessage = useMessageStore((s) => s.pinMessage);
  const unpinMessage = useMessageStore((s) => s.unpinMessage);
  const setMessages = useMessageStore((s) => s.setMessages);
  const decryptingIds = useMessageStore((s) => s.decryptingIds);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const typingUsers = useTypingStore((s) => s.typingByChannel[channelId] ?? EMPTY_TYPING);
  const me = useAuthStore((s) => s.user?.id);
  const activeChannel = Object.values(channelsByGuild).flat().find((channel) => channel.id === channelId);
  const activeGuildId = activeChannel?.guild_id || null;
  const activeGuildChannels = activeGuildId ? (channelsByGuild[activeGuildId] ?? EMPTY_CHANNELS) : EMPTY_CHANNELS;
  const { permissions, isAdmin } = usePermissions(activeGuildId);
  const canManageMessages = isAdmin || hasPermission(permissions, Permissions.MANAGE_MESSAGES);
  const activeChannelType = activeChannel?.channel_type ?? activeChannel?.type;
  const canCreateThreads =
    Boolean(activeGuildId) &&
    (activeChannelType === 0 || activeChannelType === 5) &&
    (isAdmin || hasPermission(permissions, Permissions.SEND_MESSAGES));
  const canVoteInPolls = !activeGuildId || isAdmin || hasPermission(permissions, Permissions.SEND_MESSAGES);
  const linkedThreadsByStarterMessageId = useMemo(() => {
    const map: Record<string, Channel[]> = {};
    for (const channel of activeGuildChannels) {
      const channelType = channel.channel_type ?? channel.type;
      if (channelType !== 6) continue;
      if (channel.parent_id !== channelId) continue;
      const starterMessageId = channel.thread_metadata?.starter_message_id;
      if (!starterMessageId) continue;
      const key = String(starterMessageId);
      if (!map[key]) map[key] = [];
      map[key].push(channel);
    }
    for (const threadList of Object.values(map)) {
      threadList.sort((a, b) => {
        const left = new Date(a.created_at || 0).getTime();
        const right = new Date(b.created_at || 0).getTime();
        return right - left;
      });
    }
    return map;
  }, [activeGuildChannels, channelId]);
  const activeTyping = typingUsers.filter((id) => id !== me);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null);
  const [profileUser, setProfileUser] = useState<Message['author'] | null>(null);
  const [profilePos, setProfilePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [emojiPickerFor, setEmojiPickerFor] = useState<{ messageId: string; position: { x: number; y: number } } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [threadModalForMessageId, setThreadModalForMessageId] = useState<string | null>(null);
  const [threadName, setThreadName] = useState('');
  const [threadCreateError, setThreadCreateError] = useState<string | null>(null);
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [attachmentBusyId, setAttachmentBusyId] = useState<string | null>(null);
  const [isCoarsePointer, setIsCoarsePointer] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  });
  const hasHydratedChannelRef = useRef(false);
  const lastReadStateMessageIdRef = useRef<string | null>(null);
  const prevMessagesLenRef = useRef(0);
  const isLoadingMoreRef = useRef(false);

  // Resolve typing user IDs to usernames
  const allMembers = useMemberStore((s) => s.members);

  const messageById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const msg of messages) {
      map.set(msg.id, msg);
    }
    return map;
  }, [messages]);

  const replyLayoutById = useMemo(() => {
    const cache = new Map<string, { depth: number; parentId: string | null }>();

    const resolve = (messageId: string, visited: Set<string>): { depth: number; parentId: string | null } => {
      const cached = cache.get(messageId);
      if (cached) return cached;

      const current = messageById.get(messageId);
      if (!current) {
        const fallback = { depth: 0, parentId: null };
        cache.set(messageId, fallback);
        return fallback;
      }

      const parentId = resolveReplyParentId(current);
      if (!parentId) {
        const root = { depth: 0, parentId: null };
        cache.set(messageId, root);
        return root;
      }

      if (visited.has(messageId)) {
        const looped = { depth: 1, parentId };
        cache.set(messageId, looped);
        return looped;
      }

      visited.add(messageId);
      const parent = messageById.get(parentId);
      if (!parent) {
        const unresolved = { depth: 1, parentId };
        cache.set(messageId, unresolved);
        visited.delete(messageId);
        return unresolved;
      }

      const parentLayout = resolve(parent.id, visited);
      const computed = {
        depth: Math.min(MAX_REPLY_NEST_DEPTH, parentLayout.depth + 1),
        parentId,
      };
      cache.set(messageId, computed);
      visited.delete(messageId);
      return computed;
    };

    for (const message of messages) {
      resolve(message.id, new Set<string>());
    }
    return cache;
  }, [messages, messageById]);

  // Build flat row list for virtualization
  const rows: VirtualRow[] = useMemo(() => {
    const result: VirtualRow[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const prevMsg = i > 0 ? messages[i - 1] : null;
      const currLayout = replyLayoutById.get(msg.id);
      const prevLayout = prevMsg ? replyLayoutById.get(prevMsg.id) : undefined;
      let currDepth = currLayout?.depth ?? 0;
      let currParentId = currLayout?.parentId ?? null;
      const msgType = msg.message_type ?? msg.type;
      if (!currParentId && currDepth === 0 && prevMsg && msgType === MessageType.Reply) {
        currDepth = 1;
        currParentId = prevMsg.id;
      }
      const prevDepth = prevLayout?.depth ?? 0;
      const isGrouped =
        currDepth === 0 &&
        prevDepth === 0 &&
        shouldGroup(prevMsg, msg);
      const showDateSep = prevMsg && isDifferentDay(getTimestamp(prevMsg), getTimestamp(msg));

      if (showDateSep) {
        result.push({ type: 'date-separator', date: getTimestamp(msg) });
      }

      result.push({
        type: 'message',
        message: msg,
        messageIndex: i,
        isGrouped,
        replyDepth: currDepth,
        replyParentId: currParentId,
      });
    }

    if (activeTyping.length > 0) {
      result.push({ type: 'typing' });
    }

    result.push({ type: 'bottom-sentinel' });
    return result;
  }, [messages, activeTyping.length, replyLayoutById]);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 140;
  }, []);

  const readStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markLatestRead = useCallback(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage?.id || lastReadStateMessageIdRef.current === lastMessage.id) return;
    lastReadStateMessageIdRef.current = lastMessage.id;
    if (readStateTimerRef.current) clearTimeout(readStateTimerRef.current);
    readStateTimerRef.current = setTimeout(() => {
      channelApi.updateReadState(channelId, lastMessage.id).then(() => {
        window.dispatchEvent(new CustomEvent('paracord:read-state-updated'));
      }).catch(() => {
        /* ignore */
      });
    }, 500);
  }, [messages, channelId]);

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row.type === 'welcome') return 120;
      if (row.type === 'date-separator') return 48;
      if (row.type === 'typing') return 36;
      if (row.type === 'bottom-sentinel') return 1;
      // message row
      return row.isGrouped ? 28 : 60;
    },
    overscan: 10,
    measureElement: (el) => {
      if (!el) return 0;
      return el.getBoundingClientRect().height;
    },
  });

  useEffect(() => {
    hasHydratedChannelRef.current = false;
    lastReadStateMessageIdRef.current = null;
    prevMessagesLenRef.current = 0;
    setShowScrollButton(false);
    setThreadModalForMessageId(null);
    setThreadCreateError(null);
    setThreadName('');
    setBulkDeleteMode(false);
    setSelectedMessageIds([]);
    setBulkDeleting(false);
    setAttachmentBusyId(null);
  }, [channelId]);

  useEffect(() => {
    const shouldHydrateThreads =
      Boolean(activeGuildId) &&
      (activeChannelType === 0 || activeChannelType === 5 || activeChannelType === 7);
    if (!shouldHydrateThreads) return;
    const lastHydrated = _threadHydratedAt.get(channelId) ?? 0;
    if (Date.now() - lastHydrated < THREAD_CACHE_TTL_MS) return;
    let cancelled = false;
    const hydrateThreads = async () => {
      try {
        const [activeRes, archivedRes] = await Promise.all([
          channelApi.getThreads(channelId),
          channelApi.getArchivedThreads(channelId),
        ]);
        if (cancelled) return;
        _threadHydratedAt.set(channelId, Date.now());
        const upsertChannel = useChannelStore.getState();
        for (const thread of [...activeRes.data, ...archivedRes.data]) {
          upsertChannel.addChannel(thread);
          upsertChannel.updateChannel(thread);
        }
      } catch {
        // Threads already available in guild channel payload for many servers.
      }
    };
    void hydrateThreads();
    return () => {
      cancelled = true;
    };
  }, [channelId, activeGuildId, activeChannelType]);

  // Scroll to bottom on new messages / initial load
  useEffect(() => {
    if (!messages.length) return;

    // If we just loaded older messages (prepend), don't scroll
    if (isLoadingMoreRef.current) {
      isLoadingMoreRef.current = false;
      prevMessagesLenRef.current = messages.length;
      return;
    }

    const shouldStickToBottom = !hasHydratedChannelRef.current || isNearBottom();
    if (shouldStickToBottom) {
      // Scroll to last row (bottom-sentinel)
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(rows.length - 1, {
          align: 'end',
          behavior: hasHydratedChannelRef.current ? 'smooth' : 'auto',
        });
      });
      markLatestRead();
      setShowScrollButton(false);
    } else {
      setShowScrollButton(true);
    }
    hasHydratedChannelRef.current = true;
    prevMessagesLenRef.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    if (!window.location.hash.startsWith('#msg-')) return;
    const msgId = window.location.hash.slice(5); // strip '#msg-'
    const rowIndex = rows.findIndex(
      (r) => r.type === 'message' && r.message.id === msgId
    );
    if (rowIndex >= 0) {
      virtualizer.scrollToIndex(rowIndex, { align: 'center', behavior: 'smooth' });
    }
  }, [messages.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(hover: none), (pointer: coarse)');
    const updatePointerMode = () => setIsCoarsePointer(mediaQuery.matches);
    updatePointerMode();
    mediaQuery.addEventListener('change', updatePointerMode);
    return () => mediaQuery.removeEventListener('change', updatePointerMode);
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom <= 140;
    setShowScrollButton(!nearBottom && distanceFromBottom > 200);
    if (nearBottom) {
      markLatestRead();
    }

    // Load older messages when scrolled near top
    if (scrollTop < 200 && hasMore && !isLoading) {
      isLoadingMoreRef.current = true;
      loadMore();
    }
  }, [hasMore, isLoading, loadMore, markLatestRead]);

  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end', behavior: 'smooth' });
    markLatestRead();
    setShowScrollButton(false);
  }, [virtualizer, rows.length, markLatestRead]);

  const scrollToMessage = useCallback((messageId: string) => {
    const rowIndex = rows.findIndex(
      (entry) => entry.type === 'message' && entry.message.id === messageId
    );
    if (rowIndex < 0) return;
    virtualizer.scrollToIndex(rowIndex, { align: 'center', behavior: 'smooth' });
  }, [rows, virtualizer]);

  const openReactionPicker = (e: React.MouseEvent, messageId: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setEmojiPickerFor({
      messageId,
      position: { x: rect.left, y: rect.bottom + 4 },
    });
  };

  const handleReactionSelect = async (emoji: string) => {
    if (!emojiPickerFor) return;
    const msgId = emojiPickerFor.messageId;
    setEmojiPickerFor(null);
    try {
      await addReaction(channelId, msgId, emoji);
    } catch {
      // non-fatal
    }
  };

  const startEditingMessage = (msg: Message) => {
    setEditingMessageId(msg.id);
    setEditContent(msg.content || '');
    setMenuMessageId(null);
  };

  const cancelEditing = () => {
    setEditingMessageId(null);
    setEditContent('');
  };

  const saveEditMessage = async () => {
    if (!editingMessageId) return;
    const trimmed = editContent.trim();
    if (!trimmed) return;
    const msg = messages.find((m) => m.id === editingMessageId);
    if (trimmed === (msg?.content || '')) {
      cancelEditing();
      return;
    }
    try {
      await editMessage(channelId, editingMessageId, trimmed);
    } catch {
      // keep editing state so user can retry
      return;
    }
    cancelEditing();
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void saveEditMessage();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    await deleteMessage(channelId, messageId);
    setMenuMessageId(null);
    setDeleteConfirmId(null);
  };

  const toggleBulkSelection = (messageId: string) => {
    setSelectedMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId]
    );
  };

  const cancelBulkDelete = () => {
    setBulkDeleteMode(false);
    setSelectedMessageIds([]);
  };

  const executeBulkDelete = async () => {
    if (!selectedMessageIds.length || bulkDeleting) return;
    if (!(await confirm({ title: `Delete ${selectedMessageIds.length} selected messages?`, description: 'This action cannot be undone.', confirmLabel: 'Delete', variant: 'danger' }))) return;
    setBulkDeleting(true);
    try {
      await channelApi.bulkDeleteMessages(channelId, selectedMessageIds);
      setMessages(
        channelId,
        messages.filter((message) => !selectedMessageIds.includes(message.id))
      );
      toast.success(
        `Deleted ${selectedMessageIds.length} message${selectedMessageIds.length === 1 ? '' : 's'}.`
      );
      cancelBulkDelete();
    } catch (err) {
      toast.error(`Failed to bulk delete: ${extractApiError(err)}`);
    } finally {
      setBulkDeleting(false);
    }
  };

  const requestDelete = (messageId: string) => {
    setDeleteConfirmId(messageId);
    setMenuMessageId(null);
  };

  const openAuthorProfile = (event: MouseEvent<HTMLElement>, msg: Message) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setProfilePos({ x: rect.left, y: rect.top });
    setProfileUser(msg.author);
  };

  const openCreateThreadDialog = (msg: Message) => {
    if (!canCreateThreads) return;
    const baseName = (msg.content || '').replace(/\s+/g, ' ').trim();
    const nextName = baseName ? baseName.slice(0, 80) : 'New Thread';
    setThreadModalForMessageId(msg.id);
    setThreadName(nextName);
    setThreadCreateError(null);
    setMenuMessageId(null);
  };

  const downloadAttachment = async (attachmentId: string, filename: string) => {
    if (attachmentBusyId) return;
    setAttachmentBusyId(attachmentId);
    try {
      const { data } = await fileApi.download(attachmentId);
      const blob = data as Blob;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      toast.error(`Failed to download attachment: ${extractApiError(err)}`);
    } finally {
      setAttachmentBusyId(null);
    }
  };

  const deleteAttachment = async (messageId: string, attachmentId: string) => {
    if (attachmentBusyId) return;
    if (!(await confirm({ title: 'Delete this attachment?', confirmLabel: 'Delete', variant: 'danger' }))) return;
    setAttachmentBusyId(attachmentId);
    try {
      await fileApi.delete(attachmentId);
      setMessages(
        channelId,
        messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                attachments: (message.attachments || []).filter((attachment) => attachment.id !== attachmentId),
              }
            : message
        )
      );
      toast.success('Attachment deleted.');
    } catch (err) {
      toast.error(`Failed to delete attachment: ${extractApiError(err)}`);
    } finally {
      setAttachmentBusyId(null);
    }
  };

  const openLinkedThread = (threadId: string) => {
    if (!activeGuildId) return;
    useChannelStore.getState().selectChannel(threadId);
    navigate(`/app/guilds/${activeGuildId}/channels/${threadId}`);
  };

  const submitCreateThread = async () => {
    if (!canCreateThreads || !threadModalForMessageId || !activeGuildId) return;
    const trimmed = threadName.trim();
    if (!trimmed || trimmed.length > 100) {
      setThreadCreateError('Thread name must be between 1 and 100 characters.');
      return;
    }
    setThreadCreateError(null);
    try {
      const { data: thread } = await channelApi.createThread(channelId, {
        name: trimmed,
        message_id: threadModalForMessageId,
      });
      useChannelStore.getState().addChannel(thread);
      useChannelStore.getState().selectChannel(thread.id);
      setThreadModalForMessageId(null);
      setThreadName('');
      navigate(`/app/guilds/${activeGuildId}/channels/${thread.id}`);
    } catch (err) {
      const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
      setThreadCreateError(responseData?.message || responseData?.error || 'Failed to create thread.');
    }
  };

  const buildMessageContextMenuItems = (msg: Message): ContextMenuItem[] => {
    const isOwnMessage = msg.author.id === me;
    const canEditMsg = isOwnMessage;
    const canDeleteMsg = isOwnMessage || canManageMessages;
    const canPinMsg = canManageMessages || !activeChannel?.guild_id;
    const items: ContextMenuItem[] = [];

    if (onReply) {
      items.push({
        label: 'Reply',
        icon: <Reply size={14} />,
        action: () => onReply(msg),
      });
    }

    if (canCreateThreads) {
      items.push({
        label: 'Create Thread',
        icon: <Hash size={14} />,
        action: () => openCreateThreadDialog(msg),
      });
    }

    items.push({
      label: 'React',
      icon: <Smile size={14} />,
      action: () => {
        setEmojiPickerFor({
          messageId: msg.id,
          position: {
            x: contextMenuAnchor.x + 4,
            y: contextMenuAnchor.y + 4,
          },
        });
      },
    });

    if (canEditMsg) {
      items.push({
        label: 'Edit Message',
        icon: <Pencil size={14} />,
        action: () => startEditingMessage(msg),
      });
    }

    if (canPinMsg) {
      items.push({
        label: msg.pinned ? 'Unpin Message' : 'Pin Message',
        icon: msg.pinned ? <PinOff size={14} /> : <Pin size={14} />,
        action: async () => {
          try {
            if (msg.pinned) {
              await unpinMessage(channelId, msg.id);
            } else {
              await pinMessage(channelId, msg.id);
            }
          } catch {
            // non-fatal
          }
        },
      });
    }

    items.push({ label: '', action: () => {}, divider: true });

    items.push({
      label: 'Copy Text',
      icon: <Copy size={14} />,
      action: () => {
        navigator.clipboard?.writeText(msg.content || '');
      },
    });

    items.push({
      label: 'Copy Message ID',
      icon: <Clipboard size={14} />,
      action: () => {
        navigator.clipboard?.writeText(msg.id);
      },
    });

    if (canDeleteMsg) {
      items.push({ label: '', action: () => {}, divider: true });
      items.push({
        label: 'Delete Message',
        icon: <Trash2 size={14} />,
        danger: true,
        action: () => requestDelete(msg.id),
      });
    }

    if (canManageMessages) {
      items.push({ label: '', action: () => {}, divider: true });
      items.push({
        label: bulkDeleteMode ? 'Cancel Bulk Delete' : 'Bulk Delete Messages',
        icon: <Trash2 size={14} />,
        danger: bulkDeleteMode,
        action: () => {
          if (bulkDeleteMode) {
            cancelBulkDelete();
          } else {
            setBulkDeleteMode(true);
            setSelectedMessageIds([]);
          }
        },
      });
    }

    return items;
  };

  const handleMessageContextMenu = (e: React.MouseEvent, msg: Message) => {
    setContextMenuAnchor({ x: e.clientX, y: e.clientY });
    onContextMenu(e, buildMessageContextMenuItems(msg));
  };

  // Render a single virtual row
  const renderRow = (row: VirtualRow) => {
    if (row.type === 'welcome') {
      return (
        <div className="mb-7 rounded-2xl border border-border-subtle bg-bg-mod-subtle/60 p-4">
          <div
            className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle"
          >
            <Hash size={28} style={{ color: 'var(--text-muted)' }} />
          </div>
          <h3 className="text-[1.35rem] font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
            Welcome to the channel!
          </h3>
          <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            This is the beginning of the channel.
          </p>
        </div>
      );
    }

    if (row.type === 'date-separator') {
      return (
        <div className="my-5 flex items-center gap-2">
          <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />
          <span className="rounded-full border border-border-subtle bg-bg-mod-subtle px-3 py-1 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
            {formatDate(row.date)}
          </span>
          <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />
        </div>
      );
    }

    if (row.type === 'typing') {
      const guildId = activeChannel?.guild_id;
      const guildMembers = guildId ? allMembers.get(guildId) : null;
      const resolveUsername = (userId: string): string => {
        if (guildMembers) {
          const member = guildMembers.find((m) => m.user.id === userId);
          if (member) return member.nick || member.user.username;
        }
        return 'Someone';
      };

      const names = activeTyping.map(resolveUsername);
      return (
        <div className="px-3 py-2.5 text-sm" style={{ color: 'var(--text-muted)' }}>
          {names.length === 1 && <><strong>{names[0]}</strong> is typing...</>}
          {names.length === 2 && <><strong>{names[0]}</strong> and <strong>{names[1]}</strong> are typing...</>}
          {names.length === 3 && <><strong>{names[0]}</strong>, <strong>{names[1]}</strong>, and <strong>{names[2]}</strong> are typing...</>}
          {names.length > 3 && <>{names.length} people are typing...</>}
        </div>
      );
    }

    if (row.type === 'bottom-sentinel') {
      return <div style={{ height: 1 }} />;
    }

    // Message row
    const msg = row.message;
    const isGrouped = row.isGrouped;
    const replyDepth = row.replyDepth;
    const replyParentId = row.replyParentId;
    const replyParentMessage = replyParentId ? messageById.get(replyParentId) : undefined;
    const replyIndent = Math.min(replyDepth, MAX_REPLY_NEST_DEPTH) * REPLY_INDENT_PX;
    const isOwnMessage = msg.author.id === me;
    const canEditMessage = isOwnMessage;
    const canDeleteMessage = isOwnMessage || canManageMessages;
    const canPinMessage = canManageMessages || !activeChannel?.guild_id;
    const canOpenMessageMenu = canEditMessage || canDeleteMessage || canPinMessage || canCreateThreads;
    const linkedThreads = linkedThreadsByStarterMessageId[msg.id] ?? [];

    return (
      <div
        id={`msg-${msg.id}`}
        role="article"
        aria-label={`Message from ${msg.author.username}`}
        className="group relative -mx-1.5 flex gap-3.5 rounded-2xl px-2.5 py-1.5 transition-colors sm:-mx-2.5 sm:gap-4 sm:px-3"
        style={{
          marginTop: isGrouped ? '2px' : replyDepth > 0 ? '0.5rem' : '1.35rem',
          paddingLeft: replyIndent > 0 ? `${replyIndent}px` : undefined,
          backgroundColor: hoveredMessageId === msg.id ? 'var(--bg-mod-subtle)' : 'transparent',
        }}
        onMouseEnter={() => setHoveredMessageId(msg.id)}
        onMouseLeave={() => setHoveredMessageId(null)}
        onContextMenu={(e) => handleMessageContextMenu(e, msg)}
      >
        {replyDepth > 0 && (
          <div className="pointer-events-none absolute inset-y-0 left-0">
            {Array.from({ length: replyDepth }).map((_, depthIndex) => (
              <div
                key={`${msg.id}-reply-guide-${depthIndex}`}
                className="absolute inset-y-0 border-l"
                style={{
                  left: `${depthIndex * REPLY_INDENT_PX + 10}px`,
                  borderColor: 'var(--border-subtle)',
                  opacity: depthIndex === replyDepth - 1 ? 0.55 : 0.28,
                }}
              />
            ))}
          </div>
        )}
        {isGrouped ? (
          <div className="flex w-12 flex-shrink-0 items-start justify-center pt-0.5">
            <span
              className="font-mono text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
              style={{ color: 'var(--text-muted)' }}
            >
              {new Date(getTimestamp(msg)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        ) : (
          <div className="flex h-12 w-12 flex-shrink-0 cursor-pointer items-center justify-center rounded-2xl text-sm font-semibold text-white shadow-sm"
            style={{ backgroundColor: 'var(--accent-primary)' }}
            onClick={(e) => openAuthorProfile(e, msg)}
          >
            {msg.author.username.charAt(0).toUpperCase()}
          </div>
        )}

        {bulkDeleteMode && canManageMessages && (
          <div className="flex items-start pt-1">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-accent-danger"
              checked={selectedMessageIds.includes(msg.id)}
              onChange={() => toggleBulkSelection(msg.id)}
              aria-label={`Select message ${msg.id} for bulk delete`}
            />
          </div>
        )}

        <div className="flex-1 min-w-0 pr-8 sm:pr-0">
          {replyParentId && (
            <div className="mb-0.5 flex items-center gap-1">
              <span
                className="h-3.5 w-3 shrink-0 rounded-bl-sm border-b border-l"
                style={{ borderColor: 'var(--border-subtle)', opacity: 0.65 }}
              />
              <button
                type="button"
                onClick={() => scrollToMessage(replyParentId)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-bg-mod-subtle"
                style={{ color: 'var(--text-muted)' }}
                title="Jump to replied message"
              >
                <Reply size={11} className="shrink-0" />
                <span className="max-w-[8rem] truncate font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  {replyParentMessage?.author.username || 'Original message'}
                </span>
                <span className="truncate">
                  {replyParentMessage ? getReplyPreviewText(replyParentMessage) : 'Message not loaded'}
                </span>
              </button>
            </div>
          )}
          {!isGrouped && (
            <div className="flex items-baseline gap-2">
              <span
                className="cursor-pointer text-[15px] font-semibold hover:underline"
                style={{ color: 'var(--text-primary)' }}
                onClick={(e) => openAuthorProfile(e, msg)}
              >
                {msg.author.username}
              </span>
              {msg.author.bot && (
                <span className="rounded-md border border-accent-primary/35 bg-accent-primary/12 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-primary">
                  Bot
                </span>
              )}
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {formatTimestamp(getTimestamp(msg))}
              </span>
              {(msg.edited_timestamp || msg.edited_at) && (
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }} title={`Edited: ${formatTimestamp(msg.edited_timestamp || msg.edited_at || '')}`}>
                  (edited)
                </span>
              )}
            </div>
          )}
          {editingMessageId === msg.id ? (
            <div className="mt-0.5">
              <textarea
                autoFocus
                className="w-full resize-none rounded-lg border border-border-subtle bg-bg-primary/80 px-3 py-2 text-[15px] leading-[1.48rem] outline-none focus:border-accent-primary/60"
                style={{ color: 'var(--text-secondary)', minHeight: '2.5rem', maxHeight: '50vh' }}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onKeyDown={handleEditKeyDown}
                rows={1}
                ref={(el) => {
                  if (el) {
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.5) + 'px';
                  }
                }}
              />
              <div className="mt-1 flex items-center gap-2">
                <button
                  onClick={() => void saveEditMessage()}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors hover:bg-accent-primary/15"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <Check size={12} /> Save
                </button>
                <button
                  onClick={cancelEditing}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors hover:bg-bg-mod-subtle"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <XIcon size={12} /> Cancel
                </button>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Enter to save, Esc to cancel
                </span>
              </div>
            </div>
          ) : (
            <>
              {!msg.poll && decryptingIds.has(msg.id) ? (
                <div className="flex flex-col gap-1.5 py-0.5" aria-label="Decrypting message">
                  <div className="h-3.5 w-3/4 animate-pulse rounded bg-text-muted/10" />
                  <div className="h-3.5 w-1/2 animate-pulse rounded bg-text-muted/10" />
                </div>
              ) : !msg.poll ? (
                <div className="break-words text-[15px]" style={{ color: 'var(--text-primary)', lineHeight: '1.58rem' }}>
                  {parseMarkdown(msg.content || '', activeGuildId || undefined)}
                  {isGrouped && (msg.edited_timestamp || msg.edited_at) && (
                    <span className="ml-1 text-[11px]" style={{ color: 'var(--text-muted)' }} title={`Edited: ${formatTimestamp(msg.edited_timestamp || msg.edited_at || '')}`}>
                      (edited)
                    </span>
                  )}
                </div>
              ) : (
                <PollMessageCard
                  channelId={channelId}
                  poll={msg.poll}
                  canVote={canVoteInPolls}
                />
              )}
            </>
          )}

          {/* GitHub webhook embed */}
          {isGitHubWebhookMessage(msg) && (
            <GitHubEventEmbed content={msg.content || ''} />
          )}

          {/* URL Embeds — server-provided or client-extracted */}
          {(() => {
            const embeds = msg.embeds || [];
            const contentUrls = embeds.length === 0 ? extractUrls(msg.content) : [];
            const allEmbeds = embeds.length > 0
              ? embeds
              : contentUrls.slice(0, 3).map((url) => ({ url }));
            if (allEmbeds.length === 0) return null;
            return (
              <div className="flex flex-col gap-1">
                {allEmbeds.map((embed) => (
                  <MessageEmbedCard key={embed.url} embed={embed} />
                ))}
              </div>
            );
          })()}

          {linkedThreads.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {linkedThreads.map((thread) => {
                const isArchived = Boolean(thread.thread_metadata?.archived);
                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => openLinkedThread(thread.id)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-bg-mod-subtle/65 px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-border-subtle/80 hover:bg-bg-mod-strong hover:text-text-primary"
                  >
                    <MessageSquare size={12} />
                    <span className="max-w-[14rem] truncate">{thread.name || 'Thread'}</span>
                    {isArchived && (
                      <span className="rounded-full border border-border-subtle px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                        Archived
                      </span>
                    )}
                    <ArrowRight size={11} />
                  </button>
                );
              })}
            </div>
          )}
          {/* Reactions */}
          {msg.reactions && Array.isArray(msg.reactions) && msg.reactions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {(msg.reactions as Array<{emoji: string; count: number; me: boolean}>).map((r, reactionIndex) => {
                const parsedCustomEmoji = activeGuildId ? parseCustomEmojiToken(r.emoji) : null;
                return (
                <button
                  key={`${r.emoji}-${reactionIndex}`}
                  onClick={async () => {
                    try {
                      if (r.me) {
                        await removeReaction(channelId, msg.id, r.emoji);
                      } else {
                        await addReaction(channelId, msg.id, r.emoji);
                      }
                    } catch {
                      // API errors are non-fatal for reactions
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors hover:bg-bg-mod-subtle"
                  style={{
                    borderColor: r.me ? 'var(--accent-primary)' : 'var(--border-subtle)',
                    backgroundColor: r.me ? 'rgba(111, 134, 255, 0.15)' : 'transparent',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>
                    {parsedCustomEmoji && activeGuildId ? (
                      <img
                        src={buildGuildEmojiImageUrl(activeGuildId, parsedCustomEmoji.id)}
                        alt={parsedCustomEmoji.name}
                        title={`:${parsedCustomEmoji.name}:`}
                        style={{ width: 18, height: 18, objectFit: 'contain' }}
                        loading="lazy"
                      />
                    ) : (
                      r.emoji
                    )}
                  </span>
                  <span className="font-medium">{r.count}</span>
                </button>
              )})}
            </div>
          )}
          {/* Attachments */}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-2">
              {msg.attachments.map((att) => {
                const src = resolveAttachmentUrl(att.url);
                const attachmentIsImage = isImageAttachment(att);
                if (attachmentIsImage) {
                  const imageAttachments = msg.attachments!.filter(isImageAttachment);
                  const openImageLightbox = () => {
                    const lightboxImages: LightboxImage[] = imageAttachments.map((imageAtt) => ({
                      src: resolveAttachmentUrl(imageAtt.url),
                      alt: imageAtt.filename,
                      filename: imageAtt.filename,
                    }));
                    const imageIndex = imageAttachments.findIndex((a) => a.id === att.id);
                    useLightboxStore.getState().open(lightboxImages, imageIndex >= 0 ? imageIndex : 0);
                  };
                  return (
                    <div key={att.id} className="inline-flex max-w-fit flex-col gap-1.5">
                      <button
                        type="button"
                        className="inline-block max-w-fit cursor-pointer border-0 bg-transparent p-0 text-left"
                        onClick={() => void openImageLightbox()}
                      >
                        <img
                          src={src}
                          alt={att.filename}
                          className="max-w-[min(100%,400px)] rounded-lg border border-border-subtle"
                          style={{ maxHeight: '300px', objectFit: 'contain' }}
                        />
                      </button>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="rounded-md border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => void openImageLightbox()}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => void downloadAttachment(att.id, att.filename)}
                          disabled={attachmentBusyId === att.id}
                        >
                          {attachmentBusyId === att.id ? 'Downloading...' : 'Download'}
                        </button>
                        {isOwnMessage && (
                          <button
                            type="button"
                            className="rounded-md border border-accent-danger/30 bg-accent-danger/10 px-2.5 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
                            onClick={() => void deleteAttachment(msg.id, att.id)}
                            disabled={attachmentBusyId === att.id}
                          >
                            {attachmentBusyId === att.id ? 'Deleting...' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                }
                return (
                  <div
                    key={att.id}
                    className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm"
                    style={{ maxWidth: 'fit-content' }}
                  >
                    <button
                      type="button"
                      className="max-w-[20rem] truncate text-left text-text-link transition-colors hover:underline"
                      onClick={() => void downloadAttachment(att.id, att.filename)}
                      disabled={attachmentBusyId === att.id}
                    >
                      {att.filename}
                    </button>
                    {att.size && <span className="text-xs text-text-muted">({(att.size / 1024).toFixed(1)} KB)</span>}
                    <button
                      type="button"
                      className="rounded-md border border-border-subtle px-2 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                      onClick={() => void downloadAttachment(att.id, att.filename)}
                      disabled={attachmentBusyId === att.id}
                    >
                      {attachmentBusyId === att.id ? 'Downloading...' : 'Download'}
                    </button>
                    {isOwnMessage && (
                      <button
                        type="button"
                        className="rounded-md border border-accent-danger/30 bg-accent-danger/10 px-2 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
                        onClick={() => void deleteAttachment(msg.id, att.id)}
                        disabled={attachmentBusyId === att.id}
                      >
                        {attachmentBusyId === att.id ? 'Deleting...' : 'Delete'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isCoarsePointer && canOpenMessageMenu && (
          <button
            className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border-subtle bg-bg-floating text-text-muted md:hidden"
            title="Message actions"
            aria-label="Message actions"
            onClick={() => setMenuMessageId((curr) => (curr === msg.id ? null : msg.id))}
          >
            <MoreHorizontal size={14} />
          </button>
        )}

        {hoveredMessageId === msg.id && !isCoarsePointer && (
          <div className="message-actions rounded-xl border border-border-subtle bg-bg-floating p-0.5">
            <button className="hover-action-btn rounded-lg" title="Add Reaction" aria-label="Add Reaction" onClick={(e) => openReactionPicker(e, msg.id)}>
              <Smile size={16} />
            </button>
            <button className="hover-action-btn rounded-lg" title="Reply" aria-label="Reply" onClick={() => onReply?.(msg)}>
              <Reply size={16} />
            </button>
            {canOpenMessageMenu && (
              <button
                className="hover-action-btn rounded-lg"
                title="More actions"
                aria-label="More actions"
                onClick={() => setMenuMessageId((curr) => (curr === msg.id ? null : msg.id))}
              >
                <MoreHorizontal size={16} />
              </button>
            )}
          </div>
        )}
        {menuMessageId === msg.id && canOpenMessageMenu && (
          <div
            className="glass-modal absolute right-1 top-11 z-10 min-w-[10rem] max-w-[calc(100vw-2.75rem)] rounded-xl p-2 sm:right-2"
          >
            <button
              className="context-menu-item w-full text-left"
              onClick={(e) => {
                setMenuMessageId(null);
                openReactionPicker(e, msg.id);
              }}
            >
              Add Reaction
            </button>
            {onReply && (
              <button
                className="context-menu-item w-full text-left"
                onClick={() => {
                  setMenuMessageId(null);
                  onReply(msg);
                }}
              >
                Reply
              </button>
            )}
            {canCreateThreads && (
              <button
                className="context-menu-item w-full text-left"
                onClick={() => openCreateThreadDialog(msg)}
              >
                Create Thread
              </button>
            )}
            {canEditMessage && (
              <button className="context-menu-item w-full text-left" onClick={() => startEditingMessage(msg)}>
                Edit
              </button>
            )}
            {canPinMessage && (
              <button
                className="context-menu-item w-full text-left"
                onClick={async () => {
                  setMenuMessageId(null);
                  try {
                    if (msg.pinned) {
                      await unpinMessage(channelId, msg.id);
                    } else {
                      await pinMessage(channelId, msg.id);
                    }
                  } catch {
                    // pin/unpin errors are non-fatal
                  }
                }}
              >
                {msg.pinned ? 'Unpin' : 'Pin'}
              </button>
            )}
            {canDeleteMessage && (
              <button className="context-menu-item danger w-full text-left" onClick={() => requestDelete(msg.id)}>
                Delete
              </button>
            )}
          </div>
        )}
        {deleteConfirmId === msg.id && (
          <div className="glass-modal absolute right-1 top-11 z-10 rounded-xl p-3 sm:right-2" style={{ minWidth: '220px', maxWidth: 'calc(100vw - 2.75rem)' }}>
            <p className="mb-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Delete message?</p>
            <p className="mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>This action cannot be undone.</p>
            <div className="flex items-center gap-2">
              <button
                className="rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors"
                style={{ backgroundColor: 'var(--accent-danger)', color: '#fff' }}
                onClick={() => void handleDeleteMessage(msg.id)}
              >
                Delete
              </button>
              <button
                className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle"
                onClick={() => setDeleteConfirmId(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto px-2.5 sm:px-5"
        onScroll={handleScroll}
        style={{ overscrollBehavior: 'contain' }}
        role="log"
        aria-live="polite"
        aria-label="Message history"
      >
        {isLoading && messages.length === 0 ? (
          <div className="py-6" aria-label="Loading messages">
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonMessage key={i} />
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <div
              className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle"
            >
              <Hash size={32} style={{ color: 'var(--text-muted)' }} />
            </div>
            <h3 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Welcome to the channel!
            </h3>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              This is the start of the conversation. Say something!
            </p>
          </div>
        ) : (
          <div className="py-6" style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderRow(row)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {threadModalForMessageId && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg-tertiary/75 p-4 backdrop-blur-sm">
          <div className="glass-modal w-full max-w-md rounded-2xl border border-border-subtle p-4 sm:p-5">
            <h3 className="text-base font-semibold text-text-primary">Create Thread</h3>
            <p className="mt-1 text-xs text-text-muted">
              Start a focused discussion from this message.
            </p>
            <label className="mt-4 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Thread Name</span>
              <input
                className="input-field mt-2"
                value={threadName}
                maxLength={100}
                onChange={(e) => setThreadName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreateThread();
                  if (e.key === 'Escape') {
                    setThreadModalForMessageId(null);
                    setThreadCreateError(null);
                  }
                }}
                autoFocus
              />
            </label>
            {threadCreateError && (
              <div className="mt-3 rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-xs font-medium text-accent-danger">
                {threadCreateError}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button className="btn-primary" onClick={() => void submitCreateThread()}>
                Create Thread
              </button>
              <button
                className="rounded-lg px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                onClick={() => {
                  setThreadModalForMessageId(null);
                  setThreadCreateError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-[calc(var(--safe-bottom)+0.75rem)] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-subtle bg-bg-floating px-3.5 py-2 text-xs text-text-primary shadow-lg transition-all hover:bg-bg-mod-subtle sm:gap-2 sm:px-4 sm:text-sm"
          style={{
            backdropFilter: 'blur(12px)',
          }}
        >
          <ArrowDown size={16} />
          New Messages
        </button>
      )}
      {bulkDeleteMode && canManageMessages && (
        <div className="absolute bottom-[calc(var(--safe-bottom)+0.75rem)] left-1/2 z-20 flex w-[min(95%,38rem)] -translate-x-1/2 flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-bg-floating px-3 py-2.5 shadow-lg backdrop-blur-md">
          <span className="text-xs font-semibold text-text-secondary sm:text-sm">
            {selectedMessageIds.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary sm:text-sm"
              onClick={cancelBulkDelete}
              disabled={bulkDeleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-accent-danger px-2.5 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-60 sm:text-sm"
              onClick={() => void executeBulkDelete()}
              disabled={bulkDeleting || selectedMessageIds.length === 0}
            >
              {bulkDeleting ? 'Deleting...' : 'Delete Selected'}
            </button>
          </div>
        </div>
      )}
      {emojiPickerFor && createPortal(
        <EmojiPicker
          position={emojiPickerFor.position}
          onSelect={(emoji) => void handleReactionSelect(emoji)}
          onClose={() => setEmojiPickerFor(null)}
          guildId={activeGuildId || undefined}
        />,
        document.body
      )}
      {profileUser && createPortal(
        <UserProfilePopup
          user={{
            id: profileUser.id,
            username: profileUser.username,
            discriminator: profileUser.discriminator,
            avatar_hash: profileUser.avatar_hash || null,
            display_name: null,
            bot: profileUser.bot ?? false,
            system: false,
            flags: profileUser.flags ?? 0,
            created_at: '',
          }}
          position={profilePos}
          onClose={() => setProfileUser(null)}
        />,
        document.body
      )}
      {contextMenu.isOpen && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
