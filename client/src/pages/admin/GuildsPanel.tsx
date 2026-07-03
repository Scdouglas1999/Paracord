import { useState, useEffect, useCallback, useRef } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { confirm } from '../../stores/confirmStore';

type GuildRow = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
};

export function GuildsPanel() {
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
