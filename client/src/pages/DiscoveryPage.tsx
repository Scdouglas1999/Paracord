import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, Search, Users, ArrowLeft } from 'lucide-react';
import { apiClient, extractApiError } from '../api/client';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { inviteApi } from '../api/invites';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { safeStoredImageDataUrl } from '../lib/security';

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

const GUILD_COLORS = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245',
  '#3ba55c', '#faa61a', '#e67e22', '#e91e63', '#1abc9c',
];

function getGuildColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return GUILD_COLORS[Math.abs(hash) % GUILD_COLORS.length];
}

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
      const { data } = await apiClient.get<DiscoveryResponse>(
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
        const invitesRes = await apiClient.get(`/guilds/${guild.id}/invites`);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="panel-divider flex min-h-[var(--spacing-header-height)] flex-col gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            aria-label="Back to home"
            onClick={() => navigate('/app')}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-text-secondary sm:h-11 sm:w-11">
            <Compass size={18} />
          </div>
          <div>
            <span className="text-lg font-semibold text-text-primary">Discover Servers</span>
            <p className="text-xs text-text-muted">{total} public server{total !== 1 ? 's' : ''}</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <label htmlFor="discovery-search" className="sr-only">
            Search public servers
          </label>
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            id="discovery-search"
            type="text"
            placeholder="Search servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 w-full rounded-xl border border-border-subtle bg-bg-mod-subtle py-2.5 pl-10 pr-4 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-strong focus:bg-bg-mod-strong"
          />
        </div>

        {/* Category tags */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelectedTag(null)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
              selectedTag === null
                ? 'border-accent-primary/50 bg-accent-primary/15 text-accent-primary'
                : 'border-border-subtle bg-bg-mod-subtle text-text-muted hover:bg-bg-mod-strong hover:text-text-secondary'
            )}
          >
            All
          </button>
          {CATEGORIES.map((cat) => (
            <button
              type="button"
              key={cat}
              onClick={() => setSelectedTag(selectedTag === cat ? null : cat)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
                selectedTag === cat
                  ? 'border-accent-primary/50 bg-accent-primary/15 text-accent-primary'
                  : 'border-border-subtle bg-bg-mod-subtle text-text-muted hover:bg-bg-mod-strong hover:text-text-secondary'
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="h-48 animate-pulse rounded-2xl border border-border-subtle bg-bg-mod-subtle/40"
              />
            ))}
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
              <Compass size={28} className="text-text-muted" />
            </div>
            <p className="text-sm font-semibold text-text-secondary">{loadError}</p>
            <p className="mt-1 text-xs text-text-muted">Check your connection and try again.</p>
            <button
              type="button"
              onClick={() => void fetchDiscovery(search, selectedTag)}
              className="mt-4 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
            >
              Retry
            </button>
          </div>
        ) : guilds.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
              <Compass size={28} className="text-text-muted" />
            </div>
            <p className="text-sm font-semibold text-text-secondary">No servers found</p>
            <p className="mt-1 text-xs text-text-muted">
              {search
                ? 'Try a different search term.'
                : 'No public servers are available right now.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {guilds.map((guild) => {
              const isMember = myGuildIds.has(guild.id);
              const isJoining = joiningId === guild.id;
              const iconSrc = safeStoredImageDataUrl(guild.icon_hash);

              return (
                <div
                  key={guild.id}
                  className="group flex flex-col overflow-hidden rounded-2xl border border-border-subtle/70 bg-bg-mod-subtle/45 transition-all hover:border-border-strong hover:bg-bg-mod-strong/55 hover:shadow-lg"
                >
                  {/* Banner area */}
                  <div
                    className="relative h-20 w-full"
                    style={{
                      background: `linear-gradient(135deg, ${getGuildColor(guild.id)}40, ${getGuildColor(guild.id)}15)`,
                    }}
                  >
                    <div className="absolute -bottom-6 left-4">
                      <div
                        className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border-[3px] shadow-md"
                        style={{
                          borderColor: 'var(--bg-secondary)',
                          backgroundColor: iconSrc ? 'transparent' : getGuildColor(guild.id),
                        }}
                      >
                        {iconSrc ? (
                          <img src={iconSrc} alt={guild.name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-sm font-bold text-white">
                            {guild.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex flex-1 flex-col px-4 pb-4 pt-8">
                    <h3 className="truncate text-sm font-semibold text-text-primary">{guild.name}</h3>
                    {guild.description && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">
                        {guild.description}
                      </p>
                    )}

                    {guild.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {guild.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-md border border-border-subtle bg-bg-mod-subtle px-1.5 py-0.5 text-[10px] font-semibold text-text-muted"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="mt-auto flex items-center justify-between pt-3">
                      <div className="flex items-center gap-3 text-xs text-text-muted">
                        <span className="inline-flex items-center gap-1">
                          <Users size={12} />
                          {guild.member_count}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-accent-success" />
                          {guild.online_count} online
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleJoin(guild)}
                        disabled={isJoining}
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
                          isMember
                            ? 'border-accent-success/40 bg-accent-success/10 text-accent-success hover:bg-accent-success/20'
                            : 'border-accent-primary/50 bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25',
                          isJoining && 'cursor-not-allowed opacity-60'
                        )}
                      >
                        {isJoining ? 'Joining...' : isMember ? 'Visit' : 'Join'}
                      </button>
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
