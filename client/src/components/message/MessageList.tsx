import { useRef, useEffect, useMemo, useState, useReducer, useCallback, type CSSProperties, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowRight, Smile, Reply, MoreHorizontal, Hash, Check, X as XIcon, Pencil, Pin, PinOff, Copy, Clipboard, Trash2, MessageSquare, Send } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMessages } from '../../hooks/useMessages';
import { useTypingStore } from '../../stores/typingStore';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore } from '../../stores/messageStore';
import { useChannelStore } from '../../stores/channelStore';
import { useReadStateStore } from '../../stores/readStateStore';
import { useMemberStore } from '../../stores/memberStore';
import { useUIStore } from '../../stores/uiStore';
import { channelApi } from '../../api/channels';
import { fileApi } from '../../api/files';
import { extractApiError } from '../../api/client';
import { MessageType, Permissions, hasPermission, type Channel, type Member, type Message, type Role } from '../../types';
import { guildApi } from '../../api/guilds';
import { UserProfilePopup } from '../user/UserProfile';
import { EmojiPicker } from '../ui/EmojiPicker';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { usePermissions } from '../../hooks/usePermissions';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { resolveResourceUrl } from '../../lib/config/apiBaseUrl';
import { getDownloadTicket } from '../../lib/downloadTicket';
import { writeClipboardText } from '../../lib/clipboard';
import { SkeletonMessage } from '../ui/Skeleton';
import { parseMarkdown } from '../../lib/markdown';
import { getHighestRoleColor } from '../../lib/colors';
import { formatTimestamp, formatDate } from '../../lib/formatters';
import { useLightboxStore, type LightboxImage } from '../../stores/lightboxStore';
import { confirm } from '../../stores/confirmStore';
import { buildGuildEmojiImageUrl, parseCustomEmojiToken } from '../../lib/customEmoji';
import { isAllowedImageMimeType, safeClientResourceUrl, safeStoredImageDataUrl } from '../../lib/security';
import { MessageEmbedCard, extractUrls } from './MessageEmbed';
import { GitHubEventEmbed, isGitHubWebhookMessage } from './GitHubEventEmbed';
import { PollMessageCard } from './PollMessageCard';
import { EphemeralMessage } from './EphemeralMessage';
import { toast } from '../../stores/toastStore';
import { LoadingSpinner, ErrorBanner } from '../ui/Feedback';
import { Button } from '../ui/Button';

const EMPTY_TYPING: string[] = [];
const EMPTY_CHANNELS: Channel[] = [];
const EMPTY_MEMBERS: Member[] = [];

const MAX_REPLY_NEST_DEPTH = 6;
const REPLY_INDENT_PX = 18;
const THREAD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _threadHydratedAt = new Map<string, number>();
const IMAGE_ATTACHMENT_EXTENSION_RE = /\.(png|jpe?g|gif|webp)$/i;
let lightboxBlobUrls: string[] = [];

function revokeLightboxBlobUrls(): void {
  for (const url of lightboxBlobUrls) {
    URL.revokeObjectURL(url);
  }
  lightboxBlobUrls = [];
}

/**
 * Resolve an attachment URL for use in `<img>` src and similar browser-native
 * fetches.  Uses the dynamic API base and appends a token query parameter for
 * cross-origin requests where cookies won't be sent.
 */
function resolveAttachmentUrl(url: string): string | null {
  const safeRawUrl = safeClientResourceUrl(url);
  if (!safeRawUrl) return null;
  return safeClientResourceUrl(resolveResourceUrl(safeRawUrl, getDownloadTicket()));
}

/**
 * For federated attachments (those with origin_server), route the download
 * through the local federated-files proxy endpoint instead of the normal URL.
 */
function resolveFederatedAttachmentUrl(
  att: { url: string; id: string; origin_server?: string },
  channelId: string,
): string | null {
  if (att.origin_server) {
    const path = `/api/v1/federated-files/${encodeURIComponent(att.origin_server)}/${att.id}?channel_id=${encodeURIComponent(channelId)}`;
    return safeClientResourceUrl(
      resolveResourceUrl(path, getDownloadTicket()),
    );
  }
  return resolveAttachmentUrl(att.url);
}

