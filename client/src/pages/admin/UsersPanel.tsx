import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Shield, ShieldOff, Trash2, Search, ArrowUp, ArrowDown, SearchX } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { isAdmin, UserFlags } from '../../types';
import { confirm } from '../../stores/confirmStore';
import { getIdentityColor } from '../../lib/colors';
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  SettingsSectionHeader,
  TextField,
} from '../../components/ui';

type UserRow = {
  id: string;
  username: string;
  discriminator: number;
  email: string;
  display_name: string | null;
  flags: number;
  created_at: string;
};

type SortKey = 'name' | 'joined';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function UsersPanel() {
  const currentUser = useCurrentUser();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<number | null>>([]);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const limit = 25;

  const fetchUsers = useCallback(() => {
    adminApi
      .getUsers({ cursor: cursor ?? undefined, limit })
      .then(({ data }) => {
        setUsers(data.users);
        setTotal(data.total);
        setNextCursor(data.next_cursor);
      })
      .catch((err) => {
        toast.error(`Failed to load users: ${extractApiError(err)}`);
      });
  }, [cursor]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const toggleAdmin = async (userId: string, currentFlags: number) => {
    const newFlags = isAdmin(currentFlags)
      ? currentFlags & ~UserFlags.ADMIN
      : currentFlags | UserFlags.ADMIN;
    try {
      await adminApi.updateUser(userId, { flags: newFlags });
      fetchUsers();
    } catch (err) {
      toast.error(`Failed to update user role: ${extractApiError(err)}`);
    }
  };

  const deleteUser = async (userId: string, username: string) => {
    if (!(await confirm({
      title: 'Delete user?',
      description: `Delete "${username}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;
    try {
      await adminApi.deleteUser(userId);
      fetchUsers();
    } catch (err) {
      toast.error(`Failed to delete user: ${extractApiError(err)}`);
    }
  };

  const visibleUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? users.filter(
          (u) =>
            u.username.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q) ||
            (u.display_name && u.display_name.toLowerCase().includes(q)),
        )
      : users;
    const sorted = [...filtered].sort((a, b) => {
      const cmp =
        sortKey === 'name'
          ? (a.display_name || a.username).localeCompare(b.display_name || b.username)
          : a.created_at.localeCompare(b.created_at);
      return sortAsc ? cmp : -cmp;
    });
    return sorted;
  }, [users, search, sortKey, sortAsc]);

  const pageIndex = cursorStack.length;
  const pageStart = users.length > 0 ? pageIndex * limit + 1 : 0;
  const pageEnd = pageIndex * limit + users.length;

  const goPreviousPage = () => {
    setCursorStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const previousCursor = next.pop() ?? null;
      setCursor(previousCursor);
      return next;
    });
  };

  const goNextPage = () => {
    if (nextCursor === null) return;
    setCursorStack((prev) => [...prev, cursor]);
    setCursor(nextCursor);
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const SortHeader = ({ label, keyName }: { label: string; keyName: SortKey }) => (
    <th scope="col" className="px-3 pb-2 pt-0">
      <button
        type="button"
        onClick={() => toggleSort(keyName)}
        className="pc-focusable inline-flex h-[var(--h-control-sm)] items-center gap-1 rounded-[var(--radius-chip)] text-section text-text-faint transition-colors hover:text-text-primary"
      >
        {label}
        {sortKey === keyName && (sortAsc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );

  return (
    <div>
      <SettingsSectionHeader
        title="Users"
        description={
          <>
            <span className="pc-mono tabular-nums text-text-primary">
              {total.toLocaleString()}
            </span>{' '}
            {total === 1 ? ' account' : ' accounts'} on this server, bots included.
            {/* Says "bots included" because it is: this total is every row the
                list renders, while the Overview panel's "Registered users"
                counts people (paracord_db::users::count_human_users excludes
                the seeded Welcome Bot and Auto-Moderator). Two admin screens
                answering "how many accounts" with different numbers and the
                same word is the part that reads like a bug. */}
          </>
        }
        action={
          <TextField
            label="Search users"
            hideLabel
            type="text"
            placeholder="Search name or email"
            icon={<Search size={16} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-[min(18rem,100%)]"
          />
        }
      />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left">
          <thead>
            <tr>
              <SortHeader label="User" keyName="name" />
              <th scope="col" className="px-3 pb-2 text-section text-text-faint">Email</th>
              <th scope="col" className="px-3 pb-2 text-section text-text-faint">Role</th>
              <SortHeader label="Joined" keyName="joined" />
              <th scope="col" className="px-3 pb-2 text-right text-section text-text-faint">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((u) => {
              const self = u.id === currentUser?.id;
              const admin = isAdmin(u.flags);
              return (
                <tr
                  key={u.id}
                  className="border-t border-border-subtle transition-colors hover:bg-bg-mod-subtle"
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-meta font-semibold text-text-on-light"
                        style={{ backgroundColor: getIdentityColor(u.id) }}
                        aria-hidden
                      >
                        {initials(u.display_name || u.username)}
                      </span>
                      <span className="min-w-0">
                        <span className="pc-display block truncate text-name text-text-primary">
                          {u.display_name || u.username}
                        </span>
                        <span className="pc-mono block truncate text-meta text-text-muted">
                          {u.username}#{String(u.discriminator).padStart(4, '0')}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-label text-text-secondary">{u.email}</td>
                  <td className="px-3 py-2.5">
                    {admin ? (
                      <Chip size="sm" tone="accent">
                        <Shield size={12} aria-hidden /> Admin
                      </Chip>
                    ) : (
                      <span className="text-label text-text-muted">Member</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="pc-mono text-meta tabular-nums text-text-secondary">
                      {new Date(u.created_at).toLocaleDateString()}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {self ? (
                        <Chip size="sm">You</Chip>
                      ) : (
                        <>
                          <IconButton
                            label={`${admin ? 'Remove admin from' : 'Make admin'} ${u.display_name || u.username}`}
                            onClick={() => toggleAdmin(u.id, u.flags)}
                          >
                            {admin ? <ShieldOff size={16} /> : <Shield size={16} />}
                          </IconButton>
                          <IconButton
                            label={`Delete user ${u.display_name || u.username}`}
                            onClick={() => deleteUser(u.id, u.username)}
                            className="hover:bg-danger-well hover:text-accent-danger"
                          >
                            <Trash2 size={16} />
                          </IconButton>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleUsers.length === 0 && (
              <tr>
                <td colSpan={5}>
                  {search.trim() ? (
                    <EmptyState
                      icon={<SearchX size={20} />}
                      title={`Nothing matched "${search.trim()}"`}
                      description="No account on this page matches that name or email. Try a different term or clear the search."
                      action={
                        <Button variant="ghost" size="sm" onClick={() => setSearch('')}>
                          Clear search
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={<Shield size={20} />}
                      title="No users on this page yet"
                      description="Accounts will appear here as people register on this server."
                    />
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(cursorStack.length > 0 || nextCursor !== null) && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={goPreviousPage} disabled={cursorStack.length === 0}>
            Previous
          </Button>
          <span className="pc-mono text-meta tabular-nums text-text-faint">
            {pageStart}–{Math.min(pageEnd, total)} of {total.toLocaleString()}
          </span>
          <Button variant="ghost" size="sm" onClick={goNextPage} disabled={nextCursor === null}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
