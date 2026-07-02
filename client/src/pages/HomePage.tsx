import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Plus, Compass, Users, ChevronRight, Volume2, MessageSquare, FileText } from 'lucide-react';

import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { CreateGuildModal } from '../components/guild/CreateGuildModal';
import { safeStoredImageDataUrl } from '../lib/security';
import { getGuildColor } from '../lib/colors';
import { Tooltip } from '../components/ui/Tooltip';
import { toast } from '../stores/toastStore';

import type { Channel } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

export function HomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const guilds = useGuildStore((s) => s.guilds);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    void fetchRelationships();
    guilds.forEach(g => {
      void fetchChannels(g.id);
    });
  }, [fetchRelationships, guilds, fetchChannels]);

  const friends = useMemo(
    () => relationships.filter((r) => r.type === 1),
    [relationships],
  );

  const onlineFriends = useMemo(
    () =>
      friends.filter(
        (r) =>
          (getPresence(r.user.id, activeServerId ?? undefined)?.status || 'offline') !== 'offline',
      ),
    [friends, presences, getPresence, activeServerId],
  );

  const activeVoiceChannels = useMemo(() => {
    const allChannels = Object.entries(channelsByGuild)
      .filter(([gid]) => gid !== '')
      .flatMap(([_, chs]) => chs);

    return allChannels
      .filter(c => c.type === 2)
      .map(c => ({
        channel: c,
        guild: guilds.find(g => g.id === c.guild_id),
        participants: channelParticipants.get(c.id) || []
      }))
      .filter(item => item.participants.length > 0);
  }, [channelsByGuild, channelParticipants, guilds]);

  const recentDms = useMemo(() => {
    const dmChannels = channelsByGuild[''] ?? EMPTY_CHANNELS;
    if (dmChannels.length === 0) return [];
    return [...dmChannels]
      .filter((c) => c.last_message_id)
      .sort((a, b) => {
        const aId = BigInt(a.last_message_id!);
        const bId = BigInt(b.last_message_id!);
        return aId > bId ? -1 : aId < bId ? 1 : 0;
      })
      .slice(0, 5);
  }, [channelsByGuild]);

  const handleMessageFriend = async (userId: string) => {
    try {
      const { data } = await dmApi.create(userId);
      const current = useChannelStore.getState().channelsByGuild[''] || [];
      const existing = current.find((c) => c.id === data.id);
      const nextDms = existing ? current : [...current, data];
      useChannelStore.getState().setDmChannels(nextDms);
      useChannelStore.getState().selectChannel(data.id);
      navigate(`/app/dms/${data.id}`);
    } catch (err) {
      toast.error(`Failed to open direct message: ${extractApiError(err)}`);
    }
  };

  const handleGuildClick = async (guild: { id: string }) => {
    selectGuild(guild.id);
    await useChannelStore.getState().selectGuild(guild.id);
    navigate(`/app/guilds/${guild.id}`);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto scrollbar-thin rounded-2xl bg-bg-primary">
      {/* Personalized Header Gradient Banner */}
      <div
        className="relative h-[160px] shrink-0 overflow-hidden sm:h-[180px] md:h-[200px]"
        style={{
          background: `linear-gradient(135deg, var(--accent-primary) 0%, var(--bg-primary) 100%)`
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary via-bg-primary/40 to-transparent opacity-80" />
        <div className="absolute bottom-5 left-5 right-5 sm:bottom-6 sm:left-8 sm:right-8 z-10">
          <h1 className="truncate text-2xl font-extrabold tracking-tight text-white drop-shadow-md sm:text-3xl">
            Welcome to Paracord, {user?.username}
          </h1>
          <p className="mt-1 line-clamp-2 max-w-xl text-[14px] font-medium text-white/80 sm:mt-2 sm:text-[15px]">
            Your global dashboard. Manage servers, discover new communities, and quickly drop into active voice channels.
          </p>
        </div>
      </div>

      {/* Spatial Grid Layout */}
      <div className="grid flex-1 grid-cols-1 gap-5 p-5 sm:gap-6 sm:p-6 lg:p-8 xl:grid-cols-[2fr_1fr] xl:items-start">
        {/* Left Column (Activities) */}
        <div className="flex flex-col gap-8">
          {/* Global Happening Now */}
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-[17px] font-bold text-text-primary">
              <Volume2 className="text-accent-success" size={20} />
              Global Happening Now
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {activeVoiceChannels.length > 0 ? (
                activeVoiceChannels.map(({ channel, guild, participants }) => {
                  const displayParticipants = participants.slice(0, 4);
                  const overflow = participants.length > 4 ? participants.length - 4 : 0;

                  return (
                    <div
                      key={channel.id}
                      className="group flex flex-col gap-3 rounded-[16px] border border-border-subtle bg-bg-mod-subtle p-5 transition-all hover:border-border-strong hover:bg-bg-mod-strong"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 font-semibold text-text-primary truncate">
                          <Volume2 size={16} className="text-text-muted shrink-0" />
                          <span className="truncate">{channel.name}</span>
                        </div>
                        <span className="text-[13px] font-medium text-text-muted shrink-0">
                          {participants.length} Active
                        </span>
                      </div>

                      {guild && (
                        <div className="text-[12px] text-text-muted truncate font-medium">
                          in {guild.name}
                        </div>
                      )}

                      <div className="mt-2 flex items-center">
                        {displayParticipants.map((p, i: number) => (
                          <Tooltip key={p.user_id} content={p.username || p.user_id} side="top">
                            <div
                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-bg-mod-subtle bg-accent-primary text-[11px] font-bold text-white transition-transform group-hover:scale-105"
                              style={{ marginLeft: i > 0 ? '-8px' : '0' }}
                            >
                              {(p.username || p.user_id).charAt(0).toUpperCase()}
                            </div>
                          </Tooltip>
                        ))}
                        {overflow > 0 && (
                          <div className="z-10 -ml-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-bg-mod-subtle bg-bg-accent text-[11px] font-bold text-text-primary">
                            +{overflow}
                          </div>
                        )}
                      </div>

                      <button
                        className="mt-auto w-full rounded-xl bg-white/10 py-2 text-[13px] font-bold text-white transition-colors hover:bg-accent-primary"
                        onClick={() => navigate(`/app/guilds/${guild?.id}/channels/${channel.id}`)}
                      >
                        Join Voice
                      </button>
                    </div>
                  );
                })
              ) : (
                <div className="col-span-full rounded-2xl border border-border-subtle border-dashed p-8 text-center text-text-muted">
                  It's quiet. No active voice channels across your servers.
                </div>
              )}
            </div>
          </section>

          {/* Activity Feed (DMs) */}
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-[17px] font-bold text-text-primary">
              <MessageSquare className="text-text-primary" size={20} />
              Recent Activity
            </h2>
            <div className="rounded-[16px] border border-border-subtle bg-bg-mod-subtle">
              {recentDms.length > 0 ? (
                recentDms.map((dm, idx) => {
                  const username = dm.recipient?.username || 'Direct Message';
                  const isOnline = (getPresence(dm.recipient?.id || '', activeServerId ?? undefined)?.status || 'offline') !== 'offline';
                  return (
                    <button
                      type="button"
                      key={dm.id}
                      onClick={() => {
                        useChannelStore.getState().selectChannel(dm.id);
                        navigate(`/app/dms/${dm.id}`);
                      }}
                      className={`flex w-full items-start justify-between gap-4 p-4 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary ${idx !== recentDms.length - 1 ? "border-b border-border-subtle" : ""}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative shrink-0">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-primary text-sm font-semibold text-white">
                            {username.charAt(0).toUpperCase()}
                          </div>
                          {isOnline && (
                            <div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-[2.5px] border-bg-mod-subtle bg-status-online" />
                          )}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[15px] font-semibold text-text-primary">@{username}</span>
                          <span className="text-[13px] text-text-muted text-left">Direct Message</span>
                        </div>
                      </div>
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-black/20 text-text-muted hover:bg-black/40 transition-colors">
                        <ChevronRight size={16} />
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="p-8 text-center text-text-muted text-[14px]">
                  No recent activity found.
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right Column (Sidebar-ish content) */}
        <div className="flex flex-col gap-6">
          {/* Quick Actions Grid */}
          <section className="grid grid-cols-2 gap-3">
            <button
              onClick={() => navigate('/app/friends')}
              className="glass-panel flex flex-col items-center gap-2 rounded-xl py-4 transition-colors hover:bg-bg-mod-strong/55"
            >
              <UserPlus size={20} className="text-text-muted" />
              <span className="text-xs font-semibold text-text-secondary">Add Friend</span>
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="glass-panel flex flex-col items-center gap-2 rounded-xl py-4 transition-colors hover:bg-bg-mod-strong/55"
            >
              <Plus size={20} className="text-text-muted" />
              <span className="text-xs font-semibold text-text-secondary">New Server</span>
            </button>
            <button
              onClick={() => navigate('/app/discovery')}
              className="glass-panel flex flex-col items-center gap-2 rounded-xl py-4 transition-colors hover:bg-bg-mod-strong/55"
            >
              <Compass size={20} className="text-text-muted" />
              <span className="text-xs font-semibold text-text-secondary">Explore</span>
            </button>
            <button
              onClick={() => navigate('/app/friends')}
              className="glass-panel flex flex-col items-center gap-2 rounded-xl py-4 transition-colors hover:bg-bg-mod-strong/55"
            >
              <Users size={20} className="text-text-muted" />
              <span className="text-xs font-semibold text-text-secondary">Friends</span>
            </button>
            <button
              onClick={() => navigate('/app/templates')}
              className="glass-panel flex flex-col items-center gap-2 rounded-xl py-4 transition-colors hover:bg-bg-mod-strong/55"
            >
              <FileText size={20} className="text-text-muted" />
              <span className="text-xs font-semibold text-text-secondary">Templates</span>
            </button>
          </section>

          {/* Online Friends Panel */}
          <section className="card-surface rounded-[16px] border border-border-subtle bg-bg-mod-subtle/50 p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-text-secondary">
                Online Now — {onlineFriends.length}
              </h3>
            </div>

            <div className="flex flex-col gap-1 max-h-[220px] overflow-y-auto scrollbar-thin">
              {onlineFriends.length === 0 ? (
                <p className="text-sm text-text-muted text-center py-4">No friends online.</p>
              ) : (
                onlineFriends.map((rel) => (
                  <button
                    type="button"
                    key={rel.user.id}
                    onClick={() => void handleMessageFriend(rel.user.id)}
                    className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-white/5 w-full text-left"
                  >
                    <div className="relative shrink-0">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-primary text-[12px] font-semibold text-white">
                        {rel.user.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-[2px] border-bg-mod-subtle bg-status-online" />
                    </div>
                    <span className="truncate text-sm font-medium text-text-secondary w-full">
                      {rel.user.username}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* Your Servers Panel */}
          {guilds.length > 0 && (
            <section className="card-surface rounded-[16px] border border-border-subtle bg-bg-mod-subtle/50 p-4">
              <h3 className="mb-4 text-xs font-bold uppercase tracking-wider text-text-secondary">
                Your Servers
              </h3>
              <div className="flex flex-col gap-2 max-h-[240px] overflow-y-auto scrollbar-thin">
                {guilds.map((guild) => {
                  const iconSrc = safeStoredImageDataUrl(guild.icon_hash);
                  return (
                    <button
                      key={guild.id}
                      onClick={() => void handleGuildClick(guild)}
                      className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-bg-primary/30 p-2 transition-colors hover:border-border-strong hover:bg-bg-mod-strong"
                    >
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] transition-transform group-hover:scale-105"
                        style={!iconSrc ? { backgroundColor: getGuildColor(guild.id) } : undefined}
                      >
                        {iconSrc ? (
                          <img
                            src={iconSrc}
                            alt={guild.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-xs font-bold text-white">
                            {guild.name.split(' ').map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span className="truncate text-[13px] font-medium text-text-secondary group-hover:text-text-primary text-left flex-1">
                        {guild.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}
