import { Link } from 'react-router';
import { useStore } from 'zustand';
import { useChannelStore } from '../../stores/channelStore';
import { useServerConnectionStore } from '../../stores/serverConnectionStore';
import { getAccountChannelView } from '../../lib/channelView';
import { composerNoticeSuppressed, isGroupDm, pendingGroupMembers, runtimeAttachDecision, runtimeSendDecision } from '../../lib/messages/messagingReadiness';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { entityScopeKey as memberScopeKey, type AccountScope } from '../../lib/serverScope';
import { Fragment, useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, type CSSProperties, type ReactNode } from 'react';

// §5.3: one reduced-motion switch for the whole app — lib/motion is the only
// JavaScript motion engine; the composer's enter/exit surfaces are CSS.
import { emitMotion, fadeIn, ms, pressComposer, readSendOrigin, releaseSend, useLingering, useReducedMotion } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { Input, Select } from '../ui/Input';
import { IxMenu, type IxMenuEntry } from '../ix/menus';
import { GlyphFrame, IxGlyph, type IxGlyphName } from '../ix/glyphs';
import { Avatar } from '../ix/identity';
import { useGuildStore } from '../../stores/guildStore';
import { PEOPLE_HUE, serverHue } from '../../lib/identityHue';
import { emojiApi } from '../../api/emojis';
import { buildGuildEmojiImageUrl, formatCustomEmojiToken } from '../../lib/customEmoji';
import { EventFormModal } from '../guild/EventList';
import { ComposerPickerHost, type ComposerPickerTab } from './ComposerPickerHost';
import { useComposerShape } from './composerShape';
import { registerComposerFiles } from './composerFiles';
import {
  applyCompletion,
  completionAt,
  isLinkableChannel,
  matchShortcodes,
  slowModeLabel,
  type CompletionQuery,
} from './composerCompletion';
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
import { ChannelType, Permissions, hasPermission } from '../../types';
import { usePermissions } from '../../hooks/usePermissions';
import { fetchGuildRoles } from '../../lib/permissionDataCache';
import { roleColorToHex } from '../../lib/colors';
import { isAllowedImageMimeType } from '../../lib/security';
import { formatFileSize, toDatetimeLocalValue } from '../../lib/formatters';
import { toast } from '../../stores/toastStore';
import { extractApiError } from '../../api/client';
import { displayName } from '../../lib/displayName';
import { CordSpinner } from '../brand/CordMark';

/**
 * The server's refusal for an action this person lacks the permission for
 * (`routes/channels/capabilities.rs`). A channel that answers it for sending
 * is read-only to them, and says so in plain words (§4.12).
 */
const PERMISSION_REFUSAL = 'You do not have permission to use this action in this channel.';

/** How long a press on Send has to be held for its menu (touch: "Send later"). */
const LONG_PRESS_MS = 500;

/** Server emoji for `:` completion, fetched once per server per session. */
const serverEmojiCache = new Map<string, Promise<Array<{ id: string; name: string; animated?: boolean }>>>();
function loadServerEmoji(guildId: string) {
  let pending = serverEmojiCache.get(guildId);
  if (!pending) {
    pending = emojiApi.listGuild(guildId).then(({ data }) => data.map((emoji) => ({ id: emoji.id, name: emoji.name, animated: emoji.animated })));
    // A failure is said in the list, and asked again next time.
    pending.catch(() => serverEmojiCache.delete(guildId));
    serverEmojiCache.set(guildId, pending);
  }
  return pending;
}

