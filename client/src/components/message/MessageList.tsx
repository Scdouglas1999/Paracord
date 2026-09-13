import { useCurrentChannelStore, useChannelActions } from '../../hooks/useChannels';
import { entityScopeKey as memberScopeKey, type AccountScope } from '../../lib/serverScope';
import { useCurrentUser, useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { useRef, useEffect, useMemo, useState, useReducer, useCallback, type CSSProperties, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { captureScopedOperation, type OperationContext } from '../../lib/operationContext';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowDown, Smile, Reply, MoreHorizontal, Hash, Check, X as XIcon, Pencil, Pin, PinOff, Copy, Clipboard, Trash2, MessageSquare, Send, Eye, Loader2, Bookmark, BookmarkCheck } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMessages } from '../../hooks/useMessages';
import { useTypingStore } from '../../stores/typingStore';
import { useCurrentMessageStore } from '../../hooks/useMessageStore';
import { useGuild } from '../../hooks/useGuilds';
import { useServerListStore } from '../../stores/serverListStore';
import { useReadStateStore } from '../../stores/readStateStore';
import { useMemberStore } from '../../stores/memberStore';
import { useSavedMessageStore } from '../../stores/savedMessageStore';
import { useUIStore } from '../../stores/uiStore';
import { channelApi } from '../../api/channels';
import { MessageEditHistoryDialog } from './MessageEditHistoryDialog';
import { fileApi } from '../../api/files';
import { EncryptedAttachment } from '../file/EncryptedAttachment';
import { hasEncryptedAttachments } from '../../lib/messages/attachments/messageBodyProjection';
import { extractApiError } from '../../api/client';
import { MessageType, Permissions, hasPermission, type Channel, type ChannelOverwrite, type Member, type Message, type Role } from '../../types';
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
import { fadeIn, flicker, motionToken, ms, onMotion, prefersReducedMotion, RollingNumber, settleIn, useFlipList, walkIntoRoom } from '../../lib/motion';
import { parseMarkdown } from '../../lib/markdown';
import { getHighestRoleColor } from '../../lib/colors';
import { formatFileSize, formatTimestamp, relativeTime } from '../../lib/formatters';
import { useLightboxStore, type LightboxImage } from '../../stores/lightboxStore';
import { confirm } from '../../stores/confirmStore';
import { buildGuildEmojiImageUrl, parseCustomEmojiToken } from '../../lib/customEmoji';
import { isAllowedImageMimeType, safeClientResourceUrl } from '../../lib/security';
import { mentionsEveryone } from '../../lib/mentions';
import { MessageEmbedCard, extractUrls } from './MessageEmbed';
import { LitAvatar } from '../light';
import { Chip } from '../ui';
import {
  AttachmentFrame,
  AuthorMeta,
  DayDivider,
  dayDividerLabel,
  timelineTime,
  ReplyChip,
  RoomLitEventRow,
  ThreadRow,
  TIMELINE_GUTTER,
} from './TimelineParts';
import { useAuthorLights, useRoomLitEvents, type RoomLitEvent } from './messageLight';
import { useVoiceStore } from '../../stores/voiceStore';
import { GitHubEventEmbed, isGitHubWebhookMessage } from './GitHubEventEmbed';
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

const EMPTY_TYPING: string[] = [];

interface ReactionTally {
  emoji: string;
  count: number;
  me: boolean;
}

/**
 * The reactions under a message (§5.1: "a reaction pops").
 *
 * A reaction is something somebody put there, so it lands rather than slides:
 * 0.6 to 1 on the spring-settle when it's yours — and the emoji itself
 * over-rotates ±8° on the way — 0.8 to 1 when it arrives from somebody else.
 * Removing fades and shrinks the chip back out the way it came. It is its own
 * component because that is the only way the engine's list hook can watch the
 * row — and the hook is what keeps the pop honest: nothing plays on the first
 * commit, so a message scrolling into view with six reactions on it is still,
 * and only a reaction that ARRIVES while you are looking pops.
 */
