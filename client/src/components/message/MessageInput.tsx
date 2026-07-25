import { useState, useRef, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Plus, Smile, Send, X, FileText, BarChart3, PlusCircle, MinusCircle, Image, Clock3, EyeOff, Type, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Input, Select } from '../ui/Input';
import { Button } from '../ui/Button';
import { useMessageStore } from '../../stores/messageStore';
import { useMemberStore } from '../../stores/memberStore';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useTyping } from '../../hooks/useTyping';
import { MAX_MESSAGE_LENGTH, SCHEDULED_MESSAGE_MIN_LEAD_MS } from '../../lib/constants';
import { channelApi } from '../../api/channels';
import type { ChannelFeatureSettings } from '../../api/channels';
import { usePollStore } from '../../stores/pollStore';
import { useChannelStore } from '../../stores/channelStore';
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
import { usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission, type ChannelOverwrite } from '../../types';
import {
  getVersionedStorageItem,
  removeVersionedStorageItem,
  setVersionedStorageItem,
} from '../../lib/versionedStorage';
import { isAllowedImageMimeType } from '../../lib/security';
import { formatFileSize, toDatetimeLocalValue } from '../../lib/formatters';
import { toast } from '../../stores/toastStore';
import { extractApiError } from '../../api/client';
import { displayName } from '../../lib/displayName';
import { fetchChannelOverwrites } from '../../lib/permissionDataCache';

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
}

// 36px icon control (design-spec §7 Icon button): radius-sm, --interactive-normal →
// --interactive-hover on a --bg-mod-subtle wash, press = scale(.97), layered focus
// ring, 44px min touch target on coarse pointers.
const ICON_BTN =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-interactive-normal ' +
  'transition-[color,background-color,transform] duration-[140ms] ease-[var(--ease-out)] ' +
  'hover:bg-bg-mod-subtle hover:text-interactive-hover active:scale-[0.97] ' +
  'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ' +
  '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11';

// Emerald active affordance for the composer toggles (formatting / poll / schedule).
const ICON_BTN_ACTIVE =
  'bg-accent-tint text-accent-primary hover:bg-accent-tint-strong hover:text-accent-primary';

