import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { guildLandingPath } from '../lib/guildNavigation';
import { useCurrentGuilds } from '../hooks/useGuilds';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router';
import { extractApiError } from '../api/client';
import { getApi } from '../api/activeClient';
import { useGuildStore } from '../stores/guildStore';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { IxGlyph } from '../components/ix/glyphs';
import { ServerMark } from '../components/ix/identity';
import { EmptyPage, LargeTitlePage } from '../components/ix/page';
import { CreamButton, ToolChip, WideControl } from '../components/ix/primitives';
import { Modal } from '../components/ui/Modal';

interface DiscoverableGuild {
  id: string;
  name: string;
  description: string | null;
  icon_hash: string | null;
  member_count: number;
  online_count: number;
  tags: string[];
  created_at: string;
  federated?: boolean;
  origin_server?: string;
  origin_domain?: string;
}

interface DiscoveryResponse {
  guilds: DiscoverableGuild[];
  total: number;
}

const CATEGORIES = [
  'Gaming',
  'Music',
  'Education',
  'Science',
  'Technology',
  'Art',
  'Social',
  'Anime',
  'Movies',
  'Sports',
];

/** Keystroke settle time before a discovery search is issued. */
const DISCOVERY_SEARCH_DEBOUNCE_MS = 300;

