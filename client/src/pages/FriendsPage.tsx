import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Users, MessageSquare, X, Search, Check, UserPlus, UserRoundPlus, UserRoundX, Inbox, Ban } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { useChannelStore } from '../stores/channelStore';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { cn } from '../lib/utils';

type FriendsTab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

const STATUS_COLOR: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
  offline: 'bg-status-offline',
};

const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  streaming: 'Streaming',
  offline: 'Offline',
};

// Icon action button (design-spec §7 Icon button). Revealed on row hover AND
// keyboard focus so hover-only actions stay reachable (§8).
function ActionButton({
  label,
  onClick,
  disabled,
  tone = 'neutral',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'success' | 'danger';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-bg-mod-subtle text-text-secondary opacity-100 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100',
        tone === 'success' && 'text-accent-success hover:text-accent-success',
        tone === 'danger' && 'hover:text-accent-danger',
        tone === 'neutral' && 'hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

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
  const scope = activeServerId ?? undefined;

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
        (r) => (getPresence(r.user.id, scope)?.status || 'offline') !== 'offline'
      ).length,
    [friends, presences, getPresence, scope]
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

  const filterTabs: { id: FriendsTab; label: string; count: number }[] = [
    { id: 'online', label: 'Online', count: onlineCount },
    { id: 'all', label: 'All', count: friends.length },
    { id: 'pending', label: 'Pending', count: pending.length },
    { id: 'blocked', label: 'Blocked', count: blocked.length },
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
                (r) => (getPresence(r.user.id, scope)?.status || 'offline') !== 'offline'
              );

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      base = base.filter((r) => r.user.username.toLowerCase().includes(q));
    }
    return base;
  }, [activeTab, blocked, friends, pending, presences, getPresence, searchQuery, scope]);

  const sectionLabel =
    activeTab === 'all' ? 'All friends' : activeTab === 'pending' ? 'Pending' : activeTab === 'blocked' ? 'Blocked' : 'Online';

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      {/* Solid header with title + filter pills (no gradient hero) */}
      <header className="shrink-0 border-b border-border-subtle bg-bg-secondary px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
            <Users size={19} />
          </span>
          <h1 className="font-display text-heading text-text-primary">Friends</h1>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {filterTabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-pressed={active}
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                  active
                    ? 'bg-accent-tint text-accent-primary'
                    : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                )}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-meta font-semibold tabular-nums',
                      active ? 'bg-accent-primary/20 text-accent-primary' : 'bg-bg-mod-strong text-text-secondary',
                    )}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setActiveTab('add')}
              aria-pressed={activeTab === 'add'}
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-label font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                activeTab === 'add'
                  ? 'bg-accent-primary text-text-on-accent shadow-sm'
                  : 'bg-bg-mod-subtle text-text-primary hover:bg-bg-mod-strong',
              )}
            >
              <UserPlus size={15} />
              Add Friend
            </button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {activeTab === 'add' ? (
          <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
            <h2 className="font-display text-title text-text-primary">Add a friend</h2>
            <p className="mt-1.5 text-body text-text-secondary">
              Send a request with someone's exact username, or their numeric user ID if you have it.
            </p>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <label htmlFor="friend-identifier" className="sr-only">
                Username or user ID
              </label>
              <Input
                id="friend-identifier"
                type="text"
                value={addFriendInput}
                onChange={(e) => setAddFriendInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAddFriend(); }}
                placeholder="Username or user ID"
                className="flex-1"
              />
              <Button
                type="button"
                onClick={() => void handleAddFriend()}
                disabled={!addFriendInput.trim() || isActionPending('add')}
                className="sm:w-auto"
              >
                {isActionPending('add') ? 'Sending...' : 'Send Friend Request'}
              </Button>
            </div>

            {addFriendStatus && (
              <div
                role={addFriendStatus.type === 'error' ? 'alert' : 'status'}
                className={cn(
                  'mt-3 flex items-center gap-2 rounded-md border px-3.5 py-2.5 text-label font-medium',
                  addFriendStatus.type === 'success'
                    ? 'border-accent-success/35 bg-success-tint text-accent-success'
                    : 'border-accent-danger/35 bg-danger-tint text-accent-danger',
                )}
              >
                {addFriendStatus.type === 'success' ? <Check size={16} /> : <X size={16} />}
                <span>{addFriendStatus.message}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="px-4 py-4 sm:px-6">
            {relationshipError && (
              <div role="alert" className="mb-4 flex items-center gap-2 rounded-md border border-accent-danger/35 bg-danger-tint px-3.5 py-2.5 text-label font-medium text-accent-danger">
                <X size={16} />
                <span>{relationshipError}</span>
              </div>
            )}

            <div className="relative mb-5">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <label htmlFor="friends-search" className="sr-only">
                Search friends
              </label>
              <Input
                id="friends-search"
                type="text"
                placeholder={`Search ${sectionLabel.toLowerCase()}`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {list.length === 0 ? (
              <FriendsEmptyState
                tab={activeTab}
                searching={searchQuery.trim().length > 0}
                onAdd={() => setActiveTab('add')}
                onClearSearch={() => setSearchQuery('')}
              />
            ) : (
              <>
                <div className="mb-2 px-1 text-section uppercase text-text-muted">
                  {sectionLabel} — {list.length}
                </div>
                <div className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                  {list.map((rel) => {
                    const status = getPresence(rel.user.id, scope)?.status || 'offline';
                    const subtitle =
                      rel.type === 3
                        ? 'Incoming friend request'
                        : rel.type === 4
                          ? 'Outgoing friend request'
                          : rel.type === 2
                            ? 'Blocked'
                            : STATUS_LABEL[status] ?? 'Offline';
                    return (
                      <div
                        key={rel.id}
                        className="group flex items-center gap-3 px-4 py-2.5 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle"
                      >
                        <div className="relative shrink-0">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-tint text-label font-semibold text-accent-primary">
                            {rel.user.username.charAt(0).toUpperCase()}
                          </div>
                          {rel.type === 1 && status !== 'offline' && (
                            <span
                              className={cn('absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full', STATUS_COLOR[status] ?? 'bg-status-offline')}
                              style={{ boxShadow: '0 0 0 2.5px var(--bg-secondary)' }}
                            />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="truncate text-label font-semibold text-text-primary">{rel.user.username}</div>
                          <div className="truncate text-meta text-text-muted">{subtitle}</div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {rel.type === 3 && (
                            <ActionButton
                              label={`Accept friend request from ${rel.user.username}`}
                              tone="success"
                              onClick={() => void handleAcceptFriend(rel.user.id)}
                              disabled={isActionPending(`accept:${rel.user.id}`)}
                            >
                              <Check size={16} />
                            </ActionButton>
                          )}
                          {rel.type === 1 && (
                            <ActionButton
                              label={`Message ${rel.user.username}`}
                              onClick={() => void handleMessageFriend(rel.user.id)}
                              disabled={isActionPending(`message:${rel.user.id}`)}
                            >
                              <MessageSquare size={16} />
                            </ActionButton>
                          )}
                          <ActionButton
                            label={`${rel.type === 2 ? 'Unblock' : 'Remove'} ${rel.user.username}`}
                            tone="danger"
                            onClick={() => void handleRemoveFriend(rel.user.id)}
                            disabled={isActionPending(`remove:${rel.user.id}`)}
                          >
                            <X size={16} />
                          </ActionButton>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FriendsEmptyState({
  tab,
  searching,
  onAdd,
  onClearSearch,
}: {
  tab: FriendsTab;
  searching: boolean;
  onAdd: () => void;
  onClearSearch: () => void;
}) {
  if (searching) {
    return (
      <EmptyState
        icon={<Search size={20} />}
        title="No matches"
        description="No one in this list matches your search. Check the spelling, or clear the filter to see everyone again."
        action={
          <Button variant="secondary" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  }

  switch (tab) {
    case 'online':
      return (
        <EmptyState
          icon={<UserRoundPlus size={20} />}
          title="Nobody's online right now"
          description="None of your friends are online at the moment — they'll show up here the second they sign in. In the meantime, add a few more people to your circle."
          action={
            <Button size="sm" onClick={onAdd}>
              Add a friend
            </Button>
          }
        />
      );
    case 'all':
      return (
        <EmptyState
          icon={<UserRoundPlus size={20} />}
          title="Your friends list is empty"
          description="Add people by their username to start DMs, share servers, and see when they're around. It only takes their handle."
          action={
            <Button size="sm" onClick={onAdd}>
              Add your first friend
            </Button>
          }
        />
      );
    case 'pending':
      return (
        <EmptyState
          icon={<Inbox size={20} />}
          title="No pending requests"
          description="Friend requests you've sent or received will collect here. Send one and we'll let you know the moment it's accepted."
          action={
            <Button variant="secondary" size="sm" onClick={onAdd}>
              Send a request
            </Button>
          }
        />
      );
    case 'blocked':
      return (
        <EmptyState
          icon={<Ban size={20} />}
          title="You haven't blocked anyone"
          description="People you block won't be able to message you or add you as a friend. Anyone you block will appear here so you can undo it later."
        />
      );
    default:
      return (
        <EmptyState
          icon={<UserRoundX size={20} />}
          title="Nothing here yet"
          description="There's nobody in this list right now."
        />
      );
  }
}
