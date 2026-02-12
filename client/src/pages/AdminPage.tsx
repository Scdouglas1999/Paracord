import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Server, Settings, BarChart3, Shield, ShieldOff, Trash2, Pencil } from 'lucide-react';
import { adminApi } from '../api/admin';
import { useAuthStore } from '../stores/authStore';
import { isAdmin, UserFlags } from '../types';

type Tab = 'overview' | 'users' | 'guilds' | 'settings';

export function AdminPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  return (
    <div className="flex h-full">
      {/* Sidebar nav */}
      <div className="flex w-60 min-w-[15rem] flex-col border-r border-border-subtle bg-bg-secondary/50">
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-4">
          <button
            onClick={() => navigate(-1)}
            className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-lg font-semibold text-text-primary">Admin Dashboard</h1>
        </div>

        <nav className="flex flex-col gap-1 p-3">
          {([
            { id: 'overview' as Tab, label: 'Overview', icon: BarChart3 },
            { id: 'users' as Tab, label: 'Users', icon: Users },
            { id: 'guilds' as Tab, label: 'Guilds', icon: Server },
            { id: 'settings' as Tab, label: 'Settings', icon: Settings },
          ]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === id
                  ? 'bg-accent-primary/15 text-accent-primary'
                  : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
              }`}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'overview' && <OverviewPanel />}
        {activeTab === 'users' && <UsersPanel />}
        {activeTab === 'guilds' && <GuildsPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
      </div>
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
    adminApi.getStats().then(({ data }) => setStats(data)).catch(() => {});
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
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="rounded-xl border border-border-subtle bg-bg-secondary/60 p-5"
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
  const limit = 25;

  const fetchUsers = () => {
    adminApi.getUsers({ offset, limit }).then(({ data }) => {
      setUsers(data.users);
      setTotal(data.total);
    }).catch(() => {});
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
    } catch {
      /* ignore */
    }
  };

  const deleteUser = async (userId: string, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      await adminApi.deleteUser(userId);
      fetchUsers();
    } catch {
      /* ignore */
    }
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">
        Users <span className="text-sm font-normal text-text-muted">({total})</span>
      </h2>

      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-bg-secondary/60">
              <th className="px-4 py-3 font-medium text-text-secondary">Username</th>
              <th className="px-4 py-3 font-medium text-text-secondary">Email</th>
              <th className="px-4 py-3 font-medium text-text-secondary">Role</th>
              <th className="px-4 py-3 font-medium text-text-secondary">Joined</th>
              <th className="px-4 py-3 font-medium text-text-secondary">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-border-subtle/50 transition-colors hover:bg-bg-mod-subtle/30">
                <td className="px-4 py-3 text-text-primary">
                  <span className="font-medium">{u.display_name || u.username}</span>
                  <span className="ml-1 text-text-muted">#{u.discriminator}</span>
                </td>
                <td className="px-4 py-3 text-text-secondary">{u.email}</td>
                <td className="px-4 py-3">
                  {isAdmin(u.flags) ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent-primary/15 px-2.5 py-0.5 text-xs font-medium text-accent-primary">
                      <Shield size={12} /> Admin
                    </span>
                  ) : (
                    <span className="text-text-muted">Member</span>
                  )}
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
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
                      <span className="text-xs text-text-muted">You</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > limit && (
        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-text-muted">
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={offset + limit >= total}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle disabled:opacity-40"
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
    adminApi.getGuilds().then(({ data }) => setGuilds(data.guilds)).catch(() => {});
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
    } catch {
      /* ignore */
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
    } catch {
      /* ignore */
    }
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">
        Guilds <span className="text-sm font-normal text-text-muted">({guilds.length})</span>
      </h2>

      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-bg-secondary/60">
              <th className="px-4 py-3 font-medium text-text-secondary">Name</th>
              <th className="px-4 py-3 font-medium text-text-secondary">Description</th>
              <th className="px-4 py-3 font-medium text-text-secondary">Created</th>
              <th className="px-4 py-3 font-medium text-text-secondary">Actions</th>
            </tr>
          </thead>
          <tbody>
            {guilds.map((g) => (
              <tr key={g.id} className="border-b border-border-subtle/50 transition-colors hover:bg-bg-mod-subtle/30">
                <td className="px-4 py-3 font-medium text-text-primary">{g.name}</td>
                <td className="max-w-xs truncate px-4 py-3 text-text-secondary">
                  {g.description || '—'}
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {new Date(g.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
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
                <td colSpan={4} className="px-4 py-8 text-center text-text-muted">
                  No guilds yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editingGuild && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={closeEdit}>
          <div
            className="w-full max-w-md rounded-xl border border-border-subtle bg-bg-primary p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold text-text-primary">Edit guild</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-text-secondary">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-accent-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-text-secondary">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-accent-primary"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={closeEdit}
                className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle"
              >
                Cancel
              </button>
              <button
                onClick={saveGuild}
                disabled={saving}
                className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-primary/80 disabled:opacity-50"
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

function SettingsPanel() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminApi.getSettings().then(({ data }) => setSettings(data)).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data } = await adminApi.updateSettings(settings);
      setSettings(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      /* ignore */
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

      <div className="max-w-xl space-y-6">
        {/* Server Name */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-secondary">
            Server Name
          </label>
          <input
            type="text"
            value={settings.server_name || ''}
            onChange={(e) => update('server_name', e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-accent-primary"
          />
        </div>

        {/* Server Description */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-secondary">
            Server Description
          </label>
          <textarea
            value={settings.server_description || ''}
            onChange={(e) => update('server_description', e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-accent-primary"
          />
        </div>

        {/* Registration Toggle */}
        <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-secondary/60 px-4 py-4">
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
          <label className="mb-2 block text-sm font-medium text-text-secondary">
            Max Guilds Per User
          </label>
          <input
            type="number"
            value={settings.max_guilds_per_user || '100'}
            onChange={(e) => update('max_guilds_per_user', e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-accent-primary"
          />
        </div>

        {/* Max members per guild */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-secondary">
            Max Members Per Guild
          </label>
          <input
            type="number"
            value={settings.max_members_per_guild || '1000'}
            onChange={(e) => update('max_members_per_guild', e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-accent-primary"
          />
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className={`rounded-lg px-6 py-2.5 text-sm font-medium text-white transition-colors ${
            saved
              ? 'bg-accent-success'
              : 'bg-accent-primary hover:bg-accent-primary/80'
          } disabled:opacity-50`}
        >
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
