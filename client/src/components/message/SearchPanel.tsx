import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search, SearchX, X, Loader2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { channelApi } from '../../api/channels';
import { useUIStore } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { formatTimestamp } from '../../lib/formatters';
import { EmptyState, ErrorBanner } from '../ui/Feedback';
import type { Message } from '../../types';

// Wraps case-insensitive matches of `query` in an accent-tint mention chip so the
// reason a row surfaced reads at a glance (design-spec §7 mention chip).
function highlightMatches(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let idx = lower.indexOf(lowerQ);
  let key = 0;
  while (idx !== -1) {
    if (idx > start) parts.push(text.slice(start, idx));
    parts.push(
      <mark key={key++} className="rounded-xs bg-accent-tint px-0.5 text-accent-primary">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    start = idx + q.length;
    idx = lower.indexOf(lowerQ, start);
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

export function SearchPanel() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const allChannels = Object.values(channelsByGuild).flat();
  const currentChannel = allChannels.find((c) => c.id === channelId);
  const myUserId = useAuthStore((s) => s.user?.id ?? null);

  const [query, setQuery] = useState('');
  const [authorQuery, setAuthorQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [results, setResults] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextPanelMode(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setContextPanelMode]);

  // Debounced search
  useEffect(() => {
    if (!channelId || !query.trim()) {
      setResults([]);
      setHasSearched(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    const timeout = setTimeout(async () => {
      const normalizedAuthor = authorQuery.trim().toLowerCase();
      const after = fromDate ? `${fromDate}T00:00:00Z` : undefined;
      const before = toDate ? `${toDate}T23:59:59Z` : undefined;
      const authorId = onlyMine ? myUserId ?? undefined : undefined;
      const applyLocalAuthorFilter = (list: Message[]) =>
        normalizedAuthor
          ? list.filter((m) => (m.author?.username || '').toLowerCase().includes(normalizedAuthor))
          : list;
      try {
        const { data } = await channelApi.searchMessages(channelId, query.trim(), 25, {
          author_id: authorId,
          after,
          before,
        });
        setResults(applyLocalAuthorFilter(data));
        setError(null);
      } catch {
        // Fallback: client-side filter on recent messages
        try {
          const { data: recent } = await channelApi.getMessages(channelId, { limit: 100 });
          const q = query.trim().toLowerCase();
          const fallback = recent
            .filter((m) => {
              const content = (m.content ?? '').toLowerCase();
              const author = (m.author?.username ?? '').toLowerCase();
              const createdAt = new Date(m.created_at || m.timestamp || '').getTime();
              const afterOk = !after || Number.isNaN(createdAt) || createdAt >= new Date(after).getTime();
              const beforeOk = !before || Number.isNaN(createdAt) || createdAt <= new Date(before).getTime();
              const mineOk = !authorId || m.author?.id === authorId;
              return (content.includes(q) || author.includes(q)) && afterOk && beforeOk && mineOk;
            })
            .slice(0, 25);
          setResults(applyLocalAuthorFilter(fallback));
          setError(fallback.length === 0 ? 'Search is temporarily unavailable.' : null);
        } catch {
          setResults([]);
          setError('Search is temporarily unavailable.');
        }
      } finally {
        setIsLoading(false);
        setHasSearched(true);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [channelId, query, authorQuery, fromDate, toDate, onlyMine, myUserId]);

  const navigateToMessage = (msg: Message) => {
    const messageChannel = allChannels.find((c) => c.id === msg.channel_id);
    if (messageChannel?.guild_id) {
      navigate(`/app/guilds/${messageChannel.guild_id}/channels/${msg.channel_id}`);
    } else {
      navigate(`/app/dms/${msg.channel_id}`);
    }
    window.location.hash = `msg-${msg.id}`;
    setContextPanelMode(null);
  };

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-border-subtle bg-bg-secondary">
      {/* Header */}
      <div className="flex h-[var(--spacing-header-height)] shrink-0 items-center justify-between border-b border-border-subtle/50 px-4">
        <span className="text-subhead text-text-primary">Search</span>
        <button
          type="button"
          onClick={() => setContextPanelMode(null)}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          aria-label="Close search"
        >
          <X size={16} />
        </button>
      </div>

      {/* Search input + filters */}
      <div className="border-b border-border-subtle/60 px-3 pb-3 pt-3">
        <div className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 py-2 transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]">
          <Search size={16} className="shrink-0 text-text-muted" />
          <label htmlFor="message-search-query" className="sr-only">
            Search messages
          </label>
          <input
            id="message-search-query"
            ref={inputRef}
            type="text"
            placeholder="Search this channel…"
            className="flex-1 bg-transparent text-body text-text-primary placeholder:text-text-muted outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
              }
            }}
          />
        </div>
        <div className="mt-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor="message-search-author" className="sr-only">
              Author name filter
            </label>
            <input
              id="message-search-author"
              type="text"
              placeholder="Filter by author"
              className="h-8 flex-1 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 text-meta text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
              value={authorQuery}
              onChange={(e) => setAuthorQuery(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setOnlyMine((current) => !current)}
              aria-pressed={onlyMine}
              className={`h-8 rounded-full border px-3 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${
                onlyMine
                  ? 'border-transparent bg-accent-tint text-accent-primary'
                  : 'border-border-subtle text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
              }`}
            >
              From me
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-section uppercase text-text-muted">From</span>
              <input
                type="date"
                className="h-8 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 text-meta text-text-secondary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-section uppercase text-text-muted">To</span>
              <input
                type="date"
                className="h-8 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 text-meta text-text-secondary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="To date"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
        {isLoading && (
          <div className="flex items-center justify-center py-10" aria-live="polite" aria-busy="true">
            <Loader2 size={20} className="animate-spin text-accent-primary" />
            <span className="sr-only">Searching messages…</span>
          </div>
        )}

        {!isLoading && error && <ErrorBanner className="m-2" message={error} />}

        {!isLoading && !error && hasSearched && results.length === 0 && (
          <EmptyState
            icon={<SearchX size={20} />}
            title="Nothing turned up"
            description={
              currentChannel
                ? `Nothing matches "${query.trim()}" in #${currentChannel.name} yet. Try fewer words or widen the date range.`
                : `Nothing matches "${query.trim()}" yet. Try fewer words or widen the date range.`
            }
          />
        )}

        {!isLoading && !error && !hasSearched && !query.trim() && (
          <EmptyState
            icon={<Search size={20} />}
            title="Find any message"
            description={
              currentChannel
                ? `Search #${currentChannel.name} by keyword, author, or date. Matches jump you straight to the message.`
                : 'Search by keyword, author, or date. Matches jump you straight to the message.'
            }
          />
        )}

        {!isLoading && results.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {results.map((msg) => {
              const msgChannel = allChannels.find((c) => c.id === msg.channel_id);
              const content = msg.content ?? '';
              return (
                <button
                  type="button"
                  key={msg.id}
                  className="flex flex-col gap-1 rounded-sm px-2 py-2 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                  onClick={() => navigateToMessage(msg)}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-label font-semibold text-text-primary">
                      {msg.author.username}
                    </span>
                    <span className="shrink-0 font-code text-[11px] text-text-muted">
                      {formatTimestamp(msg.created_at || msg.timestamp || '')}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-meta leading-relaxed text-text-secondary">
                    {content ? (
                      highlightMatches(content, query)
                    ) : (
                      <span className="italic text-text-muted">Attachment or embed</span>
                    )}
                  </p>
                  {msgChannel && (
                    <span className="text-[11px] text-text-muted">#{msgChannel.name}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
