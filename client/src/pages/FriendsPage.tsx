import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { extractApiError } from '../api/client';
import type { Relationship } from '../api/relationships';
import { IxGlyph } from '../components/ix/glyphs';
import { Avatar } from '../components/ix/identity';
import { openProfileCard } from '../components/ix/menus';
import { EmptyPage, LargeTitlePage } from '../components/ix/page';
import { Segmented, segmentedIds } from '../components/ix/people/Segmented';
import { Control, CreamButton, SectionLabel, WideControl } from '../components/ix/primitives';
import { useBuildingLights } from '../hooks/useLights';
import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { useFreshRelationships } from '../hooks/useFreshRelationships';
import { statusLine } from '../lib/activityDisplay';
import { activateChannel } from '../lib/channelNavigation';
import { displayName } from '../lib/displayName';
import { presenceLabel } from '../lib/presence';
import { usePresenceStore } from '../stores/presenceStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useServerListStore } from '../stores/serverListStore';
import { useChannelStore } from '../stores/channelStore';
import type { Presence } from '../types';

type FriendsTab = 'online' | 'all' | 'requests' | 'blocked';

/**
 * The words for a person's presence live in `lib/presence` and nowhere else
 * (docs/lantern-stage-spec.md §1.5, §6.9). A page that keeps its own copy of
 * them drifts from the account menu a few hundred pixels away.
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
 * The line under a friend's name: the word for their presence, then where they are
 * (amber: live) or what they are doing.
 */
function FriendLine({ status, voice, detail }: { status: string; voice: VoicePlace | undefined; detail: string | null }) {
  return (
    <>
      {presenceLabel(status)}
      {voice ? (
        <span className="ix-fr__voice">
          {' · '}In {voice.room}
          {voice.place ? `, ${voice.place}` : ''}
        </span>
      ) : detail ? (
        ` · ${detail}`
      ) : null}
    </>
  );
}

/**
 * Friends (docs/index-spec.md §6.6, §8.1): a page in main under the large title, a
 * segmented control Online / All / Requests / Blocked, and **Add friend**, the page's
 * one cream button. A row opens the person's profile card; Message and Remove sit beside
 * it, and a request has its own decisions.
 */
export function FriendsPage() {
  const location = useLocation();
  // The People menu's "Add friend" and the switcher's "Add a friend" arrive with the form asked for; a
  // fresh arrival is a fresh page (the key), so the form is open from the first render.
  const asked = (location.state as { addFriend?: boolean } | null)?.addFriend === true;
  return <FriendsView key={location.key} openAdd={asked} />;
}

