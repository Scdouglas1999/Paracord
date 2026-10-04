import { useEffect, useMemo, useRef, useState } from 'react';
import { extractApiError } from '../../api/client';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { fetchGuildRoles } from '../../lib/permissionDataCache';
import { roleColorToHex } from '../../lib/colors';
import { displayName } from '../../lib/displayName';
import { entityScopeKey } from '../../lib/serverScope';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import type { Role } from '../../types';
import { presenceLabel } from '../../lib/presence';
import { Avatar } from '../ix/identity';
import { Popover } from '../ui/Popover';

function here(status: string | undefined): boolean {
  return status === 'online' || status === 'idle' || status === 'dnd';
}

export function RoleMentionChip({ guildId, roleId }: { guildId?: string; roleId: string }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const scope = useCurrentAccountScope();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const members = useMemberStore((state) =>
    guildId && scope ? state.members.get(entityScopeKey(scope, guildId)) : undefined,
  );
  const membersLoading = useMemberStore((state) =>
    guildId && scope ? Boolean(state.loading[entityScopeKey(scope, guildId)]) : false,
  );

  useEffect(() => {
    if (!guildId) {
      setError('This role is not in this conversation.');
      return;
    }
    let canceled = false;
    setError(null);
    fetchGuildRoles(guildId)
      .then((roles) => {
        if (canceled) return;
        const found = roles.find((item) => item.id === roleId) ?? null;
        setRole(found);
        if (!found) setError('This role is no longer available.');
      })
      .catch((err) => {
        if (!canceled) setError(extractApiError(err));
      });
    return () => {
      canceled = true;
    };
  }, [guildId, roleId]);

  useEffect(() => {
    if (!open || !guildId || !scope || members) return;
    void useMemberStore.getState().fetchMembers(guildId, scope);
  }, [open, guildId, scope, members]);

  const tint = role && role.color !== 0 ? roleColorToHex(role.color) : null;
  const label = error && !role ? error : `@${role?.name ?? '…'}`;
  // While the card is open, subscribing to the presence map re-renders the list
  // when someone arrives or leaves. A closed chip does not re-render on presence.
  const presences = usePresenceStore((state) => (open ? state.presences : null));
  const holders = useMemo(
    () => (members ?? []).filter((member) => roleId === guildId || member.roles.includes(roleId)),
    [members, roleId, guildId],
  );
  const present = useMemo(() => {
    if (!presences) return [];
    const getPresence = usePresenceStore.getState().getPresence;
    return holders
      .map((member) => ({ member, status: getPresence(member.user.id, scope?.serverId)?.status }))
      .filter(({ status }) => here(status));
  }, [holders, presences, scope?.serverId]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        // A mention that is not of you: ink at 600 (docs/index-spec.md §4.11).
        // The role's own color is the dot in front of its name in the card.
        className="ix-role-mention"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      <Popover anchor={anchorRef} open={open} onClose={() => setOpen(false)} label={role?.name ?? 'Role'} className="ix-role-card">
        <div className="ix-role-card__head">
          <span
            className="ix-role-card__dot"
            style={tint ? { backgroundColor: tint } : undefined}
            aria-hidden
          />
          <span className="ix-role-card__name">{role?.name ?? 'Role'}</span>
          {members && (
            <span className="ix-role-card__count">
              {holders.length} {holders.length === 1 ? 'member' : 'members'}
            </span>
          )}
        </div>
        {error && <p role="alert" className="ix-role-card__error">{error}</p>}
        {!error && !members && membersLoading && (
          <p className="ix-role-card__line">Loading members…</p>
        )}
        {!error && !members && !membersLoading && (
          <p role="alert" className="ix-role-card__error">The member list did not load.</p>
        )}
        {!error && members && (
          <p className="ix-role-card__line">
            {present.length === 0 ? 'Nobody with this role is here right now.' : `Here now · ${present.length}`}
          </p>
        )}
        <ul className="ix-role-card__list">
          {present.map(({ member, status }) => {
            const name = displayName(member.user, member.nick);
            return (
              <li key={member.user.id} className="ix-role-card__row">
                {/* Presence is ink, not color (docs/index-spec.md §2.3): a dot,
                    a dimmer dot (away), a ring (do not disturb). The word is for
                    assistive tech. */}
                <Avatar userId={member.user.id} name={name} avatar={member.user.avatar_hash ?? null} size={24} presence={status} />
                <span className="ix-role-card__person">{name}</span>
                <span className="sr-only">{presenceLabel(status)}</span>
              </li>
            );
          })}
        </ul>
      </Popover>
    </>
  );
}
