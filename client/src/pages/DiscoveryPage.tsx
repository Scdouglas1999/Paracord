import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, Search, Users, ArrowLeft } from 'lucide-react';
import { extractApiError } from '../api/client';
import { getApi } from '../api/activeClient';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { inviteApi } from '../api/invites';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { safeStoredImageDataUrl } from '../lib/security';
import { getGuildColor } from '../lib/colors';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';

interface DiscoverableGuild {
  id: string;
  name: string;
  description: string | null;
  icon_hash: string | null;
  member_count: number;
  online_count: number;
  tags: string[];
  created_at: string;
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

export function DiscoveryPage() {
  const navigate = useNavigate();
  const [guilds, setGuilds] = useState<DiscoverableGuild[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const myGuilds = useGuildStore((s) => s.guilds);
  const myGuildIds = new Set(myGuilds.map((g) => g.id));

  const fetchDiscovery = useCallback(async (searchQuery?: string, tag?: string | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery?.trim()) params.set('search', searchQuery.trim());
      if (tag) params.set('tag', tag);
      params.set('limit', '50');
      const { data } = await getApi().get<DiscoveryResponse>(
        `/discovery/guilds?${params.toString()}`
      );
      setGuilds(data.guilds);
      setTotal(data.total);
      setLoadError(null);
    } catch (err) {
      setGuilds([]);
      setTotal(0);
      setLoadError(`Failed to load public servers: ${extractApiError(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDiscovery(search, selectedTag);
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
    try {
      // Discovery join: the server should have a public invite or direct join API.
      // We try creating an invite-less join via the guild endpoint first.
      // If that fails, we look for any public invites.
      let inviteError: unknown = null;
      try {
        const invitesRes = await getApi().get(`/guilds/${guild.id}/invites`);
        const invites = invitesRes.data as Array<{ code: string }>;
        if (invites.length > 0) {
          const { data } = await inviteApi.accept(invites[0].code);
          const joinedGuild = 'guild' in data ? data.guild : data;
          useGuildStore.getState().addGuild(joinedGuild);
          await useChannelStore.getState().fetchChannels(joinedGuild.id);
          const channels = useChannelStore.getState().channelsByGuild[joinedGuild.id] || [];
          const firstChannel =
            joinedGuild.default_channel_id
              ? channels.find((c) => c.id === joinedGuild.default_channel_id)
              : channels.find((c) => c.type === 0) || channels.find((c) => c.type !== 4) || channels[0];
          toast.success(`Joined ${guild.name}!`);
          if (firstChannel) {
            navigate(`/app/guilds/${joinedGuild.id}/channels/${firstChannel.id}`);
          }
          return;
        }
      } catch (err) {
        inviteError = err;
      }
      if (inviteError) {
        toast.error(`Failed to join server: ${extractApiError(inviteError)}`);
      } else {
        toast.error('No public invite available for this server.');
      }
    } catch (err) {
      toast.error(`Failed to join server: ${extractApiError(err)}`);
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
                        onClick={() => void handleJoin(guild)}
                        disabled={isJoining}
                      >
                        {isJoining ? 'Joining...' : isMember ? 'Visit' : 'Join'}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
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