const POLL_DURATION_OPTIONS = [
  { label: 'No end time', minutes: 0 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
  { label: '3 days', minutes: 4320 },
  { label: '7 days', minutes: 10080 },
  { label: '14 days', minutes: 20160 },
];

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

function loadDraft(channelId: string): string {
  try {
    return getVersionedStorageItem(`draft:${channelId}`, [`draft:${channelId}`]) || '';
  } catch {
    return '';
  }
}

function saveDraft(channelId: string, content: string) {
  try {
    if (content.trim()) {
      setVersionedStorageItem(`draft:${channelId}`, content);
    } else {
      removeVersionedStorageItem(`draft:${channelId}`, [`draft:${channelId}`]);
    }
  } catch {
    // localStorage unavailable
  }
}

function messageInputError(err: unknown, fallback: string): string {
  const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
  if (responseData?.message) return responseData.message;
  if (responseData?.error) return responseData.error;
  const extracted = extractApiError(err);
  return extracted === 'An unexpected error occurred' ? fallback : extracted;
}

export function MessageInput({ channelId, guildId, channelName, replyingTo, onCancelReply }: MessageInputProps) {
  const [content, setContent] = useState(() => loadDraft(channelId));
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
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
  const { upload, uploading, maxUploadSize } = useFileUpload(channelId);
  const { triggerTyping } = useTyping(channelId);
  const reduceMotion = useReducedMotion();
  const activeChannel = useChannelStore((s) => s.channelsById[channelId]);
  const activeChannelType = activeChannel?.channel_type ?? activeChannel?.type;
  const canCreatePoll = activeChannelType == null || (activeChannelType !== 2 && activeChannelType !== 4);

  const [channelOverwrites, setChannelOverwrites] = useState<ChannelOverwrite[]>([]);
  useEffect(() => {
    if (!guildId || !channelId) {
      setChannelOverwrites([]);
      return;
    }
    let cancelled = false;
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
  }, [guildId, channelId]);

  const { permissions, isAdmin } = usePermissions(guildId ?? null, {
    channelId,
    channelOverwrites,
  });
  // DMs have no guild permission bits — recipients can always send/attach.
  const canSendMessages =
    !guildId || isAdmin || hasPermission(permissions, Permissions.SEND_MESSAGES);
  const canAttachFiles =
    !guildId || isAdmin || hasPermission(permissions, Permissions.ATTACH_FILES);

  const channelWaiting = useInteractionStore((s) => s.isChannelWaiting(channelId));
  const showCommandThinking = channelWaiting;

  // Anonymous posting detection
  const [channelFeatures, setChannelFeatures] = useState<ChannelFeatureSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    channelApi.getFeatureSettings(channelId).then(({ data }) => {
      if (!cancelled) setChannelFeatures(data);
    }).catch(() => {
      // Feature settings are optional
    });
    return () => { cancelled = true; };
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
  const guildMembers = useMemberStore((s) => (guildId ? s.members.get(guildId) : undefined));
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionResults = useMemo(() => {
    if (mentionQuery === null || !guildId) return [];
    const q = mentionQuery.toLowerCase();
    return (guildMembers || [])
      .filter((m) => {
        const visibleName = displayName(m.user, m.nick).toLowerCase();
        return visibleName.includes(q) || m.user.username.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [mentionQuery, guildId, guildMembers]);

  // Draft persistence: save on content change (debounced), restore on channel switch
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel any pending debounced save. Must be called alongside an explicit
  // saveDraft clear on send/schedule: the pending timer captured the old content
  // in its closure and would otherwise re-persist that stale draft in the window
  // before the content-change effect re-runs (or after an unmount that races it).
  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => saveDraft(channelId, content), 500);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [content, channelId]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, window.innerHeight * 0.5) + 'px';
    }
  }, [content]);

  useEffect(() => {
    // Restore draft for this channel; clear composer UI that must not leak across channels.
    setContent(loadDraft(channelId));
    setMentionQuery(null);
    setSlashQuery(null);
    setSlashOptionMode(false);
    useInteractionStore.getState().clearAutocompleteChoices();
    setAutocompleteLoading(false);
    if (autocompleteTimerRef.current) {
      clearTimeout(autocompleteTimerRef.current);
      autocompleteTimerRef.current = null;
    }
    autocompleteRequestIdRef.current += 1;
    setStagedFiles([]);
    setShowPollComposer(false);
    setShowFormattingTools(false);
    setShowEmojiPicker(false);
    setShowGifPicker(false);
    setShowStickerPicker(false);
    setPollQuestion('');
    setPollOptions(['', '']);
    setPollAllowMultiselect(false);
    setPollDurationMinutes(1440);
    setCreatingPoll(false);
    setShowScheduleComposer(false);
    setScheduledAt('');
    setSchedulingMessage(false);
    setSending(false);
    sendingRef.current = false;
    setSubmitError(null);
    setShowScheduledPanel(false);
    setScheduledCount(0);
  }, [channelId]);

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

  const handleSubmit = async () => {
    if (sendingRef.current || uploading || creatingPoll || schedulingMessage) return;

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
        const { data } = await channelApi.createPoll(channelId, {
          question,
          options: options.map((text) => ({ text })),
          allow_multiselect: pollAllowMultiselect,
          expires_in_minutes: pollDurationMinutes > 0 ? pollDurationMinutes : undefined,
        });
        if (data.poll) {
          usePollStore.getState().upsertPoll(data.poll);
        }
        useMessageStore.getState().addMessage(channelId, data);
        onCancelReply?.();
        resetPollComposer();
      } catch (err) {
        setSubmitError(messageInputError(err, 'Failed to create poll.'));
      } finally {
        setCreatingPoll(false);
      }
      return;
    }
    if (showScheduleComposer) {
      if (!content.trim()) {
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
        await useMessageStore.getState().scheduleMessage(
          channelId,
          content.trim(),
          sendAtIso,
          replyingTo?.id,
        );
        toast.success('Message scheduled.');
        clearDraftTimer();
        setContent('');
        setScheduledAt('');
        setScheduledCount((prev) => prev + 1);
        setShowScheduleComposer(false);
        saveDraft(channelId, '');
        onCancelReply?.();
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
      setSubmitError("You don't have permission to attach files in this channel.");
      return;
    }

    if (!content.trim() && stagedFiles.length === 0) return;
    if (content.length > MAX_MESSAGE_LENGTH) {
      setSubmitError(`Message is too long (${content.length}/${MAX_MESSAGE_LENGTH}).`);
      return;
    }

    // Lock before any await so rapid Enter cannot double-fire.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    const trimmed = content.trim();
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
            clearDraftTimer();
            setContent('');
            saveDraft(channelId, '');
            onCancelReply?.();
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
          } catch (err) {
            setSubmitError(messageInputError(err, 'Failed to run command.'));
          }
          return;
        }
      }

      setSubmitError(null);
      const attachmentIds: string[] = [];
      for (const file of stagedFiles) {
        const uploaded = await upload(file);
        if (uploaded?.id) {
          attachmentIds.push(uploaded.id);
        }
      }
      await useMessageStore.getState().sendMessage(
        channelId,
        trimmed,
        replyingTo?.id,
        attachmentIds,
      );
      clearDraftTimer();
      setContent('');
      saveDraft(channelId, '');
      setStagedFiles([]);
      onCancelReply?.();
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } catch (err) {
      setSubmitError(messageInputError(err, 'Failed to send message.'));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

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
    [content, clearAutocompleteChoices],
  );

  const insertMention = useCallback((userId: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = content.slice(0, textarea.selectionStart);
    const after = content.slice(textarea.selectionStart);
    const mentionStart = before.lastIndexOf('@');
    if (mentionStart === -1) return;
    const mentionText = `<@${userId}>`;
    const newContent = before.slice(0, mentionStart) + mentionText + ' ' + after;
    setContent(newContent);
    setMentionQuery(null);
    // Restore focus
    requestAnimationFrame(() => {
      const newPos = mentionStart + mentionText.length + 1;
      textarea.focus();
      textarea.setSelectionRange(newPos, newPos);
    });
  }, [content]);

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
        if (selected) insertMention(selected.user.id);
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
      if (showPollComposer) {
        setSubmitError('Disable poll composer before adding attachments.');
        return;
      }
      e.preventDefault();
      setStagedFiles((prev) => [...prev, ...imageFiles]);
    }
  }, [showPollComposer]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
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
    if (!canCreatePoll) return;
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
      setContent('');
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

  const busy = uploading || creatingPoll || schedulingMessage || sending;
  const sendDisabled =
    busy ||
    !canSendMessages ||
    (showScheduleComposer
      ? !content.trim() || !scheduledAt
      : !showPollComposer && !content.trim() && stagedFiles.length === 0);
  const nearLimit = content.length > MAX_MESSAGE_LENGTH * 0.9;
  const overLimit = content.length > MAX_MESSAGE_LENGTH;
  const popoverEnter = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };
  const popoverTransition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div
      className="relative flex w-full flex-col gap-2 px-4 pb-[calc(var(--safe-bottom)+1.25rem)] pt-2 sm:px-6 sm:pb-8"
      onDragOver={(e) => {
        if (!canAttachFiles || !canSendMessages) return;
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={canAttachFiles && canSendMessages ? handleDrop : undefined}
    >
      {showCommandThinking && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-meta text-text-secondary"
        >
          <Loader2 size={14} className="shrink-0 animate-spin text-accent-primary" />
          <span>Waiting for command response…</span>
        </div>
      )}
      {!canSendMessages && (
        <div
          role="status"
          className="rounded-sm border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-meta text-text-muted"
        >
          You don&apos;t have permission to send messages in this channel.
        </div>
      )}
      {isAnonymousChannel && (
        <div className="flex items-center gap-2 rounded-sm border border-accent-primary/30 bg-accent-tint px-3 py-2 text-meta text-accent-primary">
          <EyeOff size={14} className="shrink-0" />
          <span>Messages in this channel are posted anonymously</span>
        </div>
      )}

      {replyingTo && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-bg-secondary px-3 py-1.5 text-meta text-text-muted">
          <span>Replying to</span>
          <span className="font-semibold text-text-primary">{replyingTo.author}</span>
          <span className="min-w-0 flex-1 truncate text-text-muted">{replyingTo.content}</span>
          <button
            onClick={onCancelReply}
            className={cn(ICON_BTN, 'h-7 w-7')}
            aria-label="Cancel reply"
            title="Cancel reply"
          >
            <X size={15} />
          </button>
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
                  className={`relative flex flex-shrink-0 items-center gap-2 rounded-sm border bg-bg-tertiary px-2 py-1.5 ${
                    overLimit ? 'border-accent-danger' : 'border-border-subtle'
                  }`}
                  style={{ maxWidth: 'min(220px, 60vw)' }}
                >
                  {canPreviewImageFile(file) ? (
                    <img
                      src={stagedImagePreviews[i] || ''}
                      alt={file.name}
                      className="h-10 w-10 rounded-xs object-cover"
                    />
                  ) : (
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xs bg-bg-mod-subtle text-text-muted">
                      <FileText size={18} />
                    </span>
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-label text-text-primary">{file.name}</div>
                    <div
                      className={`text-meta tabular-nums ${overLimit ? 'text-accent-danger' : 'text-text-muted'}`}
                    >
                      {formatFileSize(file.size)}
                      {overLimit ? ' · exceeds limit' : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => removeFile(i)}
                    className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-bg-mod-strong text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger hover:text-text-on-danger focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                    aria-label={`Remove ${file.name}`}
                    title={`Remove ${file.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="px-0.5 text-meta text-text-muted">
            Max file size {formatFileSize(maxUploadSize)}
          </div>
        </div>
      )}

      {showPollComposer && (
        <div className="rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-section uppercase text-text-secondary">
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
                  className={ICON_BTN}
                  aria-label={`Remove option ${index + 1}`}
                >
                  <MinusCircle size={16} />
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
                className="h-4 w-4 rounded-xs accent-[color:var(--accent-primary)]"
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
        <div className="rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm">
          <label className="block">
            <span className="text-section uppercase text-text-secondary">Send At</span>
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="mt-1.5"
              min={toDatetimeLocalValue(Date.now() + SCHEDULED_MESSAGE_MIN_LEAD_MS)}
            />
          </label>
          <Button
            variant="link"
            size="sm"
            className="mt-2 h-auto px-0"
            onClick={() => setShowScheduledPanel(true)}
          >
            {scheduledCount > 0 ? `View scheduled (${scheduledCount})` : 'View scheduled'}
          </Button>
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

      {submitError && (
        <div
          className="rounded-md border border-accent-danger/40 bg-danger-tint px-3 py-2 text-meta font-semibold text-accent-danger"
          role="alert"
        >
          {submitError}
        </div>
      )}

      <div
        ref={composerShellRef}
        className={cn(
          // Constant 1px border so the drop state never reflows the composer (§7 Input,
          // no outer glow); focus-within paints the emerald edge + inset focus ring.
          'group relative flex min-h-[52px] items-end gap-1 rounded-md border px-2 py-1.5 transition-[background-color,border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]',
          isDragOver
            ? 'border-accent-primary bg-accent-tint'
            : 'border-border-subtle bg-bg-tertiary shadow-sm',
        )}
      >
        {nearLimit && (
          <span
            className={cn(
              'pointer-events-none absolute -top-6 right-1 rounded-xs px-1.5 py-0.5 text-meta tabular-nums',
              overLimit ? 'bg-danger-tint text-accent-danger' : 'text-text-muted',
            )}
          >
            {content.length}/{MAX_MESSAGE_LENGTH}
          </span>
        )}

        {/* Upload progress — indeterminate accent sweep while attachments upload. */}
        {uploading && (
          reduceMotion ? (
            <span className="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent-primary/70" />
          ) : (
            <span className="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full">
              <motion.span
                className="block h-full w-1/3 rounded-full bg-accent-primary"
                animate={{ x: ['-120%', '360%'] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
              />
            </span>
          )
        )}

        {showFormattingTools && (
          <motion.div
            {...popoverEnter}
            transition={popoverTransition}
            className="absolute bottom-full left-2 right-2 z-10 mb-2 rounded-md border border-border-subtle bg-bg-floating p-1 shadow-lg"
          >
            <MarkdownToolbar textareaRef={textareaRef} onContentChange={setContent} />
          </motion.div>
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
        {mentionQuery !== null && mentionResults.length > 0 && (
          <motion.div
            {...popoverEnter}
            transition={popoverTransition}
            className="absolute bottom-full left-2 right-2 z-20 mb-2 max-h-64 overflow-y-auto rounded-md border border-border-subtle bg-bg-floating p-1 shadow-lg"
          >
            {mentionResults.map((member, i) => (
              <button
                key={member.user.id}
                type="button"
                className={`flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${i === mentionIndex
                    ? 'bg-accent-tint text-text-primary'
                    : 'text-text-secondary hover:bg-accent-tint hover:text-text-primary'
                  }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(member.user.id);
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-tint-strong text-meta font-semibold text-accent-primary">
                  {displayName(member.user, member.nick).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-label text-text-primary">{displayName(member.user, member.nick)}</span>
                  {displayName(member.user, member.nick) !== member.user.username && (
                    <span className="ml-1.5 text-meta text-text-muted">@{member.user.username}</span>
                  )}
                </span>
              </button>
            ))}
          </motion.div>
        )}

        <button
          onClick={() => {
            if (!canAttachFiles) {
              setSubmitError("You don't have permission to attach files in this channel.");
              return;
            }
            if (showPollComposer) {
              setSubmitError('Disable poll composer before adding attachments.');
              return;
            }
            fileInputRef.current?.click();
          }}
          className={ICON_BTN}
          disabled={showPollComposer || !canAttachFiles || !canSendMessages}
          aria-label="Attach files"
          title={canAttachFiles ? 'Attach files' : "You can't attach files here"}
        >
          <Plus size={18} />
        </button>

        <button
          type="button"
          data-composer-picker-toggle="formatting"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setShowFormattingTools((prev) => !prev)}
          className={cn(ICON_BTN, showFormattingTools && ICON_BTN_ACTIVE)}
          aria-label="Formatting tools"
          title="Formatting tools"
        >
          <Type size={18} />
        </button>

        {canCreatePoll && (
          <button
            type="button"
            onClick={togglePollComposer}
            className={cn(ICON_BTN, showPollComposer && ICON_BTN_ACTIVE)}
            aria-label={showPollComposer ? 'Poll composer enabled' : 'Create a poll'}
            title={showPollComposer ? 'Poll composer enabled' : 'Create a poll'}
          >
            <BarChart3 size={18} />
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowScheduleComposer((prev) => !prev)}
          className={cn(ICON_BTN, showScheduleComposer && ICON_BTN_ACTIVE)}
          aria-label={showScheduleComposer ? 'Scheduling enabled' : 'Schedule message'}
          title={showScheduleComposer ? 'Scheduling enabled' : 'Schedule message'}
          disabled={showPollComposer}
        >
          <Clock3 size={18} />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            detectMentionQuery(e.target.value, e.target.selectionStart);
            triggerTyping();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            !canSendMessages
              ? "You can't send messages here"
              : showPollComposer
                ? 'Poll question above will be sent as a poll message'
                : showScheduleComposer
                  ? `Schedule message for ${channelName ? '#' + channelName : 'this channel'}`
                  : `Message ${channelName ? '#' + channelName : 'this channel'}`
          }
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={showPollComposer || !canSendMessages}
          className="flex-1 resize-none self-center bg-transparent px-1.5 py-2 text-body text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-70"
          style={{ maxHeight: '50vh' }}
        />

        {guildId && (
          <div className="relative">
            <button
              className={ICON_BTN}
              data-composer-picker-toggle="sticker"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => { setShowStickerPicker(!showStickerPicker); setShowGifPicker(false); setShowEmojiPicker(false); }}
              disabled={showPollComposer}
              aria-label="Stickers"
              title="Stickers"
            >
              {/* Sticker icon: a square with a folded corner (lucide-style stroke). */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5L15.5 2z" />
                <polyline points="15 2 15 9 22 9" />
                <circle cx="10" cy="14" r="2" />
                <path d="m20 17-1.09-1.09a2 2 0 0 0-2.82 0L10 22" />
              </svg>
            </button>
            {showStickerPicker && (
              <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={{ zIndex: 50 }}>
                <Suspense fallback={null}>
                  <StickerPicker
                    guildId={guildId}
                    onSelect={(stickerId) => {
                      setShowStickerPicker(false);
                      void (async () => {
                        try {
                          await useMessageStore.getState().sendMessage(channelId, '', replyingTo?.id, undefined, [stickerId]);
                          onCancelReply?.();
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
          </div>
        )}

        <div className="relative">
          <button
            className={ICON_BTN}
            data-composer-picker-toggle="gif"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { setShowGifPicker(!showGifPicker); setShowEmojiPicker(false); setShowStickerPicker(false); }}
            disabled={showPollComposer}
            aria-label="GIF"
            title="GIF"
          >
            <Image size={18} />
          </button>
          {showGifPicker && (
            <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={{ zIndex: 50 }}>
              <Suspense fallback={null}>
                <GifPicker
                  onSelect={(gifUrl) => {
                    setShowGifPicker(false);
                    void (async () => {
                      try {
                        await useMessageStore.getState().sendMessage(channelId, gifUrl, replyingTo?.id);
                        onCancelReply?.();
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
        </div>

        <div className="relative">
          <button
            className={ICON_BTN}
            data-composer-picker-toggle="emoji"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowGifPicker(false); setShowStickerPicker(false); }}
            disabled={showPollComposer}
            aria-label="Emoji"
            title="Emoji"
          >
            <Smile size={18} />
          </button>
          {showEmojiPicker && (
            <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={{ zIndex: 50 }}>
              <Suspense fallback={null}>
                <EmojiPicker
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
        </div>

        <motion.button
          onClick={() => void handleSubmit()}
          disabled={sendDisabled}
          whileTap={reduceMotion || sendDisabled ? undefined : { scale: [1, 1.08, 1] }}
          transition={{ duration: 0.32, ease: [0.2, 0.9, 0.3, 1.3] }}
          className={cn(
            'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
            sendDisabled
              ? 'cursor-not-allowed bg-bg-mod-subtle text-interactive-muted'
              : 'bg-accent-primary text-text-on-accent shadow-sm hover:bg-accent-primary-hover active:bg-accent-primary-active',
          )}
          aria-label={showScheduleComposer ? (schedulingMessage ? 'Scheduling message' : 'Schedule message') : 'Send message'}
          title={showScheduleComposer ? (schedulingMessage ? 'Scheduling message' : 'Schedule message') : 'Send message'}
        >
          {busy ? (
            <Loader2 size={17} className="animate-spin" />
          ) : showScheduleComposer ? (
            <Clock3 size={17} />
          ) : (
            <Send size={17} />
          )}
        </motion.button>
      </div>

      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border-2 border-dashed border-accent-primary/50 bg-bg-primary/60 backdrop-blur-sm">
          <div className="inline-flex items-center gap-2 text-subhead text-accent-primary">
            <Plus size={20} />
            Drop files to attach
          </div>
        </div>
      )}
    </div>
  );
}
