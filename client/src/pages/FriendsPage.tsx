import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Users, MessageSquare, X, Search, Check, UserPlus, UserRoundPlus, Inbox, Ban, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Relationship } from '../api/relationships';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { useChannelStore } from '../stores/channelStore';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { cn } from '../lib/utils';
import { displayName } from '../lib/displayName';
import { UserProfilePopup } from '../components/user/UserProfile';

type FriendsTab = 'online' | 'all' | 'requests' | 'blocked';

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
  alwaysVisible = false,
  tone = 'neutral',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  alwaysVisible?: boolean;
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
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-bg-mod-subtle text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
        !alwaysVisible && 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100',
        tone === 'success' && 'text-accent-success hover:text-accent-success',
        tone === 'danger' && 'hover:text-accent-danger',
        tone === 'neutral' && 'hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

// A single person row (design-spec §7 List item): avatar + optional presence dot,
// name + subtitle, then row actions supplied by the caller.
function PersonRow({
  name,
  subtitle,
  status,
  showPresence,
  onOpenProfile,
  actions,
}: {
  name: string;
  subtitle: string;
  status?: string;
  showPresence?: boolean;
  onOpenProfile?: (anchor: HTMLButtonElement) => void;
  actions: ReactNode;
}) {
  return (
    <div className="group flex items-center gap-1.5 px-2 py-1.5 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle">
      <button
        type="button"
        aria-label={`Open profile for ${name}`}
        onClick={(event) => onOpenProfile?.(event.currentTarget)}
        disabled={!onOpenProfile}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm px-2 py-1 text-left outline-none focus-visible:shadow-[var(--focus-ring)] disabled:cursor-default"
      >
        <div className="relative shrink-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-tint text-label font-semibold text-accent-primary">
            {name.charAt(0).toUpperCase()}
          </div>
          {showPresence && status && status !== 'offline' && (
            <span
              className={cn('absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full', STATUS_COLOR[status] ?? 'bg-status-offline')}
              style={{ boxShadow: '0 0 0 2.5px var(--bg-secondary)' }}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-label font-semibold text-text-primary">{name}</div>
          <div className="truncate text-meta text-text-muted">{subtitle}</div>
        </div>
      </button>
      <div className="flex items-center gap-1.5">{actions}</div>
    </div>
  );
}

export function FriendsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<FriendsTab>('online');
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [addFriendInput, setAddFriendInput] = useState('');
  const [addFriendStatus, setAddFriendStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [profile, setProfile] = useState<{ user: Relationship['user']; position: { x: number; y: number } } | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
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
  const requestCount = pendingIncoming.length + pendingOutgoing.length;
  const onlineCount = useMemo(
    () =>
      friends.filter(
        (r) => (getPresence(r.user.id, scope)?.status || 'offline') !== 'offline'
      ).length,
    // `getPresence` is a stable store action, so it never signals a change on
    // its own; `presences` is the value it actually reads and is what must
    // invalidate this memo. The linter cannot see through the store accessor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const openAddFriend = () => {
    setShowAddFriend(true);
    // Focus lands on the input on the next frame once it's mounted.
    requestAnimationFrame(() => addInputRef.current?.focus());
  };

  const openProfile = (user: Relationship['user'], anchor: HTMLButtonElement) => {
    const rect = anchor.getBoundingClientRect();
    setProfile({ user, position: { x: rect.right, y: rect.top } });
  };

  const handleAddFriend = async () => {
    const identifier = addFriendInput.trim();
    if (!identifier || isActionPending('add')) return;
    setAddFriendStatus(null);
    setRelationshipError(null);
    startAction('add');
    try {
      const before = useRelationshipStore.getState().relationships;
      await useRelationshipStore.getState().addFriend(identifier);
      await useRelationshipStore.getState().fetchRelationships();
      const after = useRelationshipStore.getState().relationships;
      const matched = after.find(
        (r) =>
          r.user.username.toLowerCase() === identifier.toLowerCase()
          || r.user.id === identifier,
      );
      const newlyAdded = matched && !before.some((r) => r.user.id === matched.user.id && r.type === matched.type);
      if (!matched || !newlyAdded) {
        // Server returns 204 for unknown usernames to avoid enumeration — don't claim success.
        setAddFriendStatus({
          type: 'success',
          message: `If an account named "${identifier}" exists, a friend request was sent.`,
        });
      } else if (matched.type === 1) {
        setAddFriendStatus({ type: 'success', message: `You are now friends with ${matched.user.username}!` });
      } else {
        setAddFriendStatus({ type: 'success', message: `Friend request sent to ${matched.user.username}!` });
      }
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
    { id: 'requests', label: 'Requests', count: requestCount },
    { id: 'blocked', label: 'Blocked', count: blocked.length },
  ];

  const friendListSource =
    activeTab === 'all'
      ? friends
      : activeTab === 'blocked'
        ? blocked
        : friends.filter((r) => (getPresence(r.user.id, scope)?.status || 'offline') !== 'offline');

  const searchable = activeTab === 'online' || activeTab === 'all' || activeTab === 'blocked';
  const filteredList = useMemo(() => {
    if (!searchQuery.trim()) return friendListSource;
    const q = searchQuery.toLowerCase();
    return friendListSource.filter((r) =>
      r.user.username.toLowerCase().includes(q) || displayName(r.user).toLowerCase().includes(q)
    );
  }, [friendListSource, searchQuery]);

  const sectionLabel = activeTab === 'all' ? 'All' : activeTab === 'blocked' ? 'Blocked' : 'Online';

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      {/* Solid header — title + primary Add-friend action (no gradient hero, §6.1). */}
      <header className="shrink-0 border-b border-border-subtle bg-bg-secondary px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
            <Users size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-heading text-text-primary">Friends</h1>
            <p className="text-meta text-text-muted">People you can DM, share spaces with, and see around.</p>
          </div>
          <Button
            onClick={() => (showAddFriend ? setShowAddFriend(false) : openAddFriend())}
            aria-expanded={showAddFriend}
            className="shrink-0"
          >
            <UserPlus size={16} className="mr-1.5" />
            Add friend
          </Button>
        </div>

        {/* Inline add-friend input — the primary action, not a hidden tab (§ task 1). */}
        {showAddFriend && (
          <div className="mt-4 rounded-md border border-border-subtle bg-bg-primary p-4">
            <div className="text-section uppercase text-text-muted">Add a friend</div>
            <p className="mt-1 text-meta text-text-secondary">
              Send a request with someone's exact username, or their numeric user ID if you have it.
            </p>
            <div className="mt-3 flex flex-col gap-2.5 sm:flex-row sm:items-center">
              <label htmlFor="friend-identifier" className="sr-only">
                Username or user ID
              </label>
              <Input
                id="friend-identifier"
                ref={addInputRef}
                type="text"
                value={addFriendInput}
                onChange={(e) => setAddFriendInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAddFriend(); }}
                placeholder="Username or user ID"
                className="flex-1"
              />
              <Button
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
                  'mt-3 flex items-center gap-2 rounded-sm border px-3.5 py-2.5 text-label font-medium',
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
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {filterTabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setSearchQuery(''); }}
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
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="px-4 py-4 sm:px-6">
          {relationshipError && (
            <div role="alert" className="mb-4 flex items-center gap-2 rounded-md border border-accent-danger/35 bg-danger-tint px-3.5 py-2.5 text-label font-medium text-accent-danger">
              <X size={16} />
              <span>{relationshipError}</span>
            </div>
          )}

          {activeTab === 'requests' ? (
            <RequestsView
              incoming={pendingIncoming}
              outgoing={pendingOutgoing}
              onAccept={(id) => void handleAcceptFriend(id)}
              onDecline={(id) => void handleRemoveFriend(id)}
              onAdd={openAddFriend}
              isPending={isActionPending}
              onOpenProfile={openProfile}
            />
          ) : (
            <>
              {searchable && (
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
              )}

              {filteredList.length === 0 ? (
                <FriendsEmptyState
                  tab={activeTab}
                  searching={searchQuery.trim().length > 0}
                  onAdd={openAddFriend}
                  onClearSearch={() => setSearchQuery('')}
                />
              ) : (
                <>
                  <div className="mb-2 px-1 text-section uppercase text-text-muted">
                    {sectionLabel} — {filteredList.length}
                  </div>
                  <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                    {filteredList.map((rel) => {
                      const status = getPresence(rel.user.id, scope)?.status || 'offline';
                      const isFriend = rel.type === 1;
                      const subtitle = rel.type === 2 ? 'Blocked' : STATUS_LABEL[status] ?? 'Offline';
                      return (
                        <PersonRow
                          key={rel.id}
                          name={displayName(rel.user)}
                          subtitle={subtitle}
                          status={status}
                          showPresence={isFriend}
                          onOpenProfile={(anchor) => openProfile(rel.user, anchor)}
                          actions={
                            <>
                              {isFriend && (
                                <ActionButton
                                  label={`Message ${displayName(rel.user)}`}
                                  onClick={() => void handleMessageFriend(rel.user.id)}
                                  disabled={isActionPending(`message:${rel.user.id}`)}
                                  alwaysVisible
                                >
                                  <MessageSquare size={16} />
                                </ActionButton>
                              )}
                              <ActionButton
                                label={`${rel.type === 2 ? 'Unblock' : 'Remove'} ${displayName(rel.user)}`}
                                tone="danger"
                                onClick={() => void handleRemoveFriend(rel.user.id)}
                                disabled={isActionPending(`remove:${rel.user.id}`)}
                              >
                                <X size={16} />
                              </ActionButton>
                            </>
                          }
                        />
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {profile && createPortal(
        <UserProfilePopup
          user={profile.user}
          position={profile.position}
          onClose={() => setProfile(null)}
        />,
        document.body,
      )}
    </div>
  );
}

// Incoming / Outgoing request sections (§ task 1 — visible sections with counts +
// accept/decline affordances). Each carries its own header + count.
function RequestsView({
  incoming,
  outgoing,
  onAccept,
  onDecline,
  onAdd,
  isPending,
  onOpenProfile,
}: {
  incoming: Relationship[];
  outgoing: Relationship[];
  onAccept: (userId: string) => void;
  onDecline: (userId: string) => void;
  onAdd: () => void;
  isPending: (key: string) => boolean;
  onOpenProfile: (user: Relationship['user'], anchor: HTMLButtonElement) => void;
}) {
  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <EmptyState
        icon={<Inbox size={20} />}
        title="No pending requests"
        description="Friend requests you've sent or received collect here. Send one and we'll let you know the moment it's accepted."
        action={
          <Button variant="secondary" size="sm" onClick={onAdd}>
            Send a request
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {incoming.length > 0 && (
        <section>
          <div className="mb-2 px-1 text-section uppercase text-text-muted">Incoming — {incoming.length}</div>
          <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
            {incoming.map((rel) => (
              <PersonRow
                key={rel.id}
                name={displayName(rel.user)}
                subtitle="Wants to be your friend"
                onOpenProfile={(anchor) => onOpenProfile(rel.user, anchor)}
                actions={
                  <>
                    <ActionButton
                      label={`Accept friend request from ${displayName(rel.user)}`}
                      tone="success"
                      onClick={() => onAccept(rel.user.id)}
                      disabled={isPending(`accept:${rel.user.id}`)}
                    >
                      <Check size={16} />
                    </ActionButton>
                    <ActionButton
                      label={`Decline friend request from ${displayName(rel.user)}`}
                      tone="danger"
                      onClick={() => onDecline(rel.user.id)}
                      disabled={isPending(`remove:${rel.user.id}`)}
                    >
                      <X size={16} />
                    </ActionButton>
                  </>
                }
              />
            ))}
          </div>
        </section>
      )}

      {outgoing.length > 0 && (
        <section>
          <div className="mb-2 px-1 text-section uppercase text-text-muted">Outgoing — {outgoing.length}</div>
          <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
            {outgoing.map((rel) => (
              <PersonRow
                key={rel.id}
                name={displayName(rel.user)}
                subtitle="Request sent — waiting to hear back"
                onOpenProfile={(anchor) => onOpenProfile(rel.user, anchor)}
                actions={
                  <ActionButton
                    label={`Cancel friend request to ${displayName(rel.user)}`}
                    tone="danger"
                    onClick={() => onDecline(rel.user.id)}
                    disabled={isPending(`remove:${rel.user.id}`)}
                  >
                    <X size={16} />
                  </ActionButton>
                }
              />
            ))}
          </div>
        </section>
      )}
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
          description="None of your friends are online at the moment — they'll show up here the second they sign in. In the meantime, add a few more people with the Add friend button up top."
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
          description="Add people by their username with the Add friend button up top to start DMs, share spaces, and see when they're around. All it takes is their handle."
          action={
            <Button size="sm" onClick={onAdd}>
              Add your first friend
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
          icon={<ArrowUpRight size={20} />}
          title="Nothing here yet"
          description="There's nobody in this list right now."
        />
      );
  }
}
