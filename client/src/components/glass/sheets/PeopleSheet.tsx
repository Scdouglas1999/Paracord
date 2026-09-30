import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useRoomLights } from '../../../hooks/useLights';
import { statusLine } from '../../../lib/activityDisplay';
import { displayName } from '../../../lib/displayName';
import { presenceLabel } from '../../../lib/presence';
import { entityScopeKey } from '../../../lib/serverScope';
import { useMemberStore } from '../../../stores/memberStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import type { Member, Presence, User } from '../../../types';
import { GroupDmMembersPanel } from '../../layout/GroupDmMembersPanel';
import { UserProfilePopup } from '../../user/UserProfile';
import { GlassButton } from '../primitives';
import { PersonRow, type PersonStatus } from './PersonRow';
import { SheetFrame } from './SheetFrame';
import { SheetEmpty, SheetKicker, SheetStatus } from './SheetParts';

/**
 * The people sheet (docs/glass-spec.md §3.2: "search, people and your avatar sit
 * at the pane's right edge"; WP-G18). What "people" means depends on where you
 * are:
 *
 *   a server channel   the server's members, here now first, each with their
 *                      presence, what they are doing (an activity or the words
 *                      they set) and the voice channel they are in
 *   a group message    who it is addressed to, and where you add and remove them
 *   a direct message   you and them
 *
 * It is a list, not a docked roster (the spec removes the member list from the
 * chrome): you ask for it, it slides over the conversation, and Escape puts it
 * away.
 */

const PAGE = 120;

function statusOf(presence: Presence | undefined): PersonStatus {
  const status = presence?.status;
  return status === 'online' || status === 'idle' || status === 'dnd' ? status : 'offline';
}

/** What a direct conversation knows of a person: less than a member. */
interface PersonLite {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_hash?: string | null;
  avatar?: string;
}

interface Entry {
  user: User;
  name: string;
  status: PersonStatus;
  detail: string;
  room: string | null;
}

export interface PeopleSheetProps {
  open: boolean;
  onClose: () => void;
  guildId: string | null;
  channelId: string | null;
}

export function PeopleSheet({ open, onClose, guildId, channelId }: PeopleSheetProps) {
  const channel = useCurrentChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));
  const type = channel?.type ?? channel?.channel_type;
  const isGroupDm = type === 3;
  const isDm = type === 1 || isGroupDm || !guildId;

  if (isGroupDm && channelId) {
    return (
      <SheetFrame
        open={open}
        onClose={onClose}
        kind="people"
        label="People in this message"
        title="People in this message"
        subtitle={channel?.name || undefined}
        closeLabel="Close people"
      >
        <GroupDmMembersPanel channelId={channelId} onClose={onClose} />
      </SheetFrame>
    );
  }
  if (isDm) return <DirectPeople open={open} onClose={onClose} channelId={channelId} />;
  return <ServerPeople open={open} onClose={onClose} guildId={guildId as string} />;
}

/** You and them. */
function DirectPeople({ open, onClose, channelId }: { open: boolean; onClose: () => void; channelId: string | null }) {
  const scope = useCurrentAccountScope();
  const me = useCurrentUser();
  const channel = useCurrentChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));
  const presences = usePresenceStore((s) => s.presences);
  const people = useMemo(() => {
    const list: PersonLite[] = [];
    if (channel?.recipient) list.push(channel.recipient);
    for (const recipient of channel?.recipients ?? []) {
      if (!list.some((user) => user.id === recipient.id)) list.push(recipient);
    }
    if (me && !list.some((user) => user.id === me.id)) list.push(me);
    return list;
  }, [channel, me]);

  const rows = useMemo(
    () =>
      people.map((user) => {
        const presence = usePresenceStore.getState().getPresence(user.id, scope?.serverId);
        return { user, presence, status: statusOf(presence) };
      }),
    // `presences` is the invalidation: the lookup goes through the store's index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, scope?.serverId, presences],
  );

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      kind="people"
      label="People in this message"
      title="People"
      subtitle="In this conversation"
      closeLabel="Close people"
    >
      <ul className="glass-sheet-list">
        {rows.map(({ user, presence, status }) => {
          const line = statusLine(presence);
          const detail = line
            ? line.type === 'custom' ? line.text : line.activity.line
            : presenceLabel(status);
          return (
            <PersonRow
              key={user.id}
              userId={user.id}
              name={displayName(user)}
              you={user.id === me?.id}
              avatar={user.avatar_hash ?? user.avatar ?? null}
              status={status}
              detail={detail}
            />
          );
        })}
      </ul>
    </SheetFrame>
  );
}

