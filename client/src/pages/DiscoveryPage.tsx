import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { guildLandingPath } from '../lib/guildNavigation';
import { useCurrentGuilds } from '../hooks/useGuilds';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router';
import { ArrowLeft, CalendarDays, Compass, Globe2, Search, Server, Users } from 'lucide-react';
import { extractApiError } from '../api/client';
import { getApi } from '../api/activeClient';
import { useGuildStore } from '../stores/guildStore';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { safeStoredImageDataUrl } from '../lib/security';
import { getGuildColor } from '../lib/colors';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Skeleton, SkeletonSwap } from '../components/ui/Skeleton';
import { Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle } from '../components/ui/Modal';

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

  // Search fired a request on every keystroke with nothing cancelling the
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
    <div className="flex h-full min-h-0 flex-col bg-bg-plate">
      {/* Solid header — search + category pills, no gradient hero (kill-list #1) */}
      <header className="shrink-0 border-b border-border-subtle bg-bg-raised px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Back to home"
            onClick={() => navigate('/app')}
            className="flex h-9 w-9 items-center justify-center rounded-chip text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="flex h-10 w-10 items-center justify-center rounded-well bg-accent-tint text-accent-primary">
            <Compass size={19} />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-heading text-text-primary">Discover servers</h1>
            <p className="text-meta text-text-muted">
              {total} public {total === 1 ? 'community' : 'communities'} to explore
            </p>
          </div>
        </div>

        <div className="relative mt-4">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <label htmlFor="discovery-search" className="sr-only">
            Search public servers
          </label>
          <Input
            id="discovery-search"
            type="text"
            placeholder="Search by name or topic..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* §9: the chips are 28px of ink and carry a 44px hit area (`pc-touch`).
            A wrapping row is the one case that cannot borrow space the way a lone
            control can — with an 8px row gap the second row's hit area reaches up
            into the first row's and steals its lower half, so the effective target
            is 36px, not 44. A 16px row gap makes the 44px bands tile exactly.
            It costs nothing at desktop width, where the row does not wrap. */}
        <div className="mt-3 flex flex-wrap gap-x-2 gap-y-4">
          <CategoryPill active={selectedTag === null} onClick={() => setSelectedTag(null)}>
            All
          </CategoryPill>
          {CATEGORIES.map((cat) => (
            <CategoryPill
              key={cat}
              active={selectedTag === cat}
              onClick={() => setSelectedTag(selectedTag === cat ? null : cat)}
            >
              {cat}
            </CategoryPill>
          ))}
        </div>
      </header>

      <SkeletonSwap busy={loading} className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin sm:p-6">
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-well border border-border-subtle bg-bg-raised shadow-[var(--shadow-chip)]">
                <Skeleton height={64} borderRadius={0} />
                <div className="flex flex-col gap-2.5 p-4">
                  <Skeleton width="55%" height={16} />
                  <Skeleton width="90%" height={12} />
                  <Skeleton width="70%" height={12} />
                  <div className="mt-2 flex items-center justify-between">
                    <Skeleton width={90} height={12} />
                    <Skeleton width={64} height={28} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div role="alert">
            <EmptyState
              icon={<Compass size={20} />}
              title="We couldn't reach discovery"
              description={loadError}
              action={
                <Button variant="secondary" size="sm" onClick={() => void fetchDiscovery(search, selectedTag)}>
                  Retry
                </Button>
              }
            />
          </div>
        ) : guilds.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title={filtersActive ? 'No servers match your filters' : 'No public servers yet'}
            description={
              filtersActive
                ? 'Nothing here matches your search and category. Widen the net by clearing filters, or try a different topic.'
                : "There aren't any public communities listed right now. Check back soon, or spin up your own server for people to find."
            }
            action={
              filtersActive ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {guilds.map((guild) => {
              const isMember = myGuildIds.has(guild.id);
              const isJoining = joiningId === guild.id;
              const iconSrc = safeStoredImageDataUrl(guild.icon_hash);
              const bannerColor = getGuildColor(guild.id);

              return (
                <div
                  key={guild.id}
                  className="group flex flex-col overflow-hidden rounded-well border border-border-subtle bg-bg-raised shadow-[var(--shadow-chip)] transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong"
                >
                  {/* Framed solid banner (no gradient wash — kill-list #2) */}
                  <div
                    className="relative h-16 w-full"
                    style={{ backgroundColor: `color-mix(in srgb, ${bannerColor} 26%, var(--bg-well))` }}
                  >
                    <div className="absolute -bottom-5 left-4">
                      <div
                        className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-well"
                        style={{
                          boxShadow: '0 0 0 3px var(--bg-secondary)',
                          backgroundColor: iconSrc ? 'transparent' : bannerColor,
                        }}
                      >
                        {iconSrc ? (
                          <img src={iconSrc} alt={guild.name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-label font-bold text-white">
                            {guild.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-1 flex-col px-4 pb-4 pt-7">
                    <h3 className="truncate text-heading text-text-primary">{guild.name}</h3>
                    {guild.description && (
                      <p className="mt-1 line-clamp-2 text-meta leading-relaxed text-text-secondary">
                        {guild.description}
                      </p>
                    )}

                    {guild.tags.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {guild.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-window bg-bg-mod-strong px-1.5 py-0.5 text-meta font-semibold text-text-secondary"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="mt-auto flex items-center justify-between pt-4">
                      <div className="flex items-center gap-3 text-meta tabular-nums text-text-muted">
                        <span className="inline-flex items-center gap-1">
                          <Users size={13} />
                          {guild.member_count}
                        </span>
                        <span className="inline-flex items-center gap-1 text-light-amber">
                          <span className="h-1.5 w-1.5 rounded-full bg-light-amber" />
                          {guild.online_count} online
                        </span>
                      </div>

                      <Button
                        variant={isMember ? 'secondary' : 'default'}
                        size="sm"
                        onClick={() => {
                          if (isMember) {
                            void handleJoin(guild);
                            return;
                          }
                          setJoinError(null);
                          setSelectedGuild(guild);
                        }}
                        disabled={isJoining}
                      >
                        {isJoining ? 'Opening…' : isMember ? 'Visit' : 'Preview'}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SkeletonSwap>

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
    </div>
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
  if (!guild) return null;
  const iconSrc = safeStoredImageDataUrl(guild.icon_hash);
  const bannerColor = getGuildColor(guild.id);
  const createdLabel = Number.isNaN(Date.parse(guild.created_at))
    ? null
    : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(guild.created_at));
  const titleId = 'discovery-preview-title';
  const descriptionId = 'discovery-preview-description';

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      labelledBy={titleId}
      describedBy={descriptionId}
      showCloseButton
      closeOnBackdrop={!joining}
    >
      <div className="h-24" style={{ backgroundColor: `color-mix(in srgb, ${bannerColor} 30%, var(--bg-well))` }} />
      <ModalHeader className="relative pb-1 pt-0">
        <div
          className="-mt-7 flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-plate text-title font-bold text-white"
          style={{ boxShadow: '0 0 0 4px var(--bg-secondary)', backgroundColor: iconSrc ? 'transparent' : bannerColor }}
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className="h-full w-full object-cover" />
          ) : (
            guild.name.split(' ').map((word) => word[0]).join('').slice(0, 2).toUpperCase()
          )}
        </div>
        <div className="min-w-0 pt-3">
          <ModalTitle id={titleId} className="truncate">{guild.name}</ModalTitle>
          <div className="mt-1 inline-flex items-center gap-1.5 text-meta text-text-muted">
            {guild.federated ? <Server size={13} /> : <Globe2 size={13} />}
            {guild.federated ? `From ${guild.origin_server || guild.origin_domain || 'a trusted instance'}` : 'Public server on this instance'}
          </div>
        </div>
      </ModalHeader>

      <ModalBody className="space-y-5 pb-5 pt-3">
        <p id={descriptionId} className="text-body leading-relaxed text-text-secondary">
          {guild.description?.trim() || 'This community has not added a description yet.'}
        </p>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <PreviewFact icon={<Users size={15} />} label="Members" value={guild.member_count.toLocaleString()} />
          <PreviewFact icon={<span className="h-2 w-2 rounded-full bg-light-amber" />} label="Online now" value={guild.online_count.toLocaleString()} />
          {createdLabel && <PreviewFact icon={<CalendarDays size={15} />} label="Established" value={createdLabel} className="col-span-2 sm:col-span-1" />}
        </div>

        {guild.tags.length > 0 && (
          <div>
            <div className="text-section text-text-muted">Topics</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {guild.tags.map((tag) => (
                <span key={tag} className="rounded-window bg-bg-mod-strong px-2 py-1 text-meta font-semibold text-text-secondary">{tag}</span>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-well border border-border-subtle bg-bg-well px-3.5 py-3">
          <div className="text-label font-semibold text-text-primary">
            {guild.federated ? 'Remote community' : 'Ready to join?'}
          </div>
          <p className="mt-1 text-meta leading-relaxed text-text-secondary">
            {guild.federated
              ? 'This listing comes from a trusted federated instance. Cross-instance joining is not available from Discovery yet.'
              : 'Joining adds this server to your sidebar and makes your member profile visible to the community. You can leave later.'}
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-well border border-accent-danger/35 bg-danger-tint px-3.5 py-2.5 text-label text-accent-danger">
            {error}
          </div>
        )}
      </ModalBody>

      <ModalFooter className="border-t border-border-subtle">
        <Button variant="secondary" disabled={joining} onClick={onClose}>
          {guild.federated ? 'Close' : 'Not now'}
        </Button>
        {!guild.federated && (
          <Button loading={joining} disabled={joining} onClick={() => onJoin(guild)}>
            {joining ? 'Joining server…' : `Join ${guild.name}`}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

function PreviewFact({ icon, label, value, className }: { icon: ReactNode; label: string; value: string; className?: string }) {
  return (
    <div className={cn('rounded-well border border-border-subtle bg-bg-well px-3 py-2.5', className)}>
      <div className="flex items-center gap-1.5 text-meta text-text-muted">{icon}{label}</div>
      <div className="mt-1 text-label font-semibold tabular-nums text-text-primary">{value}</div>
    </div>
  );
}

function CategoryPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // pc-touch (§9): the chip stays 28px so the category row reads as a row
        // of filters rather than a row of buttons; the *hit area* is 44px on a
        // coarse pointer. The identical chip on Friends already does this — this
        // one was the copy that got missed, and it is four targets deep in the
        // one surface a phone user browses with a thumb.
        'pc-touch inline-flex h-7 items-center rounded-full px-3 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
        active
          ? 'bg-accent-tint text-accent-primary'
          : 'bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}
