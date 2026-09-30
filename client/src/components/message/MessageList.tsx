import { useCurrentChannelStore, useChannelActions } from '../../hooks/useChannels';
import { entityScopeKey as memberScopeKey, type AccountScope } from '../../lib/serverScope';
import { useCurrentUser, useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { memo, useRef, useEffect, useLayoutEffect, useMemo, useState, useReducer, useCallback, useSyncExternalStore, type CSSProperties, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { captureScopedOperation, type OperationContext } from '../../lib/operationContext';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowDown, Smile, Reply, Hash, Check, X as XIcon, Pencil, Pin, PinOff, Copy, Clipboard, Trash2, MessageSquare, Send, Eye, Loader2, Bookmark, BookmarkCheck, Trophy, Clock, Forward } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMessages } from '../../hooks/useMessages';
import { useTypingStore } from '../../stores/typingStore';
import { useCurrentMessageStore } from '../../hooks/useMessageStore';
import { ENCRYPTED_DM_PLACEHOLDER } from '../../stores/messageStore';
import { useGuild } from '../../hooks/useGuilds';
import { useServerListStore } from '../../stores/serverListStore';
import { useReadStateStore } from '../../stores/readStateStore';
import { useMemberStore } from '../../stores/memberStore';
import { useSavedMessageStore } from '../../stores/savedMessageStore';
import { pendingReminderMessageIds, useReminderStore } from '../../stores/reminderStore';
import { useUIStore } from '../../stores/uiStore';
import { channelApi } from '../../api/channels';
import { MessageEditHistoryDialog } from './MessageEditHistoryDialog';
import { fileApi } from '../../api/files';
import { EncryptedAttachment } from '../file/EncryptedAttachment';
import { ClipAttachment, isClipAttachment } from '../../lib/media/clips/ClipAttachment';
import { hasEncryptedAttachments } from '../../lib/messages/attachments/messageBodyProjection';
import { extractApiError } from '../../api/client';
import { ChannelType, MessageType, Permissions, hasPermission, type Channel, type ChannelOverwrite, type Member, type Message, type Role } from '../../types';
import { guildApi } from '../../api/guilds';
import { UserProfilePopup } from '../user/UserProfile';
import { groupEnrollmentReason, isGroupDm, pendingGroupMembers } from '../../lib/messages/messagingReadiness';
import { EmojiPicker } from '../ui/EmojiPicker';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { usePermissions } from '../../hooks/usePermissions';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { resolveResourceUrl } from '../../lib/config/apiBaseUrl';
import { getDownloadTicket } from '../../lib/downloadTicket';
import { writeClipboardText } from '../../lib/clipboard';
import { SkeletonMessage } from '../ui/Skeleton';
import { fadeIn, flicker, motionToken, ms, onMotion, prefersReducedMotion, settleIn, useLingering, walkIntoRoom } from '../../lib/motion';
import { messagePreviewText, parseMarkdown } from '../../lib/markdown';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { formatFileSize, formatTimestamp, relativeTime } from '../../lib/formatters';
import { createResolvedLightboxImage, useLightboxStore } from '../../stores/lightboxStore';
import { confirm } from '../../stores/confirmStore';
import { ResourceImage } from '../ui/ResourceImage';
import { isAllowedImageMimeType, safeClientResourceUrl } from '../../lib/security';
import { mentionsEveryone } from '../../lib/mentions';
import { MessageEmbedCard, extractUrls } from './MessageEmbed';
import { FeedPostCard, isFeedEmbed } from '../feeds/FeedPostCard';
import { FeedSourceIcon, GAME_SERVER_POST_KIND } from '../feeds/feedKinds';
import { Chip } from '../ui';
import {
  DayDivider,
  dayDividerLabel,
  isToday,
  MessageActions,
  timelineTime,
  ReplyChip,
  RoomLitEventRow,
  ThreadRow,
  TimelineAvatar,
  TypingBubble,
  typingSentence,
} from './TimelineParts';
import { InstrumentText } from '../glass/primitives';
import {
  CatchUpDivider,
  DownloadMark,
  EventPlanCard,
  GlassFile,
  GlassMedia,
  MediaTool,
  ReactionBite,
  TrashMark,
  catchUpLabel,
  eventCardIds,
  findCatchUp,
  type ReactionTally,
} from '../glass/cards';
import { TimelineAuthor, TimelineLightSource, createTimelineLightStore, type RoomLitEvent } from './messageLight';
import { useVoiceStore } from '../../stores/voiceStore';
import { GitHubEventEmbed, isGitHubWebhookMessage } from './GitHubEventEmbed';
import { ScoreUpdateCard } from '../sports/ScoreUpdateCard';
import { isSportsScoreAuthor, parseScoreUpdate, resolveScoreSides, scoreUpdateGame, scoreUpdateHref } from '../sports/scoreUpdate';
import { useSportsStore } from '../../stores/sportsStore';
import { PollMessageCard } from './PollMessageCard';
import { EphemeralMessage } from './EphemeralMessage';
import { MessageComponents } from './MessageComponents';
import { toast } from '../../stores/toastStore';
import { ErrorBanner } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { Modal, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';
import { displayName } from '../../lib/displayName';
import { cn } from '../../lib/utils';
import { fetchChannelOverwrites, fetchGuildRoles } from '../../lib/permissionDataCache';
import { forwardBlockedReason, forwardQuote, messageBubbleText } from '../../lib/forwardedMessage';
import { RemindMeMenu } from './RemindMeMenu';
import { ForwardPicker } from './ForwardPicker';
import { ForwardedCard } from './ForwardedCard';

const EMPTY_TYPING: string[] = [];
const NO_EVENT_CARDS: string[] = [];

/**
 * Message types the server writes about the conversation rather than as
 * somebody's words (`paracord-models` `MessageType` 1-8). They read as a
 * centered line, never as a bubble (docs/glass-spec.md §3.2).
 */
const SYSTEM_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  MessageType.RecipientAdd,
  MessageType.RecipientRemove,
  MessageType.Call,
  MessageType.ChannelNameChange,
  MessageType.ChannelIconChange,
  MessageType.PinnedMessage,
  MessageType.GuildMemberJoin,
  // `SystemMessage` on the server; the client enum does not name it.
  8,
]);

export function isSystemMessage(message: Pick<Message, 'message_type' | 'type'> | null | undefined): boolean {
  if (!message) return false;
  const kind = message.message_type ?? message.type;
  return kind != null && SYSTEM_MESSAGE_TYPES.has(Number(kind));
}

/** The sentence a system message stands for: "Nick pinned a message". */
export function systemMessageText(message: Message, authorName: string): string {
  const kind = Number(message.message_type ?? message.type);
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  switch (kind) {
    case MessageType.RecipientAdd:
      return `${authorName} added someone to the conversation`;
    case MessageType.RecipientRemove:
      return `${authorName} removed someone from the conversation`;
    case MessageType.Call:
      return `${authorName} started a call`;
    case MessageType.ChannelNameChange:
      return content ? `${authorName} renamed the channel to ${content}` : `${authorName} renamed the channel`;
    case MessageType.ChannelIconChange:
      return `${authorName} changed the channel icon`;
    case MessageType.PinnedMessage:
      return `${authorName} pinned a message`;
    case MessageType.GuildMemberJoin:
      return `${authorName} joined the server`;
    default:
      return content || `${authorName} posted a system message`;
  }
}

/**
 * A message row that redraws only when something it draws changed.
 *
 * The row is written inline in the list (it reads a great deal of the list's
 * state), so rather than threading all of it through props the caller names
 * what the row depends on in `deps` and hands over the drawing as `render`.
 * `render` is called only when a dependency changed; its event handlers must
 * therefore never close over list state directly — they go through
 * {@link useForwardedActions}.
 */
const MessageRowMemo = memo(
  function MessageRowMemo({ render }: { deps: readonly unknown[]; render: () => ReactNode }) {
    return render();
  },
  (previous, next) =>
    previous.deps.length === next.deps.length
    && previous.deps.every((value, index) => Object.is(value, next.deps[index])),
);

/**
 * Stable stand-ins for the list's handlers: the returned object never changes,
 * and each of its functions calls the handler from the latest render.
 */
function useForwardedActions<T extends Record<string, (...args: never[]) => unknown>>(actions: T): T {
  const latest = useRef(actions);
  // Handlers only run in events, after the render that made them committed.
  useLayoutEffect(() => {
    latest.current = actions;
  });
  const [forwarded] = useState(() => {
    const out: Record<string, (...args: unknown[]) => unknown> = {};
    for (const key of Object.keys(actions)) {
      out[key] = (...args: unknown[]) => (latest.current[key] as (...forwardedArgs: unknown[]) => unknown)(...args);
    }
    return out as unknown as T;
  });
  return forwarded;
}

const EMPTY_CHANNELS: Channel[] = [];
const NO_THREADS: Channel[] = [];
const EMPTY_MEMBERS: Member[] = [];
const EMPTY_SAVED_IDS = new Set<string>();
const EMPTY_REMINDERS: ReturnType<typeof useReminderStore.getState>['items'] = [];

/** Avoid re-parsing markdown on hover/typing re-renders when message content is unchanged. */
const markdownParseCache = new Map<string, {
  nodes: ReactNode[];
  mentionMap: Map<string, string>;
  onMentionClick: ((userId: string) => void) | undefined;
}>();
const MARKDOWN_CACHE_MAX = 400;

function getCachedParsedMarkdown(
  messageId: string,
  content: string,
  editedKey: string,
  guildId: string | undefined,
  mentionMap: Map<string, string>,
  onMentionClick: ((userId: string) => void) | undefined,
  // A custom emoji in this content renders as an `<img>` whose URL carries the
  // download ticket, so a cached node tree built before the ticket arrived is
  // a tree of permanently broken images. The ticket is part of the identity of
  // what was parsed.
  downloadTicket: string | null,
  // Whose mention is the white chip: a mention names who it is for, so the
  // parse depends on who is reading.
  selfUserId: string | null,
): ReactNode[] {
  const key = `${messageId}\0${editedKey}\0${content}\0${guildId ?? ''}\0${downloadTicket ?? ''}\0${selfUserId ?? ''}`;
  const hit = markdownParseCache.get(key);
  if (hit && hit.mentionMap === mentionMap && hit.onMentionClick === onMentionClick) {
    return hit.nodes;
  }
  const nodes = parseMarkdown(content || '', guildId, mentionMap, onMentionClick, { selfUserId });
  markdownParseCache.set(key, { nodes, mentionMap, onMentionClick });
  if (markdownParseCache.size > MARKDOWN_CACHE_MAX) {
    const oldest = markdownParseCache.keys().next().value;
    if (oldest !== undefined) markdownParseCache.delete(oldest);
  }
  return nodes;
}

/** Match gateway mention logic: @everyone or <@id> / <@!id> in content. */
export function messageMentionsUser(
  msg: Message,
  userId: string | undefined | null,
  roleIds: ReadonlySet<string> = NO_ROLE_IDS,
): boolean {
  // `author` is typed as required but a malformed payload can omit it; never
  // let a mention check be the thing that throws inside a render.
  if (!userId || msg.author?.id === userId) return false;
  if (mentionsEveryone(msg)) return true;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (new RegExp(`<@!?${userId}>`).test(content)) return true;
  // A role the reader holds reaches them like their own name does.
  if (roleIds.size === 0) return false;
  for (const match of content.matchAll(/<@&(\d+)>/g)) {
    if (roleIds.has(match[1])) return true;
  }
  return false;
}

const NO_ROLE_IDS: ReadonlySet<string> = new Set();

const MAX_REPLY_NEST_DEPTH = 6;

/**
 * The shortest the message actions menu may be squeezed to before it scrolls.
 *
 * A short room on a short window can leave less room on both sides than the
 * menu needs; below this the menu stops being a menu, so it keeps this much
 * and scrolls the rest.
 */
const MIN_MESSAGE_MENU_HEIGHT = 120;
const THREAD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _threadHydratedAt = new Map<string, number>();
const IMAGE_ATTACHMENT_EXTENSION_RE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Object URLs handed to the lightbox, grouped by the open that created them.
 *
 * This used to be one flat module-global array drained at the *start* of the
 * next open. Two consequences: nothing was ever revoked while the component
 * stayed mounted (a session of image viewing leaked every blob), and because
 * URLs are pushed after an `await`, two fast clicks let the second open revoke
 * the URLs the first was still resolving — the lightbox opened blank.
 *
 * Keying by open generation fixes both: each open revokes only the batches that
 * preceded it, and unmount revokes everything left.
 */
let lightboxBlobGeneration = 0;
const lightboxBlobUrls = new Map<number, string[]>();

/** Revoke every batch older than `keepGeneration`. */
function revokeLightboxBlobUrls(keepGeneration = Number.POSITIVE_INFINITY): void {
  for (const [generation, urls] of lightboxBlobUrls) {
    if (generation >= keepGeneration) continue;
    for (const url of urls) URL.revokeObjectURL(url);
    lightboxBlobUrls.delete(generation);
  }
}