function ReactionRow({
  reactions,
  guildId,
  onToggle,
}: {
  reactions: readonly ReactionTally[];
  guildId: string | null | undefined;
  onToggle: (reaction: ReactionTally) => void;
}) {
  const rowRef = useFlipList<HTMLDivElement>({ enter: 'pop' });
  return (
    <div ref={rowRef} className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r, reactionIndex) => {
        const parsedCustomEmoji = guildId ? parseCustomEmojiToken(r.emoji) : null;
        return (
          <Chip
            as="button"
            key={`${r.emoji}-${reactionIndex}`}
            data-flip-key={r.emoji}
            data-flip-own={r.me || undefined}
            onClick={() => onToggle(r)}
            className={cn(
              'gap-1.5 px-2.5',
              r.me && 'bg-accent-tint text-accent-primary shadow-none hover:bg-accent-tint-strong hover:text-accent-primary',
            )}
          >
            <span data-flip-glyph>
              {parsedCustomEmoji && guildId ? (
                <img
                  src={buildGuildEmojiImageUrl(guildId, parsedCustomEmoji.id)}
                  alt={parsedCustomEmoji.name}
                  title={`:${parsedCustomEmoji.name}:`}
                  style={{ width: 18, height: 18, objectFit: 'contain' }}
                  loading="lazy"
                />
              ) : (
                r.emoji
              )}
            </span>
            {/* The tally re-rolls like every other count (§5.1). */}
            <span className="font-medium">
              <RollingNumber value={r.count} announce={false} />
            </span>
          </Chip>
        );
      })}
    </div>
  );
}

/**
 * Three dots breathing while somebody types (§5.1 "speaking is a breath", and
 * the same curve): `pc-breathe` timing, 200ms apart, still under reduced
 * motion. They are `aria-hidden` — the sentence beside them already says it.
 */
