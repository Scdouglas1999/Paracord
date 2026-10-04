import { Link } from 'react-router';
import { useStore } from 'zustand';
import { useChannelStore } from '../../stores/channelStore';
import { getAccountChannelView } from '../../lib/channelView';
import { isGroupDm, pendingGroupMembers, runtimeAttachDecision, runtimeSendDecision } from '../../lib/messages/messagingReadiness';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { entityScopeKey as memberScopeKey, type AccountScope } from '../../lib/serverScope';
import { Fragment, useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, lazy, Suspense, type CSSProperties } from 'react';

// §5.3: one reduced-motion switch for the whole app — lib/motion is the only
// JavaScript motion engine; the composer's enter/exit surfaces are CSS.
import { emitMotion, fadeIn, ms, pressComposer, readSendOrigin, releaseSend, useLingering, useReducedMotion } from '../../lib/motion';
import { ArrowUp, BarChart3, Clock3, CornerUpLeft, EyeOff, FileText, Image, Loader2, MinusCircle, Plus, PlusCircle, Smile, Type, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Input, Select } from '../ui/Input';
import { Button } from '../ui/Button';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { useCurrentMessageStoreApi } from '../../hooks/useMessageStore';
import { useMessageDraft } from '../../hooks/useMessageDraft';
import { MessagingQueuePanel, isQuietlyInFlight } from './MessagingQueuePanel';
import { MessagingRecoveryNotice } from './MessagingRecoveryNotice';
import { useMemberStore } from '../../stores/memberStore';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useMobile } from '../../hooks/useMobile';
import { useTyping } from '../../hooks/useTyping';
import { MAX_MESSAGE_LENGTH, SCHEDULED_MESSAGE_MIN_LEAD_MS } from '../../lib/constants';
import { channelApi } from '../../api/channels';
import type { ChannelFeatureSettings } from '../../api/channels';
import { usePollStore } from '../../stores/pollStore';
import { MarkdownToolbar, applyMarkdownToolbarAction, resolveMarkdownShortcut } from './MarkdownToolbar';
import { SlashCommandPopup } from './SlashCommandPopup';
import { ScheduledMessagesPanel } from './ScheduledMessagesPanel';
import type { ApplicationCommand, CommandOption } from '../../types/commands';
import { ApplicationCommandType, CommandOptionType } from '../../types/commands';
import type { ResolvedCommandOption } from '../../types/interactions';
import { InteractionType } from '../../types/interactions';
import { interactionApi } from '../../api/interactions';
import { useCommandStore } from '../../stores/commandStore';
import { useInteractionStore, type AutocompleteChoice } from '../../stores/interactionStore';
import { useConversationActions } from '../../hooks/useConversationActions';
import { captureScopedOperation } from '../../lib/operationContext';
import type { Message, Role } from '../../types';
import { Permissions, hasPermission } from '../../types';
import { usePermissions } from '../../hooks/usePermissions';
import { fetchGuildRoles } from '../../lib/permissionDataCache';
import { roleColorToHex } from '../../lib/colors';
import { isAllowedImageMimeType } from '../../lib/security';
import { formatFileSize, toDatetimeLocalValue } from '../../lib/formatters';
import { toast } from '../../stores/toastStore';
import { extractApiError } from '../../api/client';
import { displayName } from '../../lib/displayName';

/** A composer picker opens upward from its button at the composer's right
 * edge, so it grows from its own bottom-right corner (`--pc-origin`). */
const PICKER_LAYER_STYLE = { zIndex: 50, '--pc-origin': '100% 100%' } as CSSProperties;

const EmojiPicker = lazy(() =>
  import('../ui/EmojiPicker').then((m) => ({ default: m.EmojiPicker })),
);
const GifPicker = lazy(() =>
  import('./GifPicker').then((m) => ({ default: m.GifPicker })),
);
const StickerPicker = lazy(() =>
  import('./StickerPicker').then((m) => ({ default: m.StickerPicker })),
);

interface MessageInputProps {
  channelId: string;
  guildId?: string;
  channelName?: string;
  replyingTo?: { id: string; author: string; content: string } | null;
  onCancelReply?: () => void;
  /**
   * What `channelName` names: a server channel, a group DM or a person. It no
   * longer changes anything (the Glass words are "Message General" and
   * "Message Mara" alike, docs/glass-spec.md §3.2); it stays so callers need no
   * edit and a future distinction has somewhere to live.
   */
  conversationKind?: 'channel' | 'group' | 'person';
  /**
   * WP3 (spec §7.2, §8), additive: `ribbon` is the composer inside the Stage's
   * chat ribbon — 42px instead of 50, a short "Say something" that fits the
   * plate's 185px of composer, and a send
   * button in white light, because everybody it reaches is in the room right
   * now. Nothing about sending changes.
   */
  variant?: 'default' | 'ribbon';
  /**
   * This composer stands in a column too narrow for a sentence, and whatever it
   * would have named is in the heading directly above it. The invitation drops
   * to "Say something" — the same string the ribbon uses, for the same reason.
   *
   * The thread panel is `clamp(14rem, 24vw, 20rem)` wide, which leaves 148px for
   * the field once the attach and send controls have theirs. "Say something in
   * Bracket tolerance" needs 251px, so every thread whose name runs past about
   * four characters arrived cut mid-word: "Say something in Bra".
   */
  narrow?: boolean;
}

const POLL_DURATION_OPTIONS = [
  { label: 'No end time', minutes: 0 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
  { label: '3 days', minutes: 4320 },
  { label: '7 days', minutes: 10080 },
  { label: '14 days', minutes: 20160 },
];

/**
 * The composer's placeholder: "Message General", "Message Mara" (docs/glass-spec.md
 * §3.2: no `#` anywhere; the name is the thing). `_kind` no longer changes the
 * words (a channel and a person read alike now); it stays so existing callers
 * and tests need no edit.
 */
export function composerPlaceholder(
  name?: string | null,
  _kind: 'channel' | 'group' | 'person' = 'channel',
  compact = false,
): string {
  if (!name) return GENERIC_PLACEHOLDER;
  const full = `Message ${name}`;
  // A phone's composer is about 230px of text and a placeholder cannot wrap,
  // so a long name would arrive cut off mid-word. There is no telling how long
  // a name is, so past what fits the short form drops it.
  if (compact && full.length > COMPACT_PLACEHOLDER_MAX) return GENERIC_PLACEHOLDER;
  return full;
}

/**
 * While replying: "Reply to Jeremy". In a capsule too narrow for the sentence
 * the reply chip already carries the name, so it is just "Reply" (`screens/07`).
 */
export function replyPlaceholder(author: string, compact = false): string {
  if (compact) return 'Reply';
  const full = `Reply to ${author}`;
  return full.length > COMPACT_PLACEHOLDER_MAX * 2 ? 'Reply' : full;
}

const GENERIC_PLACEHOLDER = 'Write a message';

/** What fits a phone's composer at the body size, with room to spare. */
const COMPACT_PLACEHOLDER_MAX = 26;

/**
 * Below this capsule width the emoji button and the pickers' entry points fold
 * into the "+" menu (the 420px side chat and a phone are both under it).
 */
const COMPACT_CAPSULE_MAX = 420;

function canPreviewImageFile(file: File): boolean {
  return isAllowedImageMimeType(file.type);
}

function parseSlashArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    args.push(match[1] ?? match[2]);
  }
  return args;
}

function coerceOptionValue(opt: CommandOption, raw: string): unknown {
  if (opt.type === CommandOptionType.Integer || opt.type === CommandOptionType.Number) {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? raw : parsed;
  }
  if (opt.type === CommandOptionType.Boolean) {
    const lower = raw.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return raw;
  }
  return raw;
}

