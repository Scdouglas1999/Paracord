import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { channelApi } from '../../../api/channels';
import type { Message } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { cn } from '../../../lib/utils';
import { displayName } from '../../../lib/displayName';
import { TopBarOverlay } from './TopBarOverlay';

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  channelId?: string;
  channelName?: string;
  allChannels: Array<{ id: string; guild_id?: string | null; name?: string | null }>;
  presentation?: 'overlay' | 'panel';
  panelRef?: RefObject<HTMLElement | null>;
}

type SearchFilter = 'all' | 'text' | 'files';

const FILTERS: Array<{ id: SearchFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Messages' },
  { id: 'files', label: 'Attachments' },
];

// Wrap query matches in an accent chip so the reason a row surfaced is obvious.
function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let idx = lower.indexOf(lowerQ, start);
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

export function SearchOverlay({
  open,
  onClose,
  channelId,
  channelName,
  allChannels,
  presentation = 'overlay',
  panelRef,
}: SearchOverlayProps) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<SearchFilter>('all');

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open && presentation === 'overlay', onClose);

  useEffect(() => {
    if (!open || !channelId || !searchQuery.trim()) {
      setSearchResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const { data } = await channelApi.searchMessages(channelId, searchQuery.trim(), 25);
        if (cancelled) return;
        setSearchResults(data);
        setSearchError(null);
      } catch {
        try {
          const { data: recent } = await channelApi.getMessages(channelId, { limit: 100 });
          const query = searchQuery.trim().toLowerCase();
          const fallbackResults = recent
            .filter((message) => {
              const content = (message.content ?? '').toLowerCase();
              const author = (message.author?.username ?? '').toLowerCase();
              return content.includes(query) || author.includes(query);
            })
            .slice(0, 25);

          if (cancelled) return;
          setSearchResults(fallbackResults);
          setSearchError(
            fallbackResults.length === 0 ? 'Search is temporarily unavailable for this server.' : null
          );
        } catch {
          if (cancelled) return;
          setSearchResults([]);
          setSearchError('Search is temporarily unavailable for this server.');
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [open, channelId, searchQuery]);

  const filteredResults = useMemo(() => {
    if (filter === 'text') return searchResults.filter((m) => Boolean(m.content));
    if (filter === 'files') return searchResults.filter((m) => (m.attachments?.length ?? 0) > 0);
    return searchResults;
  }, [searchResults, filter]);

  const trimmedQuery = searchQuery.trim();

  const header = (
    <header className="shrink-0 border-b border-border-subtle">
      <div className="flex items-center gap-3 px-5 py-3.5">
        <span id="topbar-search-title" className="sr-only">Search Messages</span>
        <Search size={18} className="shrink-0 text-text-muted" />
        <label htmlFor="topbar-message-search" className="sr-only">Search messages</label>
        <input
          id="topbar-message-search"
          autoFocus
          className="flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
          placeholder={channelId ? `Search in #${channelName || 'channel'}` : 'Search messages'}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 px-5 pb-3">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={active}
              className={cn(
                'rounded-full px-3 py-1 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                active
                  ? 'bg-accent-tint text-accent-primary'
                  : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary',
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>
    </header>
  );

  const content = (
    <>
      {filteredResults.length > 0 ? (
        <ul className="space-y-0.5">
          {filteredResults.map((msg) => {
            const at = new Date(msg.created_at || msg.timestamp || '');
            return (
              <li key={msg.id}>
                <button
                  type="button"
                  className="w-full rounded-sm px-3 py-2.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                  onClick={() => {
                    const messageChannel = allChannels.find((c) => c.id === msg.channel_id);
                    if (messageChannel?.guild_id) {
                      navigate(`/app/guilds/${messageChannel.guild_id}/channels/${msg.channel_id}`);
                    } else {
                      navigate(`/app/dms/${msg.channel_id}`);
                    }
                    window.location.hash = `msg-${msg.id}`;
                    onClose();
                  }}
                >
                  <div className="mb-0.5 flex items-baseline justify-between gap-2">
                    <span className="truncate text-label font-semibold text-text-primary">{displayName(msg.author)}</span>
                    <span className="shrink-0 font-code text-meta tabular-nums text-text-muted">
                      {Number.isNaN(at.getTime()) ? '' : at.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-body text-text-secondary">
                    {msg.content
                      ? highlightMatch(msg.content, trimmedQuery)
                      : <span className="italic text-text-muted">Attachment</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      ) : searching ? (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="px-5 py-8 text-label text-text-muted"
        >
          Searching messages...
        </div>
      ) : trimmedQuery ? (
        searchError ? (
          <div role="alert" className="px-5 py-8 text-label text-accent-danger">{searchError}</div>
        ) : searchResults.length > 0 ? (
          <div className="px-5 py-8 text-label text-text-secondary">
            No {filter === 'files' ? 'attachments' : 'text messages'} in these results — switch the filter to see everything.
          </div>
        ) : (
          <div className="flex items-start gap-3.5 px-5 py-8">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
              <Search size={20} />
            </span>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-subhead text-text-primary">Nothing matches &ldquo;{trimmedQuery}&rdquo;</h3>
              <p className="mt-1 text-label text-text-secondary">
                Try a different word, a member&apos;s name, or open another channel to widen the search.
              </p>
            </div>
          </div>
        )
      ) : (
        <div className="flex items-start gap-3.5 px-5 py-8">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <Search size={20} />
          </span>
          <div className="min-w-0 pt-0.5">
            <h3 className="text-subhead text-text-primary">Search this channel</h3>
            <p className="mt-1 text-label text-text-secondary">
              Type a keyword, a phrase, or a member&apos;s name to find messages and shared files.
            </p>
          </div>
        </div>
      )}
    </>
  );

  if (!open) return null;
  if (presentation === 'panel') {
    return (
      <aside
        ref={panelRef}
        role="complementary"
        aria-label="Search messages"
        tabIndex={-1}
        data-testid="context-panel"
        data-mode="search"
        className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-bg-secondary shadow-sm outline-none"
        style={{ width: 'var(--member-list-width)' }}
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">{content}</div>
      </aside>
    );
  }

  return (
    <TopBarOverlay
      open
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-search-title"
      header={header}
      panelClassName="max-h-[min(82dvh,44rem)] w-full max-w-3xl"
      bodyClassName="p-2"
    >
      {content}
    </TopBarOverlay>
  );
}
