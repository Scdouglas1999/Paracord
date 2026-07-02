import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Server, Settings, BarChart3, Shield, ShieldOff, Trash2, Pencil, HardDrive, Download, Plus, Loader2, RotateCcw, Globe2 } from 'lucide-react';
import { adminApi, type FederatedServer, type SecurityEvent } from '../api/admin';
import { extractApiError } from '../api/client';
import { toast } from '../stores/toastStore';
import { Button } from '../components/ui/Button';
import { useAuthStore } from '../stores/authStore';
import { isAdmin, UserFlags } from '../types';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { confirm } from '../stores/confirmStore';

type Tab = 'overview' | 'users' | 'guilds' | 'settings' | 'federation' | 'security' | 'backups';

export function AdminPage() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  if (!currentUser) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="settings-surface-card w-full max-w-md text-center">
          <p className="text-sm leading-6 text-text-muted">Checking admin access...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin(currentUser.flags ?? 0)) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="settings-surface-card w-full max-w-md text-center">
          <h1 className="mb-4 text-xl font-semibold text-text-primary">Access denied</h1>
          <p className="mb-8 text-sm leading-6 text-text-muted">
            You need administrator access to open the control plane.
          </p>
          <button className="btn-primary" onClick={() => navigate('/app')}>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Sidebar nav */}
      <aside className="panel-surface flex w-64 min-w-[16rem] flex-col overflow-hidden">
        <div className="panel-divider flex items-center gap-3 border-b px-4 py-4">
          <button
            onClick={() => navigate(-1)}
            className="command-icon-btn"
            aria-label="Go back"
            title="Go back"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Control Plane</div>
            <h1 className="text-lg font-semibold text-text-primary">Admin</h1>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4">
          {([
            { id: 'overview' as Tab, label: 'Overview', icon: BarChart3 },
            { id: 'users' as Tab, label: 'Users', icon: Users },
            { id: 'guilds' as Tab, label: 'Guilds', icon: Server },
            { id: 'settings' as Tab, label: 'Settings', icon: Settings },
            { id: 'federation' as Tab, label: 'Federation', icon: Globe2 },
            { id: 'security' as Tab, label: 'Security', icon: Shield },
            { id: 'backups' as Tab, label: 'Backups', icon: HardDrive },
          ]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`settings-nav-item ${
                activeTab === id
                  ? 'active'
                  : ''
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Content */}
      <main className="panel-surface min-w-0 flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto p-6 md:p-8">
          {activeTab === 'overview' && <OverviewPanel />}
          {activeTab === 'users' && <UsersPanel />}
          {activeTab === 'guilds' && <GuildsPanel />}
          {activeTab === 'settings' && <SettingsPanel />}
          {activeTab === 'federation' && <FederationPanel />}
          {activeTab === 'security' && <SecurityPanel />}
          {activeTab === 'backups' && <BackupsPanel />}
        </div>
      </main>
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────

function OverviewPanel() {
  const [stats, setStats] = useState<{
    total_users: number;
    total_guilds: number;
    total_messages: number;
    total_channels: number;
  } | null>(null);

  useEffect(() => {
    adminApi
      .getStats()
      .then(({ data }) => setStats(data))
      .catch((err) => {
        toast.error(`Failed to load admin stats: ${extractApiError(err)}`);
      });
  }, []);

  if (!stats) {
    return <p className="text-text-muted">Loading stats...</p>;
  }

  const cards = [
    { label: 'Users', value: stats.total_users, icon: Users },
    { label: 'Guilds', value: stats.total_guilds, icon: Server },
    { label: 'Messages', value: stats.total_messages, icon: BarChart3 },
    { label: 'Channels', value: stats.total_channels, icon: Settings },
  ];

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">Server Overview</h2>
      <div className="mb-10 grid grid-cols-2 gap-7 lg:grid-cols-4">
        {cards.map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="card-surface rounded-xl border border-border-subtle bg-bg-secondary/60 px-6 py-6"
          >
            <div className="mb-2 flex items-center gap-2 text-text-secondary">
              <Icon size={16} />
              <span className="text-sm">{label}</span>
            </div>
            <p className="text-2xl font-bold text-text-primary">{value.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Users ─────────────────────────────────────────────────────────────

function UsersPanel() {
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

// ── Guilds ─────────────────────────────────────────────────────────────

type GuildRow = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
};

function GuildsPanel() {
  const editDialogRef = useRef<HTMLDivElement>(null);
  const [guilds, setGuilds] = useState<GuildRow[]>([]);
  const [editingGuild, setEditingGuild] = useState<GuildRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchGuilds = () => {
    adminApi
      .getGuilds()
      .then(({ data }) => setGuilds(data.guilds))
      .catch((err) => {
        toast.error(`Failed to load guilds: ${extractApiError(err)}`);
      });
  };

  useEffect(() => {
    fetchGuilds();
  }, []);

  const openEdit = (g: GuildRow) => {
    setEditingGuild(g);
    setEditName(g.name);
    setEditDescription(g.description ?? '');
  };

  const closeEdit = useCallback(() => {
    setEditingGuild(null);
    setSaving(false);
  }, []);

  useFocusTrap(editDialogRef, Boolean(editingGuild), closeEdit);

  const saveGuild = async () => {
    if (!editingGuild) return;
    setSaving(true);
    try {
      await adminApi.updateGuild(editingGuild.id, {
        name: editName.trim() || undefined,
        description: editDescription.trim() || undefined,
      });
      setGuilds((prev) =>
        prev.map((g) =>
          g.id === editingGuild.id
            ? { ...g, name: editName.trim() || g.name, description: editDescription.trim() || g.description }
            : g
        )
      );
      closeEdit();
    } catch (err) {
      toast.error(`Failed to save guild: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteGuild = async (guildId: string, name: string) => {
    if (!(await confirm({
      title: 'Delete guild?',
      description: `Delete "${name}"? This will delete all channels and messages. This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;
    try {
      await adminApi.deleteGuild(guildId);
      if (editingGuild?.id === guildId) closeEdit();
      fetchGuilds();
    } catch (err) {
      toast.error(`Failed to delete guild: ${extractApiError(err)}`);
    }
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">
        Guilds <span className="text-sm font-normal text-text-muted">({guilds.length})</span>
      </h2>

      <div className="card-surface overflow-hidden rounded-xl border border-border-subtle bg-bg-mod-subtle/40">
        <div className="overflow-x-auto">
        <table className="min-w-[720px] w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-bg-secondary/60">
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Name</th>
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Description</th>
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Created</th>
              <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Actions</th>
            </tr>
          </thead>
          <tbody>
            {guilds.map((g) => (
              <tr key={g.id} className="border-b border-border-subtle/50 last:border-b-0 transition-colors hover:bg-bg-mod-subtle/30">
                <td className="px-6 py-5 font-medium text-text-primary">{g.name}</td>
                <td className="max-w-xs truncate px-6 py-5 text-text-secondary">
                  {g.description || '-'}
                </td>
                <td className="px-6 py-5 text-text-secondary">
                  {new Date(g.created_at).toLocaleDateString()}
                </td>
                <td className="px-6 py-5">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => openEdit(g)}
                      className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                      title="Edit guild"
                      aria-label={`Edit guild ${g.name}`}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => deleteGuild(g.id, g.name)}
                      className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
                      title="Delete guild"
                      aria-label={`Delete guild ${g.name}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {guilds.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-10 text-center text-text-muted">
                  No guilds yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {editingGuild && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop"
          onClick={closeEdit}
        >
          <div
            ref={editDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-edit-guild-title"
            tabIndex={-1}
            className="glass-modal w-full max-w-md rounded-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="admin-edit-guild-title" className="mb-5 text-lg font-semibold text-text-primary">Edit Guild</h3>
            <div className="space-y-6">
              <div>
                <label className="mb-3 block text-sm font-medium text-text-secondary">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="input-field"
                />
              </div>
              <div>
                <label className="mb-3 block text-sm font-medium text-text-secondary">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  className="input-field resize-none"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={closeEdit}
                className="btn-ghost"
              >
                Cancel
              </button>
              <Button
                onClick={saveGuild}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────

function SecurityPanel() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [appliedAction, setAppliedAction] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const pageLimit = 25;

  useEffect(() => {
    let cancelled = false;
    const fetchEvents = async () => {
      setLoading(true);
      try {
        const { data } = await adminApi.listSecurityEvents({
          limit: pageLimit + 1,
          before: cursor ?? undefined,
          action: appliedAction || undefined,
        });
        if (cancelled) return;
        const pageEvents = data.slice(0, pageLimit);
        setEvents(pageEvents);
        setNextCursor(data.length > pageLimit && pageEvents.length > 0
          ? pageEvents[pageEvents.length - 1].id
          : null);
        setExpandedEventId(null);
      } catch (err) {
        if (!cancelled) {
          toast.error(`Failed to load security events: ${extractApiError(err)}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void fetchEvents();
    return () => {
      cancelled = true;
    };
  }, [appliedAction, cursor, reloadKey]);

  const applyFilter = () => {
    setCursorStack([]);
    setCursor(null);
    setAppliedAction(actionFilter.trim());
    setReloadKey((key) => key + 1);
  };

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

  const formatDetails = (event: SecurityEvent) => {
    const blocks: Array<[string, string]> = [];
    if (event.device_id) blocks.push(['Device', event.device_id]);
    if (event.user_agent) blocks.push(['User agent', event.user_agent]);
    if (event.details && Object.keys(event.details).length > 0) {
      blocks.push(['Details', JSON.stringify(event.details, null, 2)]);
    }
    return blocks;
  };

  const pageIndex = cursorStack.length + 1;

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Security Events</h2>
          <p className="text-sm text-text-muted">Recent authentication and admin activity.</p>
        </div>
        <button
          onClick={() => setReloadKey((key) => key + 1)}
          className="control-pill-btn h-10 px-4 text-sm"
        >
          Refresh
        </button>
      </div>

      <div className="mb-6 flex gap-3">
        <label htmlFor="admin-security-action-filter" className="sr-only">
          Filter security events by exact action
        </label>
        <input
          id="admin-security-action-filter"
          type="text"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Exact action (e.g. auth.login)"
          className="input-field max-w-md"
        />
        <button
          onClick={applyFilter}
          className="control-pill-btn h-10 px-4 text-sm"
        >
          Apply
        </button>
      </div>

      {loading ? (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-6 text-sm text-text-muted">
          Loading security events...
        </div>
      ) : events.length === 0 ? (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-10 text-center text-text-muted">
          No security events found.
        </div>
      ) : (
        <div className="card-surface overflow-hidden rounded-xl border border-border-subtle bg-bg-mod-subtle/40">
          <div className="overflow-x-auto">
          <table className="min-w-[960px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-secondary/60">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Time</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Action</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Actor</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Target</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">IP</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Session</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const details = formatDetails(event);
                const expanded = expandedEventId === event.id;
                return (
                  <Fragment key={event.id}>
                    <tr className="border-b border-border-subtle/50 align-top hover:bg-bg-mod-subtle/20">
                      <td className="px-4 py-3 text-text-secondary">{new Date(event.created_at).toLocaleString()}</td>
                      <td className="px-4 py-3 font-medium text-text-primary">{event.action}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.actor_user_id || '-'}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.target_user_id || '-'}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.ip_address || '-'}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.session_id || '-'}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setExpandedEventId(expanded ? null : event.id)}
                          disabled={details.length === 0}
                          className="control-pill-btn h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          aria-expanded={expanded}
                          aria-controls={`security-event-details-${event.id}`}
                        >
                          {expanded ? 'Hide' : 'View'}
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr id={`security-event-details-${event.id}`} className="border-b border-border-subtle/50 bg-bg-secondary/50">
                        <td colSpan={7} className="px-4 py-4">
                          <dl className="space-y-3">
                            {details.map(([label, value]) => (
                              <div key={label}>
                                <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</dt>
                                <dd>
                                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-primary/60 p-3 font-mono text-xs text-text-secondary">
                                    {value}
                                  </pre>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
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
            Page {pageIndex} · Showing {events.length} events
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

function SettingsPanel() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminApi
      .getSettings()
      .then(({ data }) => setSettings(data))
      .catch((err) => {
        toast.error(`Failed to load settings: ${extractApiError(err)}`);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data } = await adminApi.updateSettings(settings);
      setSettings(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast.error(`Failed to update settings: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const update = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">Server Settings</h2>

      <div className="card-stack-roomy max-w-xl">
        {/* Server Name */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Server Name
          </label>
          <input
            aria-label="Server Name"
            type="text"
            value={settings.server_name || ''}
            onChange={(e) => update('server_name', e.target.value)}
            className="input-field"
          />
        </div>

        {/* Server Description */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Server Description
          </label>
          <textarea
            aria-label="Server Description"
            value={settings.server_description || ''}
            onChange={(e) => update('server_description', e.target.value)}
            rows={3}
            className="input-field resize-none"
          />
        </div>

        {/* Registration Toggle */}
        <div className="card-surface flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
          <div>
            <p className="font-medium text-text-primary">Open Registration</p>
            <p className="text-sm text-text-muted">Allow new users to register accounts</p>
          </div>
          <button
            onClick={() =>
              update('registration_enabled', settings.registration_enabled === 'true' ? 'false' : 'true')
            }
            type="button"
            role="switch"
            aria-checked={settings.registration_enabled === 'true'}
            aria-label="Toggle open registration"
            className={`relative h-7 w-12 rounded-full transition-colors ${
              settings.registration_enabled === 'true'
                ? 'bg-accent-success'
                : 'bg-bg-mod-strong'
            }`}
          >
            <div
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                settings.registration_enabled === 'true' ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Max guilds per user */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Max Guilds Per User
          </label>
          <input
            aria-label="Max Guilds Per User"
            type="number"
            value={settings.max_guilds_per_user || '100'}
            onChange={(e) => update('max_guilds_per_user', e.target.value)}
            className="input-field"
          />
        </div>

        {/* Max members per guild */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Max Members Per Guild
          </label>
          <input
            aria-label="Max Members Per Guild"
            type="number"
            value={settings.max_members_per_guild || '1000'}
            onChange={(e) => update('max_members_per_guild', e.target.value)}
            className="input-field"
          />
        </div>

        {/* ── Guild Storage ─────────────────────────────────── */}
        <div className="border-t border-border-subtle pt-6">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Guild Storage Limits
          </h3>
        </div>

        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Max Guild Storage Quota (MB)
          </label>
          <input
            aria-label="Max Guild Storage Quota in MB"
            type="number"
            value={settings.max_guild_storage_quota || ''}
            onChange={(e) => update('max_guild_storage_quota', e.target.value)}
            placeholder="No limit"
            className="input-field"
          />
          <p className="mt-1 text-xs text-text-muted">
            Upper limit for per-guild storage quotas (in MB). Guild owners cannot set a quota higher than this.
          </p>
        </div>

        {/* ── Federation File Cache ─────────────────────────── */}
        <div className="border-t border-border-subtle pt-6">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Federation File Cache
          </h3>
        </div>

        <div className="card-surface flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
          <div>
            <p className="font-medium text-text-primary">Federation File Cache</p>
            <p className="text-sm text-text-muted">Cache files fetched from federated servers locally</p>
          </div>
          <button
            onClick={() =>
              update('federation_file_cache_enabled', settings.federation_file_cache_enabled === 'true' ? 'false' : 'true')
            }
            type="button"
            role="switch"
            aria-checked={settings.federation_file_cache_enabled === 'true'}
            aria-label="Toggle federation file cache"
            className={`relative h-7 w-12 rounded-full transition-colors ${
              settings.federation_file_cache_enabled === 'true'
                ? 'bg-accent-success'
                : 'bg-bg-mod-strong'
            }`}
          >
            <div
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                settings.federation_file_cache_enabled === 'true' ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Federation Cache Max Size (MB)
          </label>
          <input
            aria-label="Federation Cache Max Size in MB"
            type="number"
            value={settings.federation_file_cache_max_size || ''}
            onChange={(e) => update('federation_file_cache_max_size', e.target.value)}
            placeholder="No limit"
            className="input-field"
          />
        </div>

        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Federation Cache TTL (hours)
          </label>
          <input
            aria-label="Federation Cache TTL in hours"
            type="number"
            value={settings.federation_file_cache_ttl_hours || ''}
            onChange={(e) => update('federation_file_cache_ttl_hours', e.target.value)}
            placeholder="Default"
            className="input-field"
          />
          <p className="mt-1 text-xs text-text-muted">
            How long cached federated files are kept before re-fetching from the origin server.
          </p>
        </div>

        {/* Save button */}
        <div className="settings-action-row">
          <Button
            onClick={handleSave}
            disabled={saving}
            style={
              saved
                ? {
                    backgroundColor: 'var(--accent-success)',
                    borderColor: 'color-mix(in srgb, var(--accent-success) 72%, white 28%)',
                    boxShadow:
                      '0 10px 24px color-mix(in srgb, var(--accent-success) 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--accent-success) 62%, white 38%) inset',
                  }
                : undefined
            }
          >
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Backups ────────────────────────────────────────────────────────────

function FederationPanel() {
  const [servers, setServers] = useState<FederatedServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [inspectingName, setInspectingName] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<FederatedServer | null>(null);

  const [serverName, setServerName] = useState('');
  const [domain, setDomain] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [publicKeyHex, setPublicKeyHex] = useState('');
  const [keyId, setKeyId] = useState('');
  const [trusted, setTrusted] = useState(true);
  const [discover, setDiscover] = useState(true);

  const fetchServers = async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const { data } = await adminApi.listFederatedServers();
      const nextServers = Array.isArray(data.servers) ? data.servers : [];
      setServers(nextServers);
      if (selectedServer) {
        const match = nextServers.find((s) => s.server_name === selectedServer.server_name) ?? null;
        setSelectedServer(match);
      }
    } catch (err) {
      toast.error(`Failed to load federated servers: ${extractApiError(err)}`);
      setServers([]);
      setSelectedServer(null);
    } finally {
      setLoading(false);
      if (showSpinner) setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    const trimmedName = serverName.trim();
    const trimmedDomain = domain.trim();
    const trimmedEndpoint = endpoint.trim();
    if (!trimmedName || !trimmedDomain || !trimmedEndpoint) {
      toast.error('Server name, domain, and endpoint are required.');
      return;
    }
    setCreating(true);
    try {
      await adminApi.addFederatedServer({
        server_name: trimmedName,
        domain: trimmedDomain,
        federation_endpoint: trimmedEndpoint,
        public_key_hex: publicKeyHex.trim() || undefined,
        key_id: keyId.trim() || undefined,
        trusted,
        discover,
      });
      toast.success(`Federated server added: ${trimmedName}`);
      setServerName('');
      setDomain('');
      setEndpoint('');
      setPublicKeyHex('');
      setKeyId('');
      setTrusted(true);
      setDiscover(true);
      await fetchServers();
    } catch (err) {
      toast.error(`Failed to add federated server: ${extractApiError(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleInspect = async (name: string) => {
    setInspectingName(name);
    try {
      const { data } = await adminApi.getFederatedServer(name);
      setSelectedServer(data);
    } catch (err) {
      toast.error(`Failed to inspect server: ${extractApiError(err)}`);
    } finally {
      setInspectingName(null);
    }
  };

  const handleDelete = async (name: string) => {
    if (!(await confirm({
      title: 'Delete federated server?',
      description: `Delete "${name}" from trusted federation peers?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;
    setDeletingName(name);
    try {
      await adminApi.deleteFederatedServer(name);
      toast.success(`Deleted federated server: ${name}`);
      setServers((prev) => prev.filter((s) => s.server_name !== name));
      if (selectedServer?.server_name === name) setSelectedServer(null);
    } catch (err) {
      toast.error(`Failed to delete server: ${extractApiError(err)}`);
    } finally {
      setDeletingName(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="mb-2 text-xl font-semibold text-text-primary">Federation</h2>
        <p className="text-sm text-text-muted">
          Manage trusted peers and inspect discovered federation metadata.
        </p>
      </div>

      <section className="card-surface space-y-5 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Add Federated Server</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Server Name</label>
            <input
              aria-label="Server Name"
              type="text"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="example-server"
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Domain</label>
            <input
              aria-label="Domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              className="input-field"
            />
          </div>
          <div className="md:col-span-2">
            <label className="mb-2 block text-sm font-medium text-text-secondary">Federation Endpoint</label>
            <input
              aria-label="Federation Endpoint"
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://example.com/_paracord/federation/v1"
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Public Key (hex)</label>
            <input
              aria-label="Public Key hex"
              type="text"
              value={publicKeyHex}
              onChange={(e) => setPublicKeyHex(e.target.value)}
              placeholder="Optional"
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Key ID</label>
            <input
              aria-label="Key ID"
              type="text"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="Optional"
              className="input-field"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="card-surface inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-sm text-text-secondary">
            <input
              aria-label="Trusted peer"
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
              className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
            />
            Trusted peer
          </label>
          <label className="card-surface inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-sm text-text-secondary">
            <input
              aria-label="Discover keys automatically"
              type="checkbox"
              checked={discover}
              onChange={(e) => setDiscover(e.target.checked)}
              className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
            />
            Discover keys automatically
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-2"
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {creating ? 'Adding...' : 'Add Server'}
          </Button>
          <button
            onClick={() => fetchServers(true)}
            disabled={refreshing}
            className="btn-secondary inline-flex items-center gap-2"
          >
            {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
            {refreshing ? 'Refreshing...' : 'Refresh List'}
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">Known Servers</h3>
        {loading ? (
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-6 text-sm text-text-muted">
            Loading federated servers...
          </div>
        ) : servers.length === 0 ? (
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-6 text-sm text-text-muted">
            No federated servers configured yet.
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((server) => (
              <div
                key={server.server_name}
                className="card-surface flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary">{server.server_name}</p>
                  <p className="truncate text-sm text-text-muted">{server.domain}</p>
                  <p className="truncate text-xs text-text-muted">{server.federation_endpoint}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${
                      server.trusted
                        ? 'bg-accent-success/20 text-accent-success'
                        : 'bg-warning/20 text-warning'
                    }`}
                  >
                    {server.trusted ? 'Trusted' : 'Untrusted'}
                  </span>
                  <button
                    onClick={() => handleInspect(server.server_name)}
                    disabled={inspectingName === server.server_name}
                    className="btn-secondary inline-flex items-center gap-2"
                  >
                    {inspectingName === server.server_name ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Pencil size={14} />
                    )}
                    Inspect
                  </button>
                  <button
                    onClick={() => handleDelete(server.server_name)}
                    disabled={deletingName === server.server_name}
                    className="btn-danger inline-flex items-center gap-2"
                  >
                    {deletingName === server.server_name ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedServer && (
        <section className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 p-6">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-muted">
            Server Details: {selectedServer.server_name}
          </h3>
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Domain:</span> {selectedServer.domain}
            </p>
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Trusted:</span>{' '}
              {selectedServer.trusted ? 'Yes' : 'No'}
            </p>
            <p className="text-text-secondary md:col-span-2">
              <span className="font-medium text-text-primary">Endpoint:</span>{' '}
              {selectedServer.federation_endpoint}
            </p>
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Key ID:</span>{' '}
              {selectedServer.key_id || 'Not set'}
            </p>
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Last Seen:</span>{' '}
              {selectedServer.last_seen_at || 'Never'}
            </p>
            <p className="break-all text-text-secondary md:col-span-2">
              <span className="font-medium text-text-primary">Public Key:</span>{' '}
              {selectedServer.public_key_hex || 'Not set'}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

type BackupRow = {
  name: string;
  size_bytes: number;
  created_at: string;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function BackupsPanel() {
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [restoringName, setRestoringName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [downloadingName, setDownloadingName] = useState<string | null>(null);

  const fetchBackups = async () => {
    try {
      const { data } = await adminApi.listBackups();
      setBackups(data.backups);
    } catch (err) {
      toast.error(`Failed to load backups: ${extractApiError(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBackups();
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const { data } = await adminApi.createBackup(includeMedia);
      toast.success(`Backup created: ${data.filename}`);
      fetchBackups();
    } catch (err) {
      toast.error(`Failed to create backup: ${extractApiError(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = async (name: string) => {
    setDownloadingName(name);
    try {
      const { data } = await adminApi.downloadBackup(name);
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(`Failed to download backup: ${extractApiError(err)}`);
    } finally {
      setDownloadingName(null);
    }
  };

  const handleDelete = async (name: string) => {
    if (!(await confirm({
      title: 'Delete backup?',
      description: `Delete "${name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;
    setDeletingName(name);
    try {
      await adminApi.deleteBackup(name);
      toast.success(`Backup deleted: ${name}`);
      setBackups((prev) => prev.filter((b) => b.name !== name));
    } catch (err) {
      toast.error(`Failed to delete backup: ${extractApiError(err)}`);
    } finally {
      setDeletingName(null);
    }
  };

  const handleRestore = async (name: string) => {
    if (!(await confirm({
      title: 'Restore backup?',
      description: `Restore "${name}" now? This will overwrite current data on disk. A server restart is recommended after restore.`,
      confirmLabel: 'Restore',
      variant: 'danger',
    }))) return;
    setRestoringName(name);
    try {
      const { data } = await adminApi.restoreBackup(name);
      toast.success(data.message || `Backup restored: ${name}`);
    } catch (err) {
      toast.error(`Failed to restore backup: ${extractApiError(err)}`);
    } finally {
      setRestoringName(null);
    }
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">Backups</h2>

      {/* Create backup controls */}
      <div className="mb-8 flex flex-wrap items-center gap-5">
        <Button
          onClick={handleCreate}
          disabled={creating}
          className="inline-flex items-center gap-2"
        >
          {creating ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
          {creating ? 'Creating Backup...' : 'Create Backup'}
        </Button>

        <label className="card-surface inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={includeMedia}
            onChange={(e) => setIncludeMedia(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
          />
          Include media files
        </label>
      </div>

      {/* Backups list */}
      {loading ? (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-6 text-sm text-text-muted">
          Loading backups...
        </div>
      ) : backups.length === 0 ? (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-10 text-center text-text-muted">
          No backups yet. Create your first backup above.
        </div>
      ) : (
        <div className="card-surface overflow-hidden rounded-xl border border-border-subtle bg-bg-mod-subtle/40">
          <div className="overflow-x-auto">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-secondary/60">
                <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Filename</th>
                <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Date</th>
                <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Size</th>
                <th className="px-6 py-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr
                  key={b.name}
                  className="border-b border-border-subtle/50 last:border-b-0 transition-colors hover:bg-bg-mod-subtle/30"
                >
                  <td className="px-6 py-5 font-medium text-text-primary">
                    <span className="font-mono text-xs">{b.name}</span>
                  </td>
                  <td className="px-6 py-5 text-text-secondary">
                    {b.created_at
                      ? new Date(b.created_at).toLocaleString()
                      : '-'}
                  </td>
                  <td className="px-6 py-5 text-text-secondary">
                    {formatBytes(b.size_bytes)}
                  </td>
                  <td className="px-6 py-5">
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => handleRestore(b.name)}
                        disabled={restoringName === b.name}
                        className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary disabled:opacity-50"
                        title="Restore backup"
                        aria-label={`Restore backup ${b.name}`}
                      >
                        {restoringName === b.name ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <RotateCcw size={16} />
                        )}
                      </button>
                      <button
                        onClick={() => handleDownload(b.name)}
                        disabled={downloadingName === b.name}
                        className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary disabled:opacity-50"
                        title="Download backup"
                        aria-label={`Download backup ${b.name}`}
                      >
                        {downloadingName === b.name ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Download size={16} />
                        )}
                      </button>
                      <button
                        onClick={() => handleDelete(b.name)}
                        disabled={deletingName === b.name}
                        className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-accent-danger/10 hover:text-accent-danger disabled:opacity-50"
                        title="Delete backup"
                        aria-label={`Delete backup ${b.name}`}
                      >
                        {deletingName === b.name ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Trash2 size={16} />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