function TypingDots() {
  return (
    <span className="pc-typing-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
const EMPTY_CHANNELS: Channel[] = [];
const EMPTY_MEMBERS: Member[] = [];
const EMPTY_SAVED_IDS = new Set<string>();

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
): ReactNode[] {
  const key = `${messageId}\0${editedKey}\0${content}\0${guildId ?? ''}`;
  const hit = markdownParseCache.get(key);
  if (hit && hit.mentionMap === mentionMap && hit.onMentionClick === onMentionClick) {
    return hit.nodes;
  }
  const nodes = parseMarkdown(content || '', guildId, mentionMap, onMentionClick);
  markdownParseCache.set(key, { nodes, mentionMap, onMentionClick });
  if (markdownParseCache.size > MARKDOWN_CACHE_MAX) {
    const oldest = markdownParseCache.keys().next().value;
    if (oldest !== undefined) markdownParseCache.delete(oldest);
  }
  return nodes;
}

/** Match gateway mention logic: @everyone or <@id> / <@!id> in content. */
export function messageMentionsUser(msg: Message, userId: string | undefined | null): boolean {
  // `author` is typed as required but a malformed payload can omit it; never
  // let a mention check be the thing that throws inside a render.
  if (!userId || msg.author?.id === userId) return false;
  if (mentionsEveryone(msg)) return true;
  const content = typeof msg.content === 'string' ? msg.content : '';
  return new RegExp(`<@!?${userId}>`).test(content);
}

const MAX_REPLY_NEST_DEPTH = 6;
const REPLY_INDENT_PX = 18;
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
        className="max-w-[min(100%,400px)] rounded-[var(--radius-well)] bg-bg-well px-3 py-6 text-center text-meta text-text-faint shadow-[var(--shadow-well)]"
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
  const channelActions = useChannelActions();
  const activeChannel = useCurrentChannelStore((s) => s.channelsById[channelId]);
  const typingUsers = useTypingStore((s) => s.typingByChannel[channelId] ?? EMPTY_TYPING);
  const me = useCurrentUser()?.id;
  const activeGuildId = activeChannel?.guild_id || null;
  const originServerId = useGuild(activeChannel?.guild_id)?.scope.serverId ?? null;
  const activeServerId = useServerListStore((state) => state.activeServerId);
  const savedServerScope = activeServerId ?? '__local__';
  const savedIds = useSavedMessageStore((state) =>
    state.serverId === savedServerScope ? state.savedIds : EMPTY_SAVED_IDS,
  );
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
  /* The composer's words lift out; this row arrives from 26px below on the  */
  /* spring-settle curve, so the two read as one object moving. Three rules  */
  /* keep it honest:                                                        */
  /*   · only a row the person at this keyboard CAUSED lands — the gesture   */
  /*     arrives on the motion bus, and without one nothing animates (§5.3:  */
  /*     never animate what the user did not cause);                        */
  /*   · only the new row animates: it is a transform on the row itself, so  */
  /*     no neighbour moves and the list never reflow-animates;             */
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
      // 26px, arriving as the typed words leave (§5.1 / the MotionSay study).
      settleIn(document.getElementById(`msg-${arrived.id}`), { distance: 26 });
      // The receipt is the last thing to arrive: it is the server's answer, and
      // it waits for the row to be on its mark before it fades in.
      fadeIn(scrollRef.current?.querySelector<HTMLElement>('[data-motion-receipt]'), {
        delay: ms('--duration-move'),
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
  }, [savedServerScope]);
  useEffect(() => {
    if (!activeGuildId || !channelId) {
      setChannelOverwrites([]);
      return;
    }
    let cancelled = false;
    // Shared, deduped fetch: MessageList, MessageInput and MemberList all need
    // this for the same channel and used to request it independently.
    fetchChannelOverwrites(channelId)
      .then((data) => {
        if (!cancelled) setChannelOverwrites(data);
      })
      .catch(() => {
        if (!cancelled) setChannelOverwrites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeGuildId, channelId]);
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
  // from WP1 — this file never decides who is lit.
  const authorLight = useAuthorLights(activeGuildId, channelServerId);
  const roomLitEvents = useRoomLitEvents(activeGuildId);
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
    deleteDialogGeneration.current++;
    const context = deleteContext.current; deleteContext.current = null; context?.dispose();
  }, []);
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

  // Build mention map: userId -> display name for @mention rendering.
  // Select only the active guild membership list to avoid rebuilding on unrelated guild updates.
  const mentionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of activeGuildMembers) {
      map.set(member.user.id, displayName(member.user, member.nick));
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
    // Guild switches are fast and this response is not. Without the guard, the
    // previous guild's roles landed after the switch and painted every author
    // name with a colour from a guild the user is no longer looking at.
    let cancelled = false;
    fetchGuildRoles(activeGuildId).then((data) => {
      if (!cancelled) setGuildRoles(data);
    }).catch(() => {
      // non-fatal, role colors will simply not show
    });
    return () => {
      cancelled = true;
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
      // The first message of a channel gets a divider too: the reference render
      // opens with a "Today" chip, and a timeline with no day on it is a list.
      const showDateSep = prevMsg
        ? isDifferentDay(getTimestamp(prevMsg), getTimestamp(msg))
        : Boolean(getTimestamp(msg));

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
  }, [messages, activeTyping.length, replyLayoutById, roomLitEvents]);

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
      if (row.type === 'date-separator') return 48;
      if (row.type === 'room-event') return 30;
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
    let cancelled = false;
    const hydrateThreads = async () => {
      try {
        const [activeRes, archivedRes] = await Promise.all([
          channelApi.getThreads(channelId),
          channelApi.getArchivedThreads(channelId),
        ]);
        if (cancelled) return;
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
      cancelled = true;
    };
  }, [channelId, activeGuildId, activeChannelType, channelActions]);

  // Clear the load-more guard when the store finishes loading (including failures).
  useEffect(() => {
    if (!isLoading) {
      isLoadingMoreRef.current = false;
    }
  }, [isLoading]);

  // Latest scroll machinery, refreshed every render for the effect below.
  const scrollDepsRef = useRef({ virtualizer, rows, markLatestRead, isNearBottom });
  scrollDepsRef.current = { virtualizer, rows, markLatestRead, isNearBottom };

  // Scroll to bottom on new messages / initial load
  useEffect(() => {
    if (!messages.length) return;

    // If we just loaded older messages (prepend), don't scroll
    if (isLoadingMoreRef.current) {
      isLoadingMoreRef.current = false;
      prevMessagesLenRef.current = messages.length;
      return;
    }

    // Read the scroll machinery through a ref rather than closing over it.
    // `virtualizer`, `rows` and `markLatestRead` all change identity on almost
    // every render (typing indicators, reactions, hover). Listing them as
    // dependencies would re-run this effect — and therefore re-scroll — for
    // reasons that have nothing to do with a new message arriving; omitting
    // them without a ref would capture stale values. The ref gives correct
    // values with the intended trigger set (channel, count, newest id).
    const { virtualizer, rows, markLatestRead, isNearBottom } = scrollDepsRef.current;
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
    revokeLightboxBlobUrls();
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
      virtualizer.scrollToIndex(rowIndex, { align: 'center', behavior: 'smooth' });
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
    let cancelled = false;
    void (async () => {
      try {
        await fetchMessages(channelId, { around: msgId, limit: 50 });
        if (cancelled) return;
        requestAnimationFrame(() => {
          if (cancelled) return;
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
      cancelled = true;
    };
  }, [messages.length, channelId, fetchMessages, highlightJumpTarget, rows, virtualizer]);

  const scrollToMessage = useCallback((messageId: string) => {
    const rowIndex = rows.findIndex(
      (entry) => entry.type === 'message' && entry.message.id === messageId
    );
    if (rowIndex >= 0) {
      virtualizer.scrollToIndex(rowIndex, { align: 'center', behavior: 'smooth' });
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
  }, [rows, virtualizer, highlightJumpTarget, fetchMessages, channelId]);

  useEffect(() => {
    const messageId = pendingScrollMessageRef.current;
    if (!messageId) return;
    const rowIndex = rows.findIndex(
      (entry) => entry.type === 'message' && entry.message.id === messageId,
    );
    if (rowIndex < 0) return;
    pendingScrollMessageRef.current = null;
    virtualizer.scrollToIndex(rowIndex, { align: 'center', behavior: 'smooth' });
    highlightJumpTarget(messageId);
  }, [rows, virtualizer, highlightJumpTarget]);

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
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom <= 140;
    setShowScrollButton(!nearBottom && distanceFromBottom > 200);
    if (nearBottom) {
      markLatestRead();
      setNewMessageCount(0);
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
    setNewMessageCount(0);
  }, [virtualizer, rows.length, markLatestRead]);

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

  const buildMessageContextMenuItems = (msg: Message): ContextMenuItem[] => {
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
    setContextMenuAnchor({ x: e.clientX, y: e.clientY });
    onContextMenu(e, buildMessageContextMenuItems(msg));
  };

  // Render a single virtual row
  const renderRow = (row: VirtualRow) => {
    if (row.type === 'date-separator') {
      return <DayDivider label={dayDividerLabel(row.date)} />;
    }

    if (row.type === 'room-event') {
      return <RoomLitEventRow event={row.event} onJoin={joinLitRoom} />;
    }

    if (row.type === 'typing') {
      const guildId = activeChannel?.guild_id;
      const guildMembers = guildId === activeGuildId
        ? activeGuildMembers
        : (guildId && memberScope ? useMemberStore.getState().members.get(memberScopeKey(memberScope, guildId)) ?? null : null);
      const resolveUsername = (userId: string): string => {
        if (guildMembers) {
          const member = guildMembers.find((m) => m.user.id === userId);
          if (member) return displayName(member.user, member.nick);
        }
        return 'Someone';
      };

      const names = activeTyping.map(resolveUsername);
      return (
        <div className={cn('py-2 text-meta text-text-faint sm:pl-[82px]', TIMELINE_GUTTER)}>
          {names.length === 1 && <><strong className="font-semibold text-text-secondary">{names[0]}</strong> is typing</>}
          {names.length === 2 && <><strong className="font-semibold text-text-secondary">{names[0]}</strong> and <strong className="font-semibold text-text-secondary">{names[1]}</strong> are typing</>}
          {names.length === 3 && <><strong className="font-semibold text-text-secondary">{names[0]}</strong>, <strong className="font-semibold text-text-secondary">{names[1]}</strong>, and <strong className="font-semibold text-text-secondary">{names[2]}</strong> are typing</>}
          {names.length > 3 && <>{names.length} people are typing</>}
          <TypingDots />
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
    const replyDepth = row.replyDepth;
    const replyParentId = row.replyParentId;
    const replyParentMessage = replyParentId ? messageById.get(replyParentId) : undefined;
    const replyIndent = Math.min(replyDepth, MAX_REPLY_NEST_DEPTH) * REPLY_INDENT_PX;
    const isOwnMessage = msg.author.id === me;
    const canEditMessage = isOwnMessage && !hasEncryptedAttachments(msg);
    const canDeleteMessage = isOwnMessage || canManageMessages;
    const canPinMessage = canPinInChannel;
    const canReportMessage = Boolean(activeGuildId) && msg.author.id !== me;
    const canOpenMessageMenu =
      canEditMessage || canDeleteMessage || canPinMessage || canCreateThreads || canReportMessage || Boolean(msg.anonymous?.can_deanonymize);
    const linkedThreads = linkedThreadsByStarterMessageId[msg.id] ?? [];
    const authorGuildMember = activeGuildMemberById.get(msg.author.id);
    const authorName = displayName(msg.author, authorGuildMember?.nick);
    const authorRoleColor = authorGuildMember ? getHighestRoleColor(authorGuildMember.roles ?? [], guildRoles) : undefined;
    // §1.5: a person is a rim of light, not a coloured dot. The author's light
    // also carries "in Shop floor" when they are in a room right now (§7.4).
    const authorPerson = authorLight({
      id: msg.author.id,
      name: authorName,
      avatar: msg.author.avatar_hash ?? msg.author.avatar ?? null,
    });
    // A message that pings the reader gets the mention-line treatment (§7):
    // a persistent emerald tint plus a 2px accent left border, hover-independent.
    const mentionsMe = messageMentionsUser(msg, me);
    const isActiveRow = hoveredMessageId === msg.id || focusedMessageId === msg.id;
    // "From the room": written by somebody who is in the call right now (§7.2).
    const fromRoom = Boolean(inRoomUserIds?.has(msg.author.id));
    const rowBackground = jumpHighlightId === msg.id
      ? 'var(--accent-tint-strong)'
      : isActiveRow
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
        aria-label={`Message from ${authorName}`}
        aria-posinset={row.messageIndex + 1}
        aria-setsize={messages.length}
        tabIndex={msg.id === activeRowMessageId ? 0 : -1}
        className={cn(
          'group relative flex gap-[14px] rounded-[var(--radius-control)] py-1.5',
          'transition-colors duration-[140ms] ease-[var(--ease-out)]',
          'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
          TIMELINE_GUTTER,
          ribbon && 'gap-2.5 px-3.5 py-1',
          fromRoom && 'shadow-[var(--shadow-raised)]',
        )}
        style={{
          marginTop: isGrouped ? '2px' : replyDepth > 0 ? '0.5rem' : '10px',
          paddingLeft: replyIndent > 0 ? `${16 + replyIndent}px` : undefined,
          borderLeft: mentionsMe || jumpHighlightId === msg.id ? '2px solid var(--accent-primary)' : undefined,
          backgroundColor:
            rowBackground === 'transparent' && fromRoom ? 'var(--bg-raised)' : rowBackground,
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
          <div className={cn('flex w-9 flex-shrink-0 items-start justify-center pt-0.5', ribbon && 'w-7')}>
            <span className="pc-mono text-[11px] text-text-faint opacity-0 transition-opacity duration-[140ms] ease-[var(--ease-out)] group-hover:opacity-100">
              {new Date(getTimestamp(msg)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        ) : (
          <button
            type="button"
            aria-label={`Open profile for ${authorName}`}
            className={cn(
              'relative flex h-9 w-9 flex-shrink-0 rounded-full border-0 p-0 transition-transform duration-[140ms] ease-[var(--ease-out)] active:scale-95 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
              ribbon && 'h-7 w-7',
            )}
            onClick={(e) => openAuthorProfile(e, msg)}
          >
            <LitAvatar person={authorPerson} size={ribbon ? 28 : 36} hideLabel />
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
                replyParentMessage ? getReplyPreviewText(replyParentMessage) : 'Message not loaded'
              }
              onJump={() => scrollToMessage(replyParentId)}
            />
          )}
          {!isGrouped && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <button
                type="button"
                className="pc-display rounded-[var(--radius-window)] text-left text-name leading-tight hover:underline focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                style={{ color: authorRoleColor ?? 'var(--text-primary)' }}
                aria-label={`Open profile for ${authorName}`}
                onClick={(e) => openAuthorProfile(e, msg)}
              >
                {authorName}
              </button>
              {msg.anonymous?.is_anonymous && (
                <Chip size="sm" className="text-accent-warning">
                  Anonymous
                </Chip>
              )}
              {msg.author.bot && (
                <Chip size="sm" className="text-accent-primary">
                  Bot
                </Chip>
              )}
              <AuthorMeta
                person={authorPerson}
                timestamp={timelineTime(getTimestamp(msg))}
                title={formatTimestamp(getTimestamp(msg))}
              />
              {(msg.edited_timestamp || msg.edited_at) && (
                <button
                  type="button"
                  className="rounded-[var(--radius-window)] text-left text-[11px] text-text-faint hover:underline focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
                aria-label={`Edit message from ${authorName}`}
className="w-full resize-none rounded-[var(--radius-well)] bg-bg-well px-3 py-2 text-body text-text-primary shadow-[var(--shadow-well)] outline-none transition-[box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring-input)]"
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
                  disabled={editSaving}
                  className="inline-flex items-center gap-1 rounded-chip px-2 py-1 text-meta font-semibold text-accent-primary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                >
                  <Check size={13} /> {editSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={cancelEditing}
                  className="inline-flex items-center gap-1 rounded-chip px-2 py-1 text-meta font-semibold text-text-muted transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
                      <div className="h-3.5 w-3/4 pc-skeleton rounded-[var(--radius-window)] bg-bg-mod-subtle" />
                      <div className="h-3.5 w-1/2 pc-skeleton rounded-[var(--radius-window)] bg-bg-mod-subtle" />
                    </div>
                  ) : (
                    <div className={cn('break-words text-body text-text-body', ribbon && 'text-ribbon')}>
                      {getCachedParsedMarkdown(
                        msg.id,
                        msg.content || '',
                        String(msg.edited_timestamp || msg.edited_at || ''),
                        activeGuildId || undefined,
                        mentionMap,
                        handleMentionClick,
                      )}
                    </div>
                  )}
                </EphemeralMessage>
              ) : !msg.poll && decryptingIds.has(msg.id) ? (
                <div className="flex flex-col gap-1.5 py-0.5" aria-label="Decrypting message">
                  <div className="h-3.5 w-3/4 pc-skeleton rounded-[var(--radius-window)] bg-bg-mod-subtle" />
                  <div className="h-3.5 w-1/2 pc-skeleton rounded-[var(--radius-window)] bg-bg-mod-subtle" />
                </div>
              ) : !msg.poll ? (
                <div className={cn('mt-0.5 break-words text-body text-text-body', ribbon && 'text-ribbon')}>
                  {getCachedParsedMarkdown(
                    msg.id,
                    msg.content || '',
                    String(msg.edited_timestamp || msg.edited_at || ''),
                    activeGuildId || undefined,
                    mentionMap,
                    handleMentionClick,
                  )}
                  {isGrouped && (msg.edited_timestamp || msg.edited_at) && (
                    <button
                      type="button"
                      className="ml-1 rounded px-0 text-left text-[11px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-plate"
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

          {msg.components && msg.components.length > 0 && (
            <MessageComponents
              components={msg.components}
              messageId={msg.id}
              channelId={channelId}
              guildId={activeGuildId || undefined}
            />
          )}

          {msg.anonymous?.is_anonymous && deanonymizedById[msg.id] && (
            <p className="mt-1 text-meta text-text-muted">
              Real author: <span className="font-semibold text-text-secondary">{deanonymizedById[msg.id]}</span>
            </p>
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
            <div className="flex flex-wrap items-center gap-1.5">
              {linkedThreads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  name={thread.name || 'Thread'}
                  meta={threadMetaFor(thread)}
                  people={[authorPerson]}
                  archived={Boolean(thread.thread_metadata?.archived)}
                  onOpen={() => openLinkedThread(thread.id)}
                />
              ))}
            </div>
          )}
          {/* Reactions */}
          {msg.reactions && Array.isArray(msg.reactions) && msg.reactions.length > 0 && (
            <ReactionRow
              reactions={msg.reactions as ReactionTally[]}
              guildId={activeGuildId}
              onToggle={(reaction) => void toggleReaction(msg.id, reaction)}
            />
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
                        className="rounded-well object-contain"
                        style={{ width: 128, height: 128 }}
                        loading="lazy"
                      />
                    ) : (
                      <div className="inline-flex items-center gap-1.5 rounded-well border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary">
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
                // Encrypted attachment seam: in an end-to-end encrypted
                // conversation the server's row is an opaque blob. Its real
                // name, type and bytes come from the encrypted message body and
                // are decrypted on this device; an attachment the body never
                // described is labelled as not encrypted rather than shown as
                // if it were.
                if (msg.e2ee) {
                  return <EncryptedAttachment key={att.id} attachment={att} />;
                }
                const src = resolveFederatedAttachmentUrl(att, msg.channel_id);
                const isFederated = Boolean(att.origin_server);
                const federatedBadge = isFederated ? (
                  <Chip
                    size="sm"
                    tone="accent"
                    title={att.content_hash ? `Hash: ${att.content_hash}` : `From: ${att.origin_server}`}
                  >
                    Federated
                  </Chip>
                ) : null;
                const attachmentIsImage = isImageAttachment(att) && Boolean(src);
                if (attachmentIsImage) {
                  if (lowBandwidthMode) {
                    return (
                      <div
                        key={att.id}
                        // `[&>button]:mt-0`: see AttachmentFrame — the same
                    // vertical-rhythm fallback would push Download out of line.
                    className="mt-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-[var(--radius-well)] bg-bg-well px-3 py-2 text-meta shadow-[var(--shadow-chip)] [&>button]:mt-0"
                      >
                        {federatedBadge}
                        <span className="max-w-[20rem] truncate font-medium text-text-body">
                          {att.filename}
                        </span>
                        <Chip size="sm" className="text-text-faint">Preview off</Chip>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void downloadAttachment(att.id, att.filename)}
                          disabled={attachmentBusyId === att.id}
                        >
                          {attachmentBusyId === att.id
                            ? downloadProgress != null
                              ? `${downloadProgress}%`
                              : 'Downloading…'
                            : 'Download'}
                        </Button>
                        {isOwnMessage && !isFederated && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => void deleteAttachment(msg.id, att.id)}
                            disabled={attachmentBusyId === att.id}
                          >
                            {attachmentBusyId === att.id ? 'Deleting…' : 'Delete'}
                          </Button>
                        )}
                      </div>
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
                    // §7.4: the picture sits in a well with its own line under
                    // it — the file's name and size, then what you can do with
                    // it. No frame, no border, no card-in-a-card.
                    <AttachmentFrame
                      key={att.id}
                      footer={
                        <>
                          {federatedBadge}
                          <span className="min-w-0 truncate font-medium text-text-body">{att.filename}</span>
                          {att.size != null && (
                            <span className="pc-mono ml-auto shrink-0">{formatFileSize(att.size)}</span>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => void openImageLightbox()}>
                            Open
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void downloadAttachment(att.id, att.filename)}
                            disabled={attachmentBusyId === att.id}
                          >
                            {attachmentBusyId === att.id ? (downloadProgress != null ? `${downloadProgress}%` : 'Downloading…') : 'Download'}
                          </Button>
                          {isOwnMessage && !isFederated && (
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => void deleteAttachment(msg.id, att.id)}
                              disabled={attachmentBusyId === att.id}
                            >
                              {attachmentBusyId === att.id ? 'Deleting…' : 'Delete'}
                            </Button>
                          )}
                        </>
                      }
                    >
                      <button
                        type="button"
                        aria-label={`Open image preview: ${att.filename}`}
                        className="pc-focusable block w-full cursor-pointer border-0 bg-transparent p-0 text-left"
                        onClick={() => void openImageLightbox()}
                      >
                        <ResolvedAttachmentImage
                          url={src!}
                          alt={att.filename}
                          className="block w-full"
                          style={{ maxHeight: '300px', objectFit: 'contain' }}
                        />
                      </button>
                    </AttachmentFrame>
                  );
                }
                return (
                  <div
                    key={att.id}
                    className="mt-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-[var(--radius-well)] bg-bg-well px-3 py-2 text-meta shadow-[var(--shadow-chip)]"
                  >
                    {federatedBadge}
                    <button
                      type="button"
                      className="pc-focusable max-w-[20rem] truncate rounded-[var(--radius-chip)] text-left font-medium text-text-link transition-colors hover:underline"
                      onClick={() => void downloadAttachment(att.id, att.filename)}
                      disabled={attachmentBusyId === att.id}
                    >
                      {att.filename}
                    </button>
                    {att.size != null && <span className="pc-mono text-text-faint">{formatFileSize(att.size)}</span>}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void downloadAttachment(att.id, att.filename)}
                      disabled={attachmentBusyId === att.id}
                    >
                      {attachmentBusyId === att.id ? (downloadProgress != null ? `${downloadProgress}%` : 'Downloading…') : 'Download'}
                    </Button>
                    {isOwnMessage && !isFederated && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void deleteAttachment(msg.id, att.id)}
                        disabled={attachmentBusyId === att.id}
                      >
                        {attachmentBusyId === att.id ? 'Deleting…' : 'Delete'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isCoarsePointer && canOpenMessageMenu && (
          <button
            className="pc-focusable absolute right-1.5 top-1.5 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-bg-raised text-text-secondary shadow-[var(--shadow-lifted)] md:hidden"
            title="Message actions"
            aria-label="Message actions"
            onClick={() => setMenuMessageId((curr) => (curr === msg.id ? null : msg.id))}
          >
            <MoreHorizontal size={15} />
          </button>
        )}

        {(hoveredMessageId === msg.id || focusedMessageId === msg.id) && !isCoarsePointer && (
          <div className="pc-hover-in pc-floating absolute -top-3.5 right-4 flex items-center gap-0.5 overflow-hidden p-0.5 sm:right-8">
            {canAddReactions && (
              <button className="hover-action-btn rounded-chip" title="Add reaction" aria-label="Add reaction" onClick={(e) => openReactionPicker(e, msg.id)}>
                <Smile size={16} />
              </button>
            )}
            <button className="hover-action-btn rounded-chip" title="Reply" aria-label="Reply" onClick={() => onReply?.(msg)}>
              <Reply size={16} />
            </button>
            {canOpenMessageMenu && (
              <button
                className="hover-action-btn rounded-chip"
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
            className="pc-floating absolute right-1 top-11 z-10 min-w-[10rem] max-w-[calc(100vw-2.75rem)] p-1 sm:right-2"
          >
            {canAddReactions && (
              <button
                className="context-menu-item w-full text-left"
                onClick={(e) => {
                  setMenuMessageId(null);
                  openReactionPicker(e, msg.id);
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
                  void deanonymizeMessage(msg);
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
                Create thread
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
            <button
              className="context-menu-item w-full text-left"
              onClick={() => void toggleSavedMessage(msg)}
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
      </div>
    );
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative flex-1 overflow-hidden">
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
        className="flex h-full flex-col overflow-y-auto"
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
          <div className={cn('flex h-full flex-col items-start justify-end gap-3 pb-8', TIMELINE_GUTTER)}>
            <span className="pc-window h-2.5 w-2.5" aria-hidden />
            <div>
              <h3 className="pc-display text-heading text-text-primary">
                {activeChannel?.name ? `${activeChannel.name} is dark` : 'Nobody has said anything here yet'}
              </h3>
              <p className="mt-1 max-w-md text-body text-text-body">
                {activeChannel?.name
                  ? `Nobody has posted in ${activeChannel.name} yet. Say something and the room lights up.`
                  : 'Say something and the room lights up.'}
              </p>
            </div>
            <Button
              variant="primary"
              className="mt-1 gap-2"
              onClick={() => {
                const composer = document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]');
                composer?.focus();
              }}
            >
              <Send size={16} />
              Send the first message
            </Button>
          </div>
        ) : (
          // §7.4: a room reads from the bottom. `mt-auto` only has room to act
          // when the timeline is shorter than the plate; past that it scrolls.
          <>
            <div className="mt-auto shrink-0 py-6" style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
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
                className={cn('-mt-4 shrink-0 pb-6 text-right', TIMELINE_GUTTER, ribbon && 'px-3.5')}
              >
                <span data-motion-receipt className="pc-mono text-meta text-text-faint">
                  Delivered
                </span>
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
                className="rounded-chip px-3.5 py-2 text-label font-semibold text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
                className="rounded-chip px-3.5 py-2 text-label font-semibold text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
          className="pc-focusable absolute bottom-[calc(var(--safe-bottom)+0.75rem)] left-1/2 flex h-[var(--h-control)] -translate-x-1/2 items-center gap-2 rounded-[var(--radius-control)] bg-bg-raised px-4 text-label font-semibold text-text-primary shadow-[var(--shadow-lifted)] transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong"
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
              className="rounded-chip px-3 py-1.5 text-label font-semibold text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
              onClick={cancelBulkDelete}
              disabled={bulkDeleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-chip bg-danger-well px-3 py-1.5 text-label font-semibold text-text-on-danger shadow-[var(--shadow-chip)] transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-well-hover focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
              onClick={() => void executeBulkDelete()}
              disabled={bulkDeleting || selectedMessageIds.length === 0}
            >
              {bulkDeleting ? 'Deleting...' : 'Delete selected'}
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
        labelledBy="delete-message-dialog-title"
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
