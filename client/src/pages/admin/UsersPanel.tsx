import { useState, useEffect } from 'react';
import { Shield, ShieldOff, Trash2 } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { isAdmin, UserFlags } from '../../types';
import { confirm } from '../../stores/confirmStore';

export function UsersPanel() {
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<Array<{
    id: string;
    username: string;
    discriminator: number;
    email: string;
    display_name: string | null;
    flags: number;
    created_at: string;
  }>>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<number | null>>([]);
  const [search, setSearch] = useState('');
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

  const filteredUsers = search.trim()
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(search.toLowerCase()) ||
          u.email.toLowerCase().includes(search.toLowerCase()) ||
          (u.display_name && u.display_name.toLowerCase().includes(search.toLowerCase()))
      )
    : users;

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

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">
        Users <span className="text-sm font-normal text-text-muted">({total})</span>
      </h2>

      {/* Search / filter */}
      <div className="mb-6 max-w-md">
        <input
          type="text"
          placeholder="Search users by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input-field"
        />
      </div>

      <div className="card-surface overflow-hidden rounded-xl border border-border-subtle bg-bg-mod-subtle/40">
        <div className="overflow-x-auto">
        <table className="min-w-[760px] w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-bg-secondary/60">
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Username</th>
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Email</th>
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Role</th>
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Joined</th>
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((u) => (
              <tr key={u.id} className="border-b border-border-subtle/50 last:border-b-0 transition-colors hover:bg-bg-mod-subtle/30">
                <td className="px-6 py-5 text-text-primary">
                  <span className="font-medium">{u.display_name || u.username}</span>
                  <span className="ml-1 text-text-muted">#{u.discriminator}</span>
                </td>
                <td className="px-6 py-5 text-text-secondary">{u.email}</td>
                <td className="px-6 py-5">
                  {isAdmin(u.flags) ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent-primary/15 px-2.5 py-0.5 text-xs font-medium text-accent-primary">
                      <Shield size={12} /> Admin
                    </span>
                  ) : (
                    <span className="text-text-muted">Member</span>
                  )}
                </td>
                <td className="px-6 py-5 text-text-secondary">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="px-6 py-5">
                  <div className="flex items-center gap-4">
                    {u.id !== currentUser?.id && (
                      <>
                        <button
                          onClick={() => toggleAdmin(u.id, u.flags)}
                          className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                          title={isAdmin(u.flags) ? 'Remove admin' : 'Make admin'}
                          aria-label={`${isAdmin(u.flags) ? 'Remove admin from' : 'Make admin'} ${u.display_name || u.username}`}
                        >
                          {isAdmin(u.flags) ? <ShieldOff size={16} /> : <Shield size={16} />}
                        </button>
                        <button
                          onClick={() => deleteUser(u.id, u.username)}
                          className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
                          title="Delete user"
                          aria-label={`Delete user ${u.display_name || u.username}`}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                    {u.id === currentUser?.id && (
                      <span className="text-xs text-text-muted italic">You</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filteredUsers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-10 text-center text-text-muted">
                  {search.trim() ? 'No users match your search' : 'No users found'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {(cursorStack.length > 0 || nextCursor !== null) && (
        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={goPreviousPage}
            disabled={cursorStack.length === 0}
            className="control-pill-btn h-10 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-text-muted">
            {pageStart} - {Math.min(pageEnd, total)} of {total}
          </span>
          <button
            onClick={goNextPage}
            disabled={nextCursor === null}
            className="control-pill-btn h-10 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
