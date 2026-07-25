import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Compass, Globe2, Search, Server, Users } from 'lucide-react';
import { extractApiError } from '../api/client';
import { getApi } from '../api/activeClient';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { safeStoredImageDataUrl } from '../lib/security';
import { getGuildColor } from '../lib/colors';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';
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
  const myGuilds = useGuildStore((s) => s.guilds);
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
        setLoadError(`Failed to load public spaces: ${extractApiError(err)}`);
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
    if (myGuildIds.has(guild.id)) {
      // Already a member, navigate to the guild
      const guildChannels = useChannelStore.getState().channelsByGuild[guild.id];
      if (!guildChannels?.length) {
        await useChannelStore.getState().fetchChannels(guild.id);
      }
      const channels = useChannelStore.getState().channelsByGuild[guild.id] || [];
      const firstChannel =
        channels.find((c) => c.type === 0) ||
        channels.find((c) => c.type !== 4) ||
        channels[0];
      if (firstChannel) {
        navigate(`/app/guilds/${guild.id}/channels/${firstChannel.id}`);
      }
      return;
    }

    setJoiningId(guild.id);
    setJoinError(null);
    try {
      const { data: joinedGuild } = await getApi().put(`/guilds/${guild.id}/members/@me`);
      useGuildStore.getState().addGuild(joinedGuild);
      await useChannelStore.getState().fetchChannels(joinedGuild.id);
      const channels = useChannelStore.getState().channelsByGuild[joinedGuild.id] || [];
      const firstChannel =
        joinedGuild.default_channel_id
          ? channels.find((c) => c.id === joinedGuild.default_channel_id)
          : channels.find((c) => c.type === 0) || channels.find((c) => c.type !== 4) || channels[0];
      toast.success(`Joined ${guild.name}!`);
      setSelectedGuild(null);
      if (firstChannel) {
        navigate(`/app/guilds/${joinedGuild.id}/channels/${firstChannel.id}`);
      }
    } catch (err) {
      setJoinError(`We couldn't join this space: ${extractApiError(err)}`);
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
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      {/* Solid header — search + category pills, no gradient hero (kill-list #1) */}
      <header className="shrink-0 border-b border-border-subtle bg-bg-secondary px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Back to home"
            onClick={() => navigate('/app')}
            className="flex h-9 w-9 items-center justify-center rounded-sm text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
            <Compass size={19} />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-heading text-text-primary">Discover spaces</h1>
            <p className="text-meta text-text-muted">
              {total} public {total === 1 ? 'community' : 'communities'} to explore
            </p>
          </div>
        </div>

        <div className="relative mt-4">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <label htmlFor="discovery-search" className="sr-only">
            Search public spaces
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

        <div className="mt-3 flex flex-wrap gap-2">
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

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin sm:p-6">
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
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
            title={filtersActive ? 'No spaces match your filters' : 'No public spaces yet'}
            description={
              filtersActive
                ? 'Nothing here matches your search and category. Widen the net by clearing filters, or try a different topic.'
                : "There aren't any public communities listed right now. Check back soon, or spin up your own space for people to find."
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
                  className="group flex flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong"
                >
                  {/* Framed solid banner (no gradient wash — kill-list #2) */}
                  <div
                    className="relative h-16 w-full"
                    style={{ backgroundColor: `color-mix(in srgb, ${bannerColor} 26%, var(--bg-tertiary))` }}
                  >
                    <div className="absolute -bottom-5 left-4">
                      <div
                        className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-md"
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
                    <h3 className="truncate text-subhead text-text-primary">{guild.name}</h3>
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
                            className="rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-semibold text-text-secondary"
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
                        <span className="inline-flex items-center gap-1 text-status-online">
                          <span className="h-1.5 w-1.5 rounded-full bg-status-online" />
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
      </div>

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
      panelClassName="bg-bg-secondary"
    >
      <div className="h-24" style={{ backgroundColor: `color-mix(in srgb, ${bannerColor} 30%, var(--bg-tertiary))` }} />
      <ModalHeader className="relative pb-1 pt-0">
        <div
          className="-mt-7 flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg text-title font-bold text-white"
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
            {guild.federated ? `From ${guild.origin_server || guild.origin_domain || 'a trusted server'}` : 'Public space on this server'}
          </div>
        </div>
      </ModalHeader>

      <ModalBody className="space-y-5 pb-5 pt-3">
        <p id={descriptionId} className="text-body leading-relaxed text-text-secondary">
          {guild.description?.trim() || 'This community has not added a description yet.'}
        </p>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <PreviewFact icon={<Users size={15} />} label="Members" value={guild.member_count.toLocaleString()} />
          <PreviewFact icon={<span className="h-2 w-2 rounded-full bg-status-online" />} label="Online now" value={guild.online_count.toLocaleString()} />
          {createdLabel && <PreviewFact icon={<CalendarDays size={15} />} label="Established" value={createdLabel} className="col-span-2 sm:col-span-1" />}
        </div>

        {guild.tags.length > 0 && (
          <div>
            <div className="text-section uppercase text-text-muted">Topics</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {guild.tags.map((tag) => (
                <span key={tag} className="rounded-xs bg-bg-mod-strong px-2 py-1 text-meta font-semibold text-text-secondary">{tag}</span>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-md border border-border-subtle bg-bg-tertiary px-3.5 py-3">
          <div className="text-label font-semibold text-text-primary">
            {guild.federated ? 'Remote community' : 'Ready to join?'}
          </div>
          <p className="mt-1 text-meta leading-relaxed text-text-secondary">
            {guild.federated
              ? 'This listing comes from a trusted federated server. Cross-server joining is not available from Discovery yet.'
              : 'Joining adds this space to your sidebar and makes your member profile visible to the community. You can leave later.'}
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-accent-danger/35 bg-danger-tint px-3.5 py-2.5 text-label text-accent-danger">
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
            {joining ? 'Joining space…' : `Join ${guild.name}`}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

function PreviewFact({ icon, label, value, className }: { icon: ReactNode; label: string; value: string; className?: string }) {
  return (
    <div className={cn('rounded-md border border-border-subtle bg-bg-tertiary px-3 py-2.5', className)}>
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
        'inline-flex h-7 items-center rounded-full px-3 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
        active
          ? 'bg-accent-tint text-accent-primary'
          : 'bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}