export function DiscoveryPage() {
  const guildScope = useCurrentAccountScope();
  const navigate = useNavigate();
  const [guilds, setGuilds] = useState<DiscoverableGuild[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [selectedGuild, setSelectedGuild] = useState<DiscoverableGuild | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const myGuilds = useCurrentGuilds();
  const myGuildIds = new Set(myGuilds.map((g) => g.id));

  const fetchDiscovery = useCallback(
    async (searchQuery?: string, tag?: string | null, signal?: AbortSignal) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (searchQuery?.trim()) params.set('search', searchQuery.trim());
        if (tag) params.set('tag', tag);
        params.set('limit', '50');
        params.set('include_federated', 'true');
        const { data } = await getApi().get<DiscoveryResponse>(
          `/discovery/guilds?${params.toString()}`,
          { signal },
        );
        setGuilds(data.guilds);
        setTotal(data.total);
        setLoadError(null);
      } catch (err) {
        if (signal?.aborted || axios.isCancel(err)) return;
        setGuilds([]);
        setTotal(0);
        setLoadError(`Failed to load public servers: ${extractApiError(err)}`);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [],
  );

  // Search fired a request on every keystroke with nothing canceling the
  // previous one, so typing "gaming" issued six overlapping searches whose
  // responses could land out of order and leave the wrong results on screen.
  // Debounce keystrokes and abort the in-flight request when the query moves
  // on — but load the first page immediately, so opening the page is not
  // gratuitously delayed by a debounce that has nothing to wait for.
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true;
      void fetchDiscovery(search, selectedTag, controller.signal);
      return () => controller.abort();
    }
    const timer = setTimeout(() => {
      void fetchDiscovery(search, selectedTag, controller.signal);
    }, DISCOVERY_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchDiscovery, search, selectedTag]);

  const handleJoin = async (guild: DiscoverableGuild) => {
    if (!guildScope) return;
    setJoiningId(guild.id);
    setJoinError(null);
    try {
      const existing = myGuilds.find(entry => entry.id === guild.id);
      const joined = existing ?? await useGuildStore.getState().joinPublic(guild.id, guildScope);
      const path = await guildLandingPath(joined);
      if (!existing) toast.success(`Joined ${guild.name}!`);
      setSelectedGuild(null);
      navigate(path);
    } catch (err) {
      setJoinError(`We couldn't join this server: ${extractApiError(err)}`);
    } finally {
      setJoiningId(null);
    }
  };

  const filtersActive = search.trim().length > 0 || selectedTag !== null;
  const clearFilters = () => {
    setSearch('');
    setSelectedTag(null);
  };

  return (
    <LargeTitlePage
      title="Discover"
      subtitle={`${total} public ${total === 1 ? 'community' : 'communities'} to explore`}
      data-testid="ix-discover"
      className="ix-sp ix-dc"
    >
      <label className="ix-psearch" htmlFor="discovery-search">
        <IxGlyph name="search" size={15} />
        <span className="sr-only">Search public servers</span>
        <input
          id="discovery-search"
          type="search"
          placeholder="Search by name or topic"
          value={search}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      {/* §9: the chips are quiet fills with a 44px hit area on a coarse pointer (`pc-touch`). */}
      <div className="ix-dc__chips" role="group" aria-label="Topics">
        <CategoryChip active={selectedTag === null} onClick={() => setSelectedTag(null)}>
          All
        </CategoryChip>
        {CATEGORIES.map((cat) => (
          <CategoryChip key={cat} active={selectedTag === cat} onClick={() => setSelectedTag(selectedTag === cat ? null : cat)}>
            {cat}
          </CategoryChip>
        ))}
      </div>

      {loading ? (
        <ul className="ix-dc__grid" role="status" aria-busy="true" aria-label="Loading public servers">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="ix-dc__card ix-dc__card--skeleton" aria-hidden="true">
              <span className="ix-dc__bone ix-dc__bone--mark" />
              <span className="ix-dc__bone ix-dc__bone--title" />
              <span className="ix-dc__bone ix-dc__bone--line" />
              <span className="ix-dc__bone ix-dc__bone--line ix-dc__bone--short" />
            </li>
          ))}
        </ul>
      ) : loadError ? (
        <EmptyPage
          inline
          role="alert"
          glyph="x"
          title="We couldn't reach discovery"
          line={loadError}
          action={
            <WideControl onClick={() => void fetchDiscovery(search, selectedTag)} className="ix-dc__retry">
              Retry
            </WideControl>
          }
        />
      ) : guilds.length === 0 ? (
        <EmptyPage
          inline
          glyph="search"
          title={filtersActive ? 'No servers match your filters' : 'No public servers yet'}
          line={
            filtersActive
              ? 'Nothing here matches your search and topic. Clear the filters, or try a different topic.'
              : "There aren't any public communities listed right now. Check back soon, or start your own server for people to find."
          }
          action={
            filtersActive ? (
              <WideControl onClick={clearFilters} className="ix-dc__retry">
                Clear filters
              </WideControl>
            ) : undefined
          }
        />
      ) : (
        <ul className="ix-dc__grid">
          {guilds.map((guild) => {
            const isMember = myGuildIds.has(guild.id);
            const isJoining = joiningId === guild.id;
            return (
              <li key={guild.id} className="ix-dc__card" data-testid="ix-discover-card">
                <div className="ix-dc__head">
                  <ServerMark guildId={guild.id} name={guild.name} icon={guild.icon_hash} size={44} />
                  <h3 className="ix-dc__name">{guild.name}</h3>
                </div>
                {guild.description && <p className="ix-dc__about">{guild.description}</p>}
                {guild.tags.length > 0 && (
                  <ul className="ix-dc__tags" aria-label="Topics">
                    {guild.tags.slice(0, 3).map((tag) => (
                      <li key={tag}>{tag}</li>
                    ))}
                  </ul>
                )}
                <div className="ix-dc__foot">
                  <p className="ix-dc__facts">
                    <span>{guild.member_count} members</span>
                    <span className="ix-dc__online">{guild.online_count} online</span>
                  </p>
                  <WideControl
                    className="ix-dc__open"
                    disabled={isJoining}
                    onClick={() => {
                      if (isMember) {
                        void handleJoin(guild);
                        return;
                      }
                      setJoinError(null);
                      setSelectedGuild(guild);
                    }}
                  >
                    {isJoining ? 'Opening…' : isMember ? 'Visit' : 'Preview'}
                  </WideControl>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <DiscoveryPreview
        guild={selectedGuild}
        joining={selectedGuild != null && joiningId === selectedGuild.id}
        error={joinError}
        onClose={() => {
          if (joiningId) return;
          setSelectedGuild(null);
          setJoinError(null);
        }}
        onJoin={(guild) => { void handleJoin(guild); }}
      />
    </LargeTitlePage>
  );
}

function DiscoveryPreview({
  guild,
  joining,
  error,
  onClose,
  onJoin,
}: {
  guild: DiscoverableGuild | null;
  joining: boolean;
  error: string | null;
  onClose: () => void;
  onJoin: (guild: DiscoverableGuild) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  if (!guild) return null;
  const createdLabel = Number.isNaN(Date.parse(guild.created_at))
    ? null
    : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(guild.created_at));

  return (
    <Modal
      open
      onClose={onClose}
      labeledBy={titleId}
      describedBy={descriptionId}
      panelClassName="ix-dialog-panel ix-dc__preview"
      closeOnBackdrop={!joining}
    >
      <div className="ix-dialog">
        <div className="ix-dc__preview-head">
          <ServerMark guildId={guild.id} name={guild.name} icon={guild.icon_hash} size={56} />
          <div className="ix-dc__preview-title">
            <h2 id={titleId} className="ix-dialog__title">
              {guild.name}
            </h2>
            <p className="ix-dc__origin">
              {guild.federated ? `From ${guild.origin_server || guild.origin_domain || 'a trusted instance'}` : 'Public server on this instance'}
            </p>
          </div>
        </div>

        <p id={descriptionId} className="ix-dc__preview-about">
          {guild.description?.trim() || 'This community has not added a description yet.'}
        </p>

        <dl className="ix-dc__stats">
          <div>
            <dt>Members</dt>
            <dd>{guild.member_count.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Online now</dt>
            <dd>{guild.online_count.toLocaleString()}</dd>
          </div>
          {createdLabel && (
            <div>
              <dt>Established</dt>
              <dd>{createdLabel}</dd>
            </div>
          )}
        </dl>

        {guild.tags.length > 0 && (
          <ul className="ix-dc__tags" aria-label="Topics">
            {guild.tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        )}

        <p className="ix-dc__note">
          <strong>{guild.federated ? 'Remote community' : 'Ready to join?'}</strong>
          {guild.federated
            ? 'This listing comes from a trusted federated instance. Cross-instance joining is not available from Discovery yet.'
            : 'Joining adds this server to your dock and makes your member profile visible to the community. You can leave later.'}
        </p>

        {error && (
          <p role="alert" className="ix-dialog__error">
            {error}
          </p>
        )}

        <div className="ix-dialog__actions">
          <button type="button" className="ix-dialog__cancel" disabled={joining} onClick={onClose}>
            {guild.federated ? 'Close' : 'Not now'}
          </button>
          {!guild.federated && (
            <CreamButton disabled={joining} onClick={() => onJoin(guild)}>
              {joining ? 'Joining server…' : `Join ${guild.name}`}
            </CreamButton>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CategoryChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <ToolChip
      // pc-touch (§9): the chip stays a quiet 28px tile; the hit area is 44px on a coarse pointer.
      className={cn('pc-touch ix-dc__chip')}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </ToolChip>
  );
}
