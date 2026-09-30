import { useFreshRelationships } from '../hooks/useFreshRelationships';
import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { useBuildingLights } from '../hooks/useLights';
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, X, Search, Check, UserPlus, UserRoundPlus, Inbox, Ban, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Relationship } from '../api/relationships';
import { activateChannel } from '../lib/channelNavigation';
import { extractApiError } from '../api/client';
import { useChannelStore } from '../stores/channelStore';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { Input } from '../components/ui/Input';
import { SearchWell } from '../components/ui/TextField';
import { Tabs } from '../components/ui/Tabs';
import { displayName } from '../lib/displayName';
import { statusLine } from '../lib/activityDisplay';
import { presenceLabel } from '../lib/presence';
import type { Presence } from '../types';
import { UserProfilePopup } from '../components/user/UserProfile';
import { GlassPage, PageBar, PageScroll, PageSection } from '../components/home/GlassPage';
import { PagePerson, PageRow } from '../components/home/PageRow';

type FriendsTab = 'online' | 'all' | 'requests' | 'blocked';

/**
 * The words for a person's presence live in `lib/presence` and nowhere else
 * (docs/lantern-stage-spec.md §1.5, §6.9). A page that keeps its own copy of
 * them drifts from the account plate two hundred pixels away.
 */

/** Live first, then here, away, do not disturb, offline: the order a row is worth a glance. */
const STATUS_RANK: Record<string, number> = { streaming: 0, online: 1, idle: 2, dnd: 3 };
const rankOf = (status: string) => STATUS_RANK[status] ?? 4;

interface VoicePlace {
  room: string;
  place: string | null;
}

/** What somebody who is not a stranger is doing: the words they typed, else the app. */
function detailOf(presence: Presence | undefined): string | null {
  const line = statusLine(presence);
  if (!line) return null;
  if (line.type === 'custom') return line.text;
  // A row's line already says "Playing X" or "Watching X"; a track only says what it is.
  return line.activity.kind === 'listening' ? `Listening to ${line.activity.line}` : line.activity.line;
}

/**
 * The line under a friend's name: the word for their presence, then where they
 * are (amber: live) or what they are doing. Presence on the face is ink, never a
 * colored dot (docs/design/glass-plan.md §1.3).
 */
function FriendLine({ status, voice, detail }: { status: string; voice: VoicePlace | undefined; detail: string | null }) {
  return (
    <>
      {presenceLabel(status)}
      {voice ? (
        <span className="glass-prow__voice">
          {' · '}In {voice.room}
          {voice.place ? `, ${voice.place}` : ''}
        </span>
      ) : detail ? (
        ` · ${detail}`
      ) : null}
    </>
  );
}

