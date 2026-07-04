import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
import { EmojiPicker } from '../ui/EmojiPicker';
import { channelApi } from '../../api/channels';
import type { ChannelFeatureSettings } from '../../api/channels';
import { usePollStore } from '../../stores/pollStore';
import { useChannelStore } from '../../stores/channelStore';
import { MarkdownToolbar, applyMarkdownToolbarAction, resolveMarkdownShortcut } from './MarkdownToolbar';
import { GifPicker } from './GifPicker';
import { StickerPicker } from './StickerPicker';
import { SlashCommandPopup } from './SlashCommandPopup';
import { ScheduledMessagesPanel } from './ScheduledMessagesPanel';
import type { ApplicationCommand } from '../../types/commands';
import {
  getVersionedStorageItem,
  removeVersionedStorageItem,
  setVersionedStorageItem,
} from '../../lib/versionedStorage';
import { isAllowedImageMimeType } from '../../lib/security';
import { formatFileSize, toDatetimeLocalValue } from '../../lib/formatters';
import { toast } from '../../stores/toastStore';
import { extractApiError } from '../../api/client';

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
  const [showScheduledPanel, setShowScheduledPanel] = useState(false);
  const [scheduledCount, setScheduledCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useFileUpload(channelId);
  const { triggerTyping } = useTyping(channelId);
  const reduceMotion = useReducedMotion();
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const activeChannel = useMemo(
    () => Object.values(channelsByGuild).flat().find((channel) => channel.id === channelId),
    [channelsByGuild, channelId],
  );
  const activeChannelType = activeChannel?.channel_type ?? activeChannel?.type;
  const canCreatePoll = activeChannelType == null || (activeChannelType !== 2 && activeChannelType !== 4);

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

  // @mention autocomplete
  const allMembers = useMemberStore((s) => s.members);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionResults = useMemo(() => {
    if (mentionQuery === null || !guildId) return [];
    const guildMembers = allMembers.get(guildId) || [];
    const q = mentionQuery.toLowerCase();
    return guildMembers
      .filter((m) => {
        const name = (m.nick || m.user.username).toLowerCase();
        return name.includes(q);
      })
      .slice(0, 8);
  }, [mentionQuery, guildId, allMembers]);

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
    // Restore draft for this channel
    setContent(loadDraft(channelId));
    setMentionQuery(null);
    setSlashQuery(null);
    setShowPollComposer(false);
    setShowFormattingTools(false);
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
    setSubmitError(null);
    setShowScheduledPanel(false);
    setScheduledCount(0);
  }, [channelId]);

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

    if (!content.trim() && stagedFiles.length === 0) return;
    if (content.length > MAX_MESSAGE_LENGTH) {
      setSubmitError(`Message is too long (${content.length}/${MAX_MESSAGE_LENGTH}).`);
      return;
    }
    try {
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
        content.trim(),
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

    // Detect slash command: only at position 0, e.g. "/cmd"
    const slashMatch = text.match(/^\/(\w*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
    } else {
      setSlashQuery(null);
    }
  }, []);

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
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    // Dismiss slash popup on Escape
    if (slashQuery !== null) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashQuery(null);
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

  const busy = uploading || creatingPoll || schedulingMessage;
  const sendDisabled =
    busy ||
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
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
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
        <div className="flex gap-2 overflow-x-auto pb-1">
          {stagedFiles.map((file, i) => (
            <div
              key={i}
              className="relative flex flex-shrink-0 items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2 py-1.5"
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
                <div className="text-meta tabular-nums text-text-muted">{formatFileSize(file.size)}</div>
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
          ))}
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
        className={cn(
          'group relative flex min-h-[52px] items-end gap-1 rounded-md border px-2 py-1.5 transition-colors duration-[140ms] ease-[var(--ease-out)]',
          isDragOver
            ? 'border-2 border-dashed border-accent-primary bg-accent-tint'
            : 'border-border-subtle bg-bg-tertiary shadow-sm focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]',
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
            visible={slashQuery !== null}
            onSelectCommand={(cmd: ApplicationCommand) => {
              setContent(`/${cmd.name} `);
              setSlashQuery(null);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            onDismiss={() => setSlashQuery(null)}
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
                  {member.user.username.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-label text-text-primary">{member.nick || member.user.username}</span>
                  {member.nick && (
                    <span className="ml-1.5 text-meta text-text-muted">@{member.user.username}</span>
                  )}
                </span>
              </button>
            ))}
          </motion.div>
        )}

        <button
          onClick={() => {
            if (showPollComposer) {
              setSubmitError('Disable poll composer before adding attachments.');
              return;
            }
            fileInputRef.current?.click();
          }}
          className={ICON_BTN}
          disabled={showPollComposer}
          aria-label="Attach files"
          title="Attach files"
        >
          <Plus size={18} />
        </button>

        <button
          type="button"
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
          placeholder={showPollComposer ? 'Poll question above will be sent as a poll message' : showScheduleComposer ? `Schedule message for ${channelName ? '#' + channelName : 'this channel'}` : `Message ${channelName ? '#' + channelName : 'this channel'}`}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={showPollComposer}
          className="flex-1 resize-none self-center bg-transparent px-1.5 py-2 text-body text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-70"
          style={{ maxHeight: '50vh' }}
        />

        {guildId && (
          <div className="relative">
            <button
              className={ICON_BTN}
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
              </div>
            )}
          </div>
        )}

        <div className="relative">
          <button
            className={ICON_BTN}
            onClick={() => { setShowGifPicker(!showGifPicker); setShowEmojiPicker(false); setShowStickerPicker(false); }}
            disabled={showPollComposer}
            aria-label="GIF"
            title="GIF"
          >
            <Image size={18} />
          </button>
          {showGifPicker && (
            <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={{ zIndex: 50 }}>
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
            </div>
          )}
        </div>

        <div className="relative">
          <button
            className={ICON_BTN}
            onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowGifPicker(false); setShowStickerPicker(false); }}
            disabled={showPollComposer}
            aria-label="Emoji"
            title="Emoji"
          >
            <Smile size={18} />
          </button>
          {showEmojiPicker && (
            <div className="absolute bottom-full right-0 mb-2 max-w-[90vw]" style={{ zIndex: 50 }}>
              <EmojiPicker
                onSelect={(emoji) => {
                  setContent((prev) => `${prev}${emoji}`);
                  triggerTyping();
                  setShowEmojiPicker(false);
                }}
                onClose={() => setShowEmojiPicker(false)}
                guildId={guildId}
              />
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