/** A server's members: here now first, then everyone else. */
function ServerPeople({ open, onClose, guildId }: { open: boolean; onClose: () => void; guildId: string }) {
  const scope = useCurrentAccountScope();
  const memberKey = scope ? entityScopeKey(scope, guildId) : null;
  const members = useMemberStore((s) => (memberKey ? s.members.get(memberKey) : undefined));
  const loaded = useMemberStore((s) => (memberKey ? Boolean(s.membersLoaded[memberKey]) : false));
  const presences = usePresenceStore((s) => s.presences);
  const rooms = useRoomLights(guildId);
  const [limit, setLimit] = useState(PAGE);
  const [profile, setProfile] = useState<{ user: User; position: { x: number; y: number } } | null>(null);

  useEffect(() => {
    if (!open || !scope) return;
    void useMemberStore.getState().fetchMembers(guildId, scope);
  }, [open, guildId, scope]);

  // Who is in which voice room (a live room, so an amber line).
  const roomOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const room of rooms) {
      for (const occupant of room.occupants) map.set(occupant.person.userId, room.name);
    }
    return map;
  }, [rooms]);

  const { here, away } = useMemo(() => {
    const entries: Entry[] = (members ?? []).map((member: Member) => {
      const presence = usePresenceStore.getState().getPresence(member.user.id, scope?.serverId);
      const status = statusOf(presence);
      const room = roomOf.get(member.user.id) ?? null;
      const line = statusLine(presence);
      const detail = line
        ? line.type === 'custom' ? line.text : line.activity.line
        : presenceLabel(status);
      return { user: member.user, name: displayName(member.user, member.nick), status, detail, room };
    });
    const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return {
      here: entries.filter((entry) => entry.status !== 'offline' || entry.room).sort(byName),
      away: entries.filter((entry) => entry.status === 'offline' && !entry.room).sort(byName),
    };
    // `presences` is the invalidation: the lookup goes through the store's index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, scope?.serverId, roomOf, presences]);

  const total = here.length + away.length;
  const shownHere = here.slice(0, limit);
  const shownAway = away.slice(0, Math.max(0, limit - here.length));
  const hidden = total - shownHere.length - shownAway.length;

  const openProfile = (user: User) => (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setProfile({ user, position: { x: rect.right, y: rect.top } });
  };

  const renderRow = (entry: Entry) => (
    <PersonRow
      key={entry.user.id}
      userId={entry.user.id}
      name={entry.name}
      avatar={entry.user.avatar_hash ?? entry.user.avatar ?? null}
      status={entry.status}
      detail={entry.room ? `In ${entry.room}` : entry.detail}
      live={Boolean(entry.room)}
      onOpen={openProfile(entry.user)}
    />
  );

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      kind="people"
      label="Members"
      title="Members"
      subtitle={loaded ? `${here.length} here now, ${total} in all` : undefined}
      closeLabel="Close members"
    >
      {!loaded && total === 0 ? (
        <SheetStatus>Loading members…</SheetStatus>
      ) : total === 0 ? (
        <SheetEmpty icon={<Users size={20} />} title="No one to show">
          Members of this server will appear here.
        </SheetEmpty>
      ) : (
        <>
          {shownHere.length > 0 && (
            <section aria-label="Here now">
              <SheetKicker>
                Here now <span className="glass-instrument">{here.length}</span>
              </SheetKicker>
              <ul className="glass-sheet-list glass-people-grid">{shownHere.map(renderRow)}</ul>
            </section>
          )}
          {shownAway.length > 0 && (
            <section aria-label="Offline">
              <SheetKicker>
                Offline <span className="glass-instrument">{away.length}</span>
              </SheetKicker>
              <ul className="glass-sheet-list glass-people-grid">{shownAway.map(renderRow)}</ul>
            </section>
          )}
          {hidden > 0 && (
            <div className="glass-sheet-more">
              <GlassButton variant="glass" onClick={() => setLimit((current) => current + PAGE)}>
                Show {Math.min(hidden, PAGE)} more
              </GlassButton>
            </div>
          )}
        </>
      )}
      <UserProfilePopup
        user={profile?.user ?? null}
        position={profile?.position ?? null}
        onClose={() => setProfile(null)}
      />
    </SheetFrame>
  );
}