/** The emoji glyph (a face) and the Format glyph ("A" over a line), drawn like the set. */
function EmojiGlyph({ size = 18 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0" />
      <path d="M9.2 9.6h.01M14.8 9.6h.01" strokeWidth={2.4} />
    </GlyphFrame>
  );
}
function FormatGlyph({ size = 14 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <path d="m5 17 5.5-12h1L17 17M7.3 12.5h7.4M4 21h16" />
    </GlyphFrame>
  );
}
function ClockGlyph({ size = 18 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </GlyphFrame>
  );
}

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
  // The send control's menu (right-click or a long press): Send later, Scheduled.
  const [sendMenu, setSendMenu] = useState(false);
  const longPress = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  // The box's measured width says whether the tool chips keep their words.
  const [compact, setCompact] = useState(false);
  // The one picker (§6.11): which tab, or closed. It leaves the way it came.
  const [picker, setPicker] = useState<ComposerPickerTab | null>(null);
  const pickerLayer = useLingering(picker);
  // Format swaps the tools row for the formatting bar (§4.12).
  const [showFormattingTools, setShowFormattingTools] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);
  // Focus anywhere in the box (the text, a chip, the picker) keeps it open.
  const [focused, setFocused] = useState(false);
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
  // The box (the capsule): what the send flight presses (`pressComposer`).
  const composerShellRef = useRef<HTMLDivElement>(null);
  // The three slices and what rides on them (composerShape.ts, §5.12).
  const capTopRef = useRef<HTMLSpanElement>(null);
  const capMidRef = useRef<HTMLSpanElement>(null);
  const fillTopRef = useRef<HTMLSpanElement>(null);
  const fillMidRef = useRef<HTMLSpanElement>(null);
  // Stable lists: the shape hook's effect depends on them.
  const shapeTops = useMemo(() => [capTopRef, fillTopRef], []);
  const shapeMids = useMemo(() => [capMidRef, fillMidRef], []);
  const headRef = useRef<HTMLDivElement>(null);
  const toolsMoveRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  // True for the frame a send closes the box up around the empty line: that
  // change is part of the send flight and snaps (M1: no other motion at send).
  const holdShapeRef = useRef(false);
  const sendingRef = useRef(false);
  const scheduleAtRef = useRef<HTMLInputElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
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
  const { actions: serverActions, encrypted, encryption, error: capabilityError, refresh: refreshActions, loading: actionsLoading } = useConversationActions(channelId);
  const runtimeState = useStore(messagingRuntime.store);
  const identityHeld = useServerConnectionStore((s) => s.servers[scope.serverId]?.phase === 'identity-changed');
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

  // Completion (§4.12): @ people and roles, # channels, : emoji. The list is a
  // popover above the box; Up/Down move, Enter or Tab picks, Escape closes.
  const memberScope = useCurrentAccountScope();
  const guildMembers = useMemberStore((s) => (guildId ? (memberScope ? s.members.get(memberScopeKey(memberScope, guildId)) : undefined) : undefined));
  const [completion, setCompletion] = useState<CompletionQuery | null>(null);
  const [completionIndex, setCompletionIndex] = useState(0);
  const { permissions: guildPerms, isAdmin: guildAdmin } = usePermissions(guildId ?? null);
  const canMentionRoles = hasPermission(guildPerms, Permissions.MENTION_EVERYONE);
  // Events are created by whoever manages the server (the Events page's rule).
  const canCreateEvents = Boolean(guildId) && (guildAdmin || hasPermission(guildPerms, Permissions.MANAGE_GUILD));
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

  const mentioning = completion?.kind === 'mention';
  useEffect(() => {
    if (!mentioning || !guildId || !memberScope || guildMembers) return;
    void useMemberStore.getState().fetchMembers(guildId, memberScope);
  }, [mentioning, guildId, memberScope, guildMembers]);

  // The server's own emoji, for `:`. Loaded the first time someone types one.
  const emojiQuerying = completion?.kind === 'emoji';
  const [serverEmoji, setServerEmoji] = useState<{ guildId: string; list: Array<{ id: string; name: string; animated?: boolean }> } | null>(null);
  const [serverEmojiError, setServerEmojiError] = useState<string | null>(null);
  useEffect(() => {
    if (!emojiQuerying || !guildId || serverEmoji?.guildId === guildId) return;
    let canceled = false;
    loadServerEmoji(guildId)
      .then((list) => {
        if (canceled) return;
        setServerEmoji({ guildId, list });
        setServerEmojiError(null);
      })
      .catch((err) => {
        if (!canceled) setServerEmojiError(`Server emoji did not load: ${extractApiError(err)}`);
      });
    return () => {
      canceled = true;
    };
  }, [emojiQuerying, guildId, serverEmoji?.guildId]);

  const guildChannels = useChannelStore((state) => (guildId ? getAccountChannelView(scope, state).channelsByGuild?.[guildId] : undefined));

  type CompletionOption =
    | { kind: 'member'; id: string; member: NonNullable<typeof guildMembers>[number] }
    | { kind: 'role'; id: string; role: Role; count: number }
    | { kind: 'channel'; id: string; name: string }
    | { kind: 'emoji'; id: string; name: string; emoji: string }
    | { kind: 'custom-emoji'; id: string; name: string; animated: boolean };

  const completionResults = useMemo(() => {
    if (!completion) return [] as CompletionOption[];
    const q = completion.query.toLowerCase();
    if (completion.kind === 'mention') {
      if (!guildId) return [] as CompletionOption[];
      const people: CompletionOption[] = (guildMembers || [])
        .filter((m) => {
          const visibleName = displayName(m.user, m.nick).toLowerCase();
          return visibleName.includes(q) || m.user.username.toLowerCase().includes(q);
        })
        .slice(0, 8)
        .map((member) => ({ kind: 'member' as const, id: member.user.id, member }));
      const roles: CompletionOption[] = composerRoles
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
    }
    if (completion.kind === 'channel') {
      return (guildChannels ?? [])
        .filter((entry) => isLinkableChannel(entry) && (entry.name ?? '').toLowerCase().includes(q))
        .slice(0, 12)
        .map((entry) => ({ kind: 'channel' as const, id: entry.id, name: entry.name ?? '' }));
    }
    const own: CompletionOption[] = (serverEmoji && serverEmoji.guildId === guildId ? serverEmoji.list : [])
      .filter((emoji) => emoji.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((emoji) => ({ kind: 'custom-emoji' as const, id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) }));
    const common: CompletionOption[] = matchShortcodes(q).map((entry) => ({ kind: 'emoji' as const, id: entry.name, name: entry.name, emoji: entry.emoji }));
    return [...own, ...common];
  }, [completion, guildId, guildMembers, composerRoles, canMentionRoles, guildChannels, serverEmoji]);

  const resizeDraft = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.max(52, viewportHeight * 0.45))}px`;
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
      // frame the timeline makes room, so the two glide as one. That change of
      // height is the flight's, not the box's own: it snaps (holdShapeRef).
      holdShapeRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { holdShapeRef.current = false; }));
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

  /** Detect the @ / # / : completion and the /slash command query at the caret. */
  const detectMentionQuery = useCallback((text: string, cursorPos: number) => {
    const found = completionAt(text, cursorPos);
    setCompletion((current) => {
      if (!found) return null;
      if (current && current.kind === found.kind && current.start === found.start && current.query === found.query) return current;
      return found;
    });
    setCompletionIndex(0);

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

  /** Put the picked completion into the draft, where its trigger was. */
  const insertCompletion = useCallback((token: string) => {
    const textarea = textareaRef.current;
    if (!textarea || !completion) return;
    const caret = textarea.selectionStart;
    const next = applyCompletion(content, caret, completion.start, token);
    // The caret lands after the token on the commit that puts it in, not a
    // frame later, so the next keystroke can never arrive before it.
    pendingCaretRef.current = next.caret;
    setContent(next.text);
    setCompletion(null);
    triggerTyping();
  }, [content, completion, setContent, triggerTyping]);
  useLayoutEffect(() => {
    const at = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (at === null || !textarea || textarea.value.length < at) return;
    pendingCaretRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(at, at);
  }, [content]);

  const completionToken = (option: CompletionOption): string => {
    switch (option.kind) {
      case 'member':
        return `<@${option.member.user.id}>`;
      case 'role':
        return `<@&${option.role.id}>`;
      case 'channel':
        return `<#${option.id}>`;
      case 'emoji':
        return option.emoji;
      case 'custom-emoji':
        return formatCustomEmojiToken(option.name, option.id, option.animated);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Dismiss composer popovers first (including a completion with zero matches).
    if (e.key === 'Escape') {
      if (completion !== null) {
        e.preventDefault();
        setCompletion(null);
        return;
      }
      if (slashQuery !== null || slashOptionMode) {
        e.preventDefault();
        setSlashQuery(null);
        setSlashOptionMode(false);
        clearAutocompleteChoices();
        return;
      }
      if (picker !== null || showFormattingTools) {
        e.preventDefault();
        setPicker(null);
        setShowFormattingTools(false);
        return;
      }
    }

    // Completion: Up/Down move, Enter or Tab picks.
    if (completion !== null && completionResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCompletionIndex((prev) => (prev + 1) % completionResults.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCompletionIndex((prev) => (prev - 1 + completionResults.length) % completionResults.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const selected = completionResults[completionIndex];
        if (selected) insertCompletion(completionToken(selected));
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
  // Files from anywhere else on the page (IX-15's drop target over main) queue
  // here, through the same checks as a drop on the box itself.
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (showPollComposer) {
      setSubmitError('Disable poll composer before adding attachments.');
      return;
    }
    if (!canAttachFiles) { setSubmitError(actions.attach.reason); return; }
    setStagedFiles((prev) => [...prev, ...files]);
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => registerComposerFiles(channelId, (files) => addFilesRef.current(files)), [channelId]);

  const [blockerSettled, setBlockerSettled] = useState(false);
  useEffect(() => {
    if (composerAction.allowed) { setBlockerSettled(false); return; }
    const timer = window.setTimeout(() => setBlockerSettled(true), 400);
    return () => window.clearTimeout(timer);
  }, [composerAction.allowed, composerAction.reason]);

  // A channel this person cannot post in has no message box: one centered
  // line says why (§4.12). Only the server's own answer decides that, never a
  // readiness dip of the messaging runtime, an encryption step this person can
  // take, or an answer that has not arrived yet.
  const serverSend = serverActions.send;
  const readOnly = !serverSend.allowed && !encrypted && !groupDmRefusal && !capabilityError && !actionsLoading;
  const readOnlyLine = !readOnly
    ? null
    : serverSend.reason === PERMISSION_REFUSAL
      ? channelType === ChannelType.Announcement
        ? `Only moderators can post in ${channelName ?? 'this channel'}`
        : `You can't send messages in ${channelName ?? 'this channel'}`
      : serverSend.reason;

  const open = !readOnly && (
    focused
    || content.length > 0
    || stagedFiles.length > 0
    || Boolean(replyingTo)
    || showFormattingTools
    || picker !== null
    || showPollComposer
    || showScheduleComposer
  );
  openRef.current = open;
  useComposerShape(
    { box: composerShellRef, top: shapeTops, mid: shapeMids, head: headRef, tools: toolsMoveRef },
    { open: openRef, hold: holdShapeRef, active: !readOnly },
  );

  // The halo is the place's hue (§2.2): the server's, or People's.
  const guildHue = useGuildStore((state) => (guildId ? state.guilds.find((guild) => guild.id === guildId)?.hue ?? null : null));
  const hue = guildId ? serverHue({ id: guildId, hue: guildHue }) : PEOPLE_HUE;

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
  // §5.13: quiet until there is something to send, then cream.
  const hasSomething = showScheduleComposer
    ? Boolean(content.trim() && scheduledAt)
    : showPollComposer || content.trim().length > 0 || stagedFiles.length > 0;
  const nearLimit = content.length > MAX_MESSAGE_LENGTH * 0.9;
  const overLimit = content.length > MAX_MESSAGE_LENGTH;
  // In a box too narrow for the words (the call's chat column, a thread
  // beside the conversation, a phone) the tool chips keep only their glyphs.
  const iconTools = ribbon || narrow || compact;
  const fullLabel = replyingTo
    ? `Reply to ${replyingTo.author}`
    : composerPlaceholder(channelName, conversationKind);
  const placeholder = showPollComposer
    ? 'The question above is what gets sent'
    : showScheduleComposer
      ? `Schedule a message for ${channelName ?? 'this conversation'}`
      : ribbon || narrow
        ? // A box narrower than a sentence, whose conversation is named in the
          // heading directly above it.
          'Say something'
        : replyingTo
          ? replyPlaceholder(replyingTo.author, iconTools)
          : composerPlaceholder(channelName, conversationKind, phoneWidth);
  const sendLabel = showScheduleComposer
    ? (schedulingMessage ? 'Scheduling message' : 'Schedule message')
    : 'Send message';
  const slowMode = slowModeLabel(channel?.rate_limit_per_user);

  const openPicker = (tab: ComposerPickerTab) => {
    setCompletion(null);
    setPicker((current) => (current === tab ? null : tab));
  };
  // Closing the picker from inside it (Escape, a choice) gives the words their
  // focus back, synchronously, so a press outside still wins the focus it takes.
  const closePicker = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && composerShellRef.current?.contains(active)) textareaRef.current?.focus();
    setPicker(null);
  }, []);

  const openSendMenu = () => {
    setPicker(null);
    setCompletion(null);
    setSendMenu(true);
  };
  const clearLongPress = () => {
    if (longPress.current.timer !== null) window.clearTimeout(longPress.current.timer);
    longPress.current.timer = null;
  };
  useEffect(() => () => clearLongPress(), []);

  // Right-click or a long press on Send (§8.4): send later, and the list of
  // what is scheduled, which is a sheet.
  const sendMenuEntries: IxMenuEntry[] = [
    {
      type: 'item',
      id: 'send-later',
      label: 'Send later…',
      icon: <ClockGlyph size={16} />,
      disabled: !actions.schedule.allowed,
      description: actions.schedule.allowed ? undefined : actions.schedule.reason ?? undefined,
      onSelect: () => {
        if (showPollComposer) resetPollComposer();
        setShowScheduleComposer(true);
        // The one thing left to choose is when.
        requestAnimationFrame(() => scheduleAtRef.current?.focus());
      },
    },
    {
      type: 'item',
      id: 'scheduled',
      label: 'Scheduled messages',
      hint: scheduledCount > 0 ? String(scheduledCount) : undefined,
      icon: <IxGlyph name="event" size={16} />,
      onSelect: () => setShowScheduledPanel(true),
    },
  ];

  type Tool = { id: string; label: string; glyph: IxGlyphName | 'format' | null; onClick: () => void; pressed?: boolean };
  const tools: Tool[] = [];
  if (canAttachFiles && canSendMessages) tools.push({ id: 'attach', label: 'Attach', glyph: 'attach', onClick: attachFiles });
  if (canSendMessages) tools.push({ id: 'gif', label: 'GIF', glyph: null, onClick: () => openPicker('gif'), pressed: picker === 'gif' });
  if (canCreatePoll) tools.push({ id: 'poll', label: 'Poll', glyph: 'poll', onClick: togglePollComposer, pressed: showPollComposer });
  if (canCreateEvents) tools.push({ id: 'event', label: 'Event', glyph: 'event', onClick: () => setShowEventForm(true) });
  tools.push({
    id: 'format',
    label: 'Format',
    glyph: 'format',
    onClick: () => {
      setShowFormattingTools(true);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  const completionLabel = completion?.kind === 'channel' ? 'Channels' : completion?.kind === 'emoji' ? 'Emoji' : 'People and roles';
  const completionError = completion?.kind === 'mention' ? composerRolesError : completion?.kind === 'emoji' ? serverEmojiError : null;
  const showCompletion = completion !== null && (completionResults.length > 0 || Boolean(completionError));

  const renderCompletionRow = (option: CompletionOption): ReactNode => {
    switch (option.kind) {
      case 'member': {
        const name = displayName(option.member.user, option.member.nick);
        return (
          <>
            <Avatar userId={option.member.user.id} name={name} avatar={option.member.user.avatar_hash ?? null} size={24} />
            <span className="ix-complete__name">{name}</span>
            {name !== option.member.user.username && <span className="ix-complete__meta">@{option.member.user.username}</span>}
          </>
        );
      }
      case 'role':
        return (
          <>
            <span className="ix-complete__mark" aria-hidden>
              <span
                className="ix-complete__dot"
                style={option.role.color === 0 ? undefined : { backgroundColor: roleColorToHex(option.role.color) }}
              />
            </span>
            <span className="ix-complete__name">@{option.role.name}</span>
            <span className="ix-complete__meta">
              {option.count < 0 ? 'Loading…' : `${option.count} ${option.count === 1 ? 'member' : 'members'}`}
            </span>
          </>
        );
      case 'channel':
        return (
          <>
            <span className="ix-complete__mark ix-complete__mark--text" aria-hidden>#</span>
            <span className="ix-complete__name">{option.name}</span>
          </>
        );
      case 'emoji':
        return (
          <>
            <span className="ix-complete__mark ix-complete__mark--emoji" aria-hidden>{option.emoji}</span>
            <span className="ix-complete__name">:{option.name}:</span>
          </>
        );
      case 'custom-emoji':
        return (
          <>
            <span className="ix-complete__mark" aria-hidden>
              <img className="ix-complete__img" src={guildId ? buildGuildEmojiImageUrl(guildId, option.id) : ''} alt="" />
            </span>
            <span className="ix-complete__name">:{option.name}:</span>
            <span className="ix-complete__meta">This server</span>
          </>
        );
    }
  };

  // Everything that sits directly above the box: notices and the cards that
  // stand in for a send (poll, send later), all at the box's width.
  const stack = (
    <div className="ix-composer__stack">
      {showCommandThinking && (
        <div role="status" aria-live="polite" className="ix-composer__note">
          <CordSpinner className="shrink-0" />
          <span>Waiting for command response…</span>
        </div>
      )}
      {!readOnly && !composerAction.allowed && blockerSettled && !composerNoticeSuppressed(composerAction.reason, identityHeld) && (
        <div role="status" className="ix-composer__note">
          <span>
            {composerAction.reason}
            {!groupDmRefusal && encrypted && encryption === 'unlock' && <Link className="ix-composer__link" to={`/unlock?${new URLSearchParams({ returnTo: window.location.pathname + window.location.search })}`}>Unlock encryption</Link>}
            {/* A second device — a fresh browser, a new laptop — signs in and
                lands here holding no identity, or a different one. Without this
                it was the one encryption blocker with no route out: nothing but
                "Check again". Setup is not the answer either — it refuses when
                the account already has an identity, and tells the user to restore
                the recovery phrase — so link straight at the page that does it. */}
            {!groupDmRefusal && encrypted && encryption === 'identity_mismatch' && <Link className="ix-composer__link" to="/recover">Restore your identity</Link>}
            {/* A blocker can be resolved by someone else (a recipient finishing
                encryption setup, a restored permission), so the check is always
                repeatable from here instead of only after a request failure.
                A group waiting on somebody's enrollment is not a server answer
                to re-ask: the missing key is the other person's to publish. */}
            {!groupDmRefusal && <button type="button" className="ix-composer__link" onClick={refreshActions}>{capabilityError ? 'Retry' : 'Check again'}</button>}
          </span>
        </div>
      )}
      {!readOnly && isAnonymousChannel && (
        <div className="ix-composer__note">
          <GlyphFrame size={14}>
            <path d="M3 3l18 18M10.6 5.1A9.7 9.7 0 0 1 12 5c5 0 8.5 4.2 9.5 7-.4 1.1-1.2 2.5-2.4 3.7M6.3 6.3C4.4 7.6 3.1 9.6 2.5 12c1 2.8 4.5 7 9.5 7 1.8 0 3.4-.5 4.7-1.3" />
          </GlyphFrame>
          <span>Messages in this channel are posted anonymously</span>
        </div>
      )}

      {!readOnly && showPollComposer && (
        <div className="ix-composer__card" data-card="poll">
          <div className="ix-composer__card-head">
            <span className="ix-composer__card-title">
              <IxGlyph name="poll" size={16} />
              Poll
            </span>
            <button type="button" className="ix-composer__text-btn" onClick={togglePollComposer}>
              Close
            </button>
          </div>

          <label className="ix-composer__field">
            <span className="ix-composer__label">Question</span>
            <Input
              type="text"
              maxLength={300}
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              placeholder="What should everyone weigh in on?"
            />
          </label>

          <div className="ix-composer__options">
            {pollOptions.map((option, index) => (
              <div key={index} className="ix-composer__option">
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
                  className="ix-composer__icon"
                  aria-label={`Remove option ${index + 1}`}
                  title={`Remove option ${index + 1}`}
                >
                  <IxGlyph name="x" size={14} />
                </button>
              </div>
            ))}
          </div>

          <div className="ix-composer__card-foot">
            <button type="button" className="ix-chip" onClick={addPollOption} disabled={pollOptions.length >= 10}>
              <IxGlyph name="plus" size={14} />
              Add option
            </button>
            <label className="ix-composer__check">
              <input
                type="checkbox"
                checked={pollAllowMultiselect}
                onChange={(e) => setPollAllowMultiselect(e.target.checked)}
              />
              Allow multiple answers
            </label>
            <label className="ix-composer__check">
              <span>Ends after</span>
              <span className="ix-composer__select">
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

      {!readOnly && showScheduleComposer && (
        <div className="ix-composer__card" data-card="schedule">
          <label className="ix-composer__field">
            <span className="ix-composer__label">Send at</span>
            <Input
              ref={scheduleAtRef}
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              min={toDatetimeLocalValue(Date.now() + SCHEDULED_MESSAGE_MIN_LEAD_MS)}
            />
          </label>
          <div className="ix-composer__card-foot ix-composer__card-foot--split">
            <button type="button" className="ix-composer__text-btn" onClick={() => setShowScheduledPanel(true)}>
              {scheduledCount > 0 ? `Scheduled messages (${scheduledCount})` : 'Scheduled messages'}
            </button>
            <button type="button" className="ix-composer__text-btn" onClick={() => setShowScheduleComposer(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <MessagingRecoveryNotice runtime={messagingRuntime} encryptedConversation={!guildId} channelId={channelId} />
      <MessagingQueuePanel runtime={messagingRuntime} channelId={channelId} />
      {draftError && (
        <div role="alert" className="ix-composer__note ix-composer__note--error">
          <span>{draftError}</span>
          <button type="button" className="ix-composer__link" onClick={() => void retrySave().catch(() => {})}>Retry saving draft</button>
        </div>
      )}
      {/* The blocker row above already carries the reason a send was refused —
          for a blocked sender, word for word. Printing it again underneath said
          the same sentence twice, stacked, which reads as two problems. */}
      {!readOnly && submitError && submitError !== composerAction.reason && !composerNoticeSuppressed(submitError, identityHeld) && (
        <div className="ix-composer__note ix-composer__note--error" role="alert">
          {submitError}
        </div>
      )}
    </div>
  );

  const scheduledSheet = (
    <ScheduledMessagesPanel
      open={showScheduledPanel}
      channelId={channelId}
      channelName={channelName}
      onClose={() => setShowScheduledPanel(false)}
      onCountChange={setScheduledCount}
    />
  );

  if (readOnly) {
    return (
      <div
        className={cn('ix-composer', narrow && 'ix-composer--narrow')}
        data-testid="ix-composer"
        data-ix-composer-open="false"
        data-read-only="true"
      >
        {stack}
        <p role="status" className="ix-composer__readonly">{readOnlyLine}</p>
        {scheduledSheet}
      </div>
    );
  }

  return (
    <div
      className={cn('ix-composer', narrow && 'ix-composer--narrow')}
      data-testid="ix-composer"
      data-ix-composer-open={open ? 'true' : 'false'}
      data-icon-tools={iconTools ? 'true' : undefined}
      data-drag-over={isDragOver ? 'true' : undefined}
      style={{ '--ix-hue': hue } as CSSProperties}
      onDragOver={(e) => {
        if (!canAttachFiles || !canSendMessages) return;
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={canAttachFiles && canSendMessages ? handleDrop : undefined}
    >
      {stack}

      <div
        ref={composerShellRef}
        className="ix-composer__box glass-composer__capsule"
        data-open={open ? 'true' : 'false'}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.contains(next)) return;
          setFocused(false);
        }}
        onMouseDown={(event) => {
          // A press on the box's empty space puts the caret in the text (the
          // whole box reads as one field), without stealing a control's press.
          const target = event.target as HTMLElement;
          if (target.closest('button, a, input, textarea, select, [role="dialog"], [role="listbox"]')) return;
          event.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        {/* The shape: three slices, so the corners never stretch (§5.12). The
            fill is drawn solid inside one translucent group, so slices that
            overlap by a pixel never show a seam while they move; the edges and
            the ring are their own slices over it. */}
        <span className="ix-composer__shape" aria-hidden>
          <span className="ix-composer__fill">
            <span ref={fillTopRef} className="ix-composer__slice ix-composer__slice--top" />
            <span ref={fillMidRef} className="ix-composer__slice ix-composer__slice--mid" />
            <span className="ix-composer__slice ix-composer__slice--bottom" />
          </span>
          <span className="ix-composer__edges">
            <span ref={capTopRef} className="ix-composer__slice ix-composer__slice--top" />
            <span ref={capMidRef} className="ix-composer__slice ix-composer__slice--mid" />
            <span className="ix-composer__slice ix-composer__slice--bottom" />
          </span>
        </span>

        <div ref={headRef} className="ix-composer__head">
          {stagedFiles.length > 0 && (
            <ul className="ix-composer__queue" aria-label="Attachments">
              {stagedFiles.map((file, i) => {
                const tooLarge = file.size > maxUploadSize;
                const image = canPreviewImageFile(file);
                const extension = file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';
                return (
                  <li
                    key={i}
                    className={cn('ix-composer__file', image && 'ix-composer__file--image')}
                    data-over={tooLarge ? 'true' : undefined}
                    title={`${file.name} · ${formatFileSize(file.size)}${tooLarge ? ` · larger than ${formatFileSize(maxUploadSize)}` : ''}`}
                  >
                    {image ? (
                      <img src={stagedImagePreviews[i] || ''} alt={file.name} className="ix-composer__thumb" />
                    ) : (
                      <>
                        <span className="ix-composer__ext" aria-hidden>{extension}</span>
                        <span className="ix-composer__file-text">
                          <span className="ix-composer__file-name">{file.name}</span>
                          <span className="ix-composer__file-size" data-over={tooLarge ? 'true' : undefined}>
                            {tooLarge ? `Over ${formatFileSize(maxUploadSize)}` : formatFileSize(file.size)}
                          </span>
                        </span>
                      </>
                    )}
                    {image && tooLarge && <span className="sr-only">Larger than {formatFileSize(maxUploadSize)}</span>}
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="ix-composer__unqueue"
                      aria-label={`Remove ${file.name}`}
                      title={`Remove ${file.name}`}
                    >
                      <IxGlyph name="x" size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="ix-composer__row">
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
              onSelect={(e) => {
                const target = e.currentTarget;
                if (completion) detectMentionQuery(target.value, target.selectionStart);
              }}
              placeholder={placeholder}
              aria-label={fullLabel}
              aria-autocomplete="list"
              aria-controls={showCompletion ? `ix-complete-${channelId}` : undefined}
              aria-activedescendant={showCompletion && completionResults[completionIndex] ? `ix-complete-${channelId}-${completionIndex}` : undefined}
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              disabled={showPollComposer}
              data-composer-input=""
              // A placeholder with a long channel name can be wider than a
              // phone's box. Clipping the PLACEHOLDER to one line keeps the box
              // at its 52px; a real draft still wraps and grows.
              className="ix-composer__input"
            />

            <button
              type="button"
              data-composer-picker-toggle="emoji"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => openPicker('emoji')}
              disabled={showPollComposer}
              className="ix-composer__emoji"
              aria-label="Emoji"
              title="Emoji"
              aria-haspopup="dialog"
              aria-expanded={picker !== null}
            >
              <EmojiGlyph />
            </button>

            <button
              ref={sendButtonRef}
              type="button"
              onClick={() => {
                if (longPress.current.fired) { longPress.current.fired = false; return; }
                void handleSubmit();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openSendMenu();
              }}
              onPointerDown={(event) => {
                if (event.pointerType !== 'touch') return;
                clearLongPress();
                longPress.current.fired = false;
                longPress.current.timer = window.setTimeout(() => {
                  longPress.current.timer = null;
                  longPress.current.fired = true;
                  openSendMenu();
                }, LONG_PRESS_MS);
              }}
              onPointerUp={clearLongPress}
              onPointerCancel={clearLongPress}
              onPointerLeave={clearLongPress}
              disabled={sendDisabled}
              // Quiet until there is something to send, then cream: the one
              // primary action on the surface (§1.4, §5.13). It does not scale
              // on press. The send flight's release reads its quiet fill and ink
              // from this element (`releaseSend`).
              className="ix-composer__send"
              data-ready={hasSomething ? 'true' : 'false'}
              aria-label={sendLabel}
              title={sendLabel}
            >
              {showsSpinner ? (
                <CordSpinner size={18} />
              ) : showScheduleComposer ? (
                <ClockGlyph />
              ) : (
                <IxGlyph name="send" size={18} />
              )}
            </button>
          </div>
        </div>

        {/* The tools row: under the input row while the box is open. Its clip
            is the box's foot, so on closing it leaves through the bottom edge. */}
        <div className="ix-composer__tools-clip" aria-hidden={!open || undefined} inert={!open || undefined}>
          <div ref={toolsMoveRef} className="ix-composer__tools-move">
            <div className="ix-composer__tools" data-format={showFormattingTools ? 'true' : undefined}>
              {replyingTo && (
                <span
                  role="group"
                  aria-label={`Replying to ${replyingTo.author}`}
                  title={replyingTo.content ? `${replyingTo.author}: ${replyingTo.content}` : undefined}
                  className="ix-chip ix-composer__reply glass-composer__reply"
                >
                  <span className="ix-composer__reply-text">
                    {iconTools ? replyingTo.author : `Replying to ${replyingTo.author}`}
                  </span>
                  <button
                    type="button"
                    onClick={onCancelReply}
                    className="ix-composer__reply-x"
                    aria-label="Cancel reply"
                    title="Cancel reply"
                  >
                    <IxGlyph name="x" size={12} />
                  </button>
                </span>
              )}
              {showFormattingTools ? (
                <>
                  <MarkdownToolbar textareaRef={textareaRef} onContentChange={setContent} />
                  <button
                    type="button"
                    className="ix-chip ix-composer__done"
                    onClick={() => {
                      setShowFormattingTools(false);
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                  >
                    Done
                  </button>
                </>
              ) : (
                tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    className="ix-chip"
                    data-tool={tool.id}
                    aria-label={iconTools && tool.glyph ? tool.label : undefined}
                    aria-pressed={tool.pressed === undefined ? undefined : tool.pressed}
                    title={iconTools && tool.glyph ? tool.label : undefined}
                    data-composer-picker-toggle={tool.id === 'gif' ? 'gif' : undefined}
                    onMouseDown={tool.id === 'gif' ? (e) => e.stopPropagation() : undefined}
                    onClick={tool.onClick}
                  >
                    {tool.glyph === 'format' ? <FormatGlyph /> : tool.glyph ? <IxGlyph name={tool.glyph} size={14} /> : null}
                    {(!iconTools || !tool.glyph) && tool.label}
                  </button>
                ))
              )}
              {(slowMode || nearLimit) && (
                <span className="ix-composer__tail">
                  {slowMode && (
                    <span className="ix-composer__slow" title={`One message every ${channel?.rate_limit_per_user ?? 0} seconds`}>
                      {slowMode}
                    </span>
                  )}
                  {nearLimit && (
                    <span className="ix-composer__count" data-over={overLimit ? 'true' : undefined}>
                      {content.length}/{MAX_MESSAGE_LENGTH}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Upload progress: an indeterminate sweep along the foot. */}
        {uploading && (
          <span className="ix-composer__progress" aria-hidden>
            {!reduceMotion && <span className="pc-sweep block h-full w-1/3 rounded-full bg-accent-primary" />}
          </span>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          tabIndex={-1}
          onChange={handleFileSelect}
        />

        {/* Slash commands: their own popover, the same surface. */}
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

        {/* @ / # / : completion. */}
        {showCompletion && (
          <div className="ix-complete" role="listbox" id={`ix-complete-${channelId}`} aria-label={completionLabel}>
            {completionError && <p role="alert" className="ix-complete__error">{completionError}</p>}
            {completionResults.map((option, i) => (
              <Fragment key={`${option.kind}-${option.id}`}>
                {option.kind === 'role' && completionResults[i - 1]?.kind !== 'role' && (
                  <p className="ix-complete__label" aria-hidden>Roles</p>
                )}
                <div
                  id={`ix-complete-${channelId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === completionIndex}
                  className="ix-complete__row"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertCompletion(completionToken(option));
                  }}
                  onMouseEnter={() => setCompletionIndex(i)}
                >
                  {renderCompletionRow(option)}
                </div>
              </Fragment>
            ))}
          </div>
        )}

        {/* The one picker, above the emoji button. */}
        {pickerLayer.value && (
          <ComposerPickerHost
            tab={pickerLayer.value}
            leaving={pickerLayer.leaving}
            guildId={guildId}
            onTab={(tab) => setPicker(tab)}
            onClose={closePicker}
            onEmoji={(emoji) => {
              setContent((prev) => `${prev}${emoji}`);
              triggerTyping();
              setPicker(null);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            onGif={(gifUrl) => {
              if (!actions.send.allowed) { setSubmitError(actions.send.reason); return; }
              setPicker(null);
              void (async () => {
                try {
                  await messageStore.getState().sendMessage(channelId, gifUrl, replyingTo?.id);
                  if (mounted.current) onCancelReply?.();
                } catch (err) {
                  setSubmitError(`Failed to send GIF: ${messageInputError(err, 'Request failed')}`);
                }
              })();
            }}
            onSticker={(stickerId) => {
              if (!actions.send.allowed) { setSubmitError(actions.send.reason); return; }
              setPicker(null);
              void (async () => {
                try {
                  await messageStore.getState().sendMessage(channelId, '', replyingTo?.id, undefined, [stickerId]);
                  if (mounted.current) onCancelReply?.();
                } catch (err) {
                  setSubmitError(`Failed to send sticker: ${messageInputError(err, 'Request failed')}`);
                }
              })();
            }}
          />
        )}
      </div>

      <IxMenu
        label="Send options"
        open={sendMenu}
        anchor={sendMenu && sendButtonRef.current ? { element: sendButtonRef.current, align: 'end', gap: 10 } : null}
        width={220}
        entries={sendMenuEntries}
        onClose={() => setSendMenu(false)}
        restoreTo={() => sendButtonRef.current}
      />

      {showEventForm && guildId && (
        <EventFormModal
          guildId={guildId}
          onClose={() => setShowEventForm(false)}
          onSaved={() => setShowEventForm(false)}
        />
      )}

      {scheduledSheet}
    </div>
  );
}