function ResolvedAttachmentImage({
  url,
  alt,
  className,
  style,
}: {
  url: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const safeRawUrl = safeClientResourceUrl(url);

  useEffect(() => {
    if (!safeRawUrl) return;

    let cancelled = false;
    let blobUrl: string | null = null;

    void fileApi.resolveAttachmentObjectUrl(safeRawUrl).then((src) => {
      if (cancelled) {
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        return;
      }
      if (src.startsWith('blob:')) blobUrl = src;
      setResolvedSrc(src);
    }).catch(() => {
      if (!cancelled) setResolvedSrc(null);
    });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [safeRawUrl]);

  if (!safeRawUrl || !resolvedSrc) {
    return (
      <div
        className="max-w-[min(100%,400px)] rounded-md border border-border-subtle bg-bg-mod-subtle px-3 py-6 text-center text-meta text-text-muted"
        style={{ maxHeight: '300px' }}
      >
        Loading attachment…
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      style={style}
    />
  );
}

function isImageAttachment(att: { content_type?: string; filename: string }): boolean {
  const contentType = (att.content_type || '').toLowerCase();
  if (contentType.startsWith('image/')) return isAllowedImageMimeType(contentType);
  return IMAGE_ATTACHMENT_EXTENSION_RE.test(att.filename);
}

interface MessageListProps {
  channelId: string;
  onReply?: (message: Message) => void;
}

function getTimestamp(msg: { timestamp?: string; created_at?: string }): string {
  return msg.timestamp || msg.created_at || '';
}

export function shouldGroup(prev: { author: { id: string }; timestamp?: string; created_at?: string } | null, curr: { author: { id: string }; timestamp?: string; created_at?: string }): boolean {
  if (!prev) return false;
  if (prev.author.id !== curr.author.id) return false;
  const prevTs = getTimestamp(prev);
  const currTs = getTimestamp(curr);
  if (!prevTs || !currTs) return false;
  const diff = new Date(currTs).getTime() - new Date(prevTs).getTime();
  return diff < 7 * 60 * 1000;
}

export function isDifferentDay(a: string, b: string): boolean {
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

export function resolveReplyParentId(message: Message): string | null {
  const legacyReferencedId = (message as Message & { referenced_message_id?: string }).referenced_message_id;
  const raw = message.reference_id || message.referenced_message?.id || legacyReferencedId || null;
  if (!raw) return null;
  return String(raw);
}

export interface ReplyLayout {
  depth: number;
  parentId: string | null;
}

/**
 * Resolve per-message reply nesting depth and parent id for the whole feed.
 * Iterative resolution is memoized in `cache`; `visited` guards against
 * self-references and cyclic reply chains so a corrupt graph can never cause
 * infinite recursion. Depth is clamped to MAX_REPLY_NEST_DEPTH.
 */
export function computeReplyLayout(messages: Message[]): Map<string, ReplyLayout> {
  const messageById = new Map<string, Message>();
  for (const msg of messages) messageById.set(msg.id, msg);

  const cache = new Map<string, ReplyLayout>();

  const resolve = (messageId: string, visited: Set<string>): ReplyLayout => {
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
}

// Row types for the virtual list
type VirtualRow =
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

// --- Consolidated UI state (useReducer) -------------------------------------
// The message feed carries several loosely-related overlay/dialog state groups.
// They are held in one reducer keyed by slice; each dispatch carries a partial
// patch (or a function of the current slice, for updates that depend on the
// latest value) that is merged into that slice.

interface PopupSlice {
  hoveredMessageId: string | null;
  focusedMessageId: string | null;
  menuMessageId: string | null;
  profileUser: Message['author'] | null;
  profilePos: { x: number; y: number };
  emojiPickerFor: { messageId: string; position: { x: number; y: number } } | null;
  deleteConfirmId: string | null;
  contextMenuAnchor: { x: number; y: number };
}
interface EditSlice {
  editingMessageId: string | null;
  editContent: string;
}
interface ReportSlice {
  reportingMessage: Message | null;
  reportReason: string;
  reportEvidence: string;
  reportSubmitting: boolean;
}
interface ThreadCreateSlice {
  threadModalForMessageId: string | null;
  threadName: string;
  threadCreateError: string | null;
}
interface BulkDeleteSlice {
  bulkDeleteMode: boolean;
  selectedMessageIds: string[];
  bulkDeleting: boolean;
}
interface AttachmentSlice {
  attachmentBusyId: string | null;
  downloadProgress: number | null;
}
interface EditHistorySlice {
  editHistoryMsgId: string | null;
  editHistoryPos: { x: number; y: number };
  editHistoryData: { id: string; content: string; edited_at: string }[];
  editHistoryLoading: boolean;
}

interface MessageListUIState {
  popup: PopupSlice;
  edit: EditSlice;
  report: ReportSlice;
  threadCreate: ThreadCreateSlice;
  bulkDelete: BulkDeleteSlice;
  attachment: AttachmentSlice;
  editHistory: EditHistorySlice;
}

type SlicePatch<S> = Partial<S> | ((prev: S) => Partial<S>);

type MessageListUIAction =
  | { slice: 'popup'; patch: SlicePatch<PopupSlice> }
  | { slice: 'edit'; patch: SlicePatch<EditSlice> }
  | { slice: 'report'; patch: SlicePatch<ReportSlice> }
  | { slice: 'threadCreate'; patch: SlicePatch<ThreadCreateSlice> }
  | { slice: 'bulkDelete'; patch: SlicePatch<BulkDeleteSlice> }
  | { slice: 'attachment'; patch: SlicePatch<AttachmentSlice> }
  | { slice: 'editHistory'; patch: SlicePatch<EditHistorySlice> };

function applySlicePatch<S>(prev: S, patch: SlicePatch<S>): S {
  const resolved = typeof patch === 'function' ? (patch as (p: S) => Partial<S>)(prev) : patch;
  return { ...prev, ...resolved };
}

function messageListUIReducer(state: MessageListUIState, action: MessageListUIAction): MessageListUIState {
  switch (action.slice) {
    case 'popup':
      return { ...state, popup: applySlicePatch(state.popup, action.patch) };
    case 'edit':
      return { ...state, edit: applySlicePatch(state.edit, action.patch) };
    case 'report':
      return { ...state, report: applySlicePatch(state.report, action.patch) };
    case 'threadCreate':
      return { ...state, threadCreate: applySlicePatch(state.threadCreate, action.patch) };
    case 'bulkDelete':
      return { ...state, bulkDelete: applySlicePatch(state.bulkDelete, action.patch) };
    case 'attachment':
      return { ...state, attachment: applySlicePatch(state.attachment, action.patch) };
    case 'editHistory':
      return { ...state, editHistory: applySlicePatch(state.editHistory, action.patch) };
    default:
      return state;
  }
}

const initialMessageListUIState: MessageListUIState = {
  popup: {
    hoveredMessageId: null,
    focusedMessageId: null,
    menuMessageId: null,
    profileUser: null,
    profilePos: { x: 0, y: 0 },
    emojiPickerFor: null,
    deleteConfirmId: null,
    contextMenuAnchor: { x: 0, y: 0 },
  },
  edit: { editingMessageId: null, editContent: '' },
  report: { reportingMessage: null, reportReason: '', reportEvidence: '', reportSubmitting: false },
  threadCreate: { threadModalForMessageId: null, threadName: '', threadCreateError: null },
  bulkDelete: { bulkDeleteMode: false, selectedMessageIds: [], bulkDeleting: false },
  attachment: { attachmentBusyId: null, downloadProgress: null },
  editHistory: { editHistoryMsgId: null, editHistoryPos: { x: 0, y: 0 }, editHistoryData: [], editHistoryLoading: false },
};

export function MessageList({ channelId, onReply }: MessageListProps) {
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const navigate = useNavigate();
  const { messages, isLoading, hasMore, loadMore, error } = useMessages(channelId);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const deleteMessage = useMessageStore((s) => s.deleteMessage);
  const editMessage = useMessageStore((s) => s.editMessage);
  const pinMessage = useMessageStore((s) => s.pinMessage);
  const unpinMessage = useMessageStore((s) => s.unpinMessage);
  const setMessages = useMessageStore((s) => s.setMessages);
  const decryptingIds = useMessageStore((s) => s.decryptingIds);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const activeChannel = useChannelStore((s) => s.channelsById[channelId]);
  const typingUsers = useTypingStore((s) => s.typingByChannel[channelId] ?? EMPTY_TYPING);
  const me = useAuthStore((s) => s.user?.id);
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

  // All overlay/dialog UI state lives in one reducer; slice setters below are
  // thin wrappers over dispatch that keep the previous call-site API intact.
  const [uiState, dispatchUI] = useReducer(messageListUIReducer, initialMessageListUIState);

  // Popup/overlay slice
  const { hoveredMessageId, focusedMessageId, menuMessageId, profileUser, profilePos, emojiPickerFor, deleteConfirmId, contextMenuAnchor } = uiState.popup;
  const setHoveredMessageId = (hoveredMessageId: string | null) =>
    dispatchUI({ slice: 'popup', patch: { hoveredMessageId } });
  const setFocusedMessageId = (value: string | null | ((curr: string | null) => string | null)) =>
    dispatchUI({ slice: 'popup', patch: (s) => ({ focusedMessageId: typeof value === 'function' ? value(s.focusedMessageId) : value }) });
  const setMenuMessageId = (value: string | null | ((curr: string | null) => string | null)) =>
    dispatchUI({ slice: 'popup', patch: (s) => ({ menuMessageId: typeof value === 'function' ? value(s.menuMessageId) : value }) });
  const setProfileUser = (profileUser: Message['author'] | null) =>
    dispatchUI({ slice: 'popup', patch: { profileUser } });
  const setProfilePos = (profilePos: { x: number; y: number }) =>
    dispatchUI({ slice: 'popup', patch: { profilePos } });
  const setEmojiPickerFor = (emojiPickerFor: { messageId: string; position: { x: number; y: number } } | null) =>
    dispatchUI({ slice: 'popup', patch: { emojiPickerFor } });
  const setDeleteConfirmId = (deleteConfirmId: string | null) =>
    dispatchUI({ slice: 'popup', patch: { deleteConfirmId } });
  const setContextMenuAnchor = (contextMenuAnchor: { x: number; y: number }) =>
    dispatchUI({ slice: 'popup', patch: { contextMenuAnchor } });

  // Inline edit slice
  const { editingMessageId, editContent } = uiState.edit;
  const setEditingMessageId = (editingMessageId: string | null) =>
    dispatchUI({ slice: 'edit', patch: { editingMessageId } });
  const setEditContent = (editContent: string) =>
    dispatchUI({ slice: 'edit', patch: { editContent } });

  // Report slice
  const { reportingMessage, reportReason, reportEvidence, reportSubmitting } = uiState.report;
  const setReportingMessage = (reportingMessage: Message | null) =>
    dispatchUI({ slice: 'report', patch: { reportingMessage } });
  const setReportReason = (reportReason: string) =>
    dispatchUI({ slice: 'report', patch: { reportReason } });
  const setReportEvidence = (reportEvidence: string) =>
    dispatchUI({ slice: 'report', patch: { reportEvidence } });
  const setReportSubmitting = (reportSubmitting: boolean) =>
    dispatchUI({ slice: 'report', patch: { reportSubmitting } });
  const reportDialogRef = useRef<HTMLDivElement>(null);

  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();

  // Thread-create slice
  const { threadModalForMessageId, threadName, threadCreateError } = uiState.threadCreate;
  const setThreadModalForMessageId = (threadModalForMessageId: string | null) =>
    dispatchUI({ slice: 'threadCreate', patch: { threadModalForMessageId } });
  const setThreadName = (threadName: string) =>
    dispatchUI({ slice: 'threadCreate', patch: { threadName } });
  const setThreadCreateError = (threadCreateError: string | null) =>
    dispatchUI({ slice: 'threadCreate', patch: { threadCreateError } });
  const threadCreateDialogRef = useRef<HTMLDivElement>(null);
  const closeThreadCreateDialog = useCallback(() => {
    dispatchUI({ slice: 'threadCreate', patch: { threadModalForMessageId: null, threadCreateError: null } });
  }, []);
  const closeReportDialog = useCallback(() => {
    dispatchUI({ slice: 'report', patch: { reportingMessage: null } });
  }, []);
  useFocusTrap(threadCreateDialogRef, Boolean(threadModalForMessageId), closeThreadCreateDialog);
  useFocusTrap(reportDialogRef, Boolean(reportingMessage), closeReportDialog);

  // Bulk-delete slice
  const { bulkDeleteMode, selectedMessageIds, bulkDeleting } = uiState.bulkDelete;
  const setBulkDeleteMode = (bulkDeleteMode: boolean) =>
    dispatchUI({ slice: 'bulkDelete', patch: { bulkDeleteMode } });
  const setSelectedMessageIds = (value: string[] | ((current: string[]) => string[])) =>
    dispatchUI({ slice: 'bulkDelete', patch: (s) => ({ selectedMessageIds: typeof value === 'function' ? value(s.selectedMessageIds) : value }) });
  const setBulkDeleting = (bulkDeleting: boolean) =>
    dispatchUI({ slice: 'bulkDelete', patch: { bulkDeleting } });

  // Attachment slice
  const { attachmentBusyId, downloadProgress } = uiState.attachment;
  const setAttachmentBusyId = (attachmentBusyId: string | null) =>
    dispatchUI({ slice: 'attachment', patch: { attachmentBusyId } });
  const setDownloadProgress = (downloadProgress: number | null) =>
    dispatchUI({ slice: 'attachment', patch: { downloadProgress } });

  // Edit-history slice
  const { editHistoryMsgId, editHistoryPos, editHistoryData, editHistoryLoading } = uiState.editHistory;
  const setEditHistoryMsgId = (editHistoryMsgId: string | null) =>
    dispatchUI({ slice: 'editHistory', patch: { editHistoryMsgId } });
  const setEditHistoryPos = (editHistoryPos: { x: number; y: number }) =>
    dispatchUI({ slice: 'editHistory', patch: { editHistoryPos } });
  const setEditHistoryData = (editHistoryData: { id: string; content: string; edited_at: string }[]) =>
    dispatchUI({ slice: 'editHistory', patch: { editHistoryData } });
  const setEditHistoryLoading = (editHistoryLoading: boolean) =>
    dispatchUI({ slice: 'editHistory', patch: { editHistoryLoading } });
  const [isCoarsePointer, setIsCoarsePointer] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  });
  const [guildRoles, setGuildRoles] = useState<Role[]>([]);
  const hasHydratedChannelRef = useRef(false);
  const lastReadStateMessageIdRef = useRef<string | null>(null);
  const prevMessagesLenRef = useRef(0);
  const isLoadingMoreRef = useRef(false);

  const activeGuildMembers = useMemberStore(
    useCallback(
      (state) => {
        if (!activeGuildId) return EMPTY_MEMBERS;
        return state.members.get(activeGuildId) ?? EMPTY_MEMBERS;
      },
      [activeGuildId],
    ),
  );

  // Build mention map: userId -> display name for @mention rendering.
  // Select only the active guild membership list to avoid rebuilding on unrelated guild updates.
  const mentionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of activeGuildMembers) {
      map.set(member.user.id, member.nick || member.user.username);
    }
    return map;
  }, [activeGuildMembers]);

  const activeGuildMemberById = useMemo(() => {
    const map = new Map<string, Member>();
    for (const member of activeGuildMembers) {
      map.set(member.user.id, member);
    }
    return map;
  }, [activeGuildMembers]);

  useEffect(() => {
    if (!activeGuildId) {
      setGuildRoles([]);
      return;
    }
    guildApi.getRoles(activeGuildId).then(({ data }) => {
      setGuildRoles(data);
    }).catch(() => {
      // non-fatal, role colors will simply not show
    });
  }, [activeGuildId]);

  const messageById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const msg of messages) {
      map.set(msg.id, msg);
    }
    return map;
  }, [messages]);

  const replyLayoutById = useMemo(() => computeReplyLayout(messages), [messages]);

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
        useReadStateStore.getState().markRead(channelId, lastMessage.id);
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

  // Roving-tabindex bookkeeping for the message feed. Only one message row is a
  // tab stop at a time; ArrowUp/Down/Home/End move focus (and the tab stop)
  // between rows so a keyboard user is not forced to tab through every loaded
  // message to reach the composer.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const messageRowNav = useMemo(() => {
    const ids: string[] = [];
    const rowIndexById = new Map<string, number>();
    rows.forEach((r, idx) => {
      if (r.type === 'message') {
        ids.push(r.message.id);
        rowIndexById.set(r.message.id, idx);
      }
    });
    return { ids, rowIndexById };
  }, [rows]);
  // The row that currently owns the tab stop: the last one the user focused if
  // it still exists, otherwise the most recent message.
  const activeRowMessageId = useMemo(() => {
    const { ids, rowIndexById } = messageRowNav;
    if (ids.length === 0) return null;
    if (activeRowId && rowIndexById.has(activeRowId)) return activeRowId;
    return ids[ids.length - 1];
  }, [activeRowId, messageRowNav]);
  const focusMessageRow = useCallback(
    (targetId: string) => {
      const rowIndex = messageRowNav.rowIndexById.get(targetId);
      if (rowIndex == null) return;
      setActiveRowId(targetId);
      virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
      // The target row may be off-screen and unmounted; focus it once the
      // virtualizer has had a chance to render it into the DOM.
      requestAnimationFrame(() => {
        document.getElementById(`msg-${targetId}`)?.focus();
      });
    },
    [messageRowNav, virtualizer]
  );
  const handleMessageRowKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>, msgId: string) => {
      // Only handle navigation when focus is on the row itself, never when it
      // bubbles up from an interior control (edit box, reaction, etc.).
      if (e.target !== e.currentTarget) return;
      const { ids } = messageRowNav;
      const idx = ids.indexOf(msgId);
      if (idx === -1) return;
      let targetIdx: number;
      switch (e.key) {
        case 'ArrowDown':
          targetIdx = Math.min(idx + 1, ids.length - 1);
          break;
        case 'ArrowUp':
          targetIdx = Math.max(idx - 1, 0);
          break;
        case 'Home':
          targetIdx = 0;
          break;
        case 'End':
          targetIdx = ids.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (targetIdx !== idx) focusMessageRow(ids[targetIdx]);
    },
    [messageRowNav, focusMessageRow]
  );

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
    } catch (err) {
      toast.error(`Failed to add reaction: ${extractApiError(err)}`);
    }
  };

  const toggleReaction = async (
    messageId: string,
    reaction: { emoji: string; me: boolean },
  ) => {
    try {
      if (reaction.me) {
        await removeReaction(channelId, messageId, reaction.emoji);
      } else {
        await addReaction(channelId, messageId, reaction.emoji);
      }
    } catch (err) {
      const action = reaction.me ? 'remove' : 'add';
      toast.error(`Failed to ${action} reaction: ${extractApiError(err)}`);
    }
  };

  const togglePin = async (message: Message) => {
    try {
      if (message.pinned) {
        await unpinMessage(channelId, message.id);
      } else {
        await pinMessage(channelId, message.id);
      }
    } catch (err) {
      const action = message.pinned ? 'unpin' : 'pin';
      toast.error(`Failed to ${action} message: ${extractApiError(err)}`);
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
    } catch (err) {
      toast.error(`Failed to edit message: ${extractApiError(err)}`);
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

  const openReportDialog = (msg: Message) => {
    if (!activeGuildId) return;
    setReportingMessage(msg);
    setReportReason('');
    setReportEvidence('');
    setMenuMessageId(null);
  };

  const submitReport = async () => {
    if (!activeGuildId || !reportingMessage) return;
    const reason = reportReason.trim();
    if (!reason) {
      toast.error('Please provide a reason for the report.');
      return;
    }
    const evidence = reportEvidence
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    setReportSubmitting(true);
    try {
      await guildApi.createReport(activeGuildId, {
        target_type: 'message',
        target_id: reportingMessage.id,
        message_id: reportingMessage.id,
        channel_id: reportingMessage.channel_id,
        reported_user_id: reportingMessage.author.id,
        reason,
        evidence: evidence.length ? evidence : undefined,
      });
      toast.success('Report submitted.');
      setReportingMessage(null);
      setReportReason('');
      setReportEvidence('');
    } catch (err) {
      toast.error(`Failed to submit report: ${extractApiError(err)}`);
    } finally {
      setReportSubmitting(false);
    }
  };

  const openAuthorProfile = (event: MouseEvent<HTMLElement>, msg: Message) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setProfilePos({ x: rect.left, y: rect.top });
    setProfileUser(msg.author);
  };

  const openEditHistory = async (event: MouseEvent<HTMLElement>, msgId: string) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setEditHistoryPos({ x: rect.left, y: rect.bottom + 4 });
    setEditHistoryMsgId(msgId);
    setEditHistoryLoading(true);
    setEditHistoryData([]);
    try {
      const { data } = await channelApi.getEditHistory(channelId, msgId);
      setEditHistoryData(data);
    } catch {
      setEditHistoryData([]);
    } finally {
      setEditHistoryLoading(false);
    }
  };

  const handleMentionClick = useCallback((userId: string) => {
    const member = activeGuildMemberById.get(userId);
    if (member) {
      setProfilePos({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      setProfileUser({
        id: member.user.id,
        username: member.user.username,
        discriminator: String(member.user.discriminator ?? '0'),
        avatar_hash: member.user.avatar_hash || null,
        bot: member.user.bot ?? false,
        flags: member.user.flags ?? 0,
      });
    }
  }, [activeGuildMemberById]);

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
    setDownloadProgress(0);
    try {
      const { data } = await fileApi.download(attachmentId, (percent) => {
        setDownloadProgress(percent);
      });
      const blob = data as Blob;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
      toast.success(`Downloaded "${filename}"`);
    } catch (err) {
      toast.error(`Failed to download attachment: ${extractApiError(err)}`);
    } finally {
      setAttachmentBusyId(null);
      setDownloadProgress(null);
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
        action: () => {
          void togglePin(msg);
        },
      });
    }

    items.push({ label: '', action: () => {}, divider: true });

    items.push({
      label: 'Copy Text',
      icon: <Copy size={14} />,
      action: () => {
        void writeClipboardText(msg.content || '')
          .then(() => toast.success('Message text copied.'))
          .catch((err) => toast.error(`Failed to copy message text: ${extractApiError(err)}`));
      },
    });

    items.push({
      label: 'Copy Message ID',
      icon: <Clipboard size={14} />,
      action: () => {
        void writeClipboardText(msg.id)
          .then(() => toast.success('Message ID copied.'))
          .catch((err) => toast.error(`Failed to copy message ID: ${extractApiError(err)}`));
      },
    });

    if (activeGuildId && msg.author.id !== me) {
      items.push({
        label: 'Report Message',
        icon: <MessageSquare size={14} />,
        action: () => openReportDialog(msg),
      });
    }

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
    if (row.type === 'date-separator') {
      return (
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
          <span className="text-meta font-semibold uppercase tabular-nums text-text-muted">
            {formatDate(row.date)}
          </span>
          <div className="h-px flex-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
        </div>
      );
    }

    if (row.type === 'typing') {
      const guildId = activeChannel?.guild_id;
      const guildMembers = guildId === activeGuildId
        ? activeGuildMembers
        : (guildId ? (useMemberStore.getState().members.get(guildId) ?? null) : null);
      const resolveUsername = (userId: string): string => {
        if (guildMembers) {
          const member = guildMembers.find((m) => m.user.id === userId);
          if (member) return member.nick || member.user.username;
        }
        return 'Someone';
      };

      const names = activeTyping.map(resolveUsername);
      return (
        <div className="px-4 py-2 text-meta text-text-muted" style={{ paddingLeft: '72px' }}>
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
    const canReportMessage = Boolean(activeGuildId) && msg.author.id !== me;
    const canOpenMessageMenu =
      canEditMessage || canDeleteMessage || canPinMessage || canCreateThreads || canReportMessage;
    const linkedThreads = linkedThreadsByStarterMessageId[msg.id] ?? [];
    const authorGuildMember = activeGuildMemberById.get(msg.author.id);
    const authorRoleColor = authorGuildMember ? getHighestRoleColor(authorGuildMember.roles ?? [], guildRoles) : undefined;
    const authorAvatarSrc = safeStoredImageDataUrl(msg.author.avatar_hash ?? msg.author.avatar);
    // A message that pings the reader gets the mention-line treatment (§7):
    // a persistent emerald tint plus a 2px accent left border, hover-independent.
    const mentionsMe = !isOwnMessage && Boolean(msg.mention_everyone);
    const isActiveRow = hoveredMessageId === msg.id || focusedMessageId === msg.id;
    const rowBackground = isActiveRow
      ? mentionsMe
        ? 'var(--accent-tint-strong)'
        : 'var(--bg-mod-subtle)'
      : mentionsMe
        ? 'var(--accent-tint)'
        : 'transparent';

    return (
      <div
        id={`msg-${msg.id}`}
        role="article"
        aria-label={`Message from ${msg.author.username}`}
        aria-posinset={row.messageIndex + 1}
        aria-setsize={messages.length}
        tabIndex={msg.id === activeRowMessageId ? 0 : -1}
        className="group relative -mx-2 flex gap-4 rounded-sm px-4 py-1 transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        style={{
          marginTop: isGrouped ? '2px' : replyDepth > 0 ? '0.5rem' : '1.25rem',
          paddingLeft: replyIndent > 0 ? `${16 + replyIndent}px` : undefined,
          borderLeft: mentionsMe ? '2px solid var(--accent-primary)' : undefined,
          backgroundColor: rowBackground,
        }}
        onMouseEnter={() => setHoveredMessageId(msg.id)}
        onMouseLeave={() => setHoveredMessageId(null)}
        onKeyDown={(e) => handleMessageRowKeyDown(e, msg.id)}
        onFocus={() => {
          setFocusedMessageId(msg.id);
          setActiveRowId(msg.id);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setFocusedMessageId((curr) => (curr === msg.id ? null : curr));
          }
        }}
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
          <div className="flex w-10 flex-shrink-0 items-start justify-center pt-0.5">
            <span
              className="text-[11px] tabular-nums opacity-0 transition-opacity duration-[140ms] ease-[var(--ease-out)] group-hover:opacity-100"
              style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-code)' }}
            >
              {new Date(getTimestamp(msg)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        ) : (
          <button
            type="button"
            aria-label={`Open profile for ${msg.author.username}`}
            className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-full border-0 p-0 shadow-sm transition-transform duration-[140ms] ease-[var(--ease-out)] active:scale-95 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            onClick={(e) => openAuthorProfile(e, msg)}
          >
            {authorAvatarSrc ? (
              <img src={authorAvatarSrc} alt="" className="h-full w-full object-cover" />
            ) : (
              // Avatar fallback is a NEUTRAL well tinted by the author's role color
              // when present — never the emerald accent (that stays reserved for
              // meaning, per §1.2 / kill-list #2). No role color → warm-neutral fill.
              <span
                className="flex h-full w-full items-center justify-center text-label font-semibold"
                style={{
                  backgroundColor: authorRoleColor
                    ? `color-mix(in srgb, ${authorRoleColor} 24%, var(--bg-mod-strong))`
                    : 'var(--bg-mod-strong)',
                  color: authorRoleColor ?? 'var(--text-secondary)',
                }}
              >
                {msg.author.username.charAt(0).toUpperCase()}
              </span>
            )}
          </button>
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
                className="inline-flex max-w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-meta text-text-muted transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                title="Jump to replied message"
              >
                <Reply size={12} className="shrink-0" />
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
              <button
                type="button"
                className="rounded-xs text-left text-[15px] font-semibold leading-tight hover:underline focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                style={{ color: authorRoleColor ?? 'var(--text-primary)' }}
                aria-label={`Open profile for ${msg.author.username}`}
                onClick={(e) => openAuthorProfile(e, msg)}
              >
                {msg.author.username}
              </button>
              {msg.anonymous?.is_anonymous && (
                <span className="rounded-xs bg-warning-tint px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-warning">
                  Anonymous
                </span>
              )}
              {msg.author.bot && (
                <span className="rounded-xs bg-accent-tint px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-primary">
                  Bot
                </span>
              )}
              <span className="text-meta tabular-nums text-text-muted" style={{ fontFamily: 'var(--font-code)' }}>
                {formatTimestamp(getTimestamp(msg))}
              </span>
              {(msg.edited_timestamp || msg.edited_at) && (
                <button
                  type="button"
                  className="rounded-xs text-left text-[11px] text-text-muted hover:underline focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                  title={`Edited: ${formatTimestamp(msg.edited_timestamp || msg.edited_at || '')}`}
                  aria-label={`Show edit history for message ${msg.id}`}
                  onClick={(e) => openEditHistory(e, msg.id)}
                >
                  (edited)
                </button>
              )}
              {msg.expires_at && (
                <span
                  className="text-[11px] text-text-muted"
                  title={`Expires ${formatTimestamp(msg.expires_at)}`}
                >
                  expires {formatTimestamp(msg.expires_at)}
                </span>
              )}
            </div>
          )}
          {editingMessageId === msg.id ? (
            <div className="mt-0.5">
              <textarea
                autoFocus
                aria-label={`Edit message from ${msg.author.username}`}
                className="w-full resize-none rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-body text-text-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)]"
                style={{ minHeight: '2.5rem', maxHeight: '50vh' }}
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
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => void saveEditMessage()}
                  className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-meta font-semibold text-accent-primary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                >
                  <Check size={13} /> Save
                </button>
                <button
                  onClick={cancelEditing}
                  className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-meta font-semibold text-text-muted transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                >
                  <XIcon size={13} /> Cancel
                </button>
                <span className="text-[11px] text-text-muted">
                  Enter to save, Esc to cancel
                </span>
              </div>
            </div>
          ) : (
            <>
              {(msg.flags ?? 0) & 64 ? (
                <EphemeralMessage>
                  {!msg.poll && decryptingIds.has(msg.id) ? (
                    <div className="flex flex-col gap-1.5 py-0.5" aria-label="Decrypting message">
                      <div className="h-3.5 w-3/4 animate-pulse rounded bg-text-muted/10" />
                      <div className="h-3.5 w-1/2 animate-pulse rounded bg-text-muted/10" />
                    </div>
                  ) : (
                    <div className="break-words text-[15px]" style={{ lineHeight: '1.58rem' }}>
                      {parseMarkdown(msg.content || '', activeGuildId || undefined, mentionMap, handleMentionClick)}
                    </div>
                  )}
                </EphemeralMessage>
              ) : !msg.poll && decryptingIds.has(msg.id) ? (
                <div className="flex flex-col gap-1.5 py-0.5" aria-label="Decrypting message">
                  <div className="h-3.5 w-3/4 animate-pulse rounded bg-text-muted/10" />
                  <div className="h-3.5 w-1/2 animate-pulse rounded bg-text-muted/10" />
                </div>
              ) : !msg.poll ? (
                <div className="break-words text-[15px]" style={{ color: 'var(--text-primary)', lineHeight: '1.58rem' }}>
                  {parseMarkdown(msg.content || '', activeGuildId || undefined, mentionMap, handleMentionClick)}
                  {isGrouped && (msg.edited_timestamp || msg.edited_at) && (
                    <button
                      type="button"
                      className="ml-1 rounded px-0 text-left text-[11px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary"
                      style={{ color: 'var(--text-muted)' }}
                      title={`Edited: ${formatTimestamp(msg.edited_timestamp || msg.edited_at || '')}`}
                      aria-label={`Show edit history for message ${msg.id}`}
                      onClick={(e) => openEditHistory(e, msg.id)}
                    >
                      (edited)
                    </button>
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
                    className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border-subtle bg-bg-secondary px-2.5 py-1 text-meta font-medium text-text-secondary shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                  >
                    <MessageSquare size={13} className="text-accent-primary" />
                    <span className="max-w-[14rem] truncate">{thread.name || 'Thread'}</span>
                    {isArchived && (
                      <span className="rounded-xs bg-bg-mod-strong px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                        Archived
                      </span>
                    )}
                    <ArrowRight size={12} />
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
                  onClick={() => void toggleReaction(msg.id, r)}
                  className="inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-meta transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                  style={{
                    borderColor: r.me ? 'var(--accent-primary)' : 'var(--border-subtle)',
                    backgroundColor: r.me ? 'var(--accent-tint)' : 'var(--bg-mod-subtle)',
                    color: r.me ? 'var(--accent-primary)' : 'var(--text-secondary)',
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
          {msg.stickers && msg.stickers.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {msg.stickers.map((sticker) => {
                const stickerSrc = sticker.image_url ? resolveAttachmentUrl(sticker.image_url) : null;
                return (
                  <div
                    key={sticker.id}
                    className="relative inline-flex flex-col items-center gap-1"
                    title={sticker.name}
                  >
                    {stickerSrc ? (
                      <img
                        src={stickerSrc}
                        alt={sticker.name}
                        className="rounded-md object-contain"
                        style={{ width: 128, height: 128 }}
                        loading="lazy"
                      />
                    ) : (
                      <div className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                          <polyline points="14 2 14 8 20 8" />
                          <circle cx="10" cy="13" r="2" />
                          <path d="m20 17-1.09-1.09a2 2 0 0 0-2.82 0L10 22" />
                        </svg>
                        {sticker.name}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {/* Attachments */}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-2">
              {msg.attachments.map((att) => {
                const src = resolveFederatedAttachmentUrl(att, msg.channel_id);
                const isFederated = Boolean(att.origin_server);
                const federatedBadge = isFederated ? (
                  <span
                    className="rounded-xs border border-accent-primary/35 bg-accent-primary/12 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-primary"
                    title={att.content_hash ? `Hash: ${att.content_hash}` : `From: ${att.origin_server}`}
                  >
                    Federated
                  </span>
                ) : null;
                const attachmentIsImage = isImageAttachment(att) && Boolean(src);
                if (attachmentIsImage) {
                  if (lowBandwidthMode) {
                    return (
                      <div
                        key={att.id}
                        className="inline-flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm"
                        style={{ maxWidth: 'fit-content' }}
                      >
                        {federatedBadge}
                        <span className="max-w-[20rem] truncate text-text-secondary">
                          {att.filename}
                        </span>
                        <span className="rounded-xs border border-border-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                          Preview Off
                        </span>
                        <button
                          type="button"
                          className="rounded-sm border border-border-subtle px-2 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => void downloadAttachment(att.id, att.filename)}
                          disabled={attachmentBusyId === att.id}
                        >
                          {attachmentBusyId === att.id
                            ? downloadProgress != null
                              ? `${downloadProgress}%`
                              : 'Downloading...'
                            : 'Download'}
                        </button>
                        {isOwnMessage && !isFederated && (
                          <button
                            type="button"
                            className="rounded-sm border border-accent-danger/30 bg-accent-danger/10 px-2 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
                            onClick={() => void deleteAttachment(msg.id, att.id)}
                            disabled={attachmentBusyId === att.id}
                          >
                            {attachmentBusyId === att.id ? 'Deleting...' : 'Delete'}
                          </button>
                        )}
                      </div>
                    );
                  }
                  const imageAttachments = msg.attachments!.filter(isImageAttachment);
                  const openImageLightbox = async () => {
                    revokeLightboxBlobUrls();
                    const safeImageAttachments = await Promise.all(
                      imageAttachments.map(async (imageAtt) => {
                        const imageSrc = resolveFederatedAttachmentUrl(imageAtt, msg.channel_id);
                        if (!imageSrc) return null;
                        const safeRawUrl = safeClientResourceUrl(imageSrc);
                        if (!safeRawUrl) return null;
                        try {
                          const resolvedSrc = await fileApi.resolveAttachmentObjectUrl(safeRawUrl);
                          if (resolvedSrc.startsWith('blob:')) {
                            lightboxBlobUrls.push(resolvedSrc);
                          }
                          return {
                            attachment: imageAtt,
                            image: {
                              src: resolvedSrc,
                              alt: imageAtt.filename,
                              filename: imageAtt.filename,
                            } satisfies LightboxImage,
                          };
                        } catch {
                          return null;
                        }
                      }),
                    );
                    const resolved = safeImageAttachments.filter(
                      (entry): entry is NonNullable<typeof entry> => entry !== null,
                    );
                    const lightboxImages = resolved.map(({ image }) => image);
                    if (lightboxImages.length === 0) return;
                    const imageIndex = resolved.findIndex(({ attachment }) => attachment.id === att.id);
                    useLightboxStore.getState().open(lightboxImages, imageIndex >= 0 ? imageIndex : 0);
                  };
                  return (
                    <div key={att.id} className="inline-flex max-w-fit flex-col gap-1.5">
                      <button
                        type="button"
                        className="inline-block max-w-fit cursor-pointer border-0 bg-transparent p-0 text-left"
                        onClick={() => void openImageLightbox()}
                      >
                        <ResolvedAttachmentImage
                          url={src!}
                          alt={att.filename}
                          className="max-w-[min(100%,400px)] rounded-md border border-border-subtle"
                          style={{ maxHeight: '300px', objectFit: 'contain' }}
                        />
                      </button>
                      <div className="flex flex-wrap items-center gap-2">
                        {federatedBadge}
                        <button
                          type="button"
                          className="rounded-sm border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => void openImageLightbox()}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="rounded-sm border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                          onClick={() => void downloadAttachment(att.id, att.filename)}
                          disabled={attachmentBusyId === att.id}
                        >
                          {attachmentBusyId === att.id ? (downloadProgress != null ? `${downloadProgress}%` : 'Downloading...') : 'Download'}
                        </button>
                        {isOwnMessage && !isFederated && (
                          <button
                            type="button"
                            className="rounded-sm border border-accent-danger/30 bg-accent-danger/10 px-2.5 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
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
                    className="inline-flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm"
                    style={{ maxWidth: 'fit-content' }}
                  >
                    {federatedBadge}
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
                      className="rounded-sm border border-border-subtle px-2 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                      onClick={() => void downloadAttachment(att.id, att.filename)}
                      disabled={attachmentBusyId === att.id}
                    >
                      {attachmentBusyId === att.id ? (downloadProgress != null ? `${downloadProgress}%` : 'Downloading...') : 'Download'}
                    </button>
                    {isOwnMessage && !isFederated && (
                      <button
                        type="button"
                        className="rounded-sm border border-accent-danger/30 bg-accent-danger/10 px-2 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
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
            className="absolute right-1.5 top-1.5 inline-flex h-8 w-8 items-center justify-center rounded-sm border border-border-subtle bg-bg-accent text-text-secondary shadow-sm md:hidden"
            title="Message actions"
            aria-label="Message actions"
            onClick={() => setMenuMessageId((curr) => (curr === msg.id ? null : msg.id))}
          >
            <MoreHorizontal size={15} />
          </button>
        )}

        {(hoveredMessageId === msg.id || focusedMessageId === msg.id) && !isCoarsePointer && (
          <div className="absolute -top-3.5 right-2 flex items-center gap-0.5 overflow-hidden rounded-sm border border-border-subtle bg-bg-accent p-0.5 shadow-md">
            <button className="hover-action-btn rounded-sm" title="Add Reaction" aria-label="Add Reaction" onClick={(e) => openReactionPicker(e, msg.id)}>
              <Smile size={16} />
            </button>
            <button className="hover-action-btn rounded-sm" title="Reply" aria-label="Reply" onClick={() => onReply?.(msg)}>
              <Reply size={16} />
            </button>
            {canOpenMessageMenu && (
              <button
                className="hover-action-btn rounded-sm"
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
            className="glass-modal absolute right-1 top-11 z-10 min-w-[10rem] max-w-[calc(100vw-2.75rem)] rounded-md p-1 sm:right-2"
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
                  await togglePin(msg);
                }}
              >
                {msg.pinned ? 'Unpin' : 'Pin'}
              </button>
            )}
            {activeGuildId && msg.author.id !== me && (
              <button className="context-menu-item w-full text-left" onClick={() => openReportDialog(msg)}>
                Report
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
          <div className="glass-modal absolute right-1 top-11 z-10 rounded-md p-3 sm:right-2" style={{ minWidth: '220px', maxWidth: 'calc(100vw - 2.75rem)' }}>
            <p className="mb-1 text-label font-semibold text-text-primary">Delete message?</p>
            <p className="mb-3 text-meta text-text-muted">This can't be undone — the message is gone for everyone.</p>
            <div className="flex items-center gap-2">
              <button
                className="rounded-sm bg-accent-danger-fill px-3 py-1.5 text-label font-semibold text-text-on-danger shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-[color-mix(in_srgb,var(--accent-danger-fill)_90%,#000)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                onClick={() => void handleDeleteMessage(msg.id)}
              >
                Delete
              </button>
              <button
                className="rounded-sm px-3 py-1.5 text-label font-semibold text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
        role="feed"
        aria-busy={isLoading ? 'true' : 'false'}
        aria-live="polite"
        aria-label="Message history"
      >
        {isLoading && messages.length === 0 ? (
          <div className="py-6" aria-label="Loading messages">
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonMessage key={i} />
            ))}
          </div>
        ) : error && messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4">
            <ErrorBanner
              className="w-full max-w-md"
              message={error}
              onRetry={() => void fetchMessages(channelId)}
            />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-start justify-end gap-3 px-2 pb-8 sm:px-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-sm bg-accent-tint">
              <Hash size={20} className="text-text-muted" />
            </span>
            <div>
              <h3 className="text-subhead text-text-primary">
                {activeChannel?.name ? `#${activeChannel.name} is ready when you are` : 'This is the start of your conversation'}
              </h3>
              <p className="mt-1 max-w-md text-label text-text-secondary">
                {activeChannel?.name
                  ? `No one has posted in #${activeChannel.name} yet. Kick things off — a hello, a question, or whatever's on your mind.`
                  : 'There are no messages here yet. Say hello and get the conversation going.'}
              </p>
            </div>
            <Button
              variant="default"
              className="mt-1 gap-2"
              onClick={() => {
                const composer = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Message "]');
                composer?.focus();
              }}
            >
              <Send size={16} />
              Send the first message
            </Button>
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
          <div
            ref={threadCreateDialogRef}
            className="glass-modal w-full max-w-md rounded-lg border border-border-strong p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-thread-dialog-title"
            tabIndex={-1}
          >
            <h3 id="create-thread-dialog-title" className="text-heading text-text-primary">Create Thread</h3>
            <p className="mt-1 text-meta text-text-secondary">
              Start a focused discussion branched off this message.
            </p>
            <label className="mt-4 block">
              <span className="text-section uppercase text-text-secondary">Thread Name</span>
              <input
                className="input-field mt-2"
                value={threadName}
                maxLength={100}
                onChange={(e) => setThreadName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreateThread();
                  if (e.key === 'Escape') {
                    closeThreadCreateDialog();
                  }
                }}
                autoFocus
              />
            </label>
            {threadCreateError && (
              <div className="mt-3 rounded-sm border-l-2 border-accent-danger bg-danger-tint px-3 py-2 text-meta font-medium text-accent-danger">
                {threadCreateError}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <button className="btn-primary" onClick={() => void submitCreateThread()}>
                Create Thread
              </button>
              <button
                className="rounded-sm px-3.5 py-2 text-label font-semibold text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                onClick={closeThreadCreateDialog}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {reportingMessage && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg-tertiary/75 p-4 backdrop-blur-sm">
          <div
            ref={reportDialogRef}
            className="glass-modal w-full max-w-lg rounded-lg border border-border-strong p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-message-dialog-title"
            tabIndex={-1}
          >
            <h3 id="report-message-dialog-title" className="text-heading text-text-primary">Report Message</h3>
            <p className="mt-1 text-meta text-text-secondary">
              Reports go to this server's moderators. Add concise evidence when you can.
            </p>
            <div className="mt-3 rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-meta text-text-secondary">
              <div className="font-semibold text-text-primary">
                {reportingMessage.author.username} ({reportingMessage.author.id})
              </div>
              <div className="mt-1 line-clamp-4 break-words">
                {reportingMessage.content || 'No text content'}
              </div>
            </div>
            <label className="mt-4 block">
              <span className="text-section uppercase text-text-secondary">Reason</span>
              <textarea
                className="input-field mt-2 min-h-[96px] resize-y"
                value={reportReason}
                maxLength={512}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Explain why this message should be reviewed..."
              />
            </label>
            <label className="mt-3 block">
              <span className="text-section uppercase text-text-secondary">Evidence (Optional)</span>
              <textarea
                className="input-field mt-2 min-h-[72px] resize-y"
                value={reportEvidence}
                onChange={(e) => setReportEvidence(e.target.value)}
                placeholder="Add one link or note per line"
              />
            </label>
            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <button
                className="btn-primary"
                onClick={() => void submitReport()}
                disabled={reportSubmitting}
              >
                {reportSubmitting ? 'Submitting...' : 'Submit Report'}
              </button>
              <button
                className="rounded-sm px-3.5 py-2 text-label font-semibold text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                onClick={closeReportDialog}
                disabled={reportSubmitting}
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
          className="absolute bottom-[calc(var(--safe-bottom)+0.75rem)] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-sm border border-border-subtle bg-bg-accent px-4 py-2 text-label font-semibold text-text-primary shadow-md transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          <ArrowDown size={16} className="text-accent-primary" />
          Jump to present
        </button>
      )}
      {bulkDeleteMode && canManageMessages && (
        <div className="absolute bottom-[calc(var(--safe-bottom)+0.75rem)] left-1/2 z-20 flex w-[min(95%,38rem)] -translate-x-1/2 flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-accent px-4 py-2.5 shadow-lg">
          <span className="text-label font-semibold tabular-nums text-text-secondary">
            {selectedMessageIds.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-sm px-3 py-1.5 text-label font-semibold text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
              onClick={cancelBulkDelete}
              disabled={bulkDeleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-sm bg-accent-danger-fill px-3 py-1.5 text-label font-semibold text-text-on-danger shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-[color-mix(in_srgb,var(--accent-danger-fill)_90%,#000)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
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
      {editHistoryMsgId && createPortal(
        <div
          className="fixed inset-0 z-[9999]"
          onClick={() => setEditHistoryMsgId(null)}
        >
          <div
            className="glass-modal absolute max-h-80 w-80 overflow-y-auto rounded-md border border-border-subtle shadow-xl backdrop-blur-md"
            style={{
              left: Math.min(editHistoryPos.x, window.innerWidth - 340),
              top: Math.min(editHistoryPos.y, window.innerHeight - 320),
              boxShadow: 'var(--shadow-lg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border-subtle px-3 py-2 text-label font-semibold text-text-primary">
              Edit History
            </div>
            {editHistoryLoading ? (
              <div className="px-3 py-4">
                <LoadingSpinner size="sm" />
              </div>
            ) : editHistoryData.length === 0 ? (
              <div className="px-3 py-4 text-meta text-text-muted">
                No earlier versions — this is the original text.
              </div>
            ) : (
              <div className="flex flex-col">
                {editHistoryData.map((entry, i) => (
                  <div
                    key={entry.id}
                    className="border-b border-border-subtle/50 px-3 py-2 last:border-b-0"
                  >
                    <div className="mb-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Version {i + 1} -- {formatTimestamp(entry.edited_at)}
                    </div>
                    <div className="break-words text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {entry.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
