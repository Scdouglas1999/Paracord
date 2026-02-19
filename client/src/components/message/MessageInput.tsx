import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Plus, Smile, Send, X, FileText, BarChart3, PlusCircle, MinusCircle } from 'lucide-react';
import { useMessageStore } from '../../stores/messageStore';
import { useMemberStore } from '../../stores/memberStore';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useTyping } from '../../hooks/useTyping';
import { MAX_MESSAGE_LENGTH } from '../../lib/constants';
import { EmojiPicker } from '../ui/EmojiPicker';
import { channelApi } from '../../api/channels';
import { usePollStore } from '../../stores/pollStore';
import { useChannelStore } from '../../stores/channelStore';
import { MarkdownToolbar, applyMarkdownToolbarAction, resolveMarkdownShortcut } from './MarkdownToolbar';

interface MessageInputProps {
  channelId: string;
  guildId?: string;
  channelName?: string;
  replyingTo?: { id: string; author: string; content: string } | null;
  onCancelReply?: () => void;
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

const DRAFT_KEY_PREFIX = 'paracord:draft:';

function loadDraft(channelId: string): string {
  try {
    return localStorage.getItem(`${DRAFT_KEY_PREFIX}${channelId}`) || '';
  } catch {
    return '';
  }
}

function saveDraft(channelId: string, content: string) {
  try {
    if (content.trim()) {
      localStorage.setItem(`${DRAFT_KEY_PREFIX}${channelId}`, content);
    } else {
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${channelId}`);
    }
  } catch {
    // localStorage unavailable
  }
}

export function MessageInput({ channelId, guildId, channelName, replyingTo, onCancelReply }: MessageInputProps) {
  const [content, setContent] = useState(() => loadDraft(channelId));
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showFormattingTools, setShowFormattingTools] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollAllowMultiselect, setPollAllowMultiselect] = useState(false);
  const [pollDurationMinutes, setPollDurationMinutes] = useState(1440);
  const [creatingPoll, setCreatingPoll] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useFileUpload(channelId);
  const { triggerTyping } = useTyping(channelId);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const activeChannel = useMemo(
    () => Object.values(channelsByGuild).flat().find((channel) => channel.id === channelId),
    [channelsByGuild, channelId],
  );
  const activeChannelType = activeChannel?.channel_type ?? activeChannel?.type;
  const canCreatePoll = activeChannelType == null || (activeChannelType !== 2 && activeChannelType !== 4);

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
    setShowPollComposer(false);
    setShowFormattingTools(false);
    setPollQuestion('');
    setPollOptions(['', '']);
    setPollAllowMultiselect(false);
    setPollDurationMinutes(1440);
    setCreatingPoll(false);
    setSubmitError(null);
  }, [channelId]);

  const stagedImagePreviews = useMemo(
    () =>
      stagedFiles.map((file) => (
        file.type.startsWith('image/') ? URL.createObjectURL(file) : null
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
        const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
        setSubmitError(responseData?.message || responseData?.error || 'Failed to create poll.');
      } finally {
        setCreatingPoll(false);
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
      setContent('');
      saveDraft(channelId, '');
      setStagedFiles([]);
      onCancelReply?.();
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } catch {
      setSubmitError('Failed to send message.');
    }
  };

  /** Detect @mention query from cursor position */
  const detectMentionQuery = useCallback((text: string, cursorPos: number) => {
    const before = text.slice(0, cursorPos);
    const match = before.match(/@(\w*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }, []);

  const insertMention = useCallback((username: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = content.slice(0, textarea.selectionStart);
    const after = content.slice(textarea.selectionStart);
    const mentionStart = before.lastIndexOf('@');
    if (mentionStart === -1) return;
    const newContent = before.slice(0, mentionStart) + `@${username} ` + after;
    setContent(newContent);
    setMentionQuery(null);
    // Restore focus
    requestAnimationFrame(() => {
      const newPos = mentionStart + username.length + 2;
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
        if (selected) insertMention(selected.user.username);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
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
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
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

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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

  return (
    <div
      className="relative px-4 pb-[calc(var(--safe-bottom)+0.75rem)] pt-2 sm:px-6 sm:pb-5"
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {replyingTo && (
        <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border border-b-0 border-border-subtle bg-bg-mod-subtle px-3 py-2 text-xs text-text-muted sm:px-4 sm:py-2.5 sm:text-sm">
          <span>Replying to</span>
          <span style={{ color: 'var(--text-primary)' }} className="font-medium">{replyingTo.author}</span>
          <span className="truncate flex-1" style={{ color: 'var(--text-muted)' }}>{replyingTo.content}</span>
          <button onClick={onCancelReply} className="command-icon-btn h-8 w-8">
            <X size={16} />
          </button>
        </div>
      )}

      {stagedFiles.length > 0 && (
        <div
          className="flex gap-2 overflow-x-auto border border-b-0 border-border-subtle bg-bg-mod-subtle px-3 py-2.5 sm:px-4 sm:py-3"
          style={{
            borderTopLeftRadius: replyingTo ? '0' : '1rem',
            borderTopRightRadius: replyingTo ? '0' : '1rem',
          }}
        >
          {stagedFiles.map((file, i) => (
            <div
              key={i}
              className="group relative flex flex-shrink-0 items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-primary/70 p-2.5"
              style={{
                maxWidth: 'min(180px, 48vw)',
              }}
            >
              {file.type.startsWith('image/') ? (
                <img
                  src={stagedImagePreviews[i] || ''}
                  alt={file.name}
                  className="h-16 w-16 rounded-md object-cover"
                />
              ) : (
                <FileText size={24} style={{ color: 'var(--text-muted)' }} />
              )}
              <div className="min-w-0">
                <div className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{file.name}</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatFileSize(file.size)}</div>
              </div>
              <button
                onClick={() => removeFile(i)}
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border-subtle opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                style={{ backgroundColor: 'var(--accent-danger)', color: '#fff' }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showPollComposer && (
        <div
          className="border border-b-0 border-border-subtle bg-bg-mod-subtle px-3 py-3 sm:px-4 sm:py-3.5"
          style={{
            borderTopLeftRadius: (replyingTo || stagedFiles.length > 0) ? '0' : '1rem',
            borderTopRightRadius: (replyingTo || stagedFiles.length > 0) ? '0' : '1rem',
          }}
        >
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              <BarChart3 size={13} />
              Poll
            </span>
            <button
              type="button"
              onClick={togglePollComposer}
              className="rounded-md border border-border-subtle px-2 py-1 text-[11px] font-semibold text-text-muted transition-colors hover:text-text-primary"
            >
              Close
            </button>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-text-secondary">Question</span>
            <input
              type="text"
              maxLength={300}
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-lg border border-border-subtle bg-bg-primary/80 px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary/45"
              placeholder="Ask a question..."
            />
          </label>

          <div className="mt-3 flex flex-col gap-2">
            {pollOptions.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  type="text"
                  value={option}
                  maxLength={100}
                  onChange={(e) => updatePollOption(index, e.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-primary/80 px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-primary/45"
                  placeholder={`Option ${index + 1}`}
                />
                <button
                  type="button"
                  onClick={() => removePollOption(index)}
                  disabled={pollOptions.length <= 2}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
                  aria-label={`Remove option ${index + 1}`}
                >
                  <MinusCircle size={15} />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={addPollOption}
              disabled={pollOptions.length >= 10}
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            >
              <PlusCircle size={13} />
              Add Option
            </button>
            <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={pollAllowMultiselect}
                onChange={(e) => setPollAllowMultiselect(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border-subtle bg-bg-primary"
              />
              Allow multiple answers
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
              <span>Duration</span>
              <select
                value={pollDurationMinutes}
                onChange={(e) => setPollDurationMinutes(Number(e.target.value))}
                className="h-8 rounded-md border border-border-subtle bg-bg-primary/80 px-2 text-xs text-text-primary outline-none transition-colors focus:border-accent-primary/45"
              >
                {POLL_DURATION_OPTIONS.map((option) => (
                  <option key={option.minutes} value={option.minutes}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      {submitError && (
        <div className="mt-2 rounded-lg border border-accent-danger/40 bg-accent-danger/10 px-3 py-2 text-xs font-semibold" style={{ color: 'var(--accent-danger)' }}>
          {submitError}
        </div>
      )}

      <div
        className={`architect-input-shell relative flex min-h-[58px] items-center gap-2 rounded-[999px] border px-3 py-2 shadow-sm sm:min-h-[62px] sm:px-3.5 sm:py-2.5 ${
          isDragOver ? 'border-2 border-dashed border-accent-primary/70' : 'border-border-subtle'
        }`}
        style={{
          borderTopLeftRadius: (replyingTo || stagedFiles.length > 0 || showPollComposer) ? '16px' : '9999px',
          borderTopRightRadius: (replyingTo || stagedFiles.length > 0 || showPollComposer) ? '16px' : '9999px',
          borderBottomLeftRadius: '9999px',
          borderBottomRightRadius: '9999px',
        }}
      >
        {showFormattingTools && (
          <div className="absolute bottom-full left-3 right-3 z-10 mb-2 rounded-2xl border border-border-subtle bg-bg-primary/95 px-2 py-1.5 shadow-lg">
            <MarkdownToolbar textareaRef={textareaRef} onContentChange={setContent} />
          </div>
        )}

        {/* @mention autocomplete */}
        {mentionQuery !== null && mentionResults.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border-subtle bg-bg-floating shadow-lg backdrop-blur-lg">
            {mentionResults.map((member, i) => (
              <button
                key={member.user.id}
                type="button"
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                  i === mentionIndex
                    ? 'bg-accent-primary/15 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-mod-subtle'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(member.user.username);
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-primary text-[11px] font-semibold text-white">
                  {member.user.username.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{member.nick || member.user.username}</span>
                  {member.nick && (
                    <span className="ml-1.5 text-xs text-text-muted">@{member.user.username}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => {
            if (showPollComposer) {
              setSubmitError('Disable poll composer before adding attachments.');
              return;
            }
            fileInputRef.current?.click();
          }}
          className="command-icon-btn h-8 w-8 flex-shrink-0 border border-transparent text-text-secondary hover:border-border-subtle hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={showPollComposer}
          aria-label="Attach files"
          title="Attach files"
        >
          <Plus size={18} />
        </button>

        <button
          type="button"
          onClick={() => setShowFormattingTools((prev) => !prev)}
          className={`command-icon-btn h-8 w-8 flex-shrink-0 border transition-colors ${
            showFormattingTools
              ? 'border-accent-primary/45 bg-accent-primary/15 text-accent-primary'
              : 'border-transparent text-text-secondary hover:border-border-subtle hover:text-text-primary'
          }`}
          aria-label="Formatting tools"
          title="Formatting tools"
        >
          <FileText size={17} />
        </button>

        {canCreatePoll && (
          <button
            type="button"
            onClick={togglePollComposer}
            className={`command-icon-btn h-8 w-8 flex-shrink-0 border transition-colors ${
              showPollComposer
                ? 'border-accent-primary/45 bg-accent-primary/15 text-accent-primary'
                : 'border-transparent text-text-secondary hover:border-border-subtle hover:text-text-primary'
            }`}
            aria-label={showPollComposer ? 'Poll composer enabled' : 'Create a poll'}
            title={showPollComposer ? 'Poll composer enabled' : 'Create a poll'}
          >
            <BarChart3 size={16} />
          </button>
        )}

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
          placeholder={showPollComposer ? 'Poll question above will be sent as a poll message' : `Message ${channelName ? '#' + channelName : 'this channel'}`}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={showPollComposer}
          className="flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-70"
          style={{
            color: 'var(--text-primary)',
            maxHeight: '50vh',
            lineHeight: '1.45rem',
          }}
        />

        <div className="relative">
          <button
            className="command-icon-btn h-8 w-8 flex-shrink-0 border border-transparent text-text-secondary hover:border-border-subtle hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
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

        <button
          onClick={() => void handleSubmit()}
          disabled={uploading || creatingPoll || (!showPollComposer && !content.trim() && stagedFiles.length === 0)}
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Send message"
          title="Send message"
        >
          <Send size={17} />
        </button>
      </div>

      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent-primary/50 bg-bg-primary/60 backdrop-blur-sm">
          <div className="text-lg font-semibold" style={{ color: 'var(--accent-primary)' }}>
            Drop files to upload
          </div>
        </div>
      )}
    </div>
  );
}