function parseSlashCommandOptions(
  command: ApplicationCommand,
  argsText: string,
): ResolvedCommandOption[] {
  if (!command.options?.length) return [];

  const parts = parseSlashArgs(argsText);
  let index = 0;
  const options: ResolvedCommandOption[] = [];
  const topLevel = command.options;

  const first = topLevel[0];
  if (first?.type === CommandOptionType.SubCommand) {
    const subName = parts[index++];
    if (!subName) return options;
    const sub = topLevel.find((entry) => entry.name === subName);
    if (!sub) return options;
    const subOptions: ResolvedCommandOption[] = [];
    for (const opt of sub.options ?? []) {
      if (index >= parts.length) break;
      if (
        opt.type === CommandOptionType.String ||
        opt.type === CommandOptionType.Integer ||
        opt.type === CommandOptionType.Number ||
        opt.type === CommandOptionType.Boolean
      ) {
        subOptions.push({
          name: opt.name,
          type: opt.type,
          value: coerceOptionValue(opt, parts[index++]),
        });
      } else {
        index++;
      }
    }
    options.push({ name: sub.name, type: CommandOptionType.SubCommand, options: subOptions });
    return options;
  }

  for (const opt of topLevel) {
    if (index >= parts.length) break;
    if (
      opt.type === CommandOptionType.String ||
      opt.type === CommandOptionType.Integer ||
      opt.type === CommandOptionType.Number ||
      opt.type === CommandOptionType.Boolean
    ) {
      options.push({
        name: opt.name,
        type: opt.type,
        value: coerceOptionValue(opt, parts[index++]),
      });
    } else {
      index++;
    }
  }
  return options;
}

/** Build options for an autocomplete request, marking the focused option. */
function buildAutocompleteOptions(
  command: ApplicationCommand,
  argsText: string,
  trailingPartial: string,
  endsWithSpace: boolean,
): ResolvedCommandOption[] | null {
  if (!command.options?.length) return null;
  const parts = parseSlashArgs(argsText);
  const topLevel = command.options;
  const first = topLevel[0];

  const fillOptions = (
    optionDefs: CommandOption[],
    filledParts: string[],
  ): { options: ResolvedCommandOption[]; focused: boolean } => {
    const options: ResolvedCommandOption[] = [];
    let partIdx = 0;
    let focused = false;
    for (const opt of optionDefs) {
      const isAutocomplete =
        !!opt.autocomplete &&
        (opt.type === CommandOptionType.String ||
          opt.type === CommandOptionType.Integer ||
          opt.type === CommandOptionType.Number);
      if (partIdx < filledParts.length) {
        const value = coerceOptionValue(opt, filledParts[partIdx++]);
        const isLastFilled = partIdx === filledParts.length && !endsWithSpace && isAutocomplete;
        options.push({
          name: opt.name,
          type: opt.type,
          value,
          focused: isLastFilled || undefined,
        });
        if (isLastFilled) focused = true;
      } else if (endsWithSpace || trailingPartial !== undefined) {
        // Next option is focused (empty or partial trailing token).
        if (isAutocomplete && !focused) {
          options.push({
            name: opt.name,
            type: opt.type,
            value: endsWithSpace ? '' : trailingPartial,
            focused: true,
          });
          focused = true;
        }
        break;
      } else {
        break;
      }
    }
    return { options, focused };
  };

  if (first?.type === CommandOptionType.SubCommand) {
    if (parts.length === 0 && !endsWithSpace) return null;
    const subName = parts[0];
    if (!subName) return null;
    const sub = topLevel.find((entry) => entry.name === subName);
    if (!sub?.options?.length) return null;
    const rest = parts.slice(1);
    const { options: subOptions, focused } = fillOptions(sub.options, rest);
    if (!focused) return null;
    return [
      {
        name: sub.name,
        type: CommandOptionType.SubCommand,
        options: subOptions,
      },
    ];
  }

  const { options, focused } = fillOptions(topLevel, parts);
  return focused ? options : null;
}

function commandHasAutocomplete(command: ApplicationCommand): boolean {
  const walk = (opts: CommandOption[] | undefined): boolean => {
    if (!opts) return false;
    for (const opt of opts) {
      if (opt.autocomplete) return true;
      if (opt.options && walk(opt.options)) return true;
    }
    return false;
  };
  return walk(command.options);
}

async function resolveGuildSlashCommand(
  guildId: string,
  commandName: string,
): Promise<ApplicationCommand | undefined> {
  const store = useCommandStore.getState();
  if (!store.guildCommands.has(guildId)) {
    await store.fetchGuildCommands(guildId);
  }
  return store.guildCommands.get(guildId)?.find(
    (cmd) => cmd.name === commandName && cmd.type === ApplicationCommandType.ChatInput,
  );
}

function messageInputError(err: unknown, fallback: string): string {
  const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
  if (responseData?.message) return responseData.message;
  if (responseData?.error) return responseData.error;
  const extracted = extractApiError(err);
  return extracted === 'An unexpected error occurred' ? fallback : extracted;
}

export function MessageInput(props: MessageInputProps) {
  const messageStore = useCurrentMessageStoreApi();
  const scope = messageStore.scope;
  if (!scope) return <p className="px-4 py-3 text-meta text-text-muted">Sign in to this instance to write a message.</p>;
  return <OwnedMessageInput key={memberScopeKey(scope, props.channelId)} {...props} scope={scope} messageStore={messageStore} />;
}

