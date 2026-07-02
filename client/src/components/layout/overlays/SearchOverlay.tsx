import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { channelApi } from '../../../api/channels';
import type { Message } from '../../../types';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { TopBarOverlay } from './TopBarOverlay';

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  channelId?: string;
  channelName?: string;
  allChannels: Array<{ id: string; guild_id?: string | null; name?: string | null }>;
}

export function SearchOverlay({ open, onClose, channelId, channelName, allChannels }: SearchOverlayProps) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

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

  return (
    <TopBarOverlay
      open={open}
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-search-title"
      panelClassName="max-h-[min(82dvh,44rem)] w-full max-w-3xl"
    >
      <div className="panel-divider flex items-center gap-3 border-b px-5 py-4.5">
        <span id="topbar-search-title" className="sr-only">Search Messages</span>
        <Search size={20} className="text-text-muted" />
        <label htmlFor="topbar-message-search" className="sr-only">Search messages</label>
        <input
          id="topbar-message-search"
          autoFocus
          className="flex-1 bg-transparent text-lg text-text-primary outline-none placeholder:text-text-muted"
          placeholder={channelId ? `Search in #${channelName || 'channel'}` : 'Search messages'}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button type="button" className="command-icon-btn" onClick={onClose} aria-label="Close search"><X size={16} /></button>
      </div>
      <div className="max-h-[min(67dvh,34rem)] overflow-y-auto p-3.5 scrollbar-thin">
        {searchResults.length > 0 ? (
          <div className="space-y-1.5">
            {searchResults.map((msg) => (
              <button
                type="button"
                key={msg.id}
                className="group w-full rounded-xl border border-transparent p-3.5 text-left transition-all hover:border-border-subtle hover:bg-bg-mod-subtle"
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
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="mr-2 text-sm font-semibold text-text-primary">{msg.author.username}</span>
                  <span className="text-xs text-text-muted">{new Date(msg.created_at || msg.timestamp || '').toLocaleString()}</span>
                </div>
                <div className="text-[15px] text-text-secondary">{msg.content || <span className="italic text-text-muted">(attachment)</span>}</div>
              </button>
            ))}
          </div>
        ) : searching ? (
          <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            className="p-8 text-center text-text-muted"
          >
            Searching messages...
          </div>
        ) : searchQuery.trim() ? (
          searchError ? (
            <div role="alert" className="p-8 text-center text-accent-danger">{searchError}</div>
          ) : (
            <div className="p-8 text-center text-text-muted">No results found</div>
          )
        ) : (
          <div className="p-8 text-center text-text-muted">Search for messages, users, or keywords</div>
        )}
      </div>
    </TopBarOverlay>
  );
}
