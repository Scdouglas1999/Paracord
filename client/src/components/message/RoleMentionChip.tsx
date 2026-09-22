import { useEffect, useMemo, useRef, useState } from 'react';
import { extractApiError } from '../../api/client';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { fetchGuildRoles } from '../../lib/permissionDataCache';
import { roleColorToHex } from '../../lib/colors';
import { personLight } from '../../lib/attention/personLight';
import { displayName } from '../../lib/displayName';
import { entityScopeKey } from '../../lib/serverScope';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import type { Role } from '../../types';
import { LitAvatar } from '../light';
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
    let cancelled = false;
    setError(null);
    fetchGuildRoles(guildId)
      .then((roles) => {
        if (cancelled) return;
        const found = roles.find((item) => item.id === roleId) ?? null;
        setRole(found);
        if (!found) setError('This role is no longer available.');
      })
      .catch((err) => {
        if (!cancelled) setError(extractApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, roleId]);

  useEffect(() => {
    if (!open || !guildId || !scope || members) return;
    void useMemberStore.getState().fetchMembers(guildId, scope);
  }, [open, guildId, scope, members]);

  const tint = role && role.color !== 0 ? roleColorToHex(role.color) : null;
  const label = error && !role ? error : `@${role?.name ?? '…'}`;
  // Subscribing to the presence map re-renders the list when someone arrives or leaves.
  const presences = usePresenceStore((state) => state.presences);
  const holders = useMemo(
    () => (members ?? []).filter((member) => roleId === guildId || member.roles.includes(roleId)),
    [members, roleId, guildId],
  );
  const present = useMemo(() => {
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
        className="pc-focusable inline rounded-[var(--radius-window)] px-0.5 font-medium transition-[background-color] duration-[var(--duration-fast)] ease-[var(--ease-out)]"
        // A role's own colour can be anything, so the ink is the colour mixed
        // into the theme's text colour: dark roles lighten on a dark theme and
        // light roles darken on a light one, and the text always reads.
        style={
          tint
            ? {
                color: `color-mix(in srgb, ${tint} 55%, var(--text-primary))`,
                backgroundColor: `color-mix(in srgb, ${tint} 16%, transparent)`,
              }
            : {
                color: 'var(--accent-primary)',
                backgroundColor: 'var(--accent-tint-strong)',
              }
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      <Popover anchor={anchorRef} open={open} onClose={() => setOpen(false)} label={role?.name ?? 'Role'} className="w-60 p-2">
        <div className="flex items-center gap-2 px-1 pb-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: tint ?? 'var(--text-muted)' }}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-label font-semibold text-text-primary">{role?.name ?? 'Role'}</span>
          {members && (
            <span className="shrink-0 text-meta text-text-muted">
              {holders.length} {holders.length === 1 ? 'member' : 'members'}
            </span>
          )}
        </div>
        {error && <p role="alert" className="px-1 text-meta text-accent-danger">{error}</p>}
        {!error && !members && membersLoading && (
          <p className="px-1 text-meta text-text-muted">Loading members…</p>
        )}
        {!error && !members && !membersLoading && (
          <p role="alert" className="px-1 text-meta text-accent-danger">The member list did not load.</p>
        )}
        {!error && members && (
          <p className="px-1 pb-1 text-section text-text-faint">
            {present.length === 0 ? 'Nobody with this role is here right now.' : `Here now · ${present.length}`}
          </p>
        )}
        <ul className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
          {present.map(({ member, status }) => {
            const name = displayName(member.user, member.nick);
            return (
              <li key={member.user.id} className="flex items-center gap-2 px-1 py-0.5">
                <LitAvatar
                  size={22}
                  person={personLight({
                    userId: member.user.id,
                    name,
                    status,
                    avatar: member.user.avatar_hash,
                  })}
                />
                <span className="min-w-0 truncate text-label text-text-primary">{name}</span>
              </li>
            );
          })}
        </ul>
      </Popover>
    </>
  );
}