function FriendsView({ openAdd }: { openAdd: boolean }) {
  const navigate = useNavigate();
  const channelScope = useCurrentAccountScope();
  const [activeTab, setActiveTab] = useState<FriendsTab>('online');
  const [showAddFriend, setShowAddFriend] = useState(openAdd);
  const [addFriendInput, setAddFriendInput] = useState('');
  const [addFriendStatus, setAddFriendStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
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
    () => friends.filter((r) => (getPresence(r.user.id, scope)?.status || 'offline') !== 'offline').length,
    // `getPresence` is a stable store action, so it never signals a change on
    // its own; `presences` is the value it actually reads and is what must
    // invalidate this memo. The linter cannot see through the store accessor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [friends, presences, getPresence, scope],
  );

  // Who is in a voice channel right now, and which: the amber on a friend's row.
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

  useEffect(() => {
    if (openAdd) requestAnimationFrame(() => addInputRef.current?.focus());
  }, [openAdd]);

  const openProfile = (user: Relationship['user'], anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    openProfileCard(user, { x: rect.right, y: rect.top });
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
        (r) => r.user.username.toLowerCase() === identifier.toLowerCase() || r.user.id === identifier,
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
      ? friendListSource.filter((r) => r.user.username.toLowerCase().includes(q) || displayName(r.user).toLowerCase().includes(q))
      : friendListSource;
    if (activeTab === 'blocked') return matches;
    // The people worth a glance first: in a voice channel, here, away, then the rest.
    const rank = (r: Relationship) => (inVoice.has(r.user.id) ? -1 : rankOf(getPresence(r.user.id, scope)?.status || 'offline'));
    return [...matches].sort((a, b) => rank(a) - rank(b) || displayName(a.user).localeCompare(displayName(b.user)));
    // `presences` is what `getPresence` reads (see `onlineCount`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendListSource, searchQuery, activeTab, inVoice, presences, getPresence, scope]);

  const sectionLabel = activeTab === 'all' ? 'All' : activeTab === 'blocked' ? 'Blocked' : 'Online';
  const searchPlaceholder =
    activeTab === 'all' ? 'Search your friends' : activeTab === 'blocked' ? 'Search blocked people' : 'Search who is online';

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
          .join(' · ');

  const tabs = [
    { value: 'online' as const, label: 'Online', count: onlineCount },
    { value: 'all' as const, label: 'All', count: friends.length },
    { value: 'requests' as const, label: 'Requests', count: requestCount },
    { value: 'blocked' as const, label: 'Blocked', count: blocked.length },
  ];
  const ids = segmentedIds('ix-friends', activeTab);

  /** One person's row: the body opens their card; message and remove sit beside it. */
  const personRow = (rel: Relationship, actions: ReactNode, options: { blocked?: boolean; subtitle?: string } = {}) => {
    const name = displayName(rel.user);
    const avatar = rel.user.avatar_hash ?? null;
    // A request has no presence to show yet: just who and why.
    if (options.subtitle !== undefined) {
      return (
        <FriendRow
          key={rel.id}
          lead={<Avatar userId={rel.user.id} name={name} avatar={avatar} size={40} ring="var(--ix-main)" />}
          name={name}
          line={options.subtitle}
          onOpen={(anchor) => openProfile(rel.user, anchor)}
          actions={actions}
        />
      );
    }
    const presence = getPresence(rel.user.id, scope);
    const status = presence?.status || 'offline';
    const voice = inVoice.get(rel.user.id);
    return (
      <FriendRow
        key={rel.id}
        offline={!options.blocked && status === 'offline'}
        lead={
          <Avatar
            userId={rel.user.id}
            name={name}
            avatar={avatar}
            size={40}
            ring="var(--ix-main)"
            presence={options.blocked ? null : status}
          />
        }
        name={name}
        line={options.blocked ? 'Blocked' : <FriendLine status={status} voice={voice} detail={detailOf(presence)} />}
        onOpen={(anchor) => openProfile(rel.user, anchor)}
        actions={actions}
        live={Boolean(voice)}
      />
    );
  };

  return (
    <LargeTitlePage title="Friends" subtitle={line} data-testid="ix-friends" className="ix-sp ix-fr">
      <div className="ix-fr__bar">
        <Segmented
          label="Show"
          idBase="ix-friends"
          items={tabs}
          value={activeTab}
          onChange={(next) => {
            setActiveTab(next);
            setSearchQuery('');
          }}
        />
        <CreamButton
          size="sm"
          aria-expanded={showAddFriend}
          onClick={() => (showAddFriend ? setShowAddFriend(false) : openAddFriend())}
        >
          Add friend
        </CreamButton>
      </div>

      {showAddFriend && (
        <section aria-label="Add a friend" className="ix-fr__add">
          <h2 className="ix-fr__add-title">Add a friend</h2>
          <p className="ix-fr__add-text">Send a request with someone&rsquo;s exact username, or their numeric user ID if you have it.</p>
          <div className="ix-fr__add-form">
            <label htmlFor="friend-identifier" className="sr-only">
              Username or user ID
            </label>
            <input
              id="friend-identifier"
              ref={addInputRef}
              type="text"
              className="ix-field"
              value={addFriendInput}
              onChange={(e) => setAddFriendInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddFriend();
              }}
              placeholder="Username or user ID"
              autoComplete="off"
              spellCheck={false}
            />
            <WideControl onClick={() => void handleAddFriend()} disabled={!addFriendInput.trim() || isActionPending('add')}>
              {isActionPending('add') ? 'Sending...' : 'Send friend request'}
            </WideControl>
          </div>
          {addFriendStatus && (
            <p
              role={addFriendStatus.type === 'error' ? 'alert' : 'status'}
              className="ix-fr__note"
              data-tone={addFriendStatus.type === 'error' ? 'danger' : undefined}
            >
              <IxGlyph name={addFriendStatus.type === 'success' ? 'check' : 'x'} size={16} />
              <span>{addFriendStatus.message}</span>
            </p>
          )}
        </section>
      )}

      {relationshipError && (
        <p role="alert" className="ix-fr__note" data-tone="danger">
          <IxGlyph name="x" size={16} />
          <span>{relationshipError}</span>
        </p>
      )}

      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className="ix-fr__panel">
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
              <label className="ix-psearch">
                <IxGlyph name="search" size={15} />
                <input
                  id="friends-search"
                  type="search"
                  aria-label="Search friends"
                  placeholder={searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}

            {filteredList.length === 0 ? (
              <FriendsEmptyState tab={activeTab} searching={searchQuery.trim().length > 0} onAdd={openAddFriend} onClearSearch={() => setSearchQuery('')} />
            ) : (
              <FriendsSection label={sectionLabel} count={filteredList.length}>
                {filteredList.map((rel) => {
                  const isFriend = rel.type === 1;
                  const name = displayName(rel.user);
                  return personRow(
                    rel,
                    <>
                      {rel.type === 2 ? (
                        <WideControl
                          aria-label={`Unblock ${name}`}
                          onClick={() => void handleRemoveFriend(rel.user.id)}
                          disabled={isActionPending(`remove:${rel.user.id}`)}
                        >
                          Unblock
                        </WideControl>
                      ) : (
                        <Control
                          label={`Remove ${name}`}
                          className="ix-fr__reveal"
                          onClick={() => void handleRemoveFriend(rel.user.id)}
                          disabled={isActionPending(`remove:${rel.user.id}`)}
                        >
                          <IxGlyph name="x" size={16} />
                        </Control>
                      )}
                      {isFriend && (
                        <Control
                          label={`Message ${name}`}
                          onClick={() => void handleMessageFriend(rel.user.id)}
                          disabled={isActionPending(`message:${rel.user.id}`)}
                        >
                          <IxGlyph name="hello" size={16} />
                        </Control>
                      )}
                    </>,
                    { blocked: rel.type === 2 },
                  );
                })}
              </FriendsSection>
            )}
          </>
        )}
      </div>
    </LargeTitlePage>
  );
}

