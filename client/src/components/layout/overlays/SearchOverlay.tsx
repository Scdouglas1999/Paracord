import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import {
  AtSign,
  Calendar,
  ChevronsUpDown,
  File,
  Hash,
  Image,
  Link2,
  ListChecks,
  MessagesSquare,
  PanelTop,
  Pin,
  Search,
  User,
  Video,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { extractApiError } from '../../../api/client';
import { guildApi } from '../../../api/guilds';
import type { GuildMessageSearchHit } from '../../../api/guilds';
import { useChannel, useGuildChannels } from '../../../hooks/useChannels';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useMobile } from '../../../hooks/useMobile';
import { useCurrentMessageStore } from '../../../hooks/useMessageStore';
import { personLight } from '../../../lib/attention/personLight';
import { displayName } from '../../../lib/displayName';
import { wallClock } from '../../../lib/formatters';
import { messageSnippetText } from '../../../lib/markdown';
import {
  applyChip,
  chipLabel,
  draftWithoutActive,
  interpretSearchDraft,
  searchLoadedMessages,
  suggestionsFor,
  toGuildSearchParams,
  type CatalogChannel,
  type CatalogMember,
  type HasFilter,
  type SearchChip,
  type SearchSuggestion,
} from '../../../lib/search/query';
import {
  clearRecentSearches,
  forgetSearch,
  readRecentSearches,
  rememberSearch,
  type RecentSearch,
} from '../../../lib/search/recent';
import { entityScopeKey } from '../../../lib/serverScope';
import { cn } from '../../../lib/utils';
import { useMemberStore } from '../../../stores/memberStore';
import type { Message } from '../../../types';
import { LitAvatar } from '../../light/LitAvatar';
import { Chip } from '../../ui/Chip';
import { ResourceImage } from '../../ui/ResourceImage';

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  guildId?: string | null;
  channelId?: string;
  channelName?: string;
  panelRef?: RefObject<HTMLElement | null>;
}

type Scope = 'server' | 'channel' | 'conversation';

const PAGE_SIZE = 25;
/** Rows past this many appear without the entrance, so a long page does not ripple. */
const ANIMATED_ROWS = 8;
const EMPTY_MESSAGES: Message[] = [];

const FILTER_GUIDE: Array<{ insert: string; hint: string; icon: LucideIcon; serverOnly?: boolean }> = [
  { insert: 'from:', hint: 'a person', icon: User },
  { insert: 'in:', hint: 'a channel', icon: Hash, serverOnly: true },
  { insert: 'has:', hint: 'link, image, video, file, poll, embed', icon: Link2 },
  { insert: 'mentions:', hint: 'a person', icon: AtSign },
  { insert: 'before:', hint: 'a date', icon: Calendar },
  { insert: 'after:', hint: 'a date', icon: Calendar },
  { insert: 'during:', hint: '2026-09-01, today, yesterday, last week', icon: Calendar },
  { insert: 'is:pinned', hint: 'pinned messages', icon: Pin },
];

const HAS_ICON: Record<HasFilter, LucideIcon> = {
  link: Link2,
  image: Image,
  video: Video,
  file: File,
  poll: ListChecks,
  embed: PanelTop,
};

/** Text, announcement, thread and forum channels hold messages the server can search. */
function isSearchableType(type: number | undefined): boolean {
  return type === 0 || type === 5 || type === 6 || type === 7;
}

