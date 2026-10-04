import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useRoomLights } from '../../../hooks/useLights';
import { statusLine } from '../../../lib/activityDisplay';
import { displayName } from '../../../lib/displayName';
import { fetchGuildRoles } from '../../../lib/permissionDataCache';
import { presenceLabel } from '../../../lib/presence';
import { entityScopeKey } from '../../../lib/serverScope';
import { useMemberStore } from '../../../stores/memberStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import type { Member, Presence, Role, User } from '../../../types';
import { openProfileCard } from '../../ix/menus/hostStore';
import { GroupDmMembersPanel } from '../../layout/GroupDmMembersPanel';
import { GlassButton } from '../primitives';
import { groupPeople, pageSections, type PeopleEntry } from './peopleGroups';
import { PersonRow, type PersonStatus } from './PersonRow';
import { SheetFrame } from './SheetFrame';
import { SheetEmpty, SheetKicker, SheetStatus } from './SheetParts';

/**
 * The people sheet (docs/index-spec.md §6.1, §8.6: the toolbar's members button;
 * WP IX-9, formerly WP-G18). What "people" means depends on where you are:
 *
 *   a server channel   the server's members: here now first (with their presence,
 *                      what they are doing, and "In Lounge" for a voice room),
 *                      then everyone else under the highest hoisted role each
 *                      holds, then Offline
 *   a group message    who it is addressed to, and where you add and remove them
 *   a direct message   you and them
 *
 * It is a list, not a docked roster: you ask for it, it opens on main's right,
 * and Escape puts it away. A row opens that person's profile card.
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

/** A server's members: here now first, then by role, then Offline. */
function ServerPeople({ open, onClose, guildId }: { open: boolean; onClose: () => void; guildId: string }) {
  const scope = useCurrentAccountScope();
  const memberKey = scope ? entityScopeKey(scope, guildId) : null;
  const members = useMemberStore((s) => (memberKey ? s.members.get(memberKey) : undefined));
  const loaded = useMemberStore((s) => (memberKey ? Boolean(s.membersLoaded[memberKey]) : false));
  const presences = usePresenceStore((s) => s.presences);
  const rooms = useRoomLights(guildId);
  const [limit, setLimit] = useState(PAGE);
  const [roles, setRoles] = useState<Role[] | null>(null);

  useEffect(() => {
    if (!open || !scope) return;
    void useMemberStore.getState().fetchMembers(guildId, scope);
  }, [open, guildId, scope]);

  // The roles name the sections after "Here now". Without them (not loaded, or
  // the request failed) everyone who is away is simply under Offline.
  useEffect(() => {
    if (!open || !scope) return undefined;
    let canceled = false;
    fetchGuildRoles(guildId, scope)
      .then((data) => {
        if (!canceled) setRoles(data);
      })
      .catch(() => {
        if (!canceled) setRoles(null);
      });
    return () => {
      canceled = true;
    };
  }, [open, guildId, scope]);

  // Who is in which voice room (a live room, so an amber line).
  const roomOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const room of rooms) {
      for (const occupant of room.occupants) map.set(occupant.person.userId, room.name);
    }
    return map;
  }, [rooms]);

  const sections = useMemo(() => {
    const entries: PeopleEntry[] = (members ?? []).map((member: Member) => {
      const presence = usePresenceStore.getState().getPresence(member.user.id, scope?.serverId);
      const status = statusOf(presence);
      const room = roomOf.get(member.user.id) ?? null;
      const line = statusLine(presence);
      const detail = line
        ? line.type === 'custom' ? line.text : line.activity.line
        : presenceLabel(status);
      return {
        user: member.user,
        name: displayName(member.user, member.nick),
        status,
        detail,
        room,
        roleIds: member.roles ?? [],
      };
    });
    return groupPeople(entries, roles);
    // `presences` is the invalidation: the lookup goes through the store's index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, scope?.serverId, roomOf, presences, roles]);

  const total = sections.reduce((count, section) => count + section.entries.length, 0);
  const hereCount = sections.find((section) => section.id === 'here')?.entries.length ?? 0;
  // A page at a time, across the sections in order.
  const { shown, hidden } = pageSections(sections, limit);

  const openProfile = (user: User) => (event: React.MouseEvent<HTMLButtonElement>) => {
    // Beside the sheet, over the conversation: the card opens to the row's left.
    const rect = event.currentTarget.getBoundingClientRect();
    openProfileCard(user, { x: rect.left, y: rect.top });
  };

  const renderRow = (entry: PeopleEntry) => (
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
      subtitle={loaded ? `${hereCount} here now, ${total} in all` : undefined}
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
          {shown.map((section) => (
            <section key={section.id} aria-label={section.label}>
              <SheetKicker>
                {section.label} <span className="glass-instrument">{section.total}</span>
              </SheetKicker>
              <ul className="glass-sheet-list glass-people-grid">{section.entries.map(renderRow)}</ul>
            </section>
          ))}
          {hidden > 0 && (
            <div className="glass-sheet-more">
              <GlassButton variant="glass" onClick={() => setLimit((current) => current + PAGE)}>
                Show {Math.min(hidden, PAGE)} more
              </GlassButton>
            </div>
          )}
        </>
      )}
    </SheetFrame>
  );
}
