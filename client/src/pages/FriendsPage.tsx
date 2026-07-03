import { useEffect, useMemo, useState } from 'react';
import { Users, MessageSquare, X, Search, Check, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { useChannelStore } from '../stores/channelStore';
import { cn } from '../lib/utils';

type FriendsTab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<FriendsTab>('online');
  const [addFriendInput, setAddFriendInput] = useState('');
  const [addFriendStatus, setAddFriendStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const activeServerId = useServerListStore((s) => s.activeServerId);

  useEffect(() => {
    void fetchRelationships();
  }, [fetchRelationships]);

  const friends = useMemo(() => relationships.filter((r) => r.type === 1), [relationships]);
  const blocked = useMemo(() => relationships.filter((r) => r.type === 2), [relationships]);
  const pendingIncoming = useMemo(() => relationships.filter((r) => r.type === 3), [relationships]);
  const pendingOutgoing = useMemo(() => relationships.filter((r) => r.type === 4), [relationships]);
  const pending = useMemo(() => [...pendingIncoming, ...pendingOutgoing], [pendingIncoming, pendingOutgoing]);
  const onlineCount = useMemo(
    () =>
      friends.filter(
        (r) =>
          (getPresence(r.user.id, activeServerId ?? undefined)?.status || 'offline') !== 'offline'
      ).length,
    [friends, presences, getPresence, activeServerId]
  );

  const isActionPending = (actionKey: string) => pendingActions.has(actionKey);
  const startAction = (actionKey: string) => {
    setPendingActions((current) => new Set(current).add(actionKey));
  };
  const finishAction = (actionKey: string) => {
    setPendingActions((current) => {
      const next = new Set(current);
      next.delete(actionKey);
      return next;
    });
  };

  const handleAddFriend = async () => {
    const identifier = addFriendInput.trim();
    if (!identifier || isActionPending('add')) return;
    setAddFriendStatus(null);
    setRelationshipError(null);
    startAction('add');
    try {
      await useRelationshipStore.getState().addFriend(identifier);
      setAddFriendStatus({ type: 'success', message: `Friend request sent to ${identifier}!` });
      setAddFriendInput('');
    } catch (err: unknown) {
      const normalized = err as {
        response?: { data?: { message?: string; error?: string }; status?: number };
      };
      const errorMessage =
        normalized.response?.data?.message ||
        normalized.response?.data?.error ||
        (normalized.response?.status === 422
          ? 'Server rejected this format. Try using the user ID instead of username.'
          : extractApiError(err));
      setAddFriendStatus({ type: 'error', message: errorMessage });
    } finally {
      finishAction('add');
    }
  };

  const handleRemoveFriend = async (userId: string) => {
    const actionKey = `remove:${userId}`;
    if (isActionPending(actionKey)) return;
    setRelationshipError(null);
    startAction(actionKey);
    try {
      await useRelationshipStore.getState().removeFriend(userId);
    } catch (err: unknown) {
      setRelationshipError(extractApiError(err) || 'Failed to update relationship');
    } finally {
      finishAction(actionKey);
    }
  };

  const handleAcceptFriend = async (userId: string) => {
    const actionKey = `accept:${userId}`;
    if (isActionPending(actionKey)) return;
    setRelationshipError(null);
    startAction(actionKey);
    try {
      await useRelationshipStore.getState().acceptFriend(userId);
    } catch (err: unknown) {
      setRelationshipError(extractApiError(err) || 'Failed to accept friend request');
    } finally {
      finishAction(actionKey);
    }
  };

  const handleMessageFriend = async (userId: string) => {
    const actionKey = `message:${userId}`;
    if (isActionPending(actionKey)) return;
    setRelationshipError(null);
    startAction(actionKey);
    try {
      const { data } = await dmApi.create(userId);
      const dmChannels = useChannelStore.getState().channelsByGuild[''] || [];
      const existing = dmChannels.find((c) => c.id === data.id);
      const nextDms = existing ? dmChannels : [...dmChannels, data];
      useChannelStore.getState().setDmChannels(nextDms);
      useChannelStore.getState().selectChannel(data.id);
      navigate(`/app/dms/${data.id}`);
    } catch (err: unknown) {
      setRelationshipError(extractApiError(err) || 'Failed to open direct message');
    } finally {
      finishAction(actionKey);
    }
  };

  const tabs: { id: FriendsTab; label: string }[] = [
    { id: 'online', label: 'Online' },
    { id: 'all', label: 'All' },
    { id: 'pending', label: 'Pending' },
    { id: 'blocked', label: 'Blocked' },
  ];

  const list = useMemo(() => {
    let base =
      activeTab === 'all'
        ? friends
        : activeTab === 'pending'
          ? pending
          : activeTab === 'blocked'
            ? blocked
            : friends.filter(
                (r) =>
                  (getPresence(r.user.id, activeServerId ?? undefined)?.status || 'offline') !== 'offline'
              );

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      base = base.filter((r) => r.user.username.toLowerCase().includes(q));
    }
    return base;
  }, [activeTab, blocked, friends, pending, presences, getPresence, searchQuery, activeServerId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="panel-divider flex min-h-[var(--spacing-header-height)] flex-col items-start gap-3 border-b px-3 py-3 sm:gap-4 sm:px-4.5 sm:py-3.5 md:px-6.5">
        <div className="flex w-full items-center gap-3.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-text-secondary sm:h-11 sm:w-11">
            <Users size={18} />
          </div>
          <span className="text-lg font-semibold text-text-primary">Friends</span>
        </div>

        <div className="w-full overflow-x-auto">
          <div className="inline-flex min-w-full items-center gap-4 rounded-xl border border-border-subtle/65 bg-bg-mod-subtle/45 px-4 py-3 sm:gap-5 sm:px-5 sm:py-3.5">
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'inline-flex h-11 shrink-0 items-center justify-center rounded-lg px-6 text-[0.92rem] font-semibold leading-none transition-colors',
                  activeTab === tab.id
                    ? 'border border-border-strong bg-bg-mod-subtle text-text-primary'
                    : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                )}
              >
                {tab.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setActiveTab('add')}
              className={cn(
                'inline-flex h-11 shrink-0 items-center justify-center rounded-lg border px-6 text-[0.92rem] font-semibold leading-none transition-colors',
                activeTab === 'add'
                  ? 'border-accent-success/70 bg-accent-success/20 text-accent-success'
                  : 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
              )}
            >
              Add Friend
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
        {activeTab === 'add' ? (
          <div className="mx-auto h-full w-full">
            <div className="glass-panel h-full rounded-2xl p-5 sm:p-6 md:p-8">
              <h2 className="text-xl font-semibold text-text-primary sm:text-2xl">Add Friend</h2>
              <p className="mt-1.5 text-sm text-text-secondary">Add friends with their username or user ID.</p>

              <div className="mt-6 flex flex-col items-stretch gap-5 rounded-xl border border-border-subtle bg-bg-mod-subtle px-5 py-4 sm:flex-row sm:items-center sm:gap-6 sm:px-6 sm:py-5">
                <UserPlus size={18} className="text-text-muted" />
                <label htmlFor="friend-identifier" className="sr-only">
                  Username or user ID
                </label>
                <input
                  id="friend-identifier"
                  type="text"
                  value={addFriendInput}
                  onChange={(e) => setAddFriendInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleAddFriend(); }}
                  placeholder="Username or user ID"
                  className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                />
                <button
                  type="button"
                  onClick={() => void handleAddFriend()}
                  className="control-pill-btn w-full sm:w-auto sm:min-w-[188px] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!addFriendInput.trim() || isActionPending('add')}
                >
                  {isActionPending('add') ? 'Sending...' : 'Send Friend Request'}
                </button>
              </div>

              {addFriendStatus && (
                <div
                  role={addFriendStatus.type === 'error' ? 'alert' : 'status'}
                  className={cn(
                    'mt-3 rounded-lg border px-3 py-2 text-sm font-medium',
                    addFriendStatus.type === 'success'
                      ? 'border-accent-success/40 bg-accent-success/10 text-accent-success'
                      : 'border-accent-danger/40 bg-accent-danger/10 text-accent-danger'
                  )}
                >
                  {addFriendStatus.message}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mx-auto h-full w-full">
            <div className="glass-panel flex h-full min-h-0 flex-col rounded-2xl p-5 sm:p-6 md:p-8">
              {relationshipError && (
                <div role="alert" className="mb-4 rounded-lg border border-accent-danger/40 bg-accent-danger/10 px-3 py-2 text-sm font-medium text-accent-danger">
                  {relationshipError}
                </div>
              )}
              <div className="card-stack-relaxed mb-8">
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-3">
                  <div className="relative">
                    <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                    <label htmlFor="friends-search" className="sr-only">
                      Search friends
                    </label>
                    <input
                      id="friends-search"
                      type="text"
                      placeholder="Search friends"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="h-14 w-full rounded-xl border border-border-subtle bg-bg-mod-subtle py-2.5 pl-10 pr-4 text-[15px] leading-normal text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-strong focus:bg-bg-mod-strong"
                    />
                  </div>
                </div>
                <div className="grid gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4 lg:gap-7">
                  <div className="card-surface min-h-[6.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/75 px-6 py-6">
                    <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Online</div>
                    <div className="mt-1 text-xl font-semibold text-text-primary">{onlineCount}</div>
                  </div>
                  <div className="card-surface min-h-[6.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/75 px-6 py-6">
                    <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">All Friends</div>
                    <div className="mt-1 text-xl font-semibold text-text-primary">{friends.length}</div>
                  </div>
                  <div className="card-surface min-h-[6.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/75 px-6 py-6">
                    <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Pending</div>
                    <div className="mt-1 text-xl font-semibold text-text-primary">{pending.length}</div>
                  </div>
                  <div className="card-surface min-h-[6.5rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/75 px-6 py-6">
                    <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Blocked</div>
                    <div className="mt-1 text-xl font-semibold text-text-primary">{blocked.length}</div>
                  </div>
                </div>
              </div>

              {list.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center py-14 text-center">
                  <div className="card-surface mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
                    <Users size={34} className="text-text-muted" />
                  </div>
                  <div className="card-stack items-center">
                    <p className="text-base font-semibold leading-tight text-text-secondary">
                      {activeTab === 'online' && "No one's around to play with right now."}
                      {activeTab === 'all' && "You don't have any friends yet."}
                      {activeTab === 'pending' && 'There are no pending friend requests.'}
                      {activeTab === 'blocked' && "You haven't blocked anyone."}
                    </p>
                    <p className="text-sm leading-relaxed text-text-muted">
                      {activeTab === 'online' && 'Try adding some friends to chat with.'}
                      {activeTab === 'all' && "Click 'Add Friend' above to get started."}
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('add')}
                      className="btn-primary mt-2"
                    >
                      Add a Friend
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex-1">
                  <div className="mt-2 mb-4 px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {activeTab === 'all' ? 'All Friends' : activeTab === 'pending' ? 'Pending' : activeTab === 'blocked' ? 'Blocked' : 'Online'} - {list.length}
                  </div>

                  <div className="card-stack">
                    {list.map((rel) => (
                      <div
                        key={rel.id}
                        className="card-surface flex flex-wrap items-center gap-5 rounded-xl border border-border-subtle/70 bg-bg-mod-subtle/45 px-4 py-4 transition-colors hover:border-border-strong hover:bg-bg-mod-strong/55 sm:flex-nowrap sm:gap-5 sm:px-5 sm:py-5"
                      >
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent-primary text-sm font-semibold text-text-on-accent">
                          {rel.user.username.charAt(0).toUpperCase()}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-text-primary">{rel.user.username}</span>
                            {rel.type === 3 && <span className="text-xs text-text-muted">Incoming request</span>}
                            {rel.type === 4 && <span className="text-xs text-text-muted">Outgoing request</span>}
                          </div>
                        </div>

                        <div className="ml-auto flex items-center gap-3">
                          {rel.type === 3 && (
                            <button
                              type="button"
                              onClick={() => void handleAcceptFriend(rel.user.id)}
                              className="command-icon-btn border border-border-subtle bg-bg-mod-subtle text-accent-success hover:bg-bg-mod-strong"
                              title="Accept Friend Request"
                              aria-label={`Accept friend request from ${rel.user.username}`}
                              disabled={isActionPending(`accept:${rel.user.id}`)}
                            >
                              <Check size={16} />
                            </button>
                          )}
                          {rel.type === 1 && (
                            <button
                              type="button"
                              className="command-icon-btn border border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                              onClick={() => void handleMessageFriend(rel.user.id)}
                              title="Message"
                              aria-label={`Message ${rel.user.username}`}
                              disabled={isActionPending(`message:${rel.user.id}`)}
                            >
                              <MessageSquare size={16} />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleRemoveFriend(rel.user.id)}
                            className="command-icon-btn border border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-accent-danger"
                            title={rel.type === 2 ? 'Unblock' : 'Remove'}
                            aria-label={`${rel.type === 2 ? 'Unblock' : 'Remove'} ${rel.user.username}`}
                            disabled={isActionPending(`remove:${rel.user.id}`)}
                          >
                            <X size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
