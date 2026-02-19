import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Plus, Compass, Users, ChevronRight } from 'lucide-react';

import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import { dmApi } from '../api/dms';
import { CreateGuildModal } from '../components/guild/CreateGuildModal';
import { isSafeImageDataUrl } from '../lib/security';
import { getGuildColor } from '../lib/colors';

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
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    void fetchRelationships();
  }, [fetchRelationships]);

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

  const recentDms = useMemo(() => {
    if (dmChannels.length === 0) return [];
    return [...dmChannels]
      .filter((c) => c.last_message_id)
      .sort((a, b) => {
        const aId = BigInt(a.last_message_id!);
        const bId = BigInt(b.last_message_id!);
        return aId > bId ? -1 : aId < bId ? 1 : 0;
      })
      .slice(0, 5);
  }, [dmChannels]);

  const handleMessageFriend = async (userId: string) => {
    try {
      const { data } = await dmApi.create(userId);
      const current = useChannelStore.getState().channelsByGuild[''] || [];
      const existing = current.find((c) => c.id === data.id);
      const nextDms = existing ? current : [...current, data];
      useChannelStore.getState().setDmChannels(nextDms);
      useChannelStore.getState().selectChannel(data.id);
      navigate(`/app/dms/${data.id}`);
    } catch {
      // ignore
    }
  };

  const handleGuildClick = async (guild: { id: string }) => {
    selectGuild(guild.id);
    await useChannelStore.getState().selectGuild(guild.id);
    await useChannelStore.getState().fetchChannels(guild.id);
    const channels = useChannelStore.getState().channelsByGuild[guild.id] || [];
    const firstChannel = channels.find((c) => c.type === 0) || channels.find((c) => c.type !== 4) || channels[0];
    if (firstChannel) {
      useChannelStore.getState().selectChannel(firstChannel.id);
      navigate(`/app/guilds/${guild.id}/channels/${firstChannel.id}`);
    } else {
      navigate(`/app/guilds/${guild.id}/settings`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="panel-divider flex items-center gap-4 border-b px-6 py-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-primary text-sm font-bold text-white">
          {user?.username?.charAt(0).toUpperCase() || 'U'}
        </div>
        <div>
          <div className="architect-eyebrow">Dashboard</div>
          <div className="text-lg font-semibold text-text-primary">
            Welcome back, {user?.username || 'User'}
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 scrollbar-thin">
        {/* Quick Actions */}
        <section className="mb-8">
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => navigate('/app/friends')}
              className="glass-panel flex items-center gap-2.5 rounded-xl px-5 py-3.5 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              <UserPlus size={18} className="text-text-muted" />
              Add Friend
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="glass-panel flex items-center gap-2.5 rounded-xl px-5 py-3.5 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              <Plus size={18} className="text-text-muted" />
              Create Server
            </button>
            <button
              onClick={() => navigate('/app/discovery')}
              className="glass-panel flex items-center gap-2.5 rounded-xl px-5 py-3.5 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              <Compass size={18} className="text-text-muted" />
              Discover
            </button>
            <button
              onClick={() => navigate('/app/friends')}
              className="glass-panel flex items-center gap-2.5 rounded-xl px-5 py-3.5 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              <Users size={18} className="text-text-muted" />
              Browse Friends
            </button>
          </div>
        </section>

        {/* Online Friends */}
        {friends.length > 0 && (
          <section className="mb-8">
            <div className="mb-3 flex items-center justify-between">
              <span className="architect-eyebrow">
                Online Friends &mdash; {onlineFriends.length}
              </span>
              <button
                onClick={() => navigate('/app/friends')}
                className="btn-ghost text-xs"
              >
                View All
              </button>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-thin">
              {onlineFriends.length === 0 ? (
                <span className="text-sm text-text-muted">No friends online right now.</span>
              ) : (
                onlineFriends.map((rel) => (
                  <button
                    key={rel.user.id}
                    onClick={() => void handleMessageFriend(rel.user.id)}
                    className="group flex shrink-0 flex-col items-center gap-1.5"
                  >
                    <div className="relative">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-primary text-sm font-semibold text-white transition-transform group-hover:scale-105">
                        {rel.user.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-[2.5px] border-bg-secondary bg-status-online" />
                    </div>
                    <span className="w-14 truncate text-center text-xs text-text-secondary group-hover:text-text-primary">
                      {rel.user.username}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>
        )}

        {/* Recent Conversations */}
        {recentDms.length > 0 && (
          <section className="mb-8">
            <div className="architect-eyebrow mb-3">Recent Conversations</div>
            <div className="card-stack">
              {recentDms.map((dm) => {
                const username = dm.recipient?.username || 'Direct Message';
                const recipientId = dm.recipient?.id;
                const presence = recipientId
                  ? getPresence(recipientId, activeServerId ?? undefined)
                  : undefined;
                const isOnline = presence?.status && presence.status !== 'offline';
                return (
                  <button
                    key={dm.id}
                    onClick={() => {
                      useChannelStore.getState().selectChannel(dm.id);
                      navigate(`/app/dms/${dm.id}`);
                    }}
                    className="card-surface flex w-full items-center gap-3 rounded-xl border border-border-subtle/70 bg-bg-mod-subtle/45 px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-bg-mod-strong/55"
                  >
                    <div className="relative">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary text-sm font-semibold text-white">
                        {username.charAt(0).toUpperCase()}
                      </div>
                      {isOnline && (
                        <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-[2px] border-bg-secondary bg-status-online" />
                      )}
                    </div>
                    <span className="flex-1 truncate text-sm font-medium text-text-primary">
                      @{username}
                    </span>
                    <ChevronRight size={16} className="text-text-muted" />
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Your Servers */}
        <section>
          <div className="architect-eyebrow mb-3">Your Servers</div>
          {guilds.length === 0 ? (
            <div className="glass-panel flex flex-col items-center justify-center rounded-2xl px-6 py-10 text-center">
              <p className="mb-3 text-sm text-text-muted">No servers yet</p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="btn-primary"
              >
                Create a Server
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {guilds.map((guild) => {
                const iconSrc = guild.icon_hash
                  ? guild.icon_hash.startsWith('data:')
                    ? (isSafeImageDataUrl(guild.icon_hash) ? guild.icon_hash : null)
                    : `/api/v1/guilds/${guild.id}/icon`
                  : null;
                return (
                  <button
                    key={guild.id}
                    onClick={() => void handleGuildClick(guild)}
                    className="glass-panel group flex flex-col items-center gap-2.5 rounded-xl px-4 py-5 transition-colors hover:bg-bg-mod-strong/55"
                  >
                    <div
                      className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl transition-transform group-hover:scale-105"
                      style={!iconSrc ? { backgroundColor: getGuildColor(guild.id) } : undefined}
                    >
                      {iconSrc ? (
                        <img
                          src={iconSrc}
                          alt={guild.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-sm font-bold text-white">
                          {guild.name.split(' ').map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span className="w-full truncate text-center text-sm font-medium text-text-secondary group-hover:text-text-primary">
                      {guild.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}