function OwnedMessageInput({ channelId, guildId, channelName, conversationKind = 'channel', replyingTo, onCancelReply, variant = 'default', narrow = false, scope, messageStore }: MessageInputProps & {
  scope: AccountScope;
  messageStore: ReturnType<typeof useCurrentMessageStoreApi>;
}) {
  // WP3: the Stage's chat ribbon. Presentation only — the same draft, the same
  // send path, the same permissions.
  const ribbon = variant === 'ribbon';
  const { content, setContent, error: draftError, retrySave, capture: captureDraft, clearSubmitted, runtime: messagingRuntime } = useMessageDraft(scope, channelId);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toolsPosition, setToolsPosition] = useState<{ x: number; y: number } | null>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  // The "+" menu opens ABOVE the capsule, and the menu's own height is only
  // known once it is on the page, so it is placed twice: at the button, then
  // (before paint) lifted by its measured height. See the layout effect below.
  const toolsAnchorRef = useRef<{ left: number; top: number } | null>(null);
  const toolsPlacedRef = useRef(false);
  // The capsule's measured width says whether the emoji button still fits.
  const [compact, setCompact] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  // The pickers leave the way they came (§5.2): kept mounted for their exit.
  const emojiLayer = useLingering(showEmojiPicker);
  const gifLayer = useLingering(showGifPicker);
  const stickerLayer = useLingering(showStickerPicker);
  const [showFormattingTools, setShowFormattingTools] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollAllowMultiselect, setPollAllowMultiselect] = useState(false);
  const [pollDurationMinutes, setPollDurationMinutes] = useState(1440);
  const [creatingPoll, setCreatingPoll] = useState(false);
  const [showScheduleComposer, setShowScheduleComposer] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [schedulingMessage, setSchedulingMessage] = useState(false);
  const [sending, setSending] = useState(false);
  const [showScheduledPanel, setShowScheduledPanel] = useState(false);
  const [scheduledCount, setScheduledCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  /* §5.1 "a message has mass" — see `beginSay` below. The words that fly are a
     ghost the motion engine owns, not React state: the send frame is the one
     frame in this moment that must not be spent re-rendering a 1,600-line
     composer, and the ghost has nothing to do with the draft anyway. */
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const wordsTimer = useRef<number | null>(null);
  const sayCount = useRef(0);
  /** Sends the outbox has accepted and the timeline has not yet shown: nonce → the words and when. */
  const unanswered = useRef(new Map<string, { text: string; at: number }>());
  const { upload, uploading, maxUploadSize } = useFileUpload(channelId);
  const { triggerTyping, stopTyping } = useTyping(channelId);
  const reduceMotion = useReducedMotion();
  const { actions: serverActions, encrypted, encryption, error: capabilityError, refresh: refreshActions } = useConversationActions(channelId);
  const runtimeState = useStore(messagingRuntime.store);
  const channel = useChannelStore(state => getAccountChannelView(scope, state).channelsById[channelId]);
  const channelType = channel?.channel_type ?? channel?.type;
  // A group conversation's own refusal is about who is in it, not about an
  // encryption rung this person could climb, so the rows below that offer a
  // route out stay hidden for it.
  const groupRoster = isGroupDm(channelType) ? channel?.recipients : undefined;
  const actions = { ...serverActions,
    send: runtimeSendDecision(serverActions.send, runtimeState, encrypted, channelId, channelType, groupRoster),
    // Encrypted attachment seam: attaching needs the same unlocked encrypted
    // storage and ready identities that sending does. A group seals attachments
    // under the same sender key as its text, so it takes the same answer.
    attach: runtimeAttachDecision(serverActions.attach, runtimeState, encrypted, channelId, channelType, groupRoster) };
  // The group's own blocker is about *other people* — somebody who has not
  // published an identity key, or a roster that has not loaded. No page this
  // person can open resolves it, so the encryption routes below stay hidden for
  // it. A group blocked on the viewer's *own* setup is an ordinary encryption
  // rung and keeps its link.
  const groupDmRefusal = isGroupDm(channelType)
    && (!channel?.recipients?.length || pendingGroupMembers(channel.recipients).length > 0);
  // A message that has gone out, or a composer its author emptied, ends the
  // typing indicator at once. Every send path clears the draft, so this one
  // place covers all of them as well as a manual clear.
  useEffect(() => { if (!content.trim()) stopTyping(); }, [content, stopTyping]);
  const canCreatePoll = actions.poll.allowed;
  const canSendMessages = actions.send.allowed;
  const canAttachFiles = actions.attach.allowed;
  // Narrow enough that a long channel name cannot fit the placeholder.
  const phoneWidth = useMobile(520);
  /**
   * A blocker is worth reading only if it lasts.
   *
   * Delivery readiness dips out of `ready` for a beat every time the runtime
   * recovers a channel — including the channel you just posted to — so the
   * "wait for recovery" notice used to appear and vanish inside 80ms, shoving
   * the composer 40px in the middle of §5.1's send. A blocker that resolves
   * itself faster than a person can read it was never a blocker; one that does
   * not is still here 400ms later, and then it shows.
   */
  const composerAction = showPollComposer ? actions.poll : showScheduleComposer ? actions.schedule
    : stagedFiles.length > 0 && !actions.attach.allowed ? actions.attach : actions.send;

  const channelWaiting = useInteractionStore((s) => s.isChannelWaiting(channelId));
  const showCommandThinking = channelWaiting;

  // Anonymous posting detection
  const [channelFeatures, setChannelFeatures] = useState<ChannelFeatureSettings | null>(null);
  useEffect(() => {
    let canceled = false;
    channelApi.getFeatureSettings(channelId).then(({ data }) => {
      if (!canceled) setChannelFeatures(data);
    }).catch(() => {
      // Feature settings are optional
    });
    return () => { canceled = true; };
  }, [channelId]);
  const isAnonymousChannel = channelFeatures?.anonymous_posting_enabled === true;

  // Slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashOptionMode, setSlashOptionMode] = useState(false);
  const [autocompleteLoading, setAutocompleteLoading] = useState(false);
  const autocompleteChoices = useInteractionStore((s) => s.autocompleteChoices);
  const clearAutocompleteChoices = useInteractionStore((s) => s.clearAutocompleteChoices);
  const autocompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autocompleteRequestIdRef = useRef(0);

  // The autocomplete debounce is scheduled from a keystroke handler and was
  // only ever cleared by the next keystroke. Typing `/cmd ` and immediately
  // closing the composer left a pending timer that fired into an unmounted
  // component and issued a request nobody was waiting for.
  useEffect(() => () => {
    if (autocompleteTimerRef.current) {
      clearTimeout(autocompleteTimerRef.current);
      autocompleteTimerRef.current = null;
    }
  }, []);

  // @mention autocomplete — subscribe only to this guild's member list
  const memberScope = useCurrentAccountScope();
  const guildMembers = useMemberStore((s) => (guildId ? (memberScope ? s.members.get(memberScopeKey(memberScope, guildId)) : undefined) : undefined));
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const { permissions: mentionPerms } = usePermissions(guildId ?? null);
  const canMentionRoles = hasPermission(mentionPerms, Permissions.MENTION_EVERYONE);
  const [composerRoles, setComposerRoles] = useState<Role[]>([]);
  const [composerRolesError, setComposerRolesError] = useState<string | null>(null);
  useEffect(() => {
    if (!guildId) {
      setComposerRoles([]);
      setComposerRolesError(null);
      return;
    }
    let canceled = false;
    fetchGuildRoles(guildId)
      .then((roles) => {
        if (!canceled) {
          setComposerRoles(roles);
          setComposerRolesError(null);
        }
      })
      .catch((err) => {
        if (!canceled) setComposerRolesError(extractApiError(err));
      });
    return () => {
      canceled = true;
    };
  }, [guildId]);

  useEffect(() => {
    if (mentionQuery === null || !guildId || !memberScope || guildMembers) return;
    void useMemberStore.getState().fetchMembers(guildId, memberScope);
  }, [mentionQuery, guildId, memberScope, guildMembers]);

  type MentionOption =
    | { kind: 'member'; id: string; member: NonNullable<typeof guildMembers>[number] }
    | { kind: 'role'; id: string; role: Role; count: number };

  const mentionResults = useMemo(() => {
    if (mentionQuery === null || !guildId) return [] as MentionOption[];
    const q = mentionQuery.toLowerCase();
    const people: MentionOption[] = (guildMembers || [])
      .filter((m) => {
        const visibleName = displayName(m.user, m.nick).toLowerCase();
        return visibleName.includes(q) || m.user.username.toLowerCase().includes(q);
      })
      .slice(0, 8)
      .map((member) => ({ kind: 'member' as const, id: member.user.id, member }));
    const roles: MentionOption[] = composerRoles
      // @everyone is its own mention, not a role to pick here.
      .filter((role) => role.id !== guildId && (role.mentionable || canMentionRoles) && role.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((role) => ({
        kind: 'role' as const,
        id: role.id,
        role,
        count: guildMembers ? guildMembers.filter((member) => member.roles.includes(role.id)).length : -1,
      }));
    return [...people, ...roles];
  }, [mentionQuery, guildId, guildMembers, composerRoles, canMentionRoles]);

  const resizeDraft = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.max(44, viewportHeight * 0.45))}px`;
  }, []);
  useEffect(() => { resizeDraft(); }, [content, resizeDraft]);
  useEffect(() => {
    const shell = composerShellRef.current;
    if (!shell) return;
    let width = shell.clientWidth;
    // Zero means "not laid out" (a detached or hidden tree), never "narrow".
    const measure = () => setCompact(shell.clientWidth > 0 && shell.clientWidth < COMPACT_CAPSULE_MAX);
    measure();
    const observer = new ResizeObserver(() => {
      if (shell.clientWidth === width) return;
      width = shell.clientWidth;
      measure();
      resizeDraft();
    });
    observer.observe(shell);
    window.addEventListener('resize', resizeDraft);
    window.visualViewport?.addEventListener('resize', resizeDraft);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeDraft);
      window.visualViewport?.removeEventListener('resize', resizeDraft);
    };
  }, [resizeDraft]);

  // Click-outside dismiss for inline emoji picker and formatting toolbar.
  useEffect(() => {
    if (!showEmojiPicker && !showFormattingTools) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (composerShellRef.current?.contains(target)) return;
      setShowEmojiPicker(false);
      setShowFormattingTools(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showEmojiPicker, showFormattingTools]);

  const refreshScheduledCount = useCallback(async () => {
    try {
      const { data } = await channelApi.listScheduledMessages(channelId);
      setScheduledCount(data.filter((m) => m.status === 0).length);
    } catch {
      // Non-critical: the badge simply stays at its last known value.
    }
  }, [channelId]);

  // Populate the pending badge when the schedule composer is first opened.
  useEffect(() => {
    if (showScheduleComposer) {
      void refreshScheduledCount();
    }
  }, [showScheduleComposer, refreshScheduledCount]);

  const stagedImagePreviews = useMemo(
    () =>
      stagedFiles.map((file) => (
        canPreviewImageFile(file) ? URL.createObjectURL(file) : null
      )),
    [stagedFiles],
  );

  useEffect(() => {
    return () => {
      stagedImagePreviews.forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
    };
  }, [stagedImagePreviews]);

  const resetPollComposer = () => {
    setShowPollComposer(false);
    setPollQuestion('');
    setPollOptions(['', '']);
    setPollAllowMultiselect(false);
    setPollDurationMinutes(1440);
    setCreatingPoll(false);
  };

  /** The words are gone (the draft cleared) or they are coming back (it failed). */
  const bringWordsBack = () => {
    if (wordsTimer.current) window.clearTimeout(wordsTimer.current);
    wordsTimer.current = null;
    const textarea = textareaRef.current;
    if (!textarea || textarea.style.opacity !== '0') return;
    textarea.style.opacity = '';
    // A draft that stays (the send failed) is as tall as it was.
    resizeDraft();
    fadeIn(textarea, { duration: ms('--duration-normal') });
  };
  const endSay = bringWordsBack;

  /**
   * "Say something" — §5.1 "a message has mass", the send flight
   * (docs/glass-spec.md §9).
   *
   * The typed words fly out of the composer to where the message lands in the
   * timeline: `MessageList` hears about it on the motion bus, keeps a stand-in
   * row for it, and sends a bubble from where the words sit (`origin`) to that
   * row, so the words leaving and the row arriving are one object moving. Here
   * is the composer's half: the words hide behind the bubble and the box closes
   * up around the empty line, the capsule gives one small press, and the send
   * control releases once.
   *
   * It runs on the SAME frame as the keystroke, before any await: §5.3's
   * "motion never delays input" is the reason this is not inside the send. The
   * draft is never touched, so a failed send restores it by doing nothing.
   *
   * Under reduced motion there is nothing to fly: §5.1's reduced form is "the
   * text clears, the row appears" — so `origin` is null, the draft simply stays
   * put until the server answers and clears it, and no bubble is ever made.
   */
  const beginSay = (text: string): string => {
    const textarea = textareaRef.current;
    const nonce = `${channelId}:${Date.now()}:${(sayCount.current += 1)}`;
    const origin = !reduceMotion && composerShellRef.current ? readSendOrigin(textarea) : null;
    emitMotion('say:sent', { channelId, nonce, text, replyToId: replyingTo?.id ?? null, origin });
    if (origin && textarea) {
      // The real words hide behind the bubble. Visibility only: the draft is
      // never touched. The box closes up around the empty line, in the same
      // frame the timeline makes room, so the two glide as one.
      textarea.style.opacity = '0';
      textarea.style.height = 'auto';
      pressComposer(composerShellRef.current);
      releaseSend(sendButtonRef.current);
      if (wordsTimer.current) window.clearTimeout(wordsTimer.current);
      // A send that neither resolves nor rejects must not leave the draft
      // invisible; the words come back on their own.
      wordsTimer.current = window.setTimeout(() => { bringWordsBack(); }, 4000);
    }
    return nonce;
  };

  const handleSubmit = async () => {
    if (sendingRef.current || uploading || creatingPoll || schedulingMessage) return;
    // Only a plain text send has this gesture, and only when it is certainly
    // going out: a poll, a schedule, an attachment, a slash command, an empty
    // or over-long draft or a conversation that will refuse it all take the
    // ordinary path with no motion at all.
    const saying = content.trim();
    const say = (
      !showPollComposer
      && !showScheduleComposer
      && composerAction.allowed
      && canSendMessages
      && stagedFiles.length === 0
      && saying.length > 0
      && content.length <= MAX_MESSAGE_LENGTH
      && !/^\/\w/.test(saying)
    ) ? beginSay(saying) : null;
    const answer = { accepted: false };
    try {
      await submitComposer(answer);
    } finally {
      // However the send ended — accepted, refused, or cut short by a check —
      // the timeline is told, so a bubble in flight is never left hanging.
      if (say) {
        if (!answer.accepted) endSay();
        else {
          const now = Date.now();
          for (const [nonce, entry] of unanswered.current) if (now - entry.at > 10_000) unanswered.current.delete(nonce);
          unanswered.current.set(say, { text: saying, at: now });
          watchUnanswered();
        }
        emitMotion('say:settled', { channelId, nonce: say, ok: answer.accepted });
      }
    }
  };

  /** Everything a send does after the gesture has begun. `answer.accepted` says the outbox took it. */
  const submitComposer = async (answer: { accepted: boolean }) => {
    let submittedDraft: Awaited<ReturnType<typeof captureDraft>>;
    sendingRef.current = true;
    try { submittedDraft = await captureDraft(); }
    catch (error) { endSay(); setSubmitError(messageInputError(error, 'Save this draft before sending.')); return; }
    finally { sendingRef.current = false; }
    // The blocker banner above the composer is already saying this, word for
    // word, and stacking a red copy of a gray sentence tells the reader nothing
    // they cannot see. The banner carries the way out ("Check again", "Set up
    // encryption"), so it stays and the echo does not.
    if (!composerAction.allowed) { setSubmitError(blockerSettled ? null : composerAction.reason); return; }

    if (showPollComposer) {
      const question = pollQuestion.trim();
      const options = pollOptions.map((opt) => opt.trim()).filter(Boolean);

      if (!question || question.length > 300) {
        setSubmitError('Poll question must be between 1 and 300 characters.');
        return;
      }
      if (options.length < 2 || options.length > 10) {
        setSubmitError('Polls require between 2 and 10 options.');
        return;
      }
      if (options.some((opt) => opt.length > 100)) {
        setSubmitError('Poll options must be 100 characters or less.');
        return;
      }

      try {
        setSubmitError(null);
        setCreatingPoll(true);
        const context = captureScopedOperation(scope);
        let response;
        try { response = await context.request<Message>({ method: 'POST', url: `/channels/${encodeURIComponent(channelId)}/polls`, data: {
          question,
          options: options.map((text) => ({ text })),
          allow_multiselect: pollAllowMultiselect,
          expires_in_minutes: pollDurationMinutes > 0 ? pollDurationMinutes : undefined,
        } }); } finally { context.dispose(); }
        const { data } = response;
        if (data.poll) {
          usePollStore.getState().upsertPoll(data.poll);
        }
        messageStore.getState().addMessage(channelId, data);
        if (mounted.current) onCancelReply?.();
        if (question === submittedDraft.content.trim()) await clearSubmitted(submittedDraft);
        resetPollComposer();
      } catch (err) {
        setSubmitError(messageInputError(err, 'Failed to create poll.'));
      } finally {
        setCreatingPoll(false);
      }
      return;
    }
    if (showScheduleComposer) {
      if (!submittedDraft.content.trim()) {
        setSubmitError('Enter a message to schedule.');
        return;
      }
      if (!scheduledAt) {
        setSubmitError('Select when this message should be sent.');
        return;
      }
      if (stagedFiles.length > 0) {
        setSubmitError('Scheduled messages currently do not support file attachments.');
        return;
      }
      const parsedSendAt = new Date(scheduledAt);
      if (Number.isNaN(parsedSendAt.getTime())) {
        setSubmitError('Select a valid scheduled time.');
        return;
      }
      if (parsedSendAt.getTime() < Date.now() + SCHEDULED_MESSAGE_MIN_LEAD_MS) {
        setSubmitError('Choose a time at least 5 seconds in the future.');
        return;
      }
      try {
        setSubmitError(null);
        setSchedulingMessage(true);
        const sendAtIso = parsedSendAt.toISOString();
        await messageStore.getState().scheduleMessage(
          channelId,
          submittedDraft.content.trim(),
          sendAtIso,
          replyingTo?.id,
        );
        toast.success('Message scheduled.');
        await clearSubmitted(submittedDraft);
        setScheduledAt('');
        setScheduledCount((prev) => prev + 1);
        setShowScheduleComposer(false);
        if (mounted.current) onCancelReply?.();
      } catch (err) {
        setSubmitError(messageInputError(err, 'Failed to schedule message.'));
      } finally {
        setSchedulingMessage(false);
      }
      return;
    }

    if (!canSendMessages) {
      setSubmitError("You don't have permission to send messages in this channel.");
      return;
    }
    if (stagedFiles.length > 0 && !canAttachFiles) {
      setSubmitError(actions.attach.reason);
      return;
    }

    if (!submittedDraft.content.trim() && stagedFiles.length === 0) return;
    if (submittedDraft.content.length > MAX_MESSAGE_LENGTH) {
      setSubmitError(`Message is too long (${submittedDraft.content.length}/${MAX_MESSAGE_LENGTH}).`);
      return;
    }

    // Lock before any await so rapid Enter cannot double-fire.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    const trimmed = submittedDraft.content.trim();
    try {
      const slashMatch = trimmed.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
      if (guildId && slashMatch && stagedFiles.length === 0) {
        const commandName = slashMatch[1];
        const argsText = (slashMatch[2] ?? '').trim();
        const command = await resolveGuildSlashCommand(guildId, commandName);
        if (command) {
          try {
            setSubmitError(null);
            const { data: interaction } = await interactionApi.invokeCommand({
              command_name: commandName,
              guild_id: guildId,
              channel_id: channelId,
              options: parseSlashCommandOptions(command, argsText),
            });
            useInteractionStore.getState().addPendingInteraction(interaction);
            await clearSubmitted(submittedDraft);
            if (mounted.current) onCancelReply?.();
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
          } catch (err) {
            setSubmitError(messageInputError(err, 'Failed to run command.'));
          }
          return;
        }
      }

      setSubmitError(null);
      // Encrypted attachment seam: in an encrypted conversation the files never
      // take the plaintext upload path. They are handed to the encrypted
      // producer, which encrypts each one on this device, stages the ciphertext
      // in the account vault and uploads only that.
      const attachmentIds: string[] = [];
      if (!encrypted) {
        for (const file of stagedFiles) {
          const uploaded = await upload(file);
          if (uploaded?.id) {
            attachmentIds.push(uploaded.id);
          }
        }
      }
      await messageStore.getState().sendMessage(
        channelId,
        trimmed,
        replyingTo?.id,
        attachmentIds,
        undefined,
        submittedDraft,
        encrypted && stagedFiles.length > 0
          ? { files: stagedFiles, maxCiphertextBytes: maxUploadSize }
          : undefined,
      );
      // The outbox has it: delivery is its business from here, and the words
      // are not coming back.
      answer.accepted = true;
      await clearSubmitted(submittedDraft);
      endSay();
      setStagedFiles(current => current.filter(file => !stagedFiles.includes(file)));
      if (mounted.current) onCancelReply?.();
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } catch (err) {
      // §5.1's failure path: the row never lands and the words come back.
      endSay();
      setSubmitError(messageInputError(err, 'Failed to send message.'));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // Leaving the conversation ends the gesture with it.
  useEffect(() => () => {
    if (wordsTimer.current) window.clearTimeout(wordsTimer.current);
  }, []);

  // A send the outbox took and then could not deliver in good time (refused,
  // failing, or waiting long enough that the queue card above the composer shows
  // for it) is held by that card, which keeps the words. The bubble in flight
  // for it is let go then, so the card and the bubble never both claim it. A send
  // that is merely on its way keeps its bubble: the card has not shown for it.
  const queueNow = useRef(runtimeState.queue);
  useEffect(() => {
    queueNow.current = runtimeState.queue;
  }, [runtimeState.queue]);
  const watchTimer = useRef<number | null>(null);
  const watchUnanswered = useCallback(() => {
    if (watchTimer.current !== null) return;
    const check = () => {
      const now = Date.now();
      for (const [nonce, { text, at }] of [...unanswered.current]) {
        if (now - at > 10_000) { unanswered.current.delete(nonce); continue; }
        const row = queueNow.current.find((entry) => entry.record.channelId === channelId
          && (entry.record.draft?.content ?? '').trim() === text);
        if (!row) continue;
        const failing = row.record.status === 'failed' || Boolean(row.record.error) || Boolean(row.record.refused);
        if (!failing && isQuietlyInFlight(row, now)) continue;
        unanswered.current.delete(nonce);
        emitMotion('say:settled', { channelId, nonce, ok: false });
      }
      if (unanswered.current.size === 0 && watchTimer.current !== null) {
        window.clearInterval(watchTimer.current);
        watchTimer.current = null;
      }
    };
    watchTimer.current = window.setInterval(check, 200);
  }, [channelId]);
  useEffect(() => () => {
    if (watchTimer.current !== null) window.clearInterval(watchTimer.current);
    watchTimer.current = null;
  }, []);

  /** Detect @mention query and /slash command query from cursor position */
  const detectMentionQuery = useCallback((text: string, cursorPos: number) => {
    const before = text.slice(0, cursorPos);
    const match = before.match(/@(\w*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }

    // Detect slash command name entry: "/cmd" with no args yet
    const slashNameMatch = text.match(/^\/(\w*)$/);
    if (slashNameMatch) {
      setSlashQuery(slashNameMatch[1]);
      setSlashOptionMode(false);
      clearAutocompleteChoices();
      setAutocompleteLoading(false);
      return;
    }

    // Detect slash option entry: "/cmd args…" — may trigger autocomplete
    const slashArgsMatch = text.match(/^\/(\w+)\s([\s\S]*)$/);
    if (slashArgsMatch && guildId) {
      setSlashQuery(null);
      setSlashOptionMode(true);
      const commandName = slashArgsMatch[1];
      const argsText = slashArgsMatch[2] ?? '';
      const endsWithSpace = /\s$/.test(text);
      const trailingPartial = endsWithSpace ? '' : (parseSlashArgs(argsText).at(-1) ?? '');

      if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
      autocompleteTimerRef.current = setTimeout(() => {
        void (async () => {
          const command = await resolveGuildSlashCommand(guildId, commandName);
          if (!command || !commandHasAutocomplete(command)) {
            clearAutocompleteChoices();
            setAutocompleteLoading(false);
            setSlashOptionMode(false);
            return;
          }
          const options = buildAutocompleteOptions(
            command,
            argsText.trimEnd(),
            trailingPartial,
            endsWithSpace,
          );
          if (!options) {
            clearAutocompleteChoices();
            setAutocompleteLoading(false);
            return;
          }
          const requestId = ++autocompleteRequestIdRef.current;
          setAutocompleteLoading(true);
          try {
            const { data: interaction } = await interactionApi.invokeCommand({
              command_name: commandName,
              guild_id: guildId,
              channel_id: channelId,
              options,
              type: InteractionType.ApplicationCommandAutocomplete,
            });
            if (requestId !== autocompleteRequestIdRef.current) return;
            useInteractionStore.getState().addPendingInteraction(interaction);
          } catch {
            if (requestId !== autocompleteRequestIdRef.current) return;
            clearAutocompleteChoices();
          } finally {
            if (requestId === autocompleteRequestIdRef.current) {
              setAutocompleteLoading(false);
            }
          }
        })();
      }, 200);
      return;
    }

    setSlashQuery(null);
    setSlashOptionMode(false);
    clearAutocompleteChoices();
    setAutocompleteLoading(false);
  }, [guildId, channelId, clearAutocompleteChoices]);

  const insertAutocompleteChoice = useCallback(
    (choice: AutocompleteChoice) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const text = content;
      const slashArgsMatch = text.match(/^\/(\w+)\s([\s\S]*)$/);
      if (!slashArgsMatch) return;
      const commandName = slashArgsMatch[1];
      const argsText = slashArgsMatch[2] ?? '';
      const endsWithSpace = /\s$/.test(text);
      const parts = parseSlashArgs(argsText.trimEnd());
      const valueStr =
        typeof choice.value === 'string' && /\s/.test(choice.value)
          ? `"${choice.value}"`
          : String(choice.value);
      if (endsWithSpace || parts.length === 0) {
        parts.push(valueStr);
      } else {
        parts[parts.length - 1] = valueStr;
      }
      const newContent = `/${commandName} ${parts.join(' ')} `;
      setContent(newContent);
      setSlashOptionMode(false);
      clearAutocompleteChoices();
      requestAnimationFrame(() => {
        textarea.focus();
        const pos = newContent.length;
        textarea.setSelectionRange(pos, pos);
      });
    },
    [content, clearAutocompleteChoices, setContent],
  );

  const insertMention = useCallback((token: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = content.slice(0, textarea.selectionStart);
    const after = content.slice(textarea.selectionStart);
    const mentionStart = before.lastIndexOf('@');
    if (mentionStart === -1) return;
    const mentionText = token;
    const newContent = before.slice(0, mentionStart) + mentionText + ' ' + after;
    setContent(newContent);
    setMentionQuery(null);
    // Restore focus
    requestAnimationFrame(() => {
      const newPos = mentionStart + mentionText.length + 1;
      textarea.focus();
      textarea.setSelectionRange(newPos, newPos);
    });
  }, [content, setContent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Dismiss composer popovers first (including mention mode with zero matches).
    if (e.key === 'Escape') {
      if (mentionQuery !== null) {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
      if (slashQuery !== null || slashOptionMode) {
        e.preventDefault();
        setSlashQuery(null);
        setSlashOptionMode(false);
        clearAutocompleteChoices();
        return;
      }
      if (showEmojiPicker || showFormattingTools || showGifPicker || showStickerPicker) {
        e.preventDefault();
        setShowEmojiPicker(false);
        setShowFormattingTools(false);
        setShowGifPicker(false);
        setShowStickerPicker(false);
        return;
      }
    }

    // Handle mention autocomplete navigation
    if (mentionQuery !== null && mentionResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionResults.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionResults.length) % mentionResults.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const selected = mentionResults[mentionIndex];
        if (selected?.kind === 'member') insertMention(`<@${selected.member.user.id}>`);
        if (selected?.kind === 'role') insertMention(`<@&${selected.role.id}>`);
        return;
      }
    }

    const textarea = textareaRef.current;
    if (textarea) {
      const markdownShortcut = resolveMarkdownShortcut(e);
      if (markdownShortcut) {
        e.preventDefault();
        e.stopPropagation();
        applyMarkdownToolbarAction(markdownShortcut, textarea, setContent);
        triggerTyping();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (sendingRef.current || uploading || creatingPoll || schedulingMessage || sending) return;
      void handleSubmit();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (showPollComposer) {
      setSubmitError('Disable poll composer before adding attachments.');
      return;
    }
    if (!canAttachFiles) { setSubmitError(actions.attach.reason); return; }
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setStagedFiles(prev => [...prev, ...files]);
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles = items
      .filter((item) => item.kind === 'file' && isAllowedImageMimeType(item.type))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);

    if (imageFiles.length > 0) {
      if (!canAttachFiles) { e.preventDefault(); setSubmitError(actions.attach.reason); return; }
      if (showPollComposer) {
        setSubmitError('Disable poll composer before adding attachments.');
        return;
      }
      e.preventDefault();
      setStagedFiles((prev) => [...prev, ...imageFiles]);
    }
  }, [showPollComposer, canAttachFiles, actions.attach.reason]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canAttachFiles) { setSubmitError(actions.attach.reason); e.target.value = ''; return; }
    if (showPollComposer) {
      setSubmitError('Disable poll composer before adding attachments.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setStagedFiles(prev => [...prev, ...files]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (index: number) => {
    setStagedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const togglePollComposer = () => {
    if (!showPollComposer && !canCreatePoll) { setSubmitError(actions.poll.reason); return; }
    if (showPollComposer) {
      if (pollQuestion.trim()) setContent(pollQuestion);
      resetPollComposer();
      setSubmitError(null);
      return;
    }
    if (stagedFiles.length > 0) {
      setSubmitError('Remove file attachments before creating a poll.');
      return;
    }
    if (!pollQuestion.trim() && content.trim()) {
      setPollQuestion(content.trim().slice(0, 300));
    }
    setShowPollComposer(true);
    setSubmitError(null);
  };

  const updatePollOption = (index: number, value: string) => {
    setPollOptions((prev) => prev.map((option, optionIndex) => (
      optionIndex === index ? value : option
    )));
  };

  const removePollOption = (index: number) => {
    setPollOptions((prev) => {
      if (prev.length <= 2) return prev;
      return prev.filter((_, optionIndex) => optionIndex !== index);
    });
  };

  const addPollOption = () => {
    setPollOptions((prev) => {
      if (prev.length >= 10) return prev;
      return [...prev, ''];
    });
  };

  const attachFiles = () => {
    if (!canAttachFiles) {
      setSubmitError(actions.attach.reason);
      return;
    }
    if (showPollComposer) {
      setSubmitError('Disable poll composer before adding attachments.');
      return;
    }
    fileInputRef.current?.click();
  };
  useLayoutEffect(() => {
    if (!toolsPosition) { toolsPlacedRef.current = false; return; }
    const anchor = toolsAnchorRef.current;
    if (toolsPlacedRef.current || !anchor) return;
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Message tools"]');
    if (!menu) return;
    toolsPlacedRef.current = true;
    setToolsPosition({ x: anchor.left, y: Math.max(8, anchor.top - menu.offsetHeight - 8) });
  }, [toolsPosition]);

  // Everything the capsule does not carry stays one click from "+": attach
  // first (the reason for the button), then the composers and pickers. Emoji
  // only appears here when the capsule has no room for its own button.
  const composerTools: ContextMenuItem[] = [
    { label: 'Attach files', icon: <Plus size={18} />, action: attachFiles, disabled: showPollComposer || !canAttachFiles || !canSendMessages, description: actions.attach.reason ?? undefined },
    { label: 'Formatting tools', icon: <Type size={18} />, action: () => { setShowFormattingTools(true); requestAnimationFrame(() => textareaRef.current?.focus()); }, selected: showFormattingTools || undefined },
    { label: 'Create a poll', icon: <BarChart3 size={18} />, action: togglePollComposer, disabled: !canCreatePoll, description: actions.poll.reason ?? undefined },
    { label: 'Schedule message', icon: <Clock3 size={18} />, action: () => setShowScheduleComposer((value) => !value), disabled: showPollComposer || !actions.schedule.allowed, description: actions.schedule.reason ?? undefined },
    ...(guildId ? [{ label: 'Stickers', icon: <Image size={18} />, action: () => { setShowStickerPicker(true); setShowGifPicker(false); setShowEmojiPicker(false); }, disabled: showPollComposer || !canSendMessages, description: actions.send.reason ?? undefined }] : []),
    { label: 'GIFs', icon: <Image size={18} />, action: () => { setShowGifPicker(true); setShowEmojiPicker(false); setShowStickerPicker(false); }, disabled: showPollComposer || !canSendMessages, description: actions.send.reason ?? undefined },
    ...(ribbon || narrow || compact
      ? [{ label: 'Emoji', icon: <Smile size={18} />, action: () => { setShowEmojiPicker(true); setShowGifPicker(false); setShowStickerPicker(false); }, disabled: showPollComposer }]
      : []),
  ];

  const [blockerSettled, setBlockerSettled] = useState(false);
  useEffect(() => {
    if (composerAction.allowed) { setBlockerSettled(false); return; }
    const timer = window.setTimeout(() => setBlockerSettled(true), 400);
    return () => window.clearTimeout(timer);
  }, [composerAction.allowed, composerAction.reason]);

  const busy = uploading || creatingPoll || schedulingMessage || sending;
  // A spinner is for a wait a person can feel. A plain send is over in a frame
  // or two — the send control's own beat (§5.1) is the feedback, and a spinner
  // that appears and vanishes inside 200ms reads as a glitch. Uploads, polls
  // and scheduling really do wait, so those keep it.
  const showsSpinner = uploading || creatingPoll || schedulingMessage;
  const sendDisabled =
    busy ||
    !composerAction.allowed ||
    (showScheduleComposer
      ? !content.trim() || !scheduledAt
      : !showPollComposer && !content.trim() && stagedFiles.length === 0);
  const nearLimit = content.length > MAX_MESSAGE_LENGTH * 0.9;
  const overLimit = content.length > MAX_MESSAGE_LENGTH;
  // The tools the capsule has no room for live in the "+" menu: on a phone, in
  // the Stage's ribbon, in a thread panel, and in any capsule narrower than
  // COMPACT_CAPSULE_MAX (the 420px side chat included).
  const foldTools = ribbon || narrow || compact;
  const fullLabel = replyingTo
    ? `Reply to ${replyingTo.author}`
    : composerPlaceholder(channelName, conversationKind);
  const placeholder = showPollComposer
    ? 'The question above is what gets sent'
    : showScheduleComposer
      ? `Schedule a message for ${channelName ?? 'this conversation'}`
      : ribbon || narrow
        ? // The ribbon and the thread panel are narrower than a sentence, and the
          // room they belong to is named in the heading directly above them.
          'Say something'
        : replyingTo
          ? replyPlaceholder(replyingTo.author, foldTools)
          : composerPlaceholder(channelName, conversationKind, phoneWidth);
  const sendLabel = showScheduleComposer
    ? (schedulingMessage ? 'Scheduling message' : 'Schedule message')
    : 'Send message';

  return (
    <div
      className={cn('glass-composer', ribbon && 'glass-composer--ribbon', narrow && 'glass-composer--narrow')}
      data-compact={foldTools ? 'true' : undefined}
      data-drag-over={isDragOver ? 'true' : undefined}
      onDragOver={(e) => {
        if (!canAttachFiles || !canSendMessages) return;
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={canAttachFiles && canSendMessages ? handleDrop : undefined}
    >
      <div className="glass-composer__stack">
        {showCommandThinking && (
          <div role="status" aria-live="polite" className="glass-composer__note">
            <Loader2 size={14} className="shrink-0 animate-spin" />
            <span>Waiting for command response…</span>
          </div>
        )}
        {!composerAction.allowed && blockerSettled && (
          <div role="status" className="glass-composer__note">
            <span>
              {composerAction.reason}
              {!groupDmRefusal && encrypted && encryption === 'setup' && <Link className="ml-2 underline" to={`/setup?${new URLSearchParams({ migrate: '1', server: scope.serverId, user: scope.userId, returnTo: window.location.pathname + window.location.search })}`}>Set up encryption</Link>}
              {!groupDmRefusal && encrypted && encryption === 'unlock' && <Link className="ml-2 underline" to={`/unlock?${new URLSearchParams({ returnTo: window.location.pathname + window.location.search })}`}>Unlock encryption</Link>}
              {/* A second device — a fresh browser, a new laptop — signs in and
                  lands here holding no identity, or a different one. Without this
                  it was the one encryption blocker with no route out: nothing but
                  "Check again". Setup is not the answer either — it refuses when
                  the account already has an identity, and tells the user to restore
                  the recovery phrase — so link straight at the page that does it. */}
              {!groupDmRefusal && encrypted && encryption === 'identity_mismatch' && <Link className="ml-2 underline" to="/recover">Restore your identity</Link>}
              {/* A blocker can be resolved by someone else (a recipient finishing
                  encryption setup, a restored permission), so the check is always
                  repeatable from here instead of only after a request failure. */}
              {/* A group waiting on somebody's enrollment is not a server answer to
                  re-ask: the capability call already said the group is encrypted,
                  and the missing key is the other person's to publish. */}
              {!groupDmRefusal && <button type="button" className="ml-2 underline" onClick={refreshActions}>{capabilityError ? 'Retry' : 'Check again'}</button>}
            </span>
          </div>
        )}
        {isAnonymousChannel && (
          <div className="glass-composer__note">
            <EyeOff size={14} className="shrink-0" />
            <span>Messages in this channel are posted anonymously</span>
          </div>
        )}

        {stagedFiles.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {stagedFiles.map((file, i) => {
                const overLimit = file.size > maxUploadSize;
                return (
                  <div
                    key={i}
                    className={cn('glass-composer__file', overLimit && 'glass-composer__file--over')}
                    style={{ maxWidth: 'min(220px, 60vw)' }}
                  >
                    {canPreviewImageFile(file) ? (
                      <img
                        src={stagedImagePreviews[i] || ''}
                        alt={file.name}
                        className="h-10 w-10 rounded-[var(--radius-chip)] object-cover"
                      />
                    ) : (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-bg-well text-text-muted">
                        <FileText size={18} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-label text-text-primary">{file.name}</div>
                      <div className={`text-meta tabular-nums ${overLimit ? 'text-accent-danger' : 'text-text-muted'}`}>
                        {formatFileSize(file.size)}
                        {overLimit ? ' · exceeds limit' : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="glass-composer__icon glass-focusable"
                      aria-label={`Remove ${file.name}`}
                      title={`Remove ${file.name}`}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="px-0.5 text-meta text-text-faint">
              Max file size <span className="pc-mono">{formatFileSize(maxUploadSize)}</span>
            </div>
          </div>
        )}

        {showPollComposer && (
          <div className="glass-composer__card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-section text-text-secondary">
                <BarChart3 size={14} className="text-accent-primary" />
                Poll
              </span>
              <Button variant="ghost" size="sm" onClick={togglePollComposer}>
                Close
              </Button>
            </div>

            <label className="block">
              <span className="text-label text-text-secondary">Question</span>
              <Input
                type="text"
                maxLength={300}
                value={pollQuestion}
                onChange={(e) => setPollQuestion(e.target.value)}
                className="mt-1.5"
                placeholder="What should everyone weigh in on?"
              />
            </label>

            <div className="mt-3 flex flex-col gap-2">
              {pollOptions.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={option}
                    maxLength={100}
                    onChange={(e) => updatePollOption(index, e.target.value)}
                    placeholder={`Option ${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removePollOption(index)}
                    disabled={pollOptions.length <= 2}
                    className="glass-composer__icon glass-focusable"
                    aria-label={`Remove option ${index + 1}`}
                  >
                    <MinusCircle size={16} aria-hidden />
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={addPollOption}
                disabled={pollOptions.length >= 10}
              >
                <PlusCircle size={14} className="mr-1.5" />
                Add option
              </Button>
              <label className="inline-flex items-center gap-2 text-label text-text-secondary">
                <input
                  type="checkbox"
                  checked={pollAllowMultiselect}
                  onChange={(e) => setPollAllowMultiselect(e.target.checked)}
                  className="h-4 w-4 rounded-window accent-[color:var(--accent-primary)]"
                />
                Allow multiple answers
              </label>
              <label className="inline-flex items-center gap-2 text-label text-text-secondary">
                <span>Duration</span>
                <span className="inline-block w-40">
                  <Select
                    value={pollDurationMinutes}
                    onChange={(e) => setPollDurationMinutes(Number(e.target.value))}
                  >
                    {POLL_DURATION_OPTIONS.map((option) => (
                      <option key={option.minutes} value={option.minutes}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </span>
              </label>
            </div>
          </div>
        )}

        {showScheduleComposer && (
          <div className="glass-composer__card">
            <label className="block">
              <span className="text-section text-text-secondary">Send at</span>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="mt-1.5"
                min={toDatetimeLocalValue(Date.now() + SCHEDULED_MESSAGE_MIN_LEAD_MS)}
              />
            </label>
            <div className="mt-2 flex items-center justify-between gap-2">
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => setShowScheduledPanel(true)}
              >
                {scheduledCount > 0 ? `View scheduled (${scheduledCount})` : 'View scheduled'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowScheduleComposer(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {showScheduledPanel && (
          <ScheduledMessagesPanel
            channelId={channelId}
            channelName={channelName}
            onClose={() => setShowScheduledPanel(false)}
            onCountChange={setScheduledCount}
          />
        )}

        <MessagingRecoveryNotice runtime={messagingRuntime} encryptedConversation={!guildId} channelId={channelId} />
        <MessagingQueuePanel runtime={messagingRuntime} channelId={channelId} />
        {draftError && (
          <div role="alert" className="flex items-center justify-between gap-2 text-meta text-accent-danger">
            <span>{draftError}</span>
            <Button variant="ghost" onClick={() => void retrySave().catch(() => {})}>Retry saving draft</Button>
          </div>
        )}
        {/* The blocker row above already carries the reason a send was refused —
            for a blocked sender, word for word. Printing it again underneath said
            the same sentence twice, stacked, which reads as two problems. */}
        {submitError && submitError !== composerAction.reason && (
          <div className="glass-composer__note glass-composer__note--error" role="alert">
            {submitError}
          </div>
        )}
      </div>

      <div
        ref={composerShellRef}
        className="glass-composer__capsule"
      >
        {nearLimit && (
          <span className="glass-composer__count" data-over={overLimit ? 'true' : undefined}>
            <span className="pc-mono">{content.length}/{MAX_MESSAGE_LENGTH}</span>
          </span>
        )}

        {/* Upload progress — indeterminate sweep while attachments upload. */}
        {uploading && (
          reduceMotion ? (
            <span className="glass-composer__progress" />
          ) : (
            <span className="glass-composer__progress">
              <span className="pc-sweep block h-full w-1/3 rounded-full bg-accent-primary" />
            </span>
          )
        )}

        {showFormattingTools && (
          <div className="pc-pop-in pc-floating absolute bottom-full left-2 right-2 z-10 mb-2 p-1 [--pc-origin:50%_100%]">
            <MarkdownToolbar textareaRef={textareaRef} onContentChange={setContent} />
          </div>
        )}

        {/* Slash command popup */}
        {guildId && (
          <SlashCommandPopup
            query={slashQuery ?? ''}
            guildId={guildId}
            visible={slashQuery !== null || slashOptionMode}
            autocompleteChoices={slashOptionMode ? autocompleteChoices : undefined}
            autocompleteLoading={autocompleteLoading}
            onSelectCommand={(cmd: ApplicationCommand) => {
              setContent(`/${cmd.name} `);
              setSlashQuery(null);
              setSlashOptionMode(false);
              clearAutocompleteChoices();
              requestAnimationFrame(() => {
                textareaRef.current?.focus();
                const next = `/${cmd.name} `;
                detectMentionQuery(next, next.length);
              });
            }}
            onSelectChoice={insertAutocompleteChoice}
            onDismiss={() => {
              setSlashQuery(null);
              setSlashOptionMode(false);
              clearAutocompleteChoices();
            }}
          />
        )}

        {/* @mention autocomplete */}
        {mentionQuery !== null && (mentionResults.length > 0 || composerRolesError) && (
          <div className="pc-pop-in pc-floating absolute bottom-full left-2 right-2 z-20 mb-2 max-h-64 overflow-y-auto p-1 [--pc-origin:50%_100%]">
            {composerRolesError && (
              <p className="px-2 py-1 text-meta text-accent-danger">{composerRolesError}</p>
            )}
            {mentionResults.map((option, i) => (
              <Fragment key={`${option.kind}-${option.id}`}>
              {option.kind === 'role' && mentionResults[i - 1]?.kind !== 'role' && (
                <p className="px-2 pb-1 pt-2 text-section text-text-faint" aria-hidden>Roles</p>
              )}
              <button
                type="button"
                className={cn(
                  'pc-focusable flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left',
                  'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                  i === mentionIndex
                    ? 'bg-bg-mod-strong text-text-primary'
                    : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(option.kind === 'member' ? `<@${option.member.user.id}>` : `<@&${option.role.id}>`);
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                {option.kind === 'member' ? (
                  <>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong text-meta font-semibold text-text-secondary">
                      {displayName(option.member.user, option.member.nick).charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-label text-text-primary">{displayName(option.member.user, option.member.nick)}</span>
                      {displayName(option.member.user, option.member.nick) !== option.member.user.username && (
                        <span className="ml-1.5 text-meta text-text-muted">@{option.member.user.username}</span>
                      )}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center" aria-hidden>
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: option.role.color === 0 ? 'var(--text-muted)' : roleColorToHex(option.role.color) }}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-label text-text-primary">@{option.role.name}</span>
                    <span className="shrink-0 text-meta text-text-muted">
                      {option.count < 0 ? 'Loading…' : `${option.count} ${option.count === 1 ? 'member' : 'members'}`}
                    </span>
                  </>
                )}
              </button>
              </Fragment>
            ))}
          </div>
        )}

        {/* "+" — attach, and everything the capsule has no room for. */}
        <button
          ref={toolsButtonRef}
          type="button"
          className="glass-composer__btn glass-focusable"
          aria-label="More message tools"
          aria-haspopup="menu"
          aria-expanded={toolsPosition !== null}
          onClick={(event) => {
            if (toolsPosition) { setToolsPosition(null); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            // The menu stands on the capsule's top edge, not on the button.
            const capsuleTop = composerShellRef.current?.getBoundingClientRect().top ?? rect.top;
            toolsAnchorRef.current = { left: rect.left, top: capsuleTop };
            toolsPlacedRef.current = false;
            setToolsPosition({ x: rect.left, y: rect.top });
          }}
        >
          <Plus size={19} strokeWidth={1.7} aria-hidden />
        </button>
        <ContextMenu
          label="Message tools"
          open={toolsPosition != null}
          position={toolsPosition ?? undefined}
          items={composerTools}
          onClose={() => {
            setToolsPosition(null);
            toolsButtonRef.current?.focus();
          }}
        />

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {replyingTo && (
          <span
            role="group"
            aria-label={`Replying to ${replyingTo.author}`}
            title={replyingTo.content ? `${replyingTo.author}: ${replyingTo.content}` : undefined}
            className="glass-composer__reply"
          >
            <CornerUpLeft size={14} strokeWidth={1.7} aria-hidden />
            <span className="glass-composer__reply-name">{replyingTo.author}</span>
            <button
              type="button"
              onClick={onCancelReply}
              className="glass-composer__reply-x glass-focusable"
              aria-label="Cancel reply"
              title="Cancel reply"
            >
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          </span>
        )}

        <textarea
          ref={textareaRef}
          value={showPollComposer ? '' : content}
          onChange={(e) => {
            setContent(e.target.value);
            detectMentionQuery(e.target.value, e.target.selectionStart);
            triggerTyping();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          aria-label={fullLabel}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={showPollComposer}
          data-composer-input=""
          // A placeholder with a long channel name can be wider than a phone's
          // composer. Clipping the PLACEHOLDER to one line keeps the capsule at
          // its 52px; a real draft still wraps and grows, which is what a draft
          // should do.
          className="glass-composer__input"
          style={{ maxHeight: '50vh' }}
        />

        {/* The layers of the pickers grow out of the capsule's right end. */}
        {stickerLayer.value && guildId && (
          <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={PICKER_LAYER_STYLE}>
            <Suspense fallback={null}>
              <StickerPicker
                leaving={stickerLayer.leaving}
                guildId={guildId}
                onSelect={(stickerId) => {
                  if (!actions.send.allowed) { setSubmitError(actions.send.reason); return; }
                  setShowStickerPicker(false);
                  void (async () => {
                    try {
                      await messageStore.getState().sendMessage(channelId, '', replyingTo?.id, undefined, [stickerId]);
                      if (mounted.current) onCancelReply?.();
                    } catch (err) {
                      setSubmitError(`Failed to send sticker: ${messageInputError(err, 'Request failed')}`);
                    }
                  })();
                }}
                onClose={() => setShowStickerPicker(false)}
              />
            </Suspense>
          </div>
        )}
        {gifLayer.value && (
          <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={PICKER_LAYER_STYLE}>
            <Suspense fallback={null}>
              <GifPicker
                leaving={gifLayer.leaving}
                onSelect={(gifUrl) => {
                  if (!actions.send.allowed) { setSubmitError(actions.send.reason); return; }
                  setShowGifPicker(false);
                  void (async () => {
                    try {
                      await messageStore.getState().sendMessage(channelId, gifUrl, replyingTo?.id);
                      if (mounted.current) onCancelReply?.();
                    } catch (err) {
                      setSubmitError(`Failed to send GIF: ${messageInputError(err, 'Request failed')}`);
                    }
                  })();
                }}
                onClose={() => setShowGifPicker(false)}
              />
            </Suspense>
          </div>
        )}
        {emojiLayer.value && (
          <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={PICKER_LAYER_STYLE}>
            <Suspense fallback={null}>
              <EmojiPicker
                leaving={emojiLayer.leaving}
                onSelect={(emoji) => {
                  setContent((prev) => `${prev}${emoji}`);
                  triggerTyping();
                  setShowEmojiPicker(false);
                }}
                onClose={() => setShowEmojiPicker(false)}
                guildId={guildId}
              />
            </Suspense>
          </div>
        )}

        {!foldTools && (
          <button
            type="button"
            data-composer-picker-toggle="emoji"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowGifPicker(false); setShowStickerPicker(false); }}
            disabled={showPollComposer}
            className="glass-composer__btn glass-focusable"
            aria-label="Emoji"
            title="Emoji"
          >
            <Smile size={19} strokeWidth={1.7} aria-hidden />
          </button>
        )}

        <button
          ref={sendButtonRef}
          type="button"
          onClick={() => void handleSubmit()}
          disabled={sendDisabled}
          // Quiet until there is something to send, then cream: the one primary
          // action on the screen (§1.4). It does not scale on press (§9).
          className="glass-composer__send glass-focusable"
          aria-label={sendLabel}
          title={sendLabel}
        >
          {showsSpinner ? (
            <Loader2 size={17} className="animate-spin" aria-hidden />
          ) : showScheduleComposer ? (
            <Clock3 size={17} aria-hidden />
          ) : (
            <ArrowUp size={17} strokeWidth={2.3} aria-hidden />
          )}
        </button>
      </div>

      {isDragOver && (
        <div className="glass-composer__drop">
          <div className="inline-flex items-center gap-2 text-heading text-text-primary">
            <Plus size={20} aria-hidden />
            Drop files to attach
          </div>
        </div>
      )}
    </div>
  );
}
