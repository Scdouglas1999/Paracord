import { useState, useEffect, useMemo } from 'react';
import { Shield, ShieldOff, Trash2, Search, ArrowUp, ArrowDown, SearchX } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { isAdmin, UserFlags } from '../../types';
import { confirm } from '../../stores/confirmStore';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/Feedback';

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
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<number | null>>([]);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const limit = 25;

  const fetchUsers = () => {
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
  };

  useEffect(() => {
    fetchUsers();
  }, [cursor]);

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

  const SortHeader = ({ label, keyName, className }: { label: string; keyName: SortKey; className?: string }) => (
    <th scope="col" className={className}>
      <button
        type="button"
        onClick={() => toggleSort(keyName)}
        className="inline-flex items-center gap-1 rounded-sm text-section uppercase text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
      >
        {label}
        {sortKey === keyName && (sortAsc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-heading text-text-primary">Users</h2>
          <p className="mt-1 text-body text-text-secondary">
            <span className="font-display tabular-nums text-text-primary">{total.toLocaleString()}</span>{' '}
            registered {total === 1 ? 'account' : 'accounts'} on this server.
          </p>
        </div>
        <div className="relative w-full max-w-xs">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            type="text"
            aria-label="Search users"
            placeholder="Search name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </header>

      <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-tertiary/40">
                <SortHeader label="User" keyName="name" className="px-5 py-3" />
                <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Email</th>
                <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Role</th>
                <SortHeader label="Joined" keyName="joined" className="px-5 py-3" />
                <th scope="col" className="px-5 py-3 text-right text-section uppercase text-text-secondary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => {
                const self = u.id === currentUser?.id;
                const admin = isAdmin(u.flags);
                return (
                  <tr
                    key={u.id}
                    className="group/row border-b border-border-subtle/60 transition-colors last:border-b-0 hover:bg-bg-mod-subtle"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-tint text-meta font-semibold text-accent-primary">
                          {initials(u.display_name || u.username)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-label font-semibold text-text-primary">
                            {u.display_name || u.username}
                          </span>
                          <span className="block truncate font-code text-meta text-text-muted">
                            {u.username}#{String(u.discriminator).padStart(4, '0')}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-body text-text-secondary">{u.email}</td>
                    <td className="px-5 py-3">
                      {admin ? (
                        <span className="inline-flex items-center gap-1 rounded-xs bg-accent-tint px-2 py-0.5 text-meta font-semibold text-accent-primary">
                          <Shield size={12} /> Admin
                        </span>
                      ) : (
                        <span className="text-body text-text-muted">Member</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-code text-meta tabular-nums text-text-secondary">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {self ? (
                          <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 text-meta font-medium text-text-secondary">You</span>
                        ) : (
                          <div className="flex items-center gap-1 opacity-0 transition-opacity duration-[140ms] focus-within:opacity-100 group-hover/row:opacity-100">
                            <button
                              onClick={() => toggleAdmin(u.id, u.flags)}
                              className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors hover:bg-bg-mod-strong hover:text-text-primary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]"
                              title={admin ? 'Remove admin' : 'Make admin'}
                              aria-label={`${admin ? 'Remove admin from' : 'Make admin'} ${u.display_name || u.username}`}
                            >
                              {admin ? <ShieldOff size={16} /> : <Shield size={16} />}
                            </button>
                            <button
                              onClick={() => deleteUser(u.id, u.username)}
                              className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors hover:bg-danger-tint hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]"
                              title="Delete user"
                              aria-label={`Delete user ${u.display_name || u.username}`}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {visibleUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5">
                    {search.trim() ? (
                      <EmptyState
                        icon={<SearchX size={20} />}
                        title={`Nothing matched "${search.trim()}"`}
                        description="No account on this page matches that name or email. Try a different term or clear the search."
                        action={<Button variant="secondary" size="sm" onClick={() => setSearch('')}>Clear search</Button>}
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
      </div>

      {(cursorStack.length > 0 || nextCursor !== null) && (
        <div className="mt-4 flex items-center justify-between">
          <Button variant="secondary" size="sm" onClick={goPreviousPage} disabled={cursorStack.length === 0}>
            Previous
          </Button>
          <span className="font-code text-meta tabular-nums text-text-muted">
            {pageStart}–{Math.min(pageEnd, total)} of {total.toLocaleString()}
          </span>
          <Button variant="secondary" size="sm" onClick={goNextPage} disabled={nextCursor === null}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