function trackLightboxBlobUrl(generation: number, url: string): void {
  if (generation !== lightboxBlobGeneration) { URL.revokeObjectURL(url); return; }
  const batch = lightboxBlobUrls.get(generation);
  if (batch) batch.push(url);
  else lightboxBlobUrls.set(generation, [url]);
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
  compact = false,
}: {
  url: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  /** A thumbnail: while loading, hold its own box instead of the full-size frame. */
  compact?: boolean;
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const safeRawUrl = safeClientResourceUrl(url);

  useEffect(() => {
    if (!safeRawUrl) return;

    let canceled = false;
    let blobUrl: string | null = null;

    void fileApi.resolveAttachmentObjectUrl(safeRawUrl).then((src) => {
      if (canceled) {
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        return;
      }
      if (src.startsWith('blob:')) blobUrl = src;
      setResolvedSrc(src);
      setFailed(false);
    }).catch(() => {
      if (!canceled) {
        setResolvedSrc(null);
        setFailed(true);
      }
    });

    return () => {
      canceled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [safeRawUrl]);

  if ((!safeRawUrl || !resolvedSrc) && compact) {
    return <span className={cn(className, 'block bg-bg-mod-subtle')} role="img" aria-label={`Loading ${alt}`} />;
  }
  if (!safeRawUrl || !resolvedSrc) {
    // The picture's own frame (the tone of a bubble, 16:9 unless the server
    // told us better) says it is coming; if it cannot come, it says so.
    return (
      <div className="glass-media__pending" role={failed || !safeRawUrl ? 'alert' : 'img'} aria-label={failed || !safeRawUrl ? undefined : `Loading ${alt}`}>
        {failed || !safeRawUrl ? `${alt} could not be loaded` : null}
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

/**
 * A forwarded server message shows its pictures as thumbnails inside the
 * quoted card. An encrypted conversation's files are decrypted by their own
 * renderer, so they stay in the ordinary attachment list.
 */
function inForwardCard(message: Message, att: { content_type?: string; filename: string }): boolean {
  return Boolean(message.forwarded_from) && !message.e2ee && isImageAttachment(att);
}

function forwardThumbnails(message: Message): ReactNode {
  const images = (message.attachments ?? []).filter((att) => inForwardCard(message, att));
  if (images.length === 0) return null;
  return images.map((att) => {
    const src = resolveFederatedAttachmentUrl(att, message.channel_id);
    return src ? (
      <ResolvedAttachmentImage
        key={att.id}
        url={src}
        alt={att.filename}
        className="h-20 w-20 rounded-[var(--radius-chip)] object-cover"
        compact
      />
    ) : (
      <span key={att.id} className="text-meta text-accent-danger">{att.filename} cannot be shown.</span>
    );
  });
}

/** "4 replies · 12 min ago" — the meta line on a thread row (§7.4). */
function threadMetaFor(thread: Channel): string {
  const replies = thread.message_count ?? null;
  const parts: string[] = [];
  if (replies != null) parts.push(`${replies} ${replies === 1 ? 'reply' : 'replies'}`);
  if (thread.created_at) parts.push(relativeTime(thread.created_at));
  return parts.join(' \u00b7 ');
}

interface MessageListProps {
  channelId: string;
  onReply?: (message: Message) => void;
  /**
   * WP3 (spec §7.2), additive: `ribbon` is the compact timeline in the Stage's
   * chat ribbon — 28px avatars, tighter rows, the 14/1.45 ribbon body step.
   * Everything else about the list is unchanged.
   */
  variant?: 'default' | 'ribbon';
  /**
   * WP3 (spec §7.2), additive: authors who are in the room right now, so their
   * messages get the raised "from the room" highlight. The set comes from
   * WP1's `useHereNow` — this list never works out who is present itself.
   */
  inRoomUserIds?: ReadonlySet<string>;
}

function getTimestamp(msg: { timestamp?: string; created_at?: string }): string {
  return msg.timestamp || msg.created_at || '';
}

type GroupableMessage = {
  author?: { id?: string | null } | null;
  timestamp?: string;
  created_at?: string;
};

export function shouldGroup(prev: GroupableMessage | null, curr: GroupableMessage): boolean {
  if (!prev) return false;
  // Author may be absent on a malformed payload. Two authorless rows are not
  // "the same author" — never group them, and never dereference blindly: this
  // exact read is what a bot reply used to crash on, taking the app with it.
  const prevAuthorId = prev.author?.id;
  const currAuthorId = curr.author?.id;
  if (!prevAuthorId || !currAuthorId) return false;
  if (prevAuthorId !== currAuthorId) return false;
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

function getReplyPreviewText(
  message: Message,
  names?: ReadonlyMap<string, string>,
  roleNames?: ReadonlyMap<string, string>,
): string {
  const text = messagePreviewText(messageBubbleText(message), names, roleNames);
  if (text) return truncateInline(text);
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
      /** Continues the group above it (same author, close in time, same day). */
      isGrouped: boolean;
      /** The next message continues this one's group; false for the group's last. */
      isLastInGroup: boolean;
      /** Written by the server about the conversation: a centered line, not a bubble. */
      isSystem: boolean;
      replyParentId: string | null;
    }
  | { type: 'typing' }
  /**
   * "6 new since 8:58": above the first message the reader had not read when
   * they opened the conversation (docs/glass-spec.md §3.2). A row of its own
   * that breaks the group it lands in.
   */
  | { type: 'catch-up'; count: number; atLeast: boolean; since: string | null }
  /**
   * A voice room in this building lit up while you were reading (§7.4). It is a
   * transition in WP1's room light observed by this client, never a server
   * message — so it lives in the row list without ever entering `messages`.
   */
  | { type: 'room-event'; event: RoomLitEvent }
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
  },
  edit: { editingMessageId: null, editContent: '' },
  report: { reportingMessage: null, reportReason: '', reportEvidence: '', reportSubmitting: false },
  threadCreate: { threadModalForMessageId: null, threadName: '', threadCreateError: null },
  bulkDelete: { bulkDeleteMode: false, selectedMessageIds: [], bulkDeleting: false },
  attachment: { attachmentBusyId: null, downloadProgress: null },
  editHistory: { editHistoryMsgId: null, editHistoryPos: { x: 0, y: 0 } },
};

export function MessageList(props: MessageListProps) {
  const scope = useCurrentAccountScope();
  const key = scope ? memberScopeKey(scope, props.channelId) : `unavailable:${props.channelId}`;
  return <OwnedMessageList key={key} {...props} scope={scope} />;
}

function OwnedMessageList({
  channelId,
  onReply,
  variant = 'default',
  inRoomUserIds,
  scope,
}: MessageListProps & { scope: AccountScope | null }) {
  // WP3: the Stage's chat ribbon. A presentation variant only — no branch below
  // changes what is fetched, rendered or announced.
  const ribbon = variant === 'ribbon';
  // Custom emoji and attachment thumbnails are authenticated by a download
  // ticket that is minted after the first paint; re-render when it lands.
  const downloadTicket = useDownloadTicket();
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { messages, isLoading, hasMore, loadMore, error } = useMessages(channelId);
  const fetchMessages = useCurrentMessageStore((s) => s.fetchMessages);
  const addReaction = useCurrentMessageStore((s) => s.addReaction);
  const removeReaction = useCurrentMessageStore((s) => s.removeReaction);
  const deleteMessage = useCurrentMessageStore((s) => s.deleteMessage);
  const editMessage = useCurrentMessageStore((s) => s.editMessage);
  const pinMessage = useCurrentMessageStore((s) => s.pinMessage);
  const unpinMessage = useCurrentMessageStore((s) => s.unpinMessage);
  const setMessages = useCurrentMessageStore((s) => s.setMessages);
  const decryptingIds = useCurrentMessageStore((s) => s.decryptingIds);
  // A parent this client watched be deleted is a different absence from a
  // parent that is merely older than the loaded window (§6.9: say the true
  // thing). Without this both read "Message not loaded", forever.
  const deletedMessageIds = useCurrentMessageStore((s) => s.deletedMessageIds);
  const channelActions = useChannelActions();
  const activeChannel = useCurrentChannelStore((s) => s.channelsById[channelId]);
  const typingUsers = useTypingStore((s) => s.typingByChannel[channelId] ?? EMPTY_TYPING);
  const me = useCurrentUser()?.id;
  const activeGuildId = activeChannel?.guild_id || null;
  const pinnedSportsGame = useSportsStore((state) =>
    scoreUpdateGame(activeGuildId ? state.byGuild[activeGuildId] : undefined, channelId),
  );
  const originServerId = useGuild(activeChannel?.guild_id)?.scope.serverId ?? null;
  const activeServerId = useServerListStore((state) => state.activeServerId);
  const savedServerScope = activeServerId ?? '__local__';
  const savedIds = useSavedMessageStore((state) =>
    state.serverId === savedServerScope ? state.savedIds : EMPTY_SAVED_IDS,
  );
  const reminderItems = useReminderStore((state) =>
    state.serverId === savedServerScope ? state.items : EMPTY_REMINDERS,
  );
  const pendingReminderIds = useMemo(
    () => pendingReminderMessageIds(reminderItems),
    [reminderItems],
  );
  const actionAnchor = useRef<HTMLDivElement>(null);
  const [remindTarget, setRemindTarget] = useState<Message | null>(null);
  const [forwardTarget, setForwardTarget] = useState<Message | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const forwardBlockedFor = (message: Message) => forwardBlockedReason(message, {
    sourceIsDm: !activeGuildId,
    unreadable: decryptingIds.has(message.id) || (Boolean(message.e2ee) && message.content === ENCRYPTED_DM_PLACEHOLDER),
  });
  const openRemind = (message: Message, x: number, y: number) => {
    const node = actionAnchor.current;
    if (node) {
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    }
    setRemindTarget(message);
  };
  const channelServerId = originServerId ?? activeServerId;
  const activeGuildChannels = useCurrentChannelStore(
    useCallback(
      (s) => (activeGuildId ? (s.channelsByGuild[activeGuildId] ?? EMPTY_CHANNELS) : EMPTY_CHANNELS),
      [activeGuildId],
    ),
  );
  const [channelOverwrites, setChannelOverwrites] = useState<ChannelOverwrite[]>([]);

  /* ---------------------------------------------------------------------- */
  /* §5.1 "a message has mass" — the landing half of the send                */
  /*                                                                        */
  /* The composer's words lift out; this row rises 8px onto its mark on the   */
  /* ease-out, so the two read as one object moving. Three rules           */
  /* keep it honest:                                                        */
  /*   · only a row the person at this keyboard CAUSED lands — the gesture   */
  /*     arrives on the motion bus, and without one nothing animates (§5.3:  */
  /*     never animate what the user did not cause);                        */
  /*   · only the new row animates: it is a transform on the row itself, so  */
  /*     no neighbor moves and the list never reflow-animates;             */
  /*   · the row cannot exist before the server has answered for it (the     */
  /*     runtime only publishes a message the recovery feed has vouched      */
  /*     for), so the receipt below is structurally "after the ack".         */
  /* ---------------------------------------------------------------------- */
  const awaitingLanding = useRef<{ nonce: string; at: number } | null>(null);
  const seenMessageIds = useRef<Set<string> | null>(null);
  const landingFrame = useRef<number | null>(null);

  useEffect(() => {
    seenMessageIds.current = null;
    awaitingLanding.current = null;
  }, [channelId]);

  useEffect(
    () => onMotion('say:sent', (detail) => {
      if (detail.channelId === channelId) awaitingLanding.current = { nonce: detail.nonce, at: Date.now() };
    }),
    [channelId],
  );

  useEffect(() => {
    const seen = seenMessageIds.current;
    seenMessageIds.current = new Set(messages.map((message) => message.id));
    // The first list for a conversation is history, not an arrival.
    if (!seen) return;
    const waiting = awaitingLanding.current;
    // A send that never landed stops being this gesture's business.
    if (!waiting || Date.now() - waiting.at > 30_000) return;
    const arrived = messages.find((message) => !seen.has(message.id) && message.author.id === me);
    if (!arrived) return;
    awaitingLanding.current = null;
    // Deliberately NOT state: a `setState` here would re-render the whole
    // timeline a second time inside the frame the row already arrived in, and
    // the frame the row arrives in is the most expensive one in the moment.
    // The engine only needs the element.
    if (landingFrame.current !== null) cancelAnimationFrame(landingFrame.current);
    landingFrame.current = requestAnimationFrame(() => {
      landingFrame.current = null;
      // 8px, arriving as the typed words leave (§5.1).
      settleIn(document.getElementById(`msg-${arrived.id}`));
      // The receipt is the last thing to arrive: it is the server's answer, and
      // it waits for the row to be on its mark before it fades in.
      fadeIn(scrollRef.current?.querySelector<HTMLElement>('[data-motion-receipt]'), {
        delay: ms('--duration-slow'),
      });
    });
  }, [messages, me]);

  useEffect(() => () => {
    if (landingFrame.current !== null) cancelAnimationFrame(landingFrame.current);
  }, []);

  /** Your own last message in this room — the only place a receipt belongs. */
  const deliveredReceipt = messages.length > 0 && messages[messages.length - 1].author.id === me;

  useEffect(() => {
    void useSavedMessageStore.getState().load();
    void useReminderStore.getState().load();
  }, [savedServerScope]);
  // Reading a room's overwrite list needs MANAGE_CHANNELS. Asking for it
  // regardless answered 403 on every room a plain member opened — a failed
  // request and a console error the timeline then hid. The member's own
  // effective permissions stay the server's to enforce; the UI gates
  // optimistically from the guild level, exactly as `usePermissions` documents.
  const guildLevel = usePermissions(activeGuildId);
  const canReadOverwrites =
    guildLevel.isAdmin || hasPermission(guildLevel.permissions, Permissions.MANAGE_CHANNELS);
  useEffect(() => {
    if (!activeGuildId || !channelId || !canReadOverwrites) {
      setChannelOverwrites([]);
      return;
    }
    let canceled = false;
    // Shared, deduped fetch: MessageList, MessageInput and MemberList all need
    // this for the same channel and used to request it independently.
    fetchChannelOverwrites(channelId)
      .then((data) => {
        if (!canceled) setChannelOverwrites(data);
      })
      .catch(() => {
        if (!canceled) setChannelOverwrites([]);
      });
    return () => {
      canceled = true;
    };
  }, [activeGuildId, canReadOverwrites, channelId]);
  const { permissions, isAdmin } = usePermissions(activeGuildId, {
    channelId,
    channelOverwrites,
  });
  const canManageMessages = isAdmin || hasPermission(permissions, Permissions.MANAGE_MESSAGES);
  // DMs: API only requires recipient membership (no MANAGE_MESSAGES). Guild: MANAGE_MESSAGES.
  const canPinInChannel = activeGuildId ? canManageMessages : true;
  const canAddReactions =
    !activeGuildId || isAdmin || hasPermission(permissions, Permissions.ADD_REACTIONS);
  const activeChannelType = activeChannel?.channel_type ?? activeChannel?.type;
  // A group whose members have not all enrolled cannot seal a message to them,
  // so its empty state names who it is waiting on instead of inviting the one
  // action that would fail. A ready group is an ordinary empty conversation.
  const groupPending = isGroupDm(activeChannelType) ? pendingGroupMembers(activeChannel?.recipients) : [];
  const emptyGroupDm = groupPending.length > 0;
  /**
   * A thread is not a room, so it never "is dark" and nothing ever "lights up"
   * in it (§7.1). An empty one is a thread nobody has replied in yet, and that
   * is what it should say — the room vocabulary belongs to the room it lives in.
   */
  const emptyThread = activeChannelType === ChannelType.Thread;
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
  // §7.4: a timeline row is a person, so every author carries their light, and
  // the meta says "in Shop floor" when they are in a room right now. Both come
  // from WP1 — this file never decides who is lit. The light is read through a
  // store that `TimelineLightSource` fills, never subscribed here: somebody
  // speaking or coming online re-renders that author's rows, not the timeline.
  const [lightStore] = useState(createTimelineLightStore);
  const roomLitEvents = useSyncExternalStore(lightStore.subscribe, lightStore.events);
  // §5.1: the inline event is a door like any other, so walking through it is
  // the same journey — the line you clicked becomes the Stage's dominant tile.
  const joinLitRoom = useCallback(
    (event: RoomLitEvent, origin?: Element | null) => {
      void walkIntoRoom({
        channelId: event.channelId,
        origin,
        go: () => {
          void useVoiceStore.getState().joinChannel(event.channelId, event.guildId ?? undefined);
          if (event.guildId) navigate(`/app/guilds/${event.guildId}/channels/${event.channelId}`);
        },
      });
    },
    [navigate],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  /** Messages that arrived while the user was scrolled away from the bottom. */
  const [newMessageCount, setNewMessageCount] = useState(0);
  const lastMessageId = messages[messages.length - 1]?.id ?? null;
  const newMessageAnnouncement =
    newMessageCount > 0
      ? `${newMessageCount} new message${newMessageCount === 1 ? '' : 's'}`
      : '';

  // All overlay/dialog UI state lives in one reducer; slice setters below are
  // thin wrappers over dispatch that keep the previous call-site API intact.
  const [uiState, dispatchUI] = useReducer(messageListUIReducer, initialMessageListUIState);

  // Popup/overlay slice
  const { hoveredMessageId, focusedMessageId, menuMessageId, profileUser, profilePos, emojiPickerFor, deleteConfirmId } = uiState.popup;
  // The reaction picker leaves the way it came (§5.2): kept for its exit beat.
  const reactionPicker = useLingering(emojiPickerFor);
  const setHoveredMessageId = (hoveredMessageId: string | null) =>
    dispatchUI({ slice: 'popup', patch: { hoveredMessageId } });
  // Hover follows the pointer, not the scroll. A wheel scroll slides row after
  // row under a resting pointer, and each one used to set the hovered row —
  // a timeline re-render and a hover toolbar animating in, per row, many times
  // a second. While the timeline is scrolling the hover is held (and the
  // toolbar put away); the row under the pointer when it stops gets it.
  const hoverHold = useRef<{ until: number; dirty: boolean; pending: string | null; timer: number | null }>({
    until: 0,
    dirty: false,
    pending: null,
    timer: null,
  });
  const hoveredRef = useRef<string | null>(hoveredMessageId);
  hoveredRef.current = hoveredMessageId;
  const hoverRow = (id: string | null) => {
    const hold = hoverHold.current;
    if (performance.now() < hold.until) {
      hold.pending = id;
      hold.dirty = true;
      return;
    }
    if (hoveredRef.current !== id) setHoveredMessageId(id);
  };
  const holdHoverForScroll = useCallback(() => {
    const hold = hoverHold.current;
    hold.until = performance.now() + 140;
    if (hoveredRef.current !== null) {
      hold.pending = null;
      hold.dirty = true;
      setHoveredMessageId(null);
    }
    if (hold.timer !== null) window.clearTimeout(hold.timer);
    hold.timer = window.setTimeout(() => {
      hold.timer = null;
      if (!hold.dirty) return;
      hold.dirty = false;
      if (hoveredRef.current !== hold.pending) setHoveredMessageId(hold.pending);
    }, 150);
  }, []);
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
  const deleteDialogGeneration = useRef(0);
  const deleteAttempts = useRef(new Set<string>());
  const deleteContext = useRef<OperationContext | null>(null);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const setDeleteConfirmId = (deleteConfirmId: string | null) => {
    const previous = deleteContext.current; deleteContext.current = null; previous?.dispose();
    deleteDialogGeneration.current++;
    if (deleteConfirmId !== null) {
      try {
        if (!scope) throw new Error('Sign in to this conversation before deleting a message.');
        const context = captureScopedOperation(scope); deleteContext.current = context;
        context.signal.addEventListener('abort', () => {
          if (deleteContext.current === context) setDeleteConfirmId(null);
        }, { once: true });
      } catch (error) { toast.error(extractApiError(error)); return; }
    }
    dispatchUI({ slice: 'popup', patch: { deleteConfirmId } });
  };
  useEffect(() => () => {
    const hold = hoverHold.current;
    if (hold.timer !== null) window.clearTimeout(hold.timer);
  }, []);
  useEffect(() => () => {
    deleteDialogGeneration.current++;
    const context = deleteContext.current; deleteContext.current = null; context?.dispose();
  }, []);
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

  const { editHistoryMsgId, editHistoryPos } = uiState.editHistory;
  const closeEditHistoryDialog = useCallback(() => {
    dispatchUI({ slice: 'editHistory', patch: { editHistoryMsgId: null } });
  }, []);
  const [isCoarsePointer, setIsCoarsePointer] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  });
  const [guildRoles, setGuildRoles] = useState<Role[]>([]);
  /** Revealed real authors for anonymous messages (keyed by message id). */
  const [deanonymizedById, setDeanonymizedById] = useState<Record<string, string>>({});
  const [deanonymizingId, setDeanonymizingId] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [threadCreating, setThreadCreating] = useState(false);
  const jumpFetchAttemptedRef = useRef<string | null>(null);
  /** Message id whose `#msg-` deep link has already been scrolled to, once. */
  const hashJumpDoneRef = useRef<string | null>(null);
  const queryJumpAttemptedRef = useRef<string | null>(null);
  const pendingScrollMessageRef = useRef<string | null>(null);
  const jumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const hasHydratedChannelRef = useRef(false);
  /**
   * The reader is at the newest message and wants to stay there. Set by the
   * reader's own scrolling; content growing underneath (an image, an embed or
   * a forwarded card finishing its load after the message arrived) does not
   * scroll, so it cannot clear it.
   */
  const followBottomRef = useRef(true);
  const followObserverRef = useRef<ResizeObserver | null>(null);
  /** When the reader last scrolled by hand (wheel, touch, scrollbar or keys). */
  const lastReaderScrollRef = useRef(0);
  const lastReadStateMessageIdRef = useRef<string | null>(null);
  const prevMessagesLenRef = useRef(0);
  const isLoadingMoreRef = useRef(false);

  const memberScope = useCurrentAccountScope();
  const activeGuildMembers = useMemberStore(
    useCallback(
      (state) => {
        if (!activeGuildId) return EMPTY_MEMBERS;
        return (memberScope ? state.members.get(memberScopeKey(memberScope, activeGuildId)) : undefined) ?? EMPTY_MEMBERS;
      },
      [activeGuildId, memberScope],
    ),
  );
  // The reader's own roles here, so a role mention reads as addressed to them.
  const myRoleIds = useMemo<ReadonlySet<string>>(() => {
    const mine = activeGuildMembers.find((member) => (member.user?.id ?? member.user_id) === me);
    return mine?.roles?.length ? new Set(mine.roles) : NO_ROLE_IDS;
  }, [activeGuildMembers, me]);

  // Build mention map: userId -> display name for @mention rendering.
  // Select only the active guild membership list to avoid rebuilding on unrelated guild updates.
  const mentionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of activeGuildMembers) {
      map.set(member.user.id, displayName(member.user, member.nick));
    }
    return map;
  }, [activeGuildMembers]);

  const roleNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of guildRoles) map.set(role.id, role.name);
    return map;
  }, [guildRoles]);

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
    // Guild switches are fast and this response is not. Without the guard, the
    // previous guild's roles landed after the switch and painted every author
    // name with a color from a guild the user is no longer looking at.
    let canceled = false;
    fetchGuildRoles(activeGuildId).then((data) => {
      if (!canceled) setGuildRoles(data);
    }).catch(() => {
      // non-fatal, role colors will simply not show
    });
    return () => {
      canceled = true;
    };
  }, [activeGuildId]);

  const messageById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const msg of messages) {
      map.set(msg.id, msg);
    }
    return map;
  }, [messages]);

  const replyLayoutById = useMemo(() => computeReplyLayout(messages), [messages]);

  // The catch-up divider's marker: the message the reader had read up to when
  // they opened this conversation. Taken once, by `markLatestRead` just before
  // it moves the read position (which opening the conversation does), so the
  // divider keeps saying what was new when you arrived while you read it.
  // "Mark read" clears it. The list is keyed by channel, so it starts empty
  // for each conversation.
  const [catchUpFrom, setCatchUpFrom] = useState<string | null>(null);
  const catchUpCapturedRef = useRef(false);

  // Build flat row list for virtualization.
  //
  // Grouping decides the bubbles' shape (§2.4): a group is one author, close in
  // time, on one day, with no reply and no system line breaking it. Every
  // message knows whether it continues the group above (`isGrouped`) and
  // whether the next one continues it (`isLastInGroup`): the first carries the
  // name and time, the last carries the face.
  const rows: VirtualRow[] = useMemo(() => {
    const result: VirtualRow[] = [];
    const nowMs = Date.now();
    const count = messages.length;
    const parentIds: (string | null)[] = new Array(count);
    const joinsPrevious: boolean[] = new Array(count);
    const dayBreaks: boolean[] = new Array(count);
    const systems: boolean[] = new Array(count);
    const catchUp = findCatchUp(messages, catchUpFrom, me, isSystemMessage, hasMore);

    for (let i = 0; i < count; i++) {
      const msg = messages[i];
      const prevMsg = i > 0 ? messages[i - 1] : null;
      let parentId = replyLayoutById.get(msg.id)?.parentId ?? null;
      const msgType = msg.message_type ?? msg.type;
      if (!parentId && prevMsg && msgType === MessageType.Reply) parentId = prevMsg.id;
      parentIds[i] = parentId;
      systems[i] = isSystemMessage(msg);
      const timestamp = getTimestamp(msg);
      // A day kicker between days, and above the oldest loaded message when it
      // is not from today (the reference opens today's conversation bare).
      dayBreaks[i] = prevMsg
        ? isDifferentDay(getTimestamp(prevMsg), timestamp)
        : Boolean(timestamp) && !isToday(timestamp, nowMs);
      joinsPrevious[i] =
        prevMsg !== null
        && !dayBreaks[i]
        // The divider splits a group: what you missed starts a new one.
        && catchUp?.index !== i
        && !parentId
        && !systems[i]
        && !systems[i - 1]
        && shouldGroup(prevMsg, msg);
    }

    for (let i = 0; i < count; i++) {
      const msg = messages[i];
      if (dayBreaks[i]) {
        result.push({ type: 'date-separator', date: getTimestamp(msg) });
      }
      if (catchUp && catchUp.index === i) {
        result.push({ type: 'catch-up', count: catchUp.count, atLeast: catchUp.atLeast, since: catchUp.since });
      }
      result.push({
        type: 'message',
        message: msg,
        messageIndex: i,
        isGrouped: joinsPrevious[i],
        isLastInGroup: !(i + 1 < count && joinsPrevious[i + 1]),
        isSystem: systems[i],
        replyParentId: parentIds[i],
      });
    }

    // Room events sit at the tail of the timeline, after everything that has
    // actually been said: they report what is happening *now*, not something
    // that happened at a point in the history.
    for (const event of roomLitEvents) {
      result.push({ type: 'room-event', event });
    }

    if (activeTyping.length > 0) {
      result.push({ type: 'typing' });
    }

    result.push({ type: 'bottom-sentinel' });
    return result;
  }, [messages, activeTyping.length, replyLayoutById, roomLitEvents, catchUpFrom, me, hasMore]);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 140;
  }, []);

  const readStateWriteRef = useRef<AbortController | null>(null);
  const readStateRetryRef = useRef(0);
  useEffect(() => {
    lastReadStateMessageIdRef.current = null;
    readStateRetryRef.current = 0;
    return () => { readStateWriteRef.current?.abort(); };
  }, [memberScope, channelId]);

  const markLatestRead = useCallback(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage?.id || lastReadStateMessageIdRef.current === lastMessage.id) return;
    const scope = memberScope;
    if (!scope) return;

    // Before the position moves, remember where it was: that is where "new"
    // starts for the catch-up divider. Once per conversation opened; a channel
    // never read has no position and so nothing to catch up on.
    if (!catchUpCapturedRef.current) {
      catchUpCapturedRef.current = true;
      const readUpTo = useReadStateStore.getState().getReadState(scope, channelId)?.last_message_id;
      if (readUpTo) setCatchUpFrom(readUpTo);
    }

    // Update the visible state immediately. Persistence is retried below and the
    // server enforces a monotonic cursor, so a delayed older request cannot undo it.
    useReadStateStore.getState().markRead(scope, channelId, lastMessage.id);
    readStateWriteRef.current?.abort();
    const writeController = new AbortController();
    readStateWriteRef.current = writeController;
    useReadStateStore.getState().saveReadPosition(scope, channelId, lastMessage.id, { delayMs: 300, signal: writeController.signal }).then(() => {
        lastReadStateMessageIdRef.current = lastMessage.id;
        readStateRetryRef.current = 0;
      }).catch((error) => {
        if (writeController.signal.aborted) return;
        // Do not permanently dedupe a failed write. Keep the optimistic cursor,
        // retry on the next near-bottom signal, and make the failure observable.
        lastReadStateMessageIdRef.current = null;
        readStateRetryRef.current += 1;
        if (readStateRetryRef.current >= 3) {
          toast.error(`Failed to save read position: ${extractApiError(error)}`);
          readStateRetryRef.current = 0;
        }
      });
  }, [messages, channelId, memberScope]);

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row.type === 'date-separator') return 44;
      // 12px above a 28px row.
      if (row.type === 'catch-up') return 40;
      if (row.type === 'room-event') return 36;
      if (row.type === 'typing') return 46;
      if (row.type === 'bottom-sentinel') return 1;
      if (row.isSystem) return 34;
      // A bubble is 42px; the first of a group adds the 22px name line, and
      // the gap above is 12px between groups and 4px inside one.
      return row.isGrouped ? 46 : 80;
    },
    overscan: 10,
    // The first row clears the 28px fade under the header; the last sits
    // 16px above the composer (§3.2).
    paddingStart: 28,
    paddingEnd: 16,
    measureElement: (el) => {
      if (!el) return 0;
      return el.getBoundingClientRect().height;
    },
  });

  /**
   * Put the timeline on its newest message and hold it there while the rows
   * around it measure themselves.
   *
   * `virtualizer.scrollToIndex(rows.length - 1)` cannot do this on a channel
   * with real history. Every row it scrolls past measures to something other
   * than its estimate, the offset it was aiming at moves, and TanStack gives up
   * after ten corrections ("Failed to scroll to index N after 10 attempts"). On
   * a 600-message channel that left the reader hundreds of messages in the past
   * on open, with "Jump to present" needing three presses to walk to the end.
   *
   * Driving the scroll element to its own end and re-checking until the height
   * stops moving lands in one gesture whatever the list length. It is also
   * instant by construction, which is the only honest option here: a smooth
   * scroll across a list whose size changes as it travels is what the
   * virtualizer warns about, and what it was already failing to deliver.
   */
  const scrollToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frames = 0;
    let settled = 0;
    const drive = () => {
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      if (Math.abs(element.scrollTop - target) <= 2) {
        // Two quiet frames in a row: nothing is still growing underneath us.
        if (++settled >= 2) return;
      } else {
        settled = 0;
        element.scrollTop = target;
      }
      if (++frames < 60) requestAnimationFrame(drive);
    };
    requestAnimationFrame(drive);
  }, []);

  /**
   * Put one message in the middle of the timeline and hold it there while the
   * rows around it measure themselves.
   *
   * `virtualizer.scrollToIndex` cannot do this, for the same reason it could
   * not open a busy channel at its newest message: every row it travels past
   * measures to something other than its estimate, the offset it was aiming at
   * moves, and TanStack gives up after ten corrections ("Failed to scroll to
   * index N after 10 attempts") — and `behavior: 'smooth'` is what it warns
   * about on a dynamically sized list in the first place. Measured on an
   * 81-message room: clicking a pin forty messages back landed the reader on
   * message 1, thirty rows short of the message they asked for, and left them
   * there with no error and nothing to retry.
   *
   * Getting close with the virtualizer and then correcting against the row's
   * own rect, frame by frame until it stops moving, lands on the message
   * itself whatever the list does underneath.
   */
  const scrollMessageIntoView = useCallback(
    (messageId: string, rowIndex: number) => {
      const element = scrollRef.current;
      if (!element) return;
      // A jump is the reader choosing a place: stop holding the bottom.
      followBottomRef.current = false;
      virtualizer.scrollToIndex(rowIndex, { align: 'center' });
      let frames = 0;
      let settled = 0;
      const drive = () => {
        const row = document.getElementById(`msg-${messageId}`);
        if (row) {
          const port = element.getBoundingClientRect();
          const rect = row.getBoundingClientRect();
          const delta = rect.top + rect.height / 2 - (port.top + port.height / 2);
          if (Math.abs(delta) <= 2) {
            // Three quiet frames: nothing above the row is still growing.
            if (++settled >= 3) return;
          } else {
            settled = 0;
            element.scrollTop = Math.max(
              0,
              Math.min(element.scrollTop + delta, element.scrollHeight - element.clientHeight),
            );
          }
        } else {
          settled = 0;
        }
        if (++frames < 90) requestAnimationFrame(drive);
      };
      requestAnimationFrame(drive);
    },
    [virtualizer],
  );

  /**
   * Where the reader was standing when a page of older messages was asked for,
   * so the prepend can be put underneath them instead of moving them.
   */
  const prependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
    /** The message the reader was standing on, so the prepend can be measured
     *  against the row itself rather than against the list's total height. */
    messageId: string | null;
    /** That row's offset from the top of the scroll port when it was recorded. */
    offset: number;
  } | null>(null);

  /**
   * Keep the reader on the message they were looking at when older history
   * arrives above it.
   *
   * Without this the prepended page lands on top and the scroll position stays
   * at 0 — which reads as "nothing happened", and, worse, ends pagination: the
   * element is already at the top, so no further scroll event can fire, so
   * `handleScroll` never asks for the next page. A channel with six hundred
   * messages dead-ended at a hundred, with the rest unreachable by scrolling.
   */
  const restorePrependAnchor = useCallback(() => {
    const anchor = prependAnchorRef.current;
    const element = scrollRef.current;
    prependAnchorRef.current = null;
    if (!anchor || !element) return;
    // Where the anchor row has to end up: its own start offset, less the gap it
    // had from the top of the port when the reader asked for the page.
    //
    // The list's total height is not enough on its own. Once a channel is at
    // its 500-message cap (MAX_MESSAGES_PER_CHANNEL) a prepended page is paid
    // for by trimming the same number of messages off the *newest* end:
    // `scrollHeight` does not change, the old `grown` was 0, and the restore
    // left the reader pinned at scrollTop 0 — where no scroll event can fire,
    // so `handleScroll` never asked for another page. Measured on a
    // 600-message channel: ten pages loaded and then nothing, ever, with
    // messages 1-50 unreachable and "Jump to present" landing on 550.
    // The anchor row's own element is no help either: at scrollTop 0 it is
    // fifty rows down the list and the virtualizer has not mounted it.
    const anchorIndex = anchor.messageId
      ? rows.findIndex((r) => r.type === 'message' && r.message.id === anchor.messageId)
      : -1;
    const offsetForAnchor =
      anchorIndex >= 0 ? virtualizer.getOffsetForIndex(anchorIndex, 'start')?.[0] : undefined;
    let frames = 0;
    let settled = 0;
    let applied = element.scrollTop;
    const drive = () => {
      // The reader moved under us; their position wins over the restore.
      if (Math.abs(element.scrollTop - applied) > 2) return;
      const anchorRow = anchor.messageId
        ? document.getElementById(`msg-${anchor.messageId}`)
        : null;
      let target: number;
      if (anchorRow) {
        // Mounted: correct against the row itself, which survives every
        // re-measure underneath it.
        target =
          element.scrollTop +
          (anchorRow.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            anchor.offset);
      } else if (offsetForAnchor !== undefined) {
        target = offsetForAnchor - anchor.offset;
      } else {
        target = anchor.scrollTop + Math.max(0, element.scrollHeight - anchor.scrollHeight);
      }
      target = Math.max(0, Math.min(target, Math.max(0, element.scrollHeight - element.clientHeight)));
      if (Math.abs(element.scrollTop - target) <= 1) {
        if (++settled >= 2) return;
      } else {
        settled = 0;
        element.scrollTop = target;
      }
      applied = element.scrollTop;
      if (++frames < 30) requestAnimationFrame(drive);
    };
    requestAnimationFrame(drive);
  }, [rows, virtualizer]);

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
    followBottomRef.current = true;
    lastReadStateMessageIdRef.current = null;
    // A deep link is per-channel; re-arm the once-guard so navigating away and
    // back to a `#msg-` link still jumps.
    hashJumpDoneRef.current = null;
    readStateRetryRef.current = 0;
    prevMessagesLenRef.current = 0;
    isLoadingMoreRef.current = false;
    setShowScrollButton(false);
    setNewMessageCount(0);
    setThreadModalForMessageId(null);
    setThreadCreateError(null);
    setThreadName('');
    setBulkDeleteMode(false);
    setSelectedMessageIds([]);
    setBulkDeleting(false);
    setAttachmentBusyId(null);
    // Clear overlays that would otherwise stick across channel switches
    // (edit mode, delete confirm, menus, report modal, etc.).
    dispatchUI({
      slice: 'popup',
      patch: {
        hoveredMessageId: null,
        focusedMessageId: null,
        menuMessageId: null,
        profileUser: null,
        emojiPickerFor: null,
        deleteConfirmId: null,
      },
    });
    dispatchUI({ slice: 'edit', patch: { editingMessageId: null, editContent: '' } });
    dispatchUI({
      slice: 'report',
      patch: { reportingMessage: null, reportReason: '', reportEvidence: '', reportSubmitting: false },
    });
    dispatchUI({
      slice: 'editHistory',
      patch: { editHistoryMsgId: null },
    });
    setDeanonymizedById({});
    setDeanonymizingId(null);
  }, [channelId]);

  useEffect(() => {
    const shouldHydrateThreads =
      Boolean(activeGuildId) &&
      (activeChannelType === 0 || activeChannelType === 5 || activeChannelType === 7);
    if (!shouldHydrateThreads) return;
    const lastHydrated = _threadHydratedAt.get(channelId) ?? 0;
    if (Date.now() - lastHydrated < THREAD_CACHE_TTL_MS) return;
    let canceled = false;
    const hydrateThreads = async () => {
      try {
        const [activeRes, archivedRes] = await Promise.all([
          channelApi.getThreads(channelId),
          channelApi.getArchivedThreads(channelId),
        ]);
        if (canceled) return;
        _threadHydratedAt.set(channelId, Date.now());
        const upsertChannel = channelActions;
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
      canceled = true;
    };
  }, [channelId, activeGuildId, activeChannelType, channelActions]);

  // Clear the load-more guard when the store finishes loading (including failures).
  useEffect(() => {
    if (!isLoading) {
      isLoadingMoreRef.current = false;
    }
  }, [isLoading]);

  // Latest scroll machinery, refreshed every render for the effect below.
  const scrollDepsRef = useRef({
    virtualizer,
    rows,
    markLatestRead,
    isNearBottom,
    scrollToEnd,
    restorePrependAnchor,
  });
  scrollDepsRef.current = {
    virtualizer,
    rows,
    markLatestRead,
    isNearBottom,
    scrollToEnd,
    restorePrependAnchor,
  };

  // Scroll to bottom on new messages / initial load
  useEffect(() => {
    if (!messages.length) return;

    // If we just loaded older messages (prepend), hold the reader's place
    // rather than scrolling anywhere.
    if (isLoadingMoreRef.current) {
      isLoadingMoreRef.current = false;
      prevMessagesLenRef.current = messages.length;
      scrollDepsRef.current.restorePrependAnchor();
      return;
    }

    // Read the scroll machinery through a ref rather than closing over it.
    // `virtualizer`, `rows` and `markLatestRead` all change identity on almost
    // every render (typing indicators, reactions, hover). Listing them as
    // dependencies would re-run this effect — and therefore re-scroll — for
    // reasons that have nothing to do with a new message arriving; omitting
    // them without a ref would capture stale values. The ref gives correct
    // values with the intended trigger set (channel, count, newest id).
    const { markLatestRead, isNearBottom, scrollToEnd } = scrollDepsRef.current;
    const shouldStickToBottom = !hasHydratedChannelRef.current || isNearBottom();
    if (shouldStickToBottom) {
      scrollToEnd();
      markLatestRead();
      setShowScrollButton(false);
      setNewMessageCount(0);
    } else {
      setShowScrollButton(true);
      // Only arrivals the user has scrolled away from are worth announcing.
      // `hasHydratedChannelRef` is false only for the channel's first page, so
      // the initial backlog never counts as "new".
      if (hasHydratedChannelRef.current && messages.length > prevMessagesLenRef.current) {
        const arrived = messages.length - prevMessagesLenRef.current;
        setNewMessageCount((current) => current + arrived);
      }
    }
    hasHydratedChannelRef.current = true;
    prevMessagesLenRef.current = messages.length;
  }, [channelId, channelServerId, messages.length, lastMessageId]);

  // The "… is typing" row is appended to the end of the timeline, so it makes
  // the list taller without changing the message count — and the effect above
  // only re-scrolls when a message arrives. A reader sitting at the bottom
  // therefore got the indicator painted just below the fold: in two desktop
  // clients side by side, typing in one never showed in the other unless the
  // reader happened to scroll down by hand. Hold the bottom when it appears.
  useEffect(() => {
    if (!activeTyping.length) return;
    const { isNearBottom, scrollToEnd } = scrollDepsRef.current;
    if (isNearBottom()) scrollToEnd();
  }, [activeTyping.length]);

  // A message that grows after it lands (its picture decodes, a link preview
  // or a forwarded card fills in) made the timeline taller after the arrival
  // scroll had settled, and a reader at the bottom was left looking at the
  // message above it with "Jump to present" showing. Hold the bottom through
  // that growth for as long as the reader has not scrolled away.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const mark = () => {
      lastReaderScrollRef.current = performance.now();
    };
    const events = ['wheel', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'keydown'] as const;
    for (const name of events) scroller.addEventListener(name, mark, { passive: true });
    return () => {
      for (const name of events) scroller.removeEventListener(name, mark);
    };
  }, [channelId]);

  const timelineContentRef = useCallback((node: HTMLDivElement | null) => {
    followObserverRef.current?.disconnect();
    followObserverRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current;
      if (!element || !followBottomRef.current || isLoadingMoreRef.current) return;
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    });
    observer.observe(node);
    followObserverRef.current = observer;
  }, []);

  const highlightJumpTarget = useCallback((messageId: string) => {
    setJumpHighlightId(messageId);
    if (jumpHighlightTimerRef.current) clearTimeout(jumpHighlightTimerRef.current);
    jumpHighlightTimerRef.current = setTimeout(() => {
      setJumpHighlightId((current) => current === messageId ? null : current);
      jumpHighlightTimerRef.current = null;
    }, 2200);
  }, []);

  // Unmount cleanup for every timer and object URL this component owns. Without
  // the blob revoke, leaving a channel stranded every lightbox image in memory
  // for the lifetime of the tab.
  useEffect(() => () => {
    if (jumpHighlightTimerRef.current) clearTimeout(jumpHighlightTimerRef.current);
    readStateWriteRef.current?.abort();
    lightboxBlobGeneration++;
    useLightboxStore.getState().close();
    revokeLightboxBlobUrls();
  }, []);

  // `window.location.hash = 'msg-<id>'` is how search and the pins panel ask
  // for a jump, and it fires `hashchange` — nothing else. The jump effect below
  // reads the hash but is keyed on the timeline'"'"'s own state, so unless a message
  // happened to arrive in the same moment it never re-ran and the jump did
  // nothing at all. Tick it here, and forget the last target so asking for the
  // same message twice works the second time too.
  const [hashJumpTick, setHashJumpTick] = useState(0);
  useEffect(() => {
    const onHashChange = () => {
      hashJumpDoneRef.current = null;
      jumpFetchAttemptedRef.current = null;
      setHashJumpTick((tick) => tick + 1);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!window.location.hash.startsWith('#msg-')) {
      jumpFetchAttemptedRef.current = null;
      hashJumpDoneRef.current = null;
      return;
    }
    const msgId = window.location.hash.slice(5); // strip '#msg-'
    // This effect depends on `rows`, which is rebuilt on every new message,
    // reaction and typing flicker. Without a once-guard the found-row branch
    // re-ran on each of those and yanked the viewport back to the search
    // target forever — the deep link permanently owned the scroll position.
    if (hashJumpDoneRef.current === msgId) return;
    const rowIndex = rows.findIndex(
      (r) => r.type === 'message' && r.message.id === msgId
    );
    if (rowIndex >= 0) {
      hashJumpDoneRef.current = msgId;
      scrollMessageIntoView(msgId, rowIndex);
      highlightJumpTarget(msgId);
      jumpFetchAttemptedRef.current = msgId;
      // Consume the hash the same way `?message=` is stripped once its target
      // is in view, so a later reload or re-render cannot replay the jump.
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
      return;
    }
    // Message not in the loaded window — fetch around the anchor once, then scroll.
    if (jumpFetchAttemptedRef.current === msgId) return;
    jumpFetchAttemptedRef.current = msgId;
    let canceled = false;
    void (async () => {
      try {
        await fetchMessages(channelId, { around: msgId, limit: 50 });
        if (canceled) return;
        requestAnimationFrame(() => {
          if (canceled) return;
          const el = document.getElementById(`msg-${msgId}`);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        });
      } catch {
        // Leave hash in place; user can retry by reopening search/pins.
        jumpFetchAttemptedRef.current = null;
      }
    })();
    return () => {
      canceled = true;
    };
  }, [messages.length, channelId, fetchMessages, highlightJumpTarget, hashJumpTick, rows, scrollMessageIntoView]);

  const scrollToMessage = useCallback((messageId: string) => {
    const rowIndex = rows.findIndex(
      (entry) => entry.type === 'message' && entry.message.id === messageId
    );
    if (rowIndex >= 0) {
      scrollMessageIntoView(messageId, rowIndex);
      highlightJumpTarget(messageId);
      return;
    }
    pendingScrollMessageRef.current = messageId;
    void (async () => {
      try {
        await fetchMessages(channelId, { around: messageId, limit: 50 });
      } catch (err) {
        if (pendingScrollMessageRef.current === messageId) pendingScrollMessageRef.current = null;
        if (queryJumpAttemptedRef.current === messageId) queryJumpAttemptedRef.current = null;
        toast.error(`Failed to jump to message: ${extractApiError(err)}`);
      }
    })();
  }, [rows, scrollMessageIntoView, highlightJumpTarget, fetchMessages, channelId]);

  useEffect(() => {
    const messageId = pendingScrollMessageRef.current;
    if (!messageId) return;
    const rowIndex = rows.findIndex(
      (entry) => entry.type === 'message' && entry.message.id === messageId,
    );
    if (rowIndex < 0) return;
    pendingScrollMessageRef.current = null;
    scrollMessageIntoView(messageId, rowIndex);
    highlightJumpTarget(messageId);
  }, [rows, scrollMessageIntoView, highlightJumpTarget]);

  useEffect(() => {
    const messageId = searchParams.get('message');
    if (!messageId) {
      queryJumpAttemptedRef.current = null;
      return;
    }
    if (queryJumpAttemptedRef.current === messageId) return;
    queryJumpAttemptedRef.current = messageId;
    scrollToMessage(messageId);
  }, [scrollToMessage, searchParams]);

  // Strip ?message= only after the target is in the loaded window so a failed
  // around-fetch can be retried from the same deep link.
  useEffect(() => {
    const messageId = searchParams.get('message');
    if (!messageId) return;
    const rowIndex = rows.findIndex(
      (entry) => entry.type === 'message' && entry.message.id === messageId,
    );
    if (rowIndex < 0) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('message');
    setSearchParams(nextParams, { replace: true });
  }, [rows, searchParams, setSearchParams]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(hover: none), (pointer: coarse)');
    const updatePointerMode = () => setIsCoarsePointer(mediaQuery.matches);
    updatePointerMode();
    mediaQuery.addEventListener('change', updatePointerMode);
    return () => mediaQuery.removeEventListener('change', updatePointerMode);
  }, []);

  /* §5.1 phone pull: dragging the timeline down at its very top reveals the
     room's lamp — a small light that brightens with the pull distance and
     flickers once when the refresh fires. A light, never a spinner. The
     gesture only watches: every listener is passive, the timeline's own scroll
     is untouched, and the lamp is driven by direct style writes (no React
     state per move). It exists only where a pull is physically possible. */
  const pullLampRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    const lamp = pullLampRef.current;
    if (!scroller || !lamp || !isCoarsePointer) return;

    const DEAD_ZONE = 8; // px of slack a finger takes before the lamp answers
    const FIRE_AT = 72; // px of pull that asks the room for what it missed
    const RIDE = 30; // px the lamp rides down at a full pull
    let startY = 0;
    let pulling = false;
    let pull = 0;
    let settle: Animation | null = null;

    const rest = () => {
      lamp.style.opacity = '0';
      lamp.style.transform = '';
    };

    const hide = () => {
      pull = 0;
      if (typeof lamp.animate !== 'function' || prefersReducedMotion()) {
        rest();
        return;
      }
      // The lamp goes out the way lights do — a fast dim, not a snap.
      const leaving = lamp.animate(
        [{ opacity: lamp.style.opacity || '0' }, { opacity: '0' }],
        { duration: ms('--duration-fast'), easing: motionToken('--ease-in'), fill: 'forwards' },
      );
      leaving.id = 'data-motion-recipe:exit';
      settle = leaving;
      leaving.finished.then(
        () => {
          settle = null;
          if (!pulling) rest();
        },
        () => {
          settle = null;
        },
      );
    };

    const paint = (amount: number) => {
      // A finger back on the lamp cancels the dim it was playing out.
      settle?.cancel();
      settle = null;
      const t = Math.min(1, amount / FIRE_AT);
      lamp.style.opacity = String(0.15 + t * 0.85);
      lamp.style.transform = `translate3d(-50%, ${-16 + t * RIDE}px, 0)`;
    };

    const onStart = (event: TouchEvent) => {
      startY = event.touches[0]?.clientY ?? 0;
      pulling = scroller.scrollTop <= 0;
      pull = 0;
    };
    const onMove = (event: TouchEvent) => {
      if (!pulling) return;
      if (scroller.scrollTop > 0) {
        // The gesture became the timeline's own scroll — it was never ours.
        pulling = false;
        if (pull > 0) hide();
        return;
      }
      const dy = (event.touches[0]?.clientY ?? 0) - startY;
      pull = Math.max(0, dy - DEAD_ZONE);
      paint(pull);
    };
    const onEnd = () => {
      if (!pulling) return;
      pulling = false;
      if (pull >= FIRE_AT) {
        // The refresh fires: the lamp flickers once to say so (§5.1), then
        // goes back out.
        const pulse = flicker(lamp);
        void fetchMessages(channelId);
        if (pulse) {
          pulse.finished.then(hide, hide);
        } else {
          hide();
        }
        return;
      }
      hide();
    };

    scroller.addEventListener('touchstart', onStart, { passive: true });
    scroller.addEventListener('touchmove', onMove, { passive: true });
    scroller.addEventListener('touchend', onEnd, { passive: true });
    scroller.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
      settle?.cancel();
      rest();
    };
  }, [isCoarsePointer, channelId, fetchMessages]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    holdHoverForScroll();
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom <= 140;
    // Only the reader can leave the bottom. The virtualizer also moves
    // scrollTop when a row above the fold measures taller, and that must not
    // count as the reader scrolling away.
    if (nearBottom) followBottomRef.current = true;
    else if (performance.now() - lastReaderScrollRef.current < 1000) followBottomRef.current = false;
    setShowScrollButton(!nearBottom && distanceFromBottom > 200);
    if (nearBottom) {
      markLatestRead();
      setNewMessageCount(0);
    }

    // Load older messages when scrolled near top
    if (scrollTop < 200 && hasMore && !isLoading) {
      isLoadingMoreRef.current = true;
      const anchorId = messages[0]?.id ?? null;
      const anchorRow = anchorId ? document.getElementById(`msg-${anchorId}`) : null;
      prependAnchorRef.current = {
        scrollHeight,
        scrollTop,
        messageId: anchorId,
        offset: anchorRow
          ? anchorRow.getBoundingClientRect().top -
            scrollRef.current.getBoundingClientRect().top
          : 0,
      };
      loadMore();
    }
  }, [hasMore, holdHoverForScroll, isLoading, loadMore, markLatestRead, messages]);

  const scrollToBottom = useCallback(() => {
    // "Jump to present" has to mean the present. A reader who scrolled a long
    // way back paid for every older page by having the same number of messages
    // trimmed off the *newest* end of the window (MAX_MESSAGES_PER_CHANNEL), so
    // the end of what is loaded can be a hundred messages short of the
    // channel's actual last message. Measured on a 600-message channel after a
    // full scrollback: one press landed on message 500 and presented it as the
    // newest, with the composer sitting under it and no sign that a hundred
    // messages were missing. Fetch the newest page back before traveling to
    // it — the plain fetch caps from the other end and keeps the newest.
    const newestLoaded = messages[messages.length - 1]?.id;
    const newestKnown = activeChannel?.last_message_id ?? null;
    if (newestKnown && newestLoaded && String(newestLoaded) !== String(newestKnown)) {
      void fetchMessages(channelId).then(() => scrollToEnd());
    }
    scrollToEnd();
    markLatestRead();
    setShowScrollButton(false);
    setNewMessageCount(0);
  }, [scrollToEnd, markLatestRead, messages, activeChannel, fetchMessages, channelId]);

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

  const toggleReaction = useCallback(async (
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
  }, [addReaction, channelId, removeReaction]);
  const toggleReactionFromRow = useCallback(
    (messageId: string, reaction: ReactionTally) => void toggleReaction(messageId, reaction),
    [toggleReaction],
  );

  const deanonymizeMessage = async (message: Message) => {
    if (!message.anonymous?.can_deanonymize || deanonymizingId) return;
    setDeanonymizingId(message.id);
    try {
      const { data } = await channelApi.deanonymizeMessage(channelId, message.id);
      const label =
        data.user?.username
          ? `${data.user.username}${data.user.discriminator != null ? `#${data.user.discriminator}` : ''}`
          : data.user_id;
      setDeanonymizedById((prev) => ({ ...prev, [message.id]: label }));
      toast.success(`Revealed author: ${label}`);
    } catch (err) {
      toast.error(`Failed to deanonymize: ${extractApiError(err)}`);
    } finally {
      setDeanonymizingId(null);
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

  const toggleSavedMessage = async (message: Message) => {
    const isSaved = savedIds.has(message.id);
    setMenuMessageId(null);
    try {
      if (isSaved) {
        await useSavedMessageStore.getState().remove(message.id);
        toast.success('Removed from saved messages.');
      } else {
        await useSavedMessageStore.getState().save(message.id);
        toast.success('Saved for later.');
      }
    } catch (err) {
      toast.error(`Failed to ${isSaved ? 'remove' : 'save'} message: ${extractApiError(err)}`);
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
    setEditSaving(false);
  };

  const saveEditMessage = async () => {
    if (!editingMessageId || editSaving) return;
    const trimmed = editContent.trim();
    if (!trimmed) return;
    const msg = messages.find((m) => m.id === editingMessageId);
    if (trimmed === (msg?.content || '')) {
      cancelEditing();
      return;
    }
    setEditSaving(true);
    try {
      await editMessage(channelId, editingMessageId, trimmed);
    } catch (err) {
      toast.error(`Failed to edit message: ${extractApiError(err)}`);
      // keep editing state so user can retry
      return;
    } finally {
      setEditSaving(false);
    }
    cancelEditing();
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!editSaving) void saveEditMessage();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (deleteAttempts.current.has(messageId)) return;
    const generation = deleteDialogGeneration.current;
    const context = deleteContext.current;
    deleteAttempts.current.add(messageId); setDeletingMessageId(messageId);
    try {
      if (!context) throw new Error('Review the current message before deleting it.');
      context.assertCurrent();
      await deleteMessage(channelId, messageId);
      context.assertCurrent();
    } catch (err) {
      if (deleteDialogGeneration.current === generation) toast.error(`Failed to delete message: ${extractApiError(err)}`);
      return;
    } finally {
      deleteAttempts.current.delete(messageId);
      setDeletingMessageId(current => current === messageId ? null : current);
    }
    if (deleteDialogGeneration.current !== generation) return;
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

  const openEditHistory = (event: MouseEvent<HTMLElement>, msgId: string) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    dispatchUI({ slice: 'editHistory', patch: {
      editHistoryMsgId: msgId, editHistoryPos: { x: rect.left, y: rect.bottom + 4 },
    } });
  };

  const handleMentionClick = useCallback((userId: string) => {
    const member = activeGuildMemberById.get(userId);
    if (member) {
      setProfilePos({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      setProfileUser({
        id: member.user.id,
        username: member.user.username,
        display_name: member.user.display_name,
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
    const nextName = baseName ? baseName.slice(0, 80) : 'New thread';
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
    channelActions.selectChannel(threadId);
    navigate(`/app/guilds/${activeGuildId}/channels/${threadId}`);
  };

  const submitCreateThread = async () => {
    if (!canCreateThreads || !threadModalForMessageId || !activeGuildId || threadCreating) return;
    const trimmed = threadName.trim();
    if (!trimmed || trimmed.length > 100) {
      setThreadCreateError('Thread name must be between 1 and 100 characters.');
      return;
    }
    setThreadCreateError(null);
    setThreadCreating(true);
    try {
      const { data: thread } = await channelApi.createThread(channelId, {
        name: trimmed,
        message_id: threadModalForMessageId,
      });
      channelActions.addChannel(thread);
      channelActions.selectChannel(thread.id);
      setThreadModalForMessageId(null);
      setThreadName('');
      navigate(`/app/guilds/${activeGuildId}/channels/${thread.id}`);
    } catch (err) {
      const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
      setThreadCreateError(responseData?.message || responseData?.error || 'Failed to create thread.');
    } finally {
      setThreadCreating(false);
    }
  };

  const buildMessageContextMenuItems = (msg: Message, at: { x: number; y: number }): ContextMenuItem[] => {
    const isOwnMessage = msg.author.id === me;
    // Editing rewrites the whole encrypted body, and a delivered message's
    // attachment descriptors cannot be recovered from the server, so an
    // encrypted message that carries attachments is not editable.
    const canEditMsg = isOwnMessage && !hasEncryptedAttachments(msg);
    const canDeleteMsg = isOwnMessage || canManageMessages;
    const canPinMsg = canPinInChannel;
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
        label: 'Create thread',
        icon: <Hash size={14} />,
        action: () => openCreateThreadDialog(msg),
      });
    }

    if (canAddReactions) {
      items.push({
        label: 'React',
        icon: <Smile size={14} />,
        // The click point itself, the way Remind me takes it: reading state
        // here returns where the PREVIOUS menu opened — the new one is still
        // being dispatched.
        action: () => {
          setEmojiPickerFor({
            messageId: msg.id,
            position: {
              x: at.x + 4,
              y: at.y + 4,
            },
          });
        },
      });
    }

    if (msg.anonymous?.can_deanonymize) {
      items.push({
        label: deanonymizedById[msg.id] ? `Author: ${deanonymizedById[msg.id]}` : 'Reveal author',
        icon: <Eye size={14} />,
        disabled: Boolean(deanonymizedById[msg.id]) || deanonymizingId === msg.id,
        action: () => {
          void deanonymizeMessage(msg);
        },
      });
    }

    if (canEditMsg) {
      items.push({
        label: 'Edit message',
        icon: <Pencil size={14} />,
        action: () => startEditingMessage(msg),
      });
    }

    if (canPinMsg) {
      items.push({
        label: msg.pinned ? 'Unpin message' : 'Pin message',
        icon: msg.pinned ? <PinOff size={14} /> : <Pin size={14} />,
        action: () => {
          void togglePin(msg);
        },
      });
    }

    items.push({
      label: 'Remind me',
      icon: <Clock size={14} />,
      // The click point itself: any anchor kept in state still holds the
      // previous menu's position while this list is being built.
      action: () => openRemind(msg, at.x, at.y),
    });
    const forwardBlocked = forwardBlockedFor(msg);
    items.push({
      label: 'Forward',
      icon: <Forward size={14} />,
      disabled: Boolean(forwardBlocked),
      description: forwardBlocked ?? undefined,
      action: () => {
        if (forwardBlocked) return;
        setForwardTarget(msg);
        setForwardOpen(true);
      },
    });

    items.push({
      label: savedIds.has(msg.id) ? 'Remove from Saved' : 'Save for later',
      icon: savedIds.has(msg.id) ? <BookmarkCheck size={14} /> : <Bookmark size={14} />,
      action: () => {
        void toggleSavedMessage(msg);
      },
    });

    items.push({ label: '', action: () => {}, divider: true });

    items.push({
      label: 'Copy text',
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
        label: 'Report message',
        icon: <MessageSquare size={14} />,
        action: () => openReportDialog(msg),
      });
    }

    if (canDeleteMsg) {
      items.push({ label: '', action: () => {}, divider: true });
      items.push({
        label: 'Delete message',
        icon: <Trash2 size={14} />,
        danger: true,
        action: () => requestDelete(msg.id),
      });
    }

    if (canManageMessages) {
      items.push({ label: '', action: () => {}, divider: true });
      items.push({
        label: bulkDeleteMode ? 'Cancel bulk delete' : 'Bulk delete messages',
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
    onContextMenu(e, buildMessageContextMenuItems(msg, { x: e.clientX, y: e.clientY }));
  };

  const rowActions = useForwardedActions({
    handleMessageRowKeyDown,
    handleMessageContextMenu,
    openAuthorProfile,
    toggleBulkSelection,
    scrollToMessage,
    openEditHistory,
    handleEditKeyDown,
    saveEditMessage,
    cancelEditing,
    downloadAttachment,
    deleteAttachment,
    openLinkedThread,
    openReactionPicker,
    reply: (message: Message) => onReply?.(message),
    togglePin,
    openCreateThreadDialog,
    startEditingMessage,
    deanonymizeMessage,
    openRemind,
    toggleSavedMessage,
    openReportDialog,
    requestDelete,
  });

  // Render a single virtual row
  const renderRow = (row: VirtualRow) => {
    if (row.type === 'date-separator') {
      return <DayDivider label={dayDividerLabel(row.date)} />;
    }

    if (row.type === 'catch-up') {
      return (
        <CatchUpDivider
          label={catchUpLabel(row)}
          onMarkRead={() => {
            setCatchUpFrom(null);
            markLatestRead();
          }}
        />
      );
    }

    if (row.type === 'room-event') {
      return <RoomLitEventRow event={row.event} onJoin={joinLitRoom} />;
    }

    if (row.type === 'typing') {
      const guildId = activeChannel?.guild_id;
      const guildMembers = guildId === activeGuildId
        ? activeGuildMembers
        : (guildId && memberScope ? useMemberStore.getState().members.get(memberScopeKey(memberScope, guildId)) ?? null : null);
      const resolveTypist = (userId: string): { id: string; name: string; avatar: string | null } => {
        if (guildMembers) {
          const member = guildMembers.find((m) => m.user.id === userId);
          if (member) {
            return { id: userId, name: displayName(member.user, member.nick), avatar: member.user.avatar_hash ?? null };
          }
        }
        // A DM has no guild and therefore no member list, so this fell through
        // to "Someone" for the one person in the conversation — whose name is
        // already in the header two lines above. The channel carries them.
        const recipients = activeChannel?.recipients
          ?? (activeChannel?.recipient ? [activeChannel.recipient] : []);
        const recipient = recipients.find((person) => person.id === userId);
        if (recipient) return { id: userId, name: displayName(recipient), avatar: recipient.avatar_hash ?? null };
        return { id: userId, name: 'Someone', avatar: null };
      };

      const typists = activeTyping.map(resolveTypist);
      // §3.2: typing is a bubble of three dots beside the typist's face. Up to
      // three are drawn; the sentence names everybody for assistive tech.
      return (
        <div className="glass-tl-typing-row glass-tl-col">
          {typists.slice(0, 3).map((typist) => (
            <div key={typist.id} className="glass-msg__typing">
              <span className="glass-msg__face">
                <TimelineAvatar userId={typist.id} name={typist.name} avatar={typist.avatar} />
              </span>
              <TypingBubble />
            </div>
          ))}
          <span className="sr-only">{typingSentence(typists.map((typist) => typist.name))}</span>
        </div>
      );
    }

    if (row.type === 'bottom-sentinel') {
      return <div style={{ height: 1 }} />;
    }

    // Message row.
    //
    // The store rejects authorless payloads, but this render path is also
    // reached for messages cached before that guard existed and for any future
    // shape the server invents. Substituting a placeholder author costs one
    // object and removes the last way a single bad record can white-screen the
    // app — the row degrades instead of the whole feed.
    const msg: Message = row.message.author?.id
      ? row.message
      : {
          ...row.message,
          author: {
            id: `unknown-${row.message.id}`,
            username: 'Unknown user',
            discriminator: '0000',
          },
        };
    const isGrouped = row.isGrouped;
    const isFirstInGroup = !isGrouped;
    const isLastInGroup = row.isLastInGroup;
    const replyParentId = row.replyParentId;
    const replyParentMessage = replyParentId ? messageById.get(replyParentId) : undefined;
    const isOwnMessage = msg.author.id === me;
    const canEditMessage = isOwnMessage && !hasEncryptedAttachments(msg);
    const canDeleteMessage = isOwnMessage || canManageMessages;
    const canPinMessage = canPinInChannel;
    const forwardBlocked = forwardBlockedFor(msg);
    const linkedThreads = linkedThreadsByStarterMessageId[msg.id] ?? NO_THREADS;
    const authorGuildMember = activeGuildMemberById.get(msg.author.id);
    const authorName = displayName(msg.author, authorGuildMember?.nick);
    const bubbleText = messageBubbleText(msg);
    const scoreUpdate = isSportsScoreAuthor(msg.author) ? parseScoreUpdate(msg.content || '') : null;
    // A feed's post reads as the feed: its picture, its name, a Feed tag, and
    // the item as a card instead of the text.
    const feedPost = msg.feed ?? null;
    const feedEmbed = feedPost ? (msg.embeds ?? []).find(isFeedEmbed) ?? null : null;
    const scoreSides = scoreUpdate ? resolveScoreSides(pinnedSportsGame, scoreUpdate) : null;
    const author = {
      id: msg.author.id,
      name: authorName,
      avatar: msg.author.avatar_hash ?? msg.author.avatar ?? null,
    };
    // A message that addresses the reader: its bubble takes the raised step
    // and their own mention becomes the white chip (§3.2).
    const mentionsMe = messageMentionsUser(msg, me, myRoleIds);
    const isActiveRow = hoveredMessageId === msg.id || focusedMessageId === msg.id;
    const menuOpen = menuMessageId === msg.id;
    // "From the room": written by somebody who is in the call right now (§7.2).
    const fromRoom = Boolean(inRoomUserIds?.has(msg.author.id));
    const isJumpTarget = jumpHighlightId === msg.id;
    const isEditing = editingMessageId === msg.id;

    const hasAttachments = Boolean(msg.attachments?.length);
    // Everything the row below reads from the list, and nothing else: while
    // these are unchanged the row keeps what it drew last time (hovering a
    // row, typing, a message arriving further up do not redraw the timeline).
    // Its handlers go through `rowActions`, which always calls the current
    // ones, so a row that did not redraw never acts on a stale list.
    //
    // The group edges are here because they decide the bubble's corners, the
    // name line and the face: a message arriving under this one from the same
    // author moves the face down, and this row must redraw for it.
    const rowDeps = [
      row.message, isGrouped, isLastInGroup, row.isSystem, replyParentId, row.messageIndex, messages.length,
      replyParentMessage, replyParentId ? deletedMessageIds.has(replyParentId) : false,
      me, mentionsMe, canManageMessages, canPinInChannel, canAddReactions, canCreateThreads, canVoteInPolls,
      Boolean(onReply), activeGuildId, channelId, ribbon, isCoarsePointer, lowBandwidthMode,
      downloadTicket, bulkDeleteMode, bulkDeleteMode && selectedMessageIds.includes(msg.id),
      authorGuildMember, activeGuildMemberById, mentionMap, roleNameMap, handleMentionClick,
      toggleReactionFromRow,
      scoreUpdate ? pinnedSportsGame : null, linkedThreads, pendingReminderIds.has(msg.id),
      savedIds.has(msg.id), decryptingIds.has(msg.id), deanonymizedById[msg.id], deanonymizingId === msg.id,
      isActiveRow, isJumpTarget, activeRowMessageId === msg.id, menuOpen,
      isEditing, isEditing ? editContent : null,
      isEditing ? editSaving : false,
      hasAttachments ? attachmentBusyId : null, hasAttachments ? downloadProgress : null,
      fromRoom, scope, lightStore,
    ];

    const timestamp = getTimestamp(msg);
    const fullTime = formatTimestamp(timestamp);
    const edited = msg.edited_timestamp || msg.edited_at;
    const rowHandlers = {
      onMouseEnter: () => hoverRow(msg.id),
      onMouseLeave: () => hoverRow(null),
      onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => rowActions.handleMessageRowKeyDown(e, msg.id),
      onFocus: () => {
        setFocusedMessageId(msg.id);
        setActiveRowId(msg.id);
      },
      onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocusedMessageId((curr) => (curr === msg.id ? null : curr));
        }
      },
      onContextMenu: (e: React.MouseEvent) => rowActions.handleMessageContextMenu(e, msg),
    };

    if (row.isSystem) {
      // §3.2: the conversation's own news is a centered line, not a bubble.
      return (
        <MessageRowMemo deps={rowDeps} render={() => (
          <div
            id={`msg-${msg.id}`}
            role="article"
            aria-label={`System message: ${systemMessageText(msg, authorName)}`}
            aria-posinset={row.messageIndex + 1}
            aria-setsize={messages.length}
            tabIndex={msg.id === activeRowMessageId ? 0 : -1}
            className="glass-tl-system glass-tl-col"
            data-jump={isJumpTarget || undefined}
            {...rowHandlers}
          >
            <span>{systemMessageText(msg, authorName)}</span>
            <InstrumentText dateTime={timestamp} className="glass-tl-system__time" title={fullTime}>
              {timelineTime(timestamp)}
            </InstrumentText>
          </div>
        )} />
      );
    }

    const decrypting = !msg.poll && decryptingIds.has(msg.id);
    const ephemeral = Boolean((msg.flags ?? 0) & 64);
    const scoreCard = !msg.poll && !decrypting && scoreUpdate && scoreSides;
    const feedCard = !msg.poll && !decrypting && !scoreCard && feedEmbed;
    // A message that is only events is an event share: a plan card, not a
    // bubble holding a chip (§3.2). An event inside a sentence stays a chip.
    const eventCards = activeGuildId && !decrypting && !ephemeral && !msg.forwarded_from && !msg.poll
      ? eventCardIds(bubbleText)
      : NO_EVENT_CARDS;
    const hasText = Boolean(bubbleText && bubbleText.trim()) && eventCards.length === 0;
    // A bubble holds words (or the promise of them: a decrypting skeleton, a
    // forwarded quote, a reply's context). A message that is only a picture or
    // only a card has no empty bubble above it.
    const hasBubble = !msg.poll && !scoreCard && !feedCard
      && (ephemeral || decrypting || hasText || Boolean(msg.forwarded_from) || Boolean(replyParentId));
    // Reactions are ONE chip biting the top-right corner of what the message
    // is (§3.2): its first picture, else its bubble, else its card. A message
    // with none of those (a sticker, an embed) gets the same chip in the flow.
    // The picture must be one the frame below actually draws.
    const biteMedia = !feedEmbed && !msg.e2ee && !lowBandwidthMode
      ? (msg.attachments ?? []).find((att) =>
        !inForwardCard(msg, att)
        && (isImageAttachment(att) || isClipAttachment(att.filename))
        && Boolean(resolveFederatedAttachmentUrl(att, msg.channel_id)))
      : undefined;
    const biteCard = scoreCard ? 'score' : feedCard ? 'feed' : msg.poll ? 'poll' : eventCards.length > 0 ? 'event' : null;
    const biteHost: 'media' | 'bubble' | 'card' | 'inline' = biteMedia
      ? 'media'
      : hasBubble && !isEditing
        ? 'bubble'
        : biteCard && !isEditing
          ? 'card'
          : 'inline';
    const bite = Array.isArray(msg.reactions) && msg.reactions.length > 0 ? (
      <ReactionBite
        reactions={msg.reactions as ReactionTally[]}
        guildId={activeGuildId}
        channelId={channelId}
        messageId={msg.id}
        onToggle={toggleReactionFromRow}
        placement={biteHost}
      />
    ) : null;
    // The actions a row offers: react, reply, more (§3.2). On the first of a
    // group they sit beside the name and time; a row without a header gets
    // them beside its bubble (fine pointer) or under it (touch, where a tap on
    // the message is what reveals them).
    const showActions = isActiveRow || menuOpen;
    const hasHeader = isFirstInGroup && !isOwnMessage;
    const actionsPlacement: 'header' | 'beside' | 'below' = hasHeader
      ? 'header'
      : isCoarsePointer ? 'below' : 'beside';
    const renderActions = () => (
      <MessageActions
        authorName={authorName}
        onReact={canAddReactions ? (e) => rowActions.openReactionPicker(e, msg.id) : undefined}
        onReply={onReply ? () => rowActions.reply(msg) : undefined}
        onMore={() => setMenuMessageId((curr) => (curr === msg.id ? null : msg.id))}
        moreExpanded={menuOpen}
      />
    );
    const face = scoreUpdate ? (
      <span className={cn('pc-sports-trophy', ribbon && 'is-ribbon')} aria-hidden>
        <Trophy size={16} />
      </span>
    ) : feedPost ? (
      <span className="pc-feed-author glass-msg__feed-face" aria-hidden>
        <FeedSourceIcon kind={feedPost.kind} iconUrl={feedPost.icon_url} size={32} />
      </span>
    ) : (
      <button
        type="button"
        aria-label={`Open profile for ${authorName}`}
        className="glass-msg__face-button"
        onClick={(e) => rowActions.openAuthorProfile(e, msg)}
      >
        <TimelineAvatar userId={author.id} name={author.name} avatar={author.avatar} />
      </button>
    );
    const parsedContent = () => {
      const nodes = getCachedParsedMarkdown(
        msg.id,
        bubbleText,
        String(msg.edited_timestamp || msg.edited_at || ''),
        activeGuildId || undefined,
        mentionMap,
        handleMentionClick,
        downloadTicket,
        me ?? null,
      );
      return nodes;
    };
    const editedMark = edited ? (
      <button
        type="button"
        className="glass-bubble__edited"
        title={`Edited: ${formatTimestamp(edited)}`}
        aria-label={`Show edit history for message ${msg.id}`}
        onClick={(e) => rowActions.openEditHistory(e, msg.id)}
      >
        edited
      </button>
    ) : null;
    const decryptingSkeleton = (
      <div className="glass-bubble__decrypting" aria-label="Decrypting message">
        <div className="pc-skeleton" />
        <div className="pc-skeleton" />
      </div>
    );
    const ownMeta = isOwnMessage && isFirstInGroup && (
      msg.anonymous?.is_anonymous || pendingReminderIds.has(msg.id) || msg.expires_at
    );

    return (
      <MessageRowMemo deps={rowDeps} render={() => (
      <div
        id={`msg-${msg.id}`}
        role="article"
        aria-label={`Message from ${authorName}`}
        aria-posinset={row.messageIndex + 1}
        aria-setsize={messages.length}
        tabIndex={msg.id === activeRowMessageId ? 0 : -1}
        className="glass-msg glass-tl-col"
        data-own={isOwnMessage || undefined}
        data-grouped={isGrouped || undefined}
        data-last={isLastInGroup || undefined}
        data-mentions-me={mentionsMe || undefined}
        data-jump={isJumpTarget || undefined}
        data-from-room={fromRoom || undefined}
        data-variant={ribbon ? 'ribbon' : undefined}
        data-coarse={isCoarsePointer || undefined}
        {...rowHandlers}
      >
        {bulkDeleteMode && canManageMessages && (
          <span className="glass-msg__check">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent-danger"
              checked={selectedMessageIds.includes(msg.id)}
              onChange={() => rowActions.toggleBulkSelection(msg.id)}
              aria-label={`Select message ${msg.id} for bulk delete`}
            />
          </span>
        )}

        {/* §3.2: the face sits at the bottom of the group, beside its last
            bubble. Your own messages have none. */}
        {!isOwnMessage && <span className="glass-msg__face">{isLastInGroup && face}</span>}

        <div className="glass-msg__body">
          {hasHeader && (
            <div className="glass-msg__head">
              {feedPost ? (
                <span className="glass-msg__name">{feedPost.name}</span>
              ) : (
                <button
                  type="button"
                  className="glass-msg__name"
                  aria-label={`Open profile for ${authorName}`}
                  onClick={(e) => rowActions.openAuthorProfile(e, msg)}
                >
                  {authorName}
                </button>
              )}
              {msg.anonymous?.is_anonymous && (
                <Chip size="sm" className="text-accent-warning">
                  Anonymous
                </Chip>
              )}
              {feedPost ? (
                <Chip size="sm">
                  {feedPost.kind === GAME_SERVER_POST_KIND ? 'Game server' : 'Feed'}
                </Chip>
              ) : msg.author.bot && (
                <Chip size="sm">
                  Bot
                </Chip>
              )}
              <InstrumentText dateTime={timestamp} className="glass-msg__time" title={fullTime}>
                {timelineTime(timestamp)}
              </InstrumentText>
              {pendingReminderIds.has(msg.id) && (
                <span className="glass-msg__time" title="Reminder set">
                  <Clock size={12} aria-hidden />
                  <span className="sr-only">Reminder set</span>
                </span>
              )}
              {msg.expires_at && (
                <span className="glass-msg__time" title={`Expires ${formatTimestamp(msg.expires_at)}`}>
                  expires {formatTimestamp(msg.expires_at)}
                </span>
              )}
              {showActions && actionsPlacement === 'header' && renderActions()}
            </div>
          )}
          {ownMeta && (
            <div className="glass-msg__head glass-msg__head--own">
              {msg.anonymous?.is_anonymous && (
                <Chip size="sm" className="text-accent-warning">
                  Anonymous
                </Chip>
              )}
              {pendingReminderIds.has(msg.id) && (
                <span className="glass-msg__time" title="Reminder set">
                  <Clock size={12} aria-hidden />
                  <span className="sr-only">Reminder set</span>
                </span>
              )}
              {msg.expires_at && (
                <span className="glass-msg__time" title={`Expires ${formatTimestamp(msg.expires_at)}`}>
                  expires {formatTimestamp(msg.expires_at)}
                </span>
              )}
            </div>
          )}
          {!hasHeader && (
            // The time, for a row that has no header to carry it.
            <InstrumentText dateTime={timestamp} className="sr-only">
              {fullTime}
            </InstrumentText>
          )}

          {isEditing ? (
            <div className="glass-msg__edit">
              <textarea
                autoFocus
                aria-label={`Edit message from ${authorName}`}
                className="w-full resize-none rounded-[var(--radius-well)] bg-bg-well px-3 py-2 text-body text-text-primary shadow-[var(--shadow-well)] outline-none focus-visible:shadow-[var(--focus-ring-input)]"
                style={{ minHeight: '2.5rem', maxHeight: '50vh' }}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onKeyDown={rowActions.handleEditKeyDown}
                rows={1}
                ref={(el) => {
                  if (el) {
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.5) + 'px';
                    // `autoFocus` lands the caret at offset 0, so the first
                    // thing typed after "Edit" went in front of the message.
                    // Put it after the last character, once per edit session.
                    if (!el.dataset.caretPlaced) {
                      el.dataset.caretPlaced = 'yes';
                      el.setSelectionRange(el.value.length, el.value.length);
                    }
                  }
                }}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => void rowActions.saveEditMessage()}
                  disabled={editSaving}
                  className="inline-flex items-center gap-1 rounded-chip px-2 py-1 text-meta font-semibold text-accent-primary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                >
                  <Check size={13} /> {editSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={rowActions.cancelEditing}
                  className="inline-flex items-center gap-1 rounded-chip px-2 py-1 text-meta font-semibold text-text-muted transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
              {hasBubble && (
                <div className="glass-msg__line" data-bitten={(biteHost === 'bubble' && bite !== null) || undefined}>
                    <div
                      className="glass-bubble"
                      data-join-top={isGrouped || undefined}
                      title={hasHeader ? undefined : fullTime}
                    >
                      {replyParentId && (
                        <ReplyChip
                          author={
                            replyParentMessage
                              ? displayName(
                                  replyParentMessage.author,
                                  activeGuildMemberById.get(replyParentMessage.author.id)?.nick,
                                )
                              : 'Original message'
                          }
                          preview={
                            replyParentMessage
                              ? getReplyPreviewText(replyParentMessage, mentionMap, roleNameMap)
                              : deletedMessageIds.has(replyParentId)
                                ? 'This message was deleted'
                                : 'Message not loaded'
                          }
                          onJump={() => rowActions.scrollToMessage(replyParentId)}
                        />
                      )}
                      {ephemeral ? (
                        <EphemeralMessage>
                          {decrypting ? decryptingSkeleton : (
                            <div className="glass-bubble__text">{parsedContent()}</div>
                          )}
                        </EphemeralMessage>
                      ) : decrypting ? (
                        decryptingSkeleton
                      ) : (
                        <>
                          {msg.forwarded_from && (
                            <ForwardedCard
                              forward={msg.forwarded_from}
                              scope={scope}
                              quote={decryptingIds.has(msg.id) ? 'Decrypting this message…' : forwardQuote(msg)}
                              thumbnails={forwardThumbnails(msg)}
                            />
                          )}
                          {hasText && <div className="glass-bubble__text">{parsedContent()}{editedMark}</div>}
                        </>
                      )}
                    </div>
                  {biteHost === 'bubble' && bite}
                  {showActions && actionsPlacement === 'beside' && renderActions()}
                </div>
              )}
              {!hasBubble && showActions && actionsPlacement === 'beside' && (
                // Nothing to sit beside (a picture, a card): the actions float
                // at the far side of the column, on their own plate.
                <div className="glass-msg__float">{renderActions()}</div>
              )}
              {scoreCard && scoreSides && scoreUpdate && (
                <div className="glass-msg__card" data-join-top={isGrouped || undefined} data-bitten={(biteHost === 'card' && biteCard === 'score' && bite !== null) || undefined}>
                  <ScoreUpdateCard
                    update={scoreUpdate}
                    lead={scoreSides.lead}
                    other={scoreSides.other}
                    href={scoreUpdateHref(activeGuildId || '', pinnedSportsGame)}
                  />
                  {biteHost === 'card' && biteCard === 'score' && bite}
                </div>
              )}
              {feedCard && (
                <div className="glass-msg__card" data-join-top={isGrouped || undefined} data-bitten={(biteHost === 'card' && biteCard === 'feed' && bite !== null) || undefined}>
                  <FeedPostCard embed={feedCard} />
                  {biteHost === 'card' && biteCard === 'feed' && bite}
                </div>
              )}
              {msg.poll && (
                <div className="glass-msg__card glass-msg__card--plan" data-join-top={isGrouped || undefined} data-bitten={(biteHost === 'card' && biteCard === 'poll' && bite !== null) || undefined}>
                  <PollMessageCard
                    channelId={channelId}
                    poll={msg.poll}
                    canVote={canVoteInPolls}
                    joinTop={isGrouped}
                  />
                  {biteHost === 'card' && biteCard === 'poll' && bite}
                </div>
              )}
              {eventCards.map((eventId, eventIndex) => (
                <div
                  key={eventId}
                  className="glass-msg__card glass-msg__card--plan"
                  data-join-top={isGrouped || eventIndex > 0 || undefined}
                  data-bitten={(eventIndex === 0 && biteHost === 'card' && biteCard === 'event' && bite !== null) || undefined}
                >
                  <EventPlanCard guildId={activeGuildId} eventId={eventId} joinTop={isGrouped || eventIndex > 0} />
                  {eventIndex === 0 && biteHost === 'card' && biteCard === 'event' && bite}
                </div>
              ))}
            </>
          )}

          {msg.components && msg.components.length > 0 && (
            <MessageComponents
              components={msg.components}
              messageId={msg.id}
              channelId={channelId}
              guildId={activeGuildId || undefined}
            />
          )}

          {msg.anonymous?.is_anonymous && deanonymizedById[msg.id] && (
            <p className="glass-msg__note">
              Real author: <span className="font-semibold text-text-secondary">{deanonymizedById[msg.id]}</span>
            </p>
          )}

          {/* GitHub webhook embed */}
          {isGitHubWebhookMessage(msg) && (
            <GitHubEventEmbed content={msg.content || ''} />
          )}

          {/* URL Embeds — server-provided or client-extracted */}
          {!feedEmbed && (() => {
            const embeds = msg.embeds || [];
            const contentUrls = embeds.length === 0 ? extractUrls(msg.content) : [];
            const allEmbeds = embeds.length > 0
              ? embeds
              : contentUrls.slice(0, 3).map((url) => ({ url }));
            if (allEmbeds.length === 0) return null;
            return (
              <div className="glass-msg__extras">
                {allEmbeds.map((embed) => (
                  <MessageEmbedCard key={embed.url} embed={embed} />
                ))}
              </div>
            );
          })()}

          {linkedThreads.length > 0 && (
            <div className="glass-msg__extras">
              {linkedThreads.map((thread) => (
                <TimelineAuthor key={thread.id} store={lightStore} author={author}>
                  {(person) => (
                    <ThreadRow
                      name={thread.name || 'Thread'}
                      meta={threadMetaFor(thread)}
                      people={[person]}
                      archived={Boolean(thread.thread_metadata?.archived)}
                      onOpen={() => rowActions.openLinkedThread(thread.id)}
                    />
                  )}
                </TimelineAuthor>
              ))}
            </div>
          )}
          {/* Reactions with nothing to bite (§3.2): the same chip, in the flow. */}
          {biteHost === 'inline' && bite}
          {msg.stickers && msg.stickers.length > 0 && (
            <div className="glass-msg__extras glass-msg__stickers">
              {msg.stickers.map((sticker) => {
                const stickerSrc = sticker.image_url ? resolveAttachmentUrl(sticker.image_url) : null;
                return (
                  <div
                    key={sticker.id}
                    className="relative inline-flex flex-col items-center gap-1"
                    title={sticker.name}
                  >
                    <ResourceImage
                      src={stickerSrc}
                      alt={sticker.name}
                      className="rounded-well object-contain"
                      style={{ width: 128, height: 128 }}
                      loading="lazy"
                      fallback={
                      <div className="inline-flex items-center gap-1.5 rounded-well border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                          <polyline points="14 2 14 8 20 8" />
                          <circle cx="10" cy="13" r="2" />
                          <path d="m20 17-1.09-1.09a2 2 0 0 0-2.82 0L10 22" />
                        </svg>
                        {sticker.name}
                      </div>
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
          {/* Attachments */}
          {!feedEmbed && msg.attachments && msg.attachments.length > 0 && (
            <div className="glass-msg__attachments">
              {msg.attachments.filter((att) => !inForwardCard(msg, att)).map((att, attIndex) => {
                // Encrypted attachment seam: in an end-to-end encrypted
                // conversation the server's row is an opaque blob. Its real
                // name, type and bytes come from the encrypted message body and
                // are decrypted on this device; an attachment the body never
                // described is labeled as not encrypted rather than shown as
                // if it were.
                if (msg.e2ee) {
                  return <EncryptedAttachment key={att.id} attachment={att} />;
                }
                const src = resolveFederatedAttachmentUrl(att, msg.channel_id);
                const isFederated = Boolean(att.origin_server);
                const federatedNote = isFederated ? (
                  <span title={att.content_hash ? `Hash: ${att.content_hash}` : `From: ${att.origin_server}`}>Federated</span>
                ) : null;
                const attachmentIsImage = isImageAttachment(att) && Boolean(src);
                const busy = attachmentBusyId === att.id;
                const busyLabel = busy ? (downloadProgress != null ? `${downloadProgress}%` : 'Downloading…') : null;
                const joinTop = hasBubble || isGrouped || attIndex > 0;
                // Downloading is one gesture whether it is a picture's tool or a
                // file's text button; so is deleting your own attachment.
                const download = () => void rowActions.downloadAttachment(att.id, att.filename);
                const remove = () => void rowActions.deleteAttachment(msg.id, att.id);
                if (attachmentIsImage) {
                  if (lowBandwidthMode) {
                    return (
                      <GlassFile
                        key={att.id}
                        name={att.filename}
                        note="Preview off"
                        badge={federatedNote}
                        joinTop={joinTop}
                        actions={
                          <>
                            <button type="button" className="glass-file__action glass-focusable" onClick={download} disabled={busy}>
                              {busyLabel ?? 'Download'}
                            </button>
                            {isOwnMessage && !isFederated && (
                              <button type="button" className="glass-file__action glass-focusable" onClick={remove} disabled={busy}>
                                {busy ? 'Deleting…' : 'Delete'}
                              </button>
                            )}
                          </>
                        }
                      />
                    );
                  }
                  const imageAttachments = msg.attachments!.filter(isImageAttachment);
                  const openImageLightbox = async () => {
                    // Claim a generation up front, then revoke only the batches
                    // that came before it — never the URLs this call is about to
                    // resolve.
                    const generation = ++lightboxBlobGeneration;
                    revokeLightboxBlobUrls(generation);
                    const safeImageAttachments = await Promise.all(
                      imageAttachments.map(async (imageAtt) => {
                        const imageSrc = resolveFederatedAttachmentUrl(imageAtt, msg.channel_id);
                        if (!imageSrc) return null;
                        const safeRawUrl = safeClientResourceUrl(imageSrc);
                        if (!safeRawUrl) return null;
                        try {
                          const resolvedSrc = await fileApi.resolveAttachmentObjectUrl(safeRawUrl);
                          if (resolvedSrc.startsWith('blob:')) {
                            trackLightboxBlobUrl(generation, resolvedSrc);
                          }
                          return {
                            attachment: imageAtt,
                            image: createResolvedLightboxImage(resolvedSrc, imageAtt.filename),
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
                    if (generation !== lightboxBlobGeneration) return;
                    if (lightboxImages.length === 0) return;
                    const imageIndex = resolved.findIndex(({ attachment }) => attachment.id === att.id);
                    useLightboxStore.getState().open(lightboxImages, imageIndex >= 0 ? imageIndex : 0);
                  };
                  return (
                    // §3.2: the picture is its own frame, 240px, no footer. To
                    // open it, press it (the lightbox downloads too); the
                    // tools over its corner download and, for your own,
                    // delete. The reactions chip bites its top-right corner.
                    <GlassMedia
                      key={att.id}
                      joinTop={joinTop}
                      width={att.width}
                      height={att.height}
                      badge={federatedNote}
                      bite={att.id === biteMedia?.id ? bite : undefined}
                      tools={
                        <>
                          <MediaTool label={`Download ${att.filename}`} busy={busyLabel} disabled={busy} onClick={download}>
                            <DownloadMark />
                          </MediaTool>
                          {isOwnMessage && !isFederated && (
                            <MediaTool label={`Delete ${att.filename}`} disabled={busy} onClick={remove}>
                              <TrashMark />
                            </MediaTool>
                          )}
                        </>
                      }
                    >
                      <button
                        type="button"
                        aria-label={`Open image preview: ${att.filename}`}
                        title={att.filename}
                        className="glass-media__open"
                        onClick={() => void openImageLightbox()}
                      >
                        <ResolvedAttachmentImage url={src!} alt={att.filename} className="glass-media__img" />
                      </button>
                    </GlassMedia>
                  );
                }
                if (src && isClipAttachment(att.filename) && !lowBandwidthMode) {
                  return (
                    // A clip cut from a stream (§6.4): a 16:9 media bubble with
                    // its first picture, a play button and "0:30 from
                    // Vincent's screen", playing inline. The same frame and
                    // tools as a picture, so its corners join the same way.
                    // With previews off it stays a file row, like a picture.
                    <GlassMedia
                      key={att.id}
                      joinTop={joinTop}
                      width={16}
                      height={9}
                      badge={federatedNote}
                      bite={att.id === biteMedia?.id ? bite : undefined}
                      tools={
                        <>
                          <MediaTool label={`Download ${att.filename}`} busy={busyLabel} disabled={busy} onClick={download}>
                            <DownloadMark />
                          </MediaTool>
                          {isOwnMessage && !isFederated && (
                            <MediaTool label={`Delete ${att.filename}`} disabled={busy} onClick={remove}>
                              <TrashMark />
                            </MediaTool>
                          )}
                        </>
                      }
                    >
                      <ClipAttachment url={src} filename={att.filename} />
                    </GlassMedia>
                  );
                }
                return (
                  <GlassFile
                    key={att.id}
                    name={att.filename}
                    size={att.size != null ? formatFileSize(att.size) : null}
                    note={src && isClipAttachment(att.filename) ? 'Preview off' : undefined}
                    badge={federatedNote}
                    joinTop={joinTop}
                    onOpen={download}
                    actions={
                      <>
                        <button type="button" className="glass-file__action glass-focusable" onClick={download} disabled={busy}>
                          {busyLabel ?? 'Download'}
                        </button>
                        {isOwnMessage && !isFederated && (
                          <button type="button" className="glass-file__action glass-focusable" onClick={remove} disabled={busy}>
                            {busy ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </>
                    }
                  />
                );
              })}
            </div>
          )}
          {showActions && actionsPlacement === 'below' && (
            <div className="glass-msg__below">{renderActions()}</div>
          )}
        </div>

        {menuMessageId === msg.id && (
          <div
            // The menu hangs below its trigger, which is fine in the middle of
            // a timeline and wrong at the end of one: the newest message is the
            // message people act on, it sits against the composer, and 235px of
            // menu below it puts Create thread, Edit, Pin, Save for later and
            // Delete past the bottom of the window. Nothing says so — there is
            // no scrollbar on the menu and the timeline is already at rest — so
            // the menu reads as a menu with two items. Measure once on mount
            // and hang it above the row instead, when there is more room there.
            //
            // The floor is NOT the window. The composer plate is painted over
            // the bottom ~90px of it, and a menu that ends between the two is
            // fully on screen and still unclickable — `elementFromPoint` on
            // "Delete" returns the composer surface. Measured at 1440x900: the
            // composer starts at y=809, and three of the eight newest messages
            // put one or two rows of their menu underneath it. The timeline's
            // own scroll port is the frame that matters; its bottom edge is
            // exactly where the composer begins and its top edge is where the
            // channel header ends. When neither side has room the menu scrolls
            // rather than hiding rows nothing says are there.
            ref={(node) => {
              if (!node) return;
              node.style.top = '';
              node.style.bottom = '';
              node.style.maxHeight = '';
              node.style.overflowY = '';
              const row = node.parentElement?.getBoundingClientRect();
              if (!row) return;
              let port: HTMLElement | null = node.parentElement;
              while (port && port !== document.body) {
                const overflowY = getComputedStyle(port).overflowY;
                if (overflowY === 'auto' || overflowY === 'scroll') break;
                port = port.parentElement;
              }
              const frame =
                port && port !== document.body
                  ? port.getBoundingClientRect()
                  : { top: 0, bottom: window.innerHeight };
              const floor = Math.min(frame.bottom, window.innerHeight) - 8;
              const ceiling = Math.max(frame.top, 0) + 8;
              const menu = node.getBoundingClientRect();
              const offset = menu.top - row.top;
              let height = menu.height;
              if (height > floor - ceiling) {
                height = Math.max(MIN_MESSAGE_MENU_HEIGHT, floor - ceiling);
                node.style.maxHeight = `${height}px`;
                node.style.overflowY = 'auto';
              }
              let top = row.top + offset;
              // Below the trigger first, above the row when that runs past the
              // floor, and pinned to the floor when neither fits — the newest
              // rows sit *under* the composer plate, so "above the row" alone
              // still left Delete beneath it.
              if (top + height > floor) top = row.top - height;
              if (top + height > floor) top = floor - height;
              if (top < ceiling) top = ceiling;
              if (Math.abs(top - (row.top + offset)) < 0.5) return;
              node.style.top = `${Math.round(top - row.top)}px`;
            }}
            className="pc-floating glass-msg__menu z-10 min-w-[10rem] max-w-[calc(100vw-2.75rem)] p-1"
          >
            {canAddReactions && (
              <button
                className="context-menu-item w-full text-left"
                onClick={(e) => {
                  setMenuMessageId(null);
                  rowActions.openReactionPicker(e, msg.id);
                }}
              >
                Add reaction
              </button>
            )}
            {msg.anonymous?.can_deanonymize && (
              <button
                className="context-menu-item w-full text-left"
                disabled={Boolean(deanonymizedById[msg.id]) || deanonymizingId === msg.id}
                onClick={() => {
                  setMenuMessageId(null);
                  void rowActions.deanonymizeMessage(msg);
                }}
              >
                {deanonymizingId === msg.id ? (
                  <span className="inline-flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Revealing…</span>
                ) : deanonymizedById[msg.id] ? (
                  `Author: ${deanonymizedById[msg.id]}`
                ) : (
                  'Reveal author'
                )}
              </button>
            )}
            {onReply && (
              <button
                className="context-menu-item w-full text-left"
                onClick={() => {
                  setMenuMessageId(null);
                  rowActions.reply(msg);
                }}
              >
                Reply
              </button>
            )}
            {canCreateThreads && (
              <button
                className="context-menu-item w-full text-left"
                onClick={() => rowActions.openCreateThreadDialog(msg)}
              >
                Create thread
              </button>
            )}
            {canEditMessage && (
              <button className="context-menu-item w-full text-left" onClick={() => rowActions.startEditingMessage(msg)}>
                Edit
              </button>
            )}
            {canPinMessage && (
              <button
                className="context-menu-item w-full text-left"
                onClick={async () => {
                  setMenuMessageId(null);
                  await rowActions.togglePin(msg);
                }}
              >
                {msg.pinned ? 'Unpin' : 'Pin'}
              </button>
            )}
            <button
              className="context-menu-item w-full text-left"
              onClick={(event) => rowActions.openRemind(msg, event.clientX, event.clientY)}
            >
              <span className="flex items-center gap-2 whitespace-nowrap">
                <Clock size={14} />
                Remind me
              </span>
            </button>
            <button
              className="context-menu-item w-full text-left"
              disabled={Boolean(forwardBlocked)}
              title={forwardBlocked ?? undefined}
              onClick={() => {
                if (forwardBlocked) return;
                setMenuMessageId(null);
                setForwardTarget(msg);
                setForwardOpen(true);
              }}
            >
              <span className="flex items-center gap-2 whitespace-nowrap">
                <Forward size={14} />
                Forward
              </span>
            </button>
            <button
              className="context-menu-item w-full text-left"
              onClick={() => void rowActions.toggleSavedMessage(msg)}
            >
              {/* `.context-menu-item` sets `display:block`, which beats the
                  `flex` utility — and preflight makes every icon a block — so
                  the icon and its label used to land on two lines. The inner
                  span owns the row instead, where nothing outranks it. */}
              <span className="flex items-center gap-2 whitespace-nowrap">
                {savedIds.has(msg.id) ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
                {savedIds.has(msg.id) ? 'Remove from Saved' : 'Save for later'}
              </span>
            </button>
            {activeGuildId && msg.author.id !== me && (
              <button className="context-menu-item w-full text-left" onClick={() => rowActions.openReportDialog(msg)}>
                Report
              </button>
            )}
            {canDeleteMessage && (
              <button className="context-menu-item danger w-full text-left" onClick={() => rowActions.requestDelete(msg.id)}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
      )} />
    );
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className={cn('glass-timeline relative flex-1 overflow-hidden', ribbon && 'glass-timeline--ribbon')}>
      {/* First, so the rows rendered after it in the same pass read its light. */}
      <TimelineLightSource guildId={activeGuildId} serverId={channelServerId} store={lightStore} />
      <div ref={actionAnchor} className="pointer-events-none fixed h-px w-px" aria-hidden />
      {remindTarget && (
        <RemindMeMenu
          anchor={actionAnchor}
          open
          onClose={() => setRemindTarget(null)}
          channelId={remindTarget.channel_id}
          messageId={remindTarget.id}
        />
      )}
      {forwardTarget && scope && (
        <ForwardPicker
          key={forwardTarget.id}
          message={forwardTarget}
          scope={scope}
          sourceEncrypted={!activeGuildId}
          open={forwardOpen}
          onClose={() => setForwardOpen(false)}
        />
      )}
      {/*
        New-message announcements live here, NOT on the scroll container.
        `aria-live` on a virtualized list makes every row mount an announcement,
        so a screen-reader user scrolling back through history heard the entire
        feed read out. A dedicated region announces only the delta.
      */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {newMessageAnnouncement}
      </div>
      {/* The pull lamp — a window the dragged-down timeline reveals. Its
          position and glow are driven from the touch listeners above; it is
          scenery, never interactive. */}
      {isCoarsePointer && (
        <span
          ref={pullLampRef}
          aria-hidden
          className="pc-window is-reading pointer-events-none absolute left-1/2 top-1.5 z-10 h-2.5 w-2.5 -translate-x-1/2 opacity-0"
        />
      )}
      <div
        ref={scrollRef}
        // §3.2: bottom-anchored in the 720px column, with a 28px fade under
        // the header (`glass-timeline.css`).
        className="glass-timeline__scroller flex h-full flex-col overflow-y-auto"
        onScroll={handleScroll}
        style={{ overscrollBehavior: 'contain' }}
        role="feed"
        aria-busy={isLoading ? 'true' : 'false'}
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
          <div className="glass-tl-col flex h-full flex-col items-start justify-end gap-3 pb-8">
            <span className="pc-window h-2.5 w-2.5" aria-hidden />
            <div>
              <h3 className="pc-display text-heading text-text-primary">
                {emptyGroupDm
                  ? 'Waiting on everyone’s encryption'
                  : emptyThread
                  ? 'No replies yet'
                  : activeChannel?.name ? `Nothing in ${activeChannel.name} yet` : 'Nobody has said anything here yet'}
              </h3>
              <p className="mt-1 max-w-md text-body text-text-body">
                {emptyGroupDm
                  ? groupEnrollmentReason(groupPending)
                  : emptyThread
                  ? 'Nobody has replied in this thread yet. Say the first thing.'
                  : 'Nobody has posted here yet. Be the first to say something.'}
              </p>
            </div>
            {/* Never offer the one action this conversation is going to refuse. */}
            {!emptyGroupDm && <Button
              variant="primary"
              className="mt-1 gap-2"
              onClick={() => {
                const composer = document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]');
                composer?.focus();
              }}
            >
              <Send size={16} />
              {emptyThread ? 'Send the first reply' : 'Send the first message'}
            </Button>}
          </div>
        ) : (
          // §3.2: a conversation reads from the bottom. `mt-auto` only has
          // room to act when the timeline is shorter than the pane; past that
          // it scrolls.
          <>
            <div ref={timelineContentRef} className="glass-timeline__content mt-auto shrink-0" style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {virtualItems.map((virtualRow) => {
                const row = rows[virtualRow.index];
                // Every virtual row is `transform`ed, and a transform opens a
                // stacking context — so the actions menu's own `z-10` can only
                // ever rank it inside its own row. Without this, the rows below
                // (later in DOM order, transparent, full width) paint over the
                // open menu and swallow its clicks: `document.elementFromPoint`
                // on "Edit" returns the *next message's* div, and only the
                // items that happen to hang past the last row are reachable.
                // Lifting the row that owns the open menu above its siblings is
                // what makes the menu clickable at all.
                const ownsOpenMenu = row.type === 'message' && menuMessageId === row.message.id;
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
                      ...(ownsOpenMenu ? { zIndex: 20 } : null),
                    }}
                  >
                    {renderRow(row)}
                  </div>
                );
              })}
            </div>
            {/* §5.1: "receipts fade in only after the server answers — never
                before". In this app a row cannot exist any earlier than that:
                the runtime publishes a message only once the authoritative
                recovery feed has vouched for it, so this line and the row it
                belongs to arrive together. It sits under the last row rather
                than inside it so no message's height ever depends on it. */}
            {deliveredReceipt && (
              <div
                // `relative`, and no longer pulled a whole line up into the row
                // above it. The timeline's rows are absolutely positioned, so
                // they paint *over* any static element after them: with the old
                // `-mt-4` the receipt was drawn behind the last row, and when
                // that row ended in an attachment card the card's own background
                // took the top 5px of the word, which read as "Jelivered".
                className="glass-tl-receipt glass-tl-col"
              >
                <InstrumentText data-motion-receipt>
                  Delivered
                </InstrumentText>
              </div>
            )}
          </>
        )}
      </div>

      {threadModalForMessageId && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-4" style={{ backgroundColor: 'var(--overlay-backdrop)' }}>
          <div
            ref={threadCreateDialogRef}
            className="pc-dialog w-full max-w-md p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-thread-dialog-title"
            tabIndex={-1}
          >
            <h3 id="create-thread-dialog-title" className="text-heading text-text-primary">Create thread</h3>
            <p className="mt-1 text-meta text-text-secondary">
              Start a focused discussion branched off this message.
            </p>
            <label className="mt-4 block">
              <span className="text-section text-text-secondary">Thread name</span>
              <input
                className="input-field mt-2"
                value={threadName}
                maxLength={100}
                onChange={(e) => setThreadName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !threadCreating) void submitCreateThread();
                  if (e.key === 'Escape') {
                    closeThreadCreateDialog();
                  }
                }}
                autoFocus
                disabled={threadCreating}
              />
            </label>
            {threadCreateError && (
              <div className="mt-3 rounded-chip border-l-2 border-accent-danger bg-danger-tint px-3 py-2 text-meta font-medium text-accent-danger">
                {threadCreateError}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <button
                className="btn-primary"
                onClick={() => void submitCreateThread()}
                disabled={threadCreating}
              >
                {threadCreating ? 'Creating…' : 'Create thread'}
              </button>
              <button
                className="rounded-chip px-3.5 py-2 text-label font-semibold text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                onClick={closeThreadCreateDialog}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {reportingMessage && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-4" style={{ backgroundColor: 'var(--overlay-backdrop)' }}>
          <div
            ref={reportDialogRef}
            className="pc-dialog w-full max-w-lg p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-message-dialog-title"
            tabIndex={-1}
          >
            <h3 id="report-message-dialog-title" className="text-heading text-text-primary">Report message</h3>
            <p className="mt-1 text-meta text-text-secondary">
              Reports go to this server's moderators. Add concise evidence when you can.
            </p>
            <div className="mt-3 rounded-chip border border-border-subtle bg-bg-well px-3 py-2 text-meta text-text-secondary">
              <div className="font-semibold text-text-primary">
                {displayName(
                  reportingMessage.author,
                  activeGuildMemberById.get(reportingMessage.author.id)?.nick,
                )} ({reportingMessage.author.id})
              </div>
              <div className="mt-1 line-clamp-4 break-words">
                {reportingMessage.content || 'No text content'}
              </div>
            </div>
            <label className="mt-4 block">
              <span className="text-section text-text-secondary">Reason</span>
              <textarea
                className="input-field mt-2 min-h-[96px] resize-y"
                value={reportReason}
                maxLength={512}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Explain why this message should be reviewed..."
              />
            </label>
            <label className="mt-3 block">
              <span className="text-section text-text-secondary">Evidence (Optional)</span>
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
                {reportSubmitting ? 'Submitting...' : 'Submit report'}
              </button>
              <button
                className="rounded-chip px-3.5 py-2 text-label font-semibold text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
          className="pc-focusable absolute bottom-[calc(var(--safe-bottom)+0.75rem)] left-1/2 flex h-[var(--h-control)] -translate-x-1/2 items-center gap-2 rounded-[var(--radius-control)] bg-bg-raised px-4 text-label font-semibold text-text-primary shadow-[var(--shadow-lifted)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong"
        >
          <ArrowDown size={16} className="text-accent-primary" />
          Jump to present
        </button>
      )}
      {bulkDeleteMode && canManageMessages && (
        <div className="absolute bottom-[calc(var(--safe-bottom)+0.75rem)] left-1/2 z-20 flex w-[min(95%,38rem)] -translate-x-1/2 flex-wrap items-center justify-between gap-2 rounded-[var(--radius-well)] bg-bg-raised px-4 py-2.5 shadow-[var(--shadow-lifted)]">
          <span className="text-label font-semibold tabular-nums text-text-secondary">
            {selectedMessageIds.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-chip px-3 py-1.5 text-label font-semibold text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
              onClick={cancelBulkDelete}
              disabled={bulkDeleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-chip bg-danger-well px-3 py-1.5 text-label font-semibold text-text-on-danger shadow-[var(--shadow-chip)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-danger-well-hover focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
              onClick={() => void executeBulkDelete()}
              disabled={bulkDeleting || selectedMessageIds.length === 0}
            >
              {bulkDeleting ? 'Deleting...' : 'Delete selected'}
            </button>
          </div>
        </div>
      )}
      {reactionPicker.value && createPortal(
        <EmojiPicker
          position={reactionPicker.value.position}
          leaving={reactionPicker.leaving}
          onSelect={(emoji) => void handleReactionSelect(emoji)}
          onClose={() => setEmojiPickerFor(null)}
          guildId={activeGuildId || undefined}
        />,
        document.body
      )}
      {createPortal(
        <UserProfilePopup
          user={profileUser ? {
            id: profileUser.id,
            username: profileUser.username,
            discriminator: profileUser.discriminator,
            avatar_hash: profileUser.avatar_hash || null,
            display_name: profileUser.display_name ?? null,
            bot: profileUser.bot ?? false,
            system: false,
            flags: profileUser.flags ?? 0,
            created_at: '',
          } : null}
          position={profilePos}
          onClose={() => setProfileUser(null)}
        />,
        document.body
      )}
      <ContextMenu
        open={contextMenu.isOpen}
        items={contextMenu.items}
        position={contextMenu.position}
        onClose={closeContextMenu}
      />
      <Modal
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        role="alertdialog"
        size="sm"
        labeledBy="delete-message-dialog-title"
        describedBy="delete-message-dialog-desc"
      >
        <ModalHeader
          icon={
            <div className="flex h-10 w-10 items-center justify-center rounded-well bg-danger-tint text-accent-danger">
              <AlertTriangle size={20} />
            </div>
          }
        >
          <ModalTitle id="delete-message-dialog-title">Delete message?</ModalTitle>
          <ModalDescription id="delete-message-dialog-desc">
            This can't be undone — the message is gone for everyone.
          </ModalDescription>
        </ModalHeader>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setDeleteConfirmId(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deletingMessageId !== null && deletingMessageId === deleteConfirmId}
            autoFocus
            onClick={() => {
              if (deleteConfirmId) void handleDeleteMessage(deleteConfirmId);
            }}
          >
            Delete
          </Button>
        </ModalFooter>
      </Modal>
      {editHistoryMsgId && <MessageEditHistoryDialog
        scope={scope} channelId={channelId} messageId={editHistoryMsgId}
        position={editHistoryPos} onClose={closeEditHistoryDialog}
      />}
    </div>
  );
}
