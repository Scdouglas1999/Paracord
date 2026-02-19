import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Server, Settings, BarChart3, Shield, ShieldOff, Trash2, Pencil, HardDrive, Download, Plus, Loader2, RotateCcw } from 'lucide-react';
import { adminApi } from '../api/admin';
import { extractApiError } from '../api/client';
import { toast } from '../stores/toastStore';
import { useAuthStore } from '../stores/authStore';
import { isAdmin, UserFlags } from '../types';

type Tab = 'overview' | 'users' | 'guilds' | 'settings' | 'security' | 'backups';

export function AdminPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Sidebar nav */}
      <aside className="panel-surface flex w-64 min-w-[16rem] flex-col overflow-hidden">
        <div className="panel-divider flex items-center gap-3 border-b px-4 py-4">
          <button
            onClick={() => navigate(-1)}
            className="command-icon-btn"
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
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const limit = 25;

  const fetchUsers = () => {
    adminApi
      .getUsers({ offset, limit })
      .then(({ data }) => {
        setUsers(data.users);
        setTotal(data.total);
      })
      .catch((err) => {
        toast.error(`Failed to load users: ${extractApiError(err)}`);
      });
  };

  useEffect(() => {
    fetchUsers();
  }, [offset]);

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
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
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
                        >
                          {isAdmin(u.flags) ? <ShieldOff size={16} /> : <Shield size={16} />}
                        </button>
                        <button
                          onClick={() => deleteUser(u.id, u.username)}
                          className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
                          title="Delete user"
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

      {total > limit && (
        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="control-pill-btn h-10 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-text-muted">
            {offset + 1} - {Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={offset + limit >= total}
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

  const closeEdit = () => {
    setEditingGuild(null);
    setSaving(false);
  };

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
    if (!confirm(`Delete guild "${name}"? This will delete all channels and messages. This cannot be undone.`)) return;
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
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => deleteGuild(g.id, g.name)}
                      className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
                      title="Delete guild"
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
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--overlay-backdrop)' }}
          onClick={closeEdit}
        >
          <div
            className="glass-modal w-full max-w-md rounded-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-5 text-lg font-semibold text-text-primary">Edit Guild</h3>
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
              <button
                onClick={saveGuild}
                disabled={saving}
                className="btn-primary"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────

function SecurityPanel() {
  const [events, setEvents] = useState<Array<{
    id: string;
    actor_user_id?: string | null;
    action: string;
    target_user_id?: string | null;
    session_id?: string | null;
    ip_address?: string | null;
    created_at: string;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const { data } = await adminApi.listSecurityEvents({
        limit: 200,
        action: actionFilter.trim() || undefined,
      });
      setEvents(data);
    } catch (err) {
      toast.error(`Failed to load security events: ${extractApiError(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchEvents();
  }, []);

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Security Events</h2>
          <p className="text-sm text-text-muted">Recent authentication and admin activity.</p>
        </div>
        <button
          onClick={() => void fetchEvents()}
          className="control-pill-btn h-10 px-4 text-sm"
        >
          Refresh
        </button>
      </div>

      <div className="mb-6 flex gap-3">
        <input
          type="text"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Filter by action (e.g. auth.login)"
          className="input-field max-w-md"
        />
        <button
          onClick={() => void fetchEvents()}
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
          <table className="min-w-[880px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-secondary/60">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Time</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Action</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Actor</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Target</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">IP</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Session</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="border-b border-border-subtle/50 last:border-b-0 align-top hover:bg-bg-mod-subtle/20">
                  <td className="px-4 py-3 text-text-secondary">{new Date(event.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 font-medium text-text-primary">{event.action}</td>
                  <td className="px-4 py-3 text-text-secondary">{event.actor_user_id || '-'}</td>
                  <td className="px-4 py-3 text-text-secondary">{event.target_user_id || '-'}</td>
                  <td className="px-4 py-3 text-text-secondary">{event.ip_address || '-'}</td>
                  <td className="px-4 py-3 text-text-secondary">{event.session_id || '-'}</td>
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
            type="number"
            value={settings.max_members_per_guild || '1000'}
            onChange={(e) => update('max_members_per_guild', e.target.value)}
            className="input-field"
          />
        </div>

        {/* Save button */}
        <div className="settings-action-row">
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary"
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
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Backups ────────────────────────────────────────────────────────────

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
    if (!confirm(`Delete backup "${name}"? This cannot be undone.`)) return;
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
    if (
      !confirm(
        `Restore backup "${name}" now?\n\nThis will overwrite current data on disk. A server restart is recommended after restore.`
      )
    ) {
      return;
    }
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
        <button
          onClick={handleCreate}
          disabled={creating}
          className="btn-primary inline-flex items-center gap-2"
        >
          {creating ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
          {creating ? 'Creating Backup...' : 'Create Backup'}
        </button>

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