export function FriendsPage() {
  const navigate = useNavigate();
  const channelScope = useCurrentAccountScope();
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
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const scope = activeServerId ?? undefined;
  const buildings = useBuildingLights();

  useFreshRelationships();

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

  // Who is in a voice room right now, and which: the amber on a friend's row.
  const inVoice = useMemo(() => {
    const map = new Map<string, VoicePlace>();
    for (const building of buildings) {
      for (const room of building.rooms) {
        if (room.kind !== 'voice') continue;
        for (const occupant of room.occupants) {
          if (!map.has(occupant.person.userId)) map.set(occupant.person.userId, { room: room.name, place: building.name });
        }
      }
    }
    return map;
  }, [buildings]);

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

  const openProfile = (user: Relationship['user'], anchor: HTMLElement) => {
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
          ? 'The instance rejected this format. Try using the user ID instead of username.'
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
      if (!channelScope) throw new Error('Sign in to this instance before messaging.');
      const data = await useChannelStore.getState().createDm(userId, channelScope);
      activateChannel(data);
      navigate(`/app/dms/${data.id}`);
    } catch (err: unknown) {
      setRelationshipError(extractApiError(err) || 'Failed to open direct message');
    } finally {
      finishAction(actionKey);
    }
  };

  const friendListSource =
    activeTab === 'all'
      ? friends
      : activeTab === 'blocked'
        ? blocked
        : friends.filter((r) => (getPresence(r.user.id, scope)?.status || 'offline') !== 'offline');

  const searchable = activeTab === 'online' || activeTab === 'all' || activeTab === 'blocked';
  const filteredList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matches = q
      ? friendListSource.filter((r) =>
          r.user.username.toLowerCase().includes(q) || displayName(r.user).toLowerCase().includes(q),
        )
      : friendListSource;
    if (activeTab === 'blocked') return matches;
    // The people worth a glance first: in a voice room, here, away, then the rest.
    const rank = (r: Relationship) =>
      inVoice.has(r.user.id) ? -1 : rankOf(getPresence(r.user.id, scope)?.status || 'offline');
    return [...matches].sort(
      (a, b) => rank(a) - rank(b) || displayName(a.user).localeCompare(displayName(b.user)),
    );
    // `presences` is what `getPresence` reads (see `onlineCount`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendListSource, searchQuery, activeTab, inVoice, presences, getPresence, scope]);

  const sectionLabel = activeTab === 'all' ? 'All' : activeTab === 'blocked' ? 'Blocked' : 'Online';
  const searchPlaceholder =
    activeTab === 'all'
      ? 'Search your friends'
      : activeTab === 'blocked'
        ? 'Search blocked people'
        : 'Search who is online';

  const line =
    friends.length === 0
      ? 'People you can message and see around'
      : [
          `${onlineCount} of ${friends.length} online`,
          pendingIncoming.length > 0
            ? `${pendingIncoming.length} ${pendingIncoming.length === 1 ? 'request' : 'requests'} waiting`
            : null,
        ]
          .filter(Boolean)
          .join(', ');

  const tabs = [
    { value: 'online' as const, label: 'Online', meta: onlineCount > 0 ? onlineCount : undefined },
    { value: 'all' as const, label: 'All', meta: friends.length > 0 ? friends.length : undefined },
    { value: 'requests' as const, label: 'Requests', meta: requestCount > 0 ? requestCount : undefined },
    { value: 'blocked' as const, label: 'Blocked', meta: blocked.length > 0 ? blocked.length : undefined },
  ];

  /** One person's row: the body opens their card; message and remove sit beside it. */
  const personRow = (
    rel: Relationship,
    actions: React.ReactNode,
    options: { blocked?: boolean; subtitle?: string } = {},
  ) => {
    const name = displayName(rel.user);
    const face = { userId: rel.user.id, name, avatar: rel.user.avatar_hash ?? null };
    // A request has no presence to show yet: just who and why.
    if (options.subtitle !== undefined) {
      return (
        <PageRow
          key={rel.id}
          lead={<PagePerson face={face} />}
          title={name}
          line={options.subtitle}
          label={`Open profile for ${name}`}
          onOpen={(anchor) => openProfile(rel.user, anchor)}
          actions={actions}
        />
      );
    }
    const presence = getPresence(rel.user.id, scope);
    const status = presence?.status || 'offline';
    const voice = inVoice.get(rel.user.id);
    return (
      <PageRow
        key={rel.id}
        offline={!options.blocked && status === 'offline'}
        lead={<PagePerson face={face} status={options.blocked ? null : status} live={Boolean(voice)} />}
        title={name}
        line={
          options.blocked ? 'Blocked' : <FriendLine status={status} voice={voice} detail={detailOf(presence)} />
        }
        label={`Open profile for ${name}`}
        onOpen={(anchor) => openProfile(rel.user, anchor)}
        actions={actions}
      />
    );
  };

  return (
    <GlassPage label="Friends">
      <PageBar
        title="Friends"
        line={line}
        actions={
          <Button
            variant="glass"
            onClick={() => (showAddFriend ? setShowAddFriend(false) : openAddFriend())}
            aria-expanded={showAddFriend}
          >
            <UserPlus size={16} aria-hidden />
            Add friend
          </Button>
        }
      />

      <PageScroll>
        <div className="glass-toolbar">
          <Tabs
            label="Show"
            items={tabs}
            value={activeTab}
            onChange={(next) => {
              setActiveTab(next);
              setSearchQuery('');
            }}
            size="sm"
          />
        </div>

        {showAddFriend && (
          <section aria-label="Add a friend" className="glass-card glass-add">
            <h2 className="glass-card__title">Add a friend</h2>
            <p className="glass-card__text">
              Send a request with someone's exact username, or their numeric user ID if you have it.
            </p>
            <div className="glass-add__form">
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
                className="glass-toolbar__grow"
              />
              <Button
                onClick={() => void handleAddFriend()}
                disabled={!addFriendInput.trim() || isActionPending('add')}
              >
                {isActionPending('add') ? 'Sending...' : 'Send friend request'}
              </Button>
            </div>
            {addFriendStatus && (
              <div
                role={addFriendStatus.type === 'error' ? 'alert' : 'status'}
                className="glass-note"
                data-tone={addFriendStatus.type === 'error' ? 'danger' : undefined}
              >
                {addFriendStatus.type === 'success' ? <Check size={16} aria-hidden /> : <X size={16} aria-hidden />}
                <span>{addFriendStatus.message}</span>
              </div>
            )}
          </section>
        )}

        {relationshipError && (
          <div role="alert" className="glass-note glass-toolbar" data-tone="danger">
            <X size={16} aria-hidden />
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
            row={personRow}
          />
        ) : (
          <>
            {searchable && (
              <div className="glass-toolbar">
                <SearchWell
                  id="friends-search"
                  label="Search friends"
                  placeholder={searchPlaceholder}
                  icon={<Search size={16} aria-hidden />}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="glass-toolbar__grow"
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
              <PageSection kicker={sectionLabel} count={filteredList.length}>
                {filteredList.map((rel) => {
                  const isFriend = rel.type === 1;
                  const name = displayName(rel.user);
                  return personRow(
                    rel,
                    <>
                      {isFriend && (
                        <IconButton
                          label={`Message ${name}`}
                          tone="raised"
                          onClick={() => void handleMessageFriend(rel.user.id)}
                          disabled={isActionPending(`message:${rel.user.id}`)}
                        >
                          <MessageSquare size={16} aria-hidden />
                        </IconButton>
                      )}
                      {rel.type === 2 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Unblock ${name}`}
                          onClick={() => void handleRemoveFriend(rel.user.id)}
                          disabled={isActionPending(`remove:${rel.user.id}`)}
                        >
                          Unblock
                        </Button>
                      ) : (
                        <IconButton
                          label={`Remove ${name}`}
                          className="glass-prow__reveal"
                          onClick={() => void handleRemoveFriend(rel.user.id)}
                          disabled={isActionPending(`remove:${rel.user.id}`)}
                        >
                          <X size={16} aria-hidden />
                        </IconButton>
                      )}
                    </>,
                    { blocked: rel.type === 2 },
                  );
                })}
              </PageSection>
            )}
          </>
        )}
      </PageScroll>
      {createPortal(
        <UserProfilePopup
          user={profile?.user ?? null}
          position={profile?.position ?? null}
          onClose={() => setProfile(null)}
        />,
        document.body,
      )}
    </GlassPage>
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
  row,
}: {
  incoming: Relationship[];
  outgoing: Relationship[];
  onAccept: (userId: string) => void;
  onDecline: (userId: string) => void;
  onAdd: () => void;
  isPending: (key: string) => boolean;
  row: (rel: Relationship, actions: React.ReactNode, options?: { blocked?: boolean; subtitle?: string }) => React.ReactNode;
}) {
  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <EmptyState
        icon={<Inbox size={20} />}
        title="No pending requests"
        description="Friend requests you've sent or received collect here. Send one and we'll let you know the moment it's accepted."
        action={
          <Button variant="glass" size="sm" onClick={onAdd}>
            Send a request
          </Button>
        }
      />
    );
  }

  return (
    <>
      {incoming.length > 0 && (
        <PageSection kicker="Incoming" count={incoming.length}>
          {incoming.map((rel) =>
            row(
              rel,
              <>
                <Button
                  variant="glass"
                  size="sm"
                  aria-label={`Accept friend request from ${displayName(rel.user)}`}
                  onClick={() => onAccept(rel.user.id)}
                  disabled={isPending(`accept:${rel.user.id}`)}
                >
                  Accept
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Decline friend request from ${displayName(rel.user)}`}
                  onClick={() => onDecline(rel.user.id)}
                  disabled={isPending(`remove:${rel.user.id}`)}
                >
                  Decline
                </Button>
              </>,
              { subtitle: 'Wants to be your friend' },
            ),
          )}
        </PageSection>
      )}

      {outgoing.length > 0 && (
        <PageSection kicker="Outgoing" count={outgoing.length}>
          {outgoing.map((rel) =>
            row(
              rel,
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Cancel friend request to ${displayName(rel.user)}`}
                onClick={() => onDecline(rel.user.id)}
                disabled={isPending(`remove:${rel.user.id}`)}
              >
                Cancel
              </Button>,
              { subtitle: 'Request sent, waiting to hear back' },
            ),
          )}
        </PageSection>
      )}
    </>
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
          <Button variant="glass" size="sm" onClick={onClearSearch}>
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
          title="None of your friends are online"
          description="They'll show up here the moment one of them is. In the meantime, add a few more people with the Add friend button up top."
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
          description="Add people by their username with the Add friend button up top to start DMs, share servers, and see when they're around. All it takes is their handle."
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
    case 'requests':
    default:
      return (
        <EmptyState
          icon={<ArrowUpRight size={20} />}
          title="No requests waiting"
          description="Nobody has asked to be friends, and you have no invitations out. Send one with the Add friend button up top — you only need their handle."
          action={
            <Button size="sm" onClick={onAdd}>
              Add a friend
            </Button>
          }
        />
      );
  }
}