function highlightTerms(text: string, query: string): ReactNode {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return text;
  const lower = text.toLowerCase();
  const marks: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lower.length;) {
    const hit = terms.find((term) => lower.startsWith(term, index));
    if (hit) {
      marks.push({ start: index, end: index + hit.length });
      index += hit.length;
    } else {
      index += 1;
    }
  }
  if (!marks.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  marks.forEach((mark, index) => {
    if (mark.start > cursor) parts.push(text.slice(cursor, mark.start));
    parts.push(
      <mark key={index} className="pc-search-mark">
        {text.slice(mark.start, mark.end)}
      </mark>,
    );
    cursor = mark.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function formatWhen(raw: string | undefined): string {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  // The app's one wall clock ("3:04 pm"), not the locale's "3:04 PM".
  return `${day}, ${wallClock(date)}`;
}

interface HitGroup {
  channelId: string;
  channelName: string;
  thread: boolean;
  hits: GuildMessageSearchHit[];
}

/** Channels in the order their newest result appears; each channel's results newest first. */
function groupHits(hits: readonly GuildMessageSearchHit[]): HitGroup[] {
  const groups: HitGroup[] = [];
  const byChannel = new Map<string, HitGroup>();
  for (const hit of hits) {
    let group = byChannel.get(hit.channel_id);
    if (!group) {
      group = {
        channelId: hit.channel_id,
        channelName: hit.channel_name,
        thread: Boolean(hit.thread_parent_id),
        hits: [],
      };
      byChannel.set(hit.channel_id, group);
      groups.push(group);
    }
    group.hits.push(hit);
  }
  return groups;
}

function suggestionIcon(chip: SearchChip): LucideIcon {
  switch (chip.kind) {
    case 'has':
      return HAS_ICON[chip.value];
    case 'in':
      return Hash;
    case 'pinned':
      return Pin;
    case 'before':
    case 'after':
    case 'during':
      return Calendar;
    case 'from':
    case 'mentions':
      return User;
  }
}

function hitId(hit: GuildMessageSearchHit): string {
  return `search-hit-${hit.message.id}`;
}

export function SearchOverlay({
  open,
  onClose,
  guildId,
  channelId,
  channelName,
  panelRef,
}: SearchOverlayProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const mobile = useMobile();
  const scopeAccount = useCurrentAccountScope();
  const activeChannel = useChannel(channelId);
  const guildChannels = useGuildChannels(guildId);
  const loadedMessages = useCurrentMessageStore((state) => (
    channelId ? state.messages[channelId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  ));
  const memberKey = scopeAccount && guildId ? entityScopeKey(scopeAccount, guildId) : null;
  const members = useMemberStore((state) => (memberKey ? state.members.get(memberKey) : undefined));
  const membersLoaded = useMemberStore((state) => (memberKey ? Boolean(state.membersLoaded[memberKey]) : false));

  const channelType = activeChannel?.type ?? activeChannel?.channel_type;
  // Direct conversations are end-to-end encrypted: the instance cannot read
  // them, so they are searched here, over what this device has decrypted.
  const conversation = channelType === 1 || channelType === 3 || !guildId;
  const canScopeChannel = !conversation && Boolean(channelId) && isSearchableType(channelType);
  const [serverScope, setServerScope] = useState<'server' | 'channel'>('server');
  const scope: Scope = conversation
    ? 'conversation'
    : serverScope === 'channel' && canScopeChannel
      ? 'channel'
      : 'server';
  const recentScope = conversation ? `dm:${channelId ?? 'none'}` : `guild:${guildId}`;

  const [draft, setDraft] = useState('');
  const [chips, setChips] = useState<SearchChip[]>([]);
  const [hits, setHits] = useState<GuildMessageSearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [selected, setSelected] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  /** Bumped per fresh result set so its rows replay the entrance. */
  const [resultKey, setResultKey] = useState(0);

  useEffect(() => {
    if (!open || !guildId || !scopeAccount || conversation) return;
    void useMemberStore.getState().fetchMembers(guildId, scopeAccount);
  }, [open, guildId, scopeAccount, conversation]);

  useEffect(() => {
    if (!open) return;
    try {
      setRecents(readRecentSearches(recentScope));
      setRecentError(null);
    } catch (err) {
      setRecents([]);
      setRecentError(err instanceof Error ? err.message : String(err));
    }
  }, [open, recentScope]);

  const catalogMembers = useMemo<CatalogMember[]>(() => {
    if (!conversation) {
      return (members ?? []).map((member) => ({
        id: member.user.id,
        label: displayName(member.user, member.nick),
        names: [member.user.username, member.user.display_name ?? '', member.nick ?? ''],
        avatar: member.user.avatar_hash ?? member.user.avatar ?? null,
      }));
    }
    // In a conversation the people are whoever wrote the messages on hand.
    const byId = new Map<string, CatalogMember>();
    for (const message of loadedMessages) {
      const author = message.author;
      if (!author?.id || byId.has(author.id)) continue;
      byId.set(author.id, {
        id: author.id,
        label: displayName(author),
        names: [author.username, author.display_name ?? ''],
        avatar: author.avatar_hash ?? author.avatar ?? null,
      });
    }
    return [...byId.values()];
  }, [conversation, members, loadedMessages]);

  const catalogChannels = useMemo<CatalogChannel[]>(() => {
    if (conversation) return [];
    return guildChannels
      .filter((channel) => isSearchableType(channel.type ?? channel.channel_type))
      .map((channel) => ({ id: channel.id, name: (channel.name || 'channel').replace(/^#/, '') }));
  }, [conversation, guildChannels]);

  const memberById = useMemo(() => new Map(catalogMembers.map((member) => [member.id, member])), [catalogMembers]);
  // The maps a snippet resolves mentions through — the same people and
  // channels the `from:`/`in:` filters complete against.
  const mentionNames = useMemo(
    () => new Map(catalogMembers.map((member) => [member.id, member.label])),
    [catalogMembers],
  );
  const channelMentionNames = useMemo(
    () => new Map(catalogChannels.map((channel) => [channel.id, channel.name])),
    [catalogChannels],
  );

  const interpreted = useMemo(
    () => interpretSearchDraft(draft, catalogMembers, catalogChannels, new Date()),
    [draft, catalogMembers, catalogChannels],
  );
  const freeText = draftWithoutActive(draft, interpreted.active);
  const suggestions = useMemo(
    () => (interpreted.active
      ? suggestionsFor(interpreted.active, catalogMembers, catalogChannels, new Date())
      : []),
    [interpreted.active, catalogMembers, catalogChannels],
  );
  const menuOpen = Boolean(interpreted.active) && !interpreted.error;
  const hasQuery = Boolean(freeText.trim() || chips.length) && !interpreted.error && !interpreted.active;

  const params = useMemo(() => {
    const next = toGuildSearchParams(chips, freeText);
    if (scope === 'channel' && channelId && !next.channel_id) next.channel_id = channelId;
    return next;
  }, [chips, freeText, scope, channelId]);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const localHits = useMemo<GuildMessageSearchHit[]>(() => {
    if (!conversation || !hasQuery || !channelId) return [];
    return searchLoadedMessages(loadedMessages, chips, freeText).map((message) => ({
      message,
      channel_id: channelId,
      channel_name: channelName || 'conversation',
    }));
  }, [conversation, hasQuery, channelId, loadedMessages, chips, freeText, channelName]);

  const visibleHits = conversation ? localHits : hits;
  const visibleTotal = conversation ? localHits.length : total;
  const groups = useMemo(() => groupHits(visibleHits), [visibleHits]);
  // Keyboard order is the order on screen, which grouping can change.
  const orderedHits = useMemo(() => groups.flatMap((group) => group.hits), [groups]);
  const hitOrder = useMemo(() => new Map(orderedHits.map((hit, index) => [hit, index])), [orderedHits]);

  useEffect(() => {
    setSelected(0);
  }, [freeText, chips, scope]);

  useEffect(() => {
    setMenuIndex(0);
  }, [interpreted.active?.key, interpreted.active?.raw]);

  useEffect(() => {
    if (!open || conversation || !guildId) return;
    if (!hasQuery) {
      setHits([]);
      setTotal(0);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let canceled = false;
    setSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const { data } = await guildApi.searchMessages(guildId, { ...params, limit: PAGE_SIZE, offset: 0 });
        if (canceled) return;
        setSearchError(null);
        setHits(data.messages);
        setTotal(data.total);
        setResultKey((key) => key + 1);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      } catch (err) {
        if (canceled) return;
        setHits([]);
        setTotal(0);
        setSearchError(extractApiError(err));
      } finally {
        if (!canceled) setSearching(false);
      }
    }, 250);
    return () => {
      canceled = true;
      clearTimeout(timeout);
    };
  }, [open, conversation, guildId, hasQuery, params]);

  const loadMore = useCallback(async () => {
    if (conversation || !guildId || loadingMore || searching) return;
    if (hits.length === 0 || hits.length >= total) return;
    setLoadingMore(true);
    try {
      const { data } = await guildApi.searchMessages(guildId, {
        ...paramsRef.current,
        limit: PAGE_SIZE,
        offset: hits.length,
      });
      setHits((current) => {
        const seen = new Set(current.map((hit) => hit.message.id));
        return [...current, ...data.messages.filter((hit) => !seen.has(hit.message.id))];
      });
      // A page that comes back short means messages were removed meanwhile.
      setTotal(data.messages.length ? data.total : hits.length);
    } catch (err) {
      setSearchError(extractApiError(err));
    } finally {
      setLoadingMore(false);
    }
  }, [conversation, guildId, loadingMore, searching, hits.length, total]);

  const moreToLoad = !conversation && hits.length > 0 && hits.length < total;
  useEffect(() => {
    const node = sentinelRef.current;
    const root = scrollRef.current;
    if (!node || !root || !moreToLoad) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root, rootMargin: '0px 0px 240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [moreToLoad, loadMore]);

  useEffect(() => {
    const hit = orderedHits[selected];
    const row = hit ? document.getElementById(hitId(hit)) : null;
    if (typeof row?.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [selected, orderedHits]);

  const focusField = () => inputRef.current?.focus();

  const commitDraft = useCallback((value: string) => {
    const next = interpretSearchDraft(value, catalogMembers, catalogChannels, new Date());
    if (next.chips.length) {
      setChips((current) => next.chips.reduce(applyChip, current));
      // Keep a trailing space so the next word does not glue to the last one.
      setDraft(next.remainder ? `${next.remainder} ` : '');
    } else {
      setDraft(value);
    }
  }, [catalogMembers, catalogChannels]);

  // A `from:yara` typed before the member list arrived resolves once it does;
  // move it out of the field then, so it is never searched as plain text.
  useEffect(() => {
    if (interpreted.chips.length) commitDraft(draft);
  }, [interpreted.chips.length, commitDraft, draft]);

  const chooseSuggestion = useCallback((suggestion: SearchSuggestion) => {
    setChips((current) => applyChip(current, suggestion.chip));
    const rest = draftWithoutActive(draft, interpreted.active);
    setDraft(rest ? `${rest} ` : '');
    focusField();
  }, [draft, interpreted.active]);

  const insertFilter = (insert: string) => {
    const base = draft.trimEnd();
    commitDraft(base ? `${base} ${insert}` : insert);
    focusField();
  };

  const saveRecent = useCallback(() => {
    const label = [freeText, ...chips.map(chipLabel)].filter(Boolean).join(' ');
    try {
      setRecents(rememberSearch(recentScope, { label, text: freeText, chips }));
    } catch (err) {
      setRecentError(err instanceof Error ? err.message : String(err));
    }
  }, [freeText, chips, recentScope]);

  const jumpTo = useCallback((hit: GuildMessageSearchHit) => {
    saveRecent();
    const hash = `msg-${hit.message.id}`;
    const pathname = conversation
      ? `/app/dms/${hit.channel_id}`
      : `/app/guilds/${guildId}/channels/${hit.channel_id}`;
    if (window.location.pathname === pathname) {
      // Same channel: the message list listens for the hash to change.
      if (window.location.hash === `#${hash}`) window.location.hash = '';
      window.location.hash = hash;
    } else {
      navigate({ pathname, hash });
    }
    onClose();
  }, [saveRecent, conversation, guildId, navigate, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && draft === '' && chips.length) {
      event.preventDefault();
      setChips((current) => current.slice(0, -1));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (menuOpen && suggestions.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMenuIndex((index) => Math.min(index + 1, suggestions.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMenuIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const suggestion = suggestions[menuIndex];
        if (suggestion) chooseSuggestion(suggestion);
        return;
      }
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((index) => Math.min(index + 1, Math.max(orderedHits.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // While a search is on its way, the list on screen answers the previous
      // words: Enter waits for the results rather than opening one of those.
      if (!searching && orderedHits[selected]) jumpTo(orderedHits[selected]);
    }
  };

  const scopeLabel = scope === 'conversation'
    ? 'This conversation'
    : scope === 'channel'
      ? 'This channel'
      : 'This server';

  const activeDescendant = menuOpen && suggestions[menuIndex]
    ? `search-suggestion-${menuIndex}`
    : orderedHits[selected] && hasQuery
      ? hitId(orderedHits[selected])
      : undefined;

  const header = (
    <header className="shrink-0 border-b border-border-subtle px-3 pb-3 pt-3">
      <div className="flex items-start gap-2">
        {/* A label for the field: a click anywhere in the well that is not a chip focuses it. */}
        <label
          htmlFor="message-search-field"
          className={cn(
            'pc-well flex min-h-[var(--h-control-phone)] min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-[var(--radius-well)] py-1.5 pl-2 pr-2',
            '',
            'focus-within:shadow-[var(--shadow-well),var(--focus-ring)]',
          )}
        >
          <Search size={16} className="ml-0.5 shrink-0 text-text-muted" aria-hidden />
          {canScopeChannel ? (
            <Chip
              as="button"
              tone="accent"
              aria-label={`Searching ${scopeLabel.toLowerCase()}. Switch to ${scope === 'server' ? 'this channel' : 'this server'}.`}
              onClick={() => {
                setServerScope((current) => (current === 'server' ? 'channel' : 'server'));
                focusField();
              }}
            >
              {scopeLabel}
              <ChevronsUpDown size={12} aria-hidden />
            </Chip>
          ) : (
            <Chip tone="accent">{scopeLabel}</Chip>
          )}
          {chips.map((chip, index) => (
            <Chip
              key={`${chipLabel(chip)}-${index}`}
              as="button"
              aria-label={`Remove ${chipLabel(chip)}`}
              onClick={() => {
                setChips((current) => current.filter((_, chipIndex) => chipIndex !== index));
                focusField();
              }}
              className="text-text-primary"
            >
              {chipLabel(chip)}
              <X size={12} className="text-text-muted" aria-hidden />
            </Chip>
          ))}
          <input
            ref={inputRef}
            id="message-search-field"
            autoFocus
            role="combobox"
            aria-label="Search messages"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? 'search-suggestions' : 'search-results'}
            aria-activedescendant={activeDescendant}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="h-7 min-w-[6rem] flex-1 bg-transparent px-0.5 text-label text-text-primary outline-none placeholder:text-text-faint"
            placeholder={chips.length ? 'Add words or filters' : 'Words or filters'}
            value={draft}
            onChange={(event) => commitDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="inline-flex h-[var(--h-control-phone)] w-9 shrink-0 items-center justify-center rounded-chip text-text-muted outline-none hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
      {conversation && (
        <p className="mt-2 px-1 text-meta text-text-muted">Searching messages loaded on this device</p>
      )}
    </header>
  );

  const menu = menuOpen ? (
    <ul
      id="search-suggestions"
      role="listbox"
      aria-label="Filter suggestions"
      className="pc-enter mb-2 overflow-hidden rounded-[var(--radius-control)] bg-bg-raised py-1 shadow-[var(--shadow-lifted)]"
    >
      <li role="presentation" className="px-3 pb-1 pt-1.5 text-meta text-text-faint">
        {interpreted.active?.key === 'from' || interpreted.active?.key === 'mentions'
          ? 'People'
          : interpreted.active?.key === 'in'
            ? 'Channels'
            : interpreted.active?.key === 'has'
              ? 'Messages with'
              : interpreted.active?.key === 'is'
                ? 'Messages that are'
                : 'Dates'}
      </li>
      {suggestions.length === 0 ? (
        <li role="presentation" className="px-3 py-2 text-label text-text-muted">
          {interpreted.active?.key === 'from' || interpreted.active?.key === 'mentions'
            ? (conversation || membersLoaded ? 'No one matches.' : 'Loading members…')
            : interpreted.active?.key === 'in'
              ? 'No channels match.'
              : interpreted.active && ['before', 'after', 'during'].includes(interpreted.active.key)
                ? 'Type a date like 2026-09-01.'
                : 'No matches.'}
        </li>
      ) : suggestions.map((suggestion, index) => {
        const person = suggestion.chip.kind === 'from' || suggestion.chip.kind === 'mentions'
          ? memberById.get(suggestion.chip.userId)
          : undefined;
        const Icon = suggestionIcon(suggestion.chip);
        return (
          <li
            key={suggestion.id}
            id={`search-suggestion-${index}`}
            role="option"
            aria-selected={index === menuIndex}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setMenuIndex(index)}
            onClick={() => chooseSuggestion(suggestion)}
            className={cn(
              'mx-1 flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-chip)] px-2 py-1.5 text-label',
              index === menuIndex ? 'bg-bg-mod-strong text-text-primary' : 'text-text-secondary',
            )}
          >
            {person ? (
              <LitAvatar
                size={22}
                hideLabel
                person={personLight({ userId: person.id, name: person.label, status: null, avatar: person.avatar })}
              />
            ) : (
              <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center text-text-muted">
                <Icon size={16} aria-hidden />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
            {suggestion.hint && <span className="shrink-0 font-code text-meta text-text-muted">{suggestion.hint}</span>}
          </li>
        );
      })}
    </ul>
  ) : null;

  let body: ReactNode = null;
  const alertText = interpreted.error ?? searchError;
  if (alertText) {
    body = <p role="alert" className="px-3 py-6 text-label text-accent-danger">{alertText}</p>;
  } else if (menuOpen) {
    body = null;
  } else if (!hasQuery) {
    body = (
      <div className="pb-2">
        {recentError && (
          <div role="alert" className="flex items-center gap-2 px-3 pt-3 text-label text-accent-danger">
            <span className="min-w-0 flex-1">{recentError}</span>
            <button
              type="button"
              onClick={() => {
                clearRecentSearches(recentScope);
                setRecentError(null);
                setRecents([]);
              }}
              className="shrink-0 rounded-chip px-2 py-1 text-meta font-semibold text-text-secondary outline-none hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            >
              Clear them
            </button>
          </div>
        )}
        {recents.length > 0 && (
          <section aria-labelledby="search-recent-title">
            <h3 id="search-recent-title" className="px-3 pb-1.5 pt-3 text-section text-text-faint">Recent searches</h3>
            <ul>
              {recents.map((recent) => (
                <li key={recent.id} className="group flex items-center gap-1 px-1">
                  <button
                    type="button"
                    onClick={() => {
                      setChips(recent.chips);
                      setDraft(recent.text);
                      focusField();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-chip px-2 py-1.5 text-left text-label text-text-secondary outline-none hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                  >
                    <Search size={14} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="min-w-0 truncate">{recent.label}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove recent search ${recent.label}`}
                    onClick={() => {
                      try {
                        setRecents(forgetSearch(recentScope, recent.id));
                      } catch (err) {
                        setRecentError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-chip text-text-muted outline-none hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-labelledby="search-filters-title">
          <h3 id="search-filters-title" className="px-3 pb-1.5 pt-3 text-section text-text-faint">Narrow it down</h3>
          <ul>
            {FILTER_GUIDE.filter((filter) => !(conversation && filter.serverOnly)).map((filter) => (
              <li key={filter.insert} className="px-1">
                <button
                  type="button"
                  onClick={() => insertFilter(filter.insert)}
                  className="flex w-full items-center gap-2.5 rounded-chip px-2 py-1.5 text-left outline-none hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                >
                  <filter.icon size={14} className="shrink-0 text-text-muted" aria-hidden />
                  <span className="shrink-0 font-code text-meta font-semibold text-text-primary">{filter.insert}</span>
                  <span className="min-w-0 truncate text-meta text-text-muted">{filter.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  } else if (visibleHits.length === 0 && searching) {
    body = (
      <p role="status" aria-live="polite" className="px-3 py-6 text-label text-text-muted">
        Searching messages…
      </p>
    );
  } else if (visibleHits.length === 0) {
    const lastChip = chips[chips.length - 1];
    body = (
      <div className="px-3 py-6">
        <p className="text-label text-text-primary">No messages match this search.</p>
        {lastChip ? (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-label text-text-muted">
            Try dropping a filter:
            <Chip
              as="button"
              aria-label={`Remove ${chipLabel(lastChip)}`}
              onClick={() => {
                setChips((current) => current.slice(0, -1));
                focusField();
              }}
            >
              {chipLabel(lastChip)}
              <X size={12} className="text-text-muted" aria-hidden />
            </Chip>
          </p>
        ) : (
          <p className="mt-1 text-label text-text-muted">
            {conversation ? 'Only messages loaded on this device can be searched.' : 'Try fewer or different words.'}
          </p>
        )}
      </div>
    );
  } else {
    body = (
      <div id="search-results" key={resultKey}>
        <p className="flex items-center justify-between px-3 pb-1 pt-2 text-meta text-text-muted" aria-live="polite">
          <span>{visibleTotal === 1 ? '1 result' : `${visibleTotal.toLocaleString()} results`}</span>
          {searching && <span>Updating…</span>}
        </p>
        {groups.map((group) => (
          <section key={group.channelId} aria-label={group.channelName}>
            {!conversation && (
              <h3 className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-section text-text-faint">
                {group.thread
                  ? <MessagesSquare size={13} className="shrink-0" aria-hidden />
                  : <Hash size={13} className="shrink-0" aria-hidden />}
                <span className="min-w-0 truncate">{group.channelName}</span>
              </h3>
            )}
            <ul className="px-1">
              {group.hits.map((hit) => {
                const index = hitOrder.get(hit) ?? 0;
                const animate = index < ANIMATED_ROWS;
                const author = hit.message.author;
                const authorName = displayName(author);
                const images = (hit.message.attachments ?? []).filter((attachment) =>
                  !attachment.encryption
                  && (attachment.content_type ?? '').toLowerCase().startsWith('image/'));
                const otherFiles = (hit.message.attachments ?? []).length - images.length;
                const text = hit.message.content
                  ? messageSnippetText(hit.message.content, mentionNames, undefined, channelMentionNames)
                  : '';
                return (
                  <li key={hit.message.id}>
                    <button
                      id={hitId(hit)}
                      type="button"
                      onClick={() => jumpTo(hit)}
                      onMouseMove={() => { if (selected !== index) setSelected(index); }}
                      className={cn(
                        'flex w-full gap-3 rounded-chip px-2 py-2 text-left outline-none focus-visible:shadow-[var(--focus-ring)]',
                        animate && 'pc-search-row',
                        index === selected ? 'bg-bg-mod-subtle' : 'hover:bg-bg-mod-subtle',
                      )}
                      style={animate ? { animationDelay: `calc(var(--stagger-light) * ${index})` } : undefined}
                    >
                      <LitAvatar
                        size={32}
                        hideLabel
                        className="mt-0.5"
                        person={personLight({
                          userId: author?.id ?? hit.message.id,
                          name: authorName,
                          status: null,
                          avatar: author?.avatar_hash ?? author?.avatar ?? null,
                        })}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 truncate text-label font-semibold text-text-primary">{authorName}</span>
                          <span className="shrink-0 text-meta tabular-nums text-text-muted">
                            {formatWhen(hit.message.created_at || hit.message.timestamp)}
                          </span>
                          {hit.message.pinned && <Pin size={12} className="shrink-0 text-text-muted" aria-label="Pinned" />}
                        </span>
                        {text ? (
                          <span className="mt-0.5 line-clamp-4 block whitespace-pre-line break-words text-label text-text-secondary">
                            {highlightTerms(text, freeText)}
                          </span>
                        ) : null}
                        {images.length > 0 && (
                          <span className="mt-1.5 flex gap-1.5">
                            {images.slice(0, 3).map((attachment) => (
                              <ResourceImage
                                key={attachment.id}
                                src={attachment.proxy_url || attachment.url}
                                alt={attachment.filename}
                                className="h-14 w-14 rounded-[var(--radius-chip)] bg-bg-well object-cover"
                              />
                            ))}
                          </span>
                        )}
                        {otherFiles > 0 && (
                          <span className="mt-1 flex items-center gap-1 text-meta text-text-muted">
                            <File size={12} aria-hidden />
                            {otherFiles === 1 ? '1 file' : `${otherFiles} files`}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {moreToLoad && <div ref={sentinelRef} className="h-6" aria-hidden />}
        {loadingMore && <p role="status" className="px-3 py-2 text-meta text-text-muted">Loading more…</p>}
      </div>
    );
  }

  if (!open) return null;

  const fill = mobile;
  return (
    <aside
      ref={panelRef}
      aria-label="Search messages"
      tabIndex={-1}
      data-testid="context-panel"
      data-mode="search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden outline-none',
        fill
          ? 'h-full w-full bg-bg-plate pt-[env(safe-area-inset-top)]'
          : 'pc-plate my-[var(--gutter)] mr-[var(--gutter)] h-[calc(100%-var(--gutter)*2)]',
      )}
      style={fill ? undefined : { width: 'var(--w-context-panel)' }}
    >
      {header}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {menu}
        {body}
      </div>
    </aside>
  );
}
