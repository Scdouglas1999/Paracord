import { useEffect, useRef, useState } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { channelApi } from '../../api/channels';
import { useUIStore } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { formatTimestamp } from '../../lib/formatters';
import type { Message } from '../../types';

export function SearchPanel() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const setSearchPanelOpen = useUIStore((s) => s.setSearchPanelOpen);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const allChannels = Object.values(channelsByGuild).flat();
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
        setSearchPanelOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setSearchPanelOpen]);

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
    setSearchPanelOpen(false);
  };

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-border-subtle bg-bg-secondary">
      {/* Header */}
      <div className="flex h-[var(--spacing-header-height)] shrink-0 items-center justify-between border-b border-border-subtle/50 px-4">
        <span className="text-sm font-semibold text-text-primary">Search</span>
        <button
          type="button"
          onClick={() => setSearchPanelOpen(false)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
          aria-label="Close search"
        >
          <X size={16} />
        </button>
      </div>

      {/* Search input */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <label htmlFor="message-search-query" className="sr-only">
            Search messages
          </label>
          <input
            id="message-search-query"
            ref={inputRef}
            type="text"
            placeholder="Search messages..."
            className="h-9 w-full rounded-lg border border-border-subtle bg-bg-mod-subtle/60 py-1 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-all focus:border-accent-primary/50 focus:bg-bg-mod-strong"
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
              placeholder="Author name filter"
              className="h-8 flex-1 rounded-md border border-border-subtle bg-bg-mod-subtle/60 px-2.5 text-xs text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent-primary/50"
              value={authorQuery}
              onChange={(e) => setAuthorQuery(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setOnlyMine((current) => !current)}
              className={`h-8 rounded-md border px-2.5 text-xs font-semibold transition-colors ${
                onlyMine
                  ? 'border-accent-primary/60 bg-accent-primary/20 text-accent-primary'
                  : 'border-border-subtle bg-bg-mod-subtle/60 text-text-secondary hover:text-text-primary'
              }`}
            >
              From Me
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">From</span>
              <input
                type="date"
                className="h-8 rounded-md border border-border-subtle bg-bg-mod-subtle/60 px-2.5 text-xs text-text-secondary outline-none transition-colors focus:border-accent-primary/50"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">To</span>
              <input
                type="date"
                className="h-8 rounded-md border border-border-subtle bg-bg-mod-subtle/60 px-2.5 text-xs text-text-secondary outline-none transition-colors focus:border-accent-primary/50"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="To date"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-3">
        {isLoading && (
          <div className="flex items-center justify-center py-10" aria-live="polite" aria-busy="true">
            <Loader2 size={20} className="animate-spin text-text-muted" />
            <span className="sr-only">Searching messages...</span>
          </div>
        )}

        {!isLoading && error && (
          <div role="alert" className="px-3 py-8 text-center text-sm text-accent-danger">{error}</div>
        )}

        {!isLoading && !error && hasSearched && results.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-text-muted">No results found</div>
        )}

        {!isLoading && !hasSearched && !query.trim() && (
          <div className="px-3 py-8 text-center text-sm text-text-muted">
            Search for messages, users, or keywords
          </div>
        )}

        {!isLoading && results.length > 0 && (
          <div className="space-y-1">
            {results.map((msg) => (
              <button
                type="button"
                key={msg.id}
                className="w-full rounded-lg p-2.5 text-left transition-colors hover:bg-bg-mod-subtle"
                onClick={() => navigateToMessage(msg)}
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-text-primary">
                    {msg.author.username}
                  </span>
                  <span className="shrink-0 text-[10px] text-text-muted">
                    {formatTimestamp(msg.created_at || msg.timestamp || '')}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs text-text-secondary">
                  {msg.content || <span className="italic text-text-muted">(attachment)</span>}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