/* ---- Parts ------------------------------------------------------------------------- */

function FriendsSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const id = `ix-fr-${label.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="ix-fr__section">
      <SectionLabel as="h2" count={count}>
        {/* The region is named by the label alone, not "Online1". */}
        <span id={id}>{label}</span>
      </SectionLabel>
      <ul className="ix-fr__list">{children}</ul>
    </section>
  );
}

interface FriendRowProps {
  lead: ReactNode;
  name: string;
  line: ReactNode;
  onOpen: (anchor: HTMLElement) => void;
  actions: ReactNode;
  offline?: boolean;
  live?: boolean;
}

/** The row's body is one control (it opens the card) and the decisions beside it are siblings, never children of it. */
function FriendRow({ lead, name, line, onOpen, actions, offline, live }: FriendRowProps) {
  return (
    <li className="ix-fr__row" data-offline={offline ? '' : undefined} data-live={live ? '' : undefined}>
      <button type="button" className="ix-fr__body" aria-label={`Open profile for ${name}`} onClick={(event) => onOpen(event.currentTarget)}>
        {lead}
        <span className="ix-fr__text">
          <span className="ix-fr__name">{name}</span>
          <span className="ix-fr__line">{line}</span>
        </span>
      </button>
      <div className="ix-fr__actions">{actions}</div>
    </li>
  );
}

// Incoming / Outgoing request sections: each carries its own header and count.
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
  row: (rel: Relationship, actions: ReactNode, options?: { blocked?: boolean; subtitle?: string }) => ReactNode;
}) {
  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <EmptyPage
        inline
        glyph="invite"
        title="No pending requests"
        line="Friend requests you've sent or received collect here. Send one and you'll see the moment it's accepted."
        action={
          <WideControl onClick={onAdd} className="ix-fr__empty-action">
            Send a request
          </WideControl>
        }
      />
    );
  }

  return (
    <>
      {incoming.length > 0 && (
        <FriendsSection label="Incoming" count={incoming.length}>
          {incoming.map((rel) =>
            row(
              rel,
              <>
                <WideControl
                  className="ix-fr__accept"
                  aria-label={`Accept friend request from ${displayName(rel.user)}`}
                  onClick={() => onAccept(rel.user.id)}
                  disabled={isPending(`accept:${rel.user.id}`)}
                >
                  Accept
                </WideControl>
                <WideControl
                  aria-label={`Decline friend request from ${displayName(rel.user)}`}
                  onClick={() => onDecline(rel.user.id)}
                  disabled={isPending(`remove:${rel.user.id}`)}
                >
                  Decline
                </WideControl>
              </>,
              { subtitle: 'Wants to be your friend' },
            ),
          )}
        </FriendsSection>
      )}

      {outgoing.length > 0 && (
        <FriendsSection label="Outgoing" count={outgoing.length}>
          {outgoing.map((rel) =>
            row(
              rel,
              <WideControl
                aria-label={`Cancel friend request to ${displayName(rel.user)}`}
                onClick={() => onDecline(rel.user.id)}
                disabled={isPending(`remove:${rel.user.id}`)}
              >
                Cancel
              </WideControl>,
              { subtitle: 'Request sent, waiting to hear back' },
            ),
          )}
        </FriendsSection>
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
  const quiet = (label: string, onClick: () => void) => (
    <WideControl onClick={onClick} className="ix-fr__empty-action">
      {label}
    </WideControl>
  );

  if (searching) {
    return (
      <EmptyPage
        inline
        glyph="search"
        title="No matches"
        line="No one in this list matches your search. Check the spelling, or clear the search to see everyone again."
        action={quiet('Clear search', onClearSearch)}
      />
    );
  }

  switch (tab) {
    case 'online':
      return (
        <EmptyPage
          inline
          glyph="people"
          title="None of your friends are online"
          line="They'll show up here the moment one of them is. In the meantime, add a few more people."
          action={quiet('Add a friend', onAdd)}
        />
      );
    case 'all':
      return (
        <EmptyPage
          inline
          glyph="people"
          title="Your friends list is empty"
          line="Add people by their username to start messages, share servers and see when they're around."
          action={quiet('Add your first friend', onAdd)}
        />
      );
    case 'blocked':
      return (
        <EmptyPage
          inline
          glyph="x"
          title="You haven't blocked anyone"
          line="People you block can't message you or add you as a friend. Anyone you block shows up here so you can undo it later."
        />
      );
    case 'requests':
    default:
      return (
        <EmptyPage
          inline
          glyph="invite"
          title="No requests waiting"
          line="Nobody has asked to be friends, and you have no requests out. Send one: you only need their username."
          action={quiet('Add a friend', onAdd)}
        />
      );
  }
}
