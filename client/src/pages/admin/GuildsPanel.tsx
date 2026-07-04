import { useState, useEffect } from 'react';
import { Pencil, Trash2, Server } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { Input, Textarea } from '../../components/ui/Input';
import { EmptyState } from '../../components/ui/Feedback';
import {
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../components/ui/Modal';
import { confirm } from '../../stores/confirmStore';

type GuildRow = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function GuildsPanel() {
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
      <header className="mb-6">
        <h2 className="font-display text-heading text-text-primary">Guilds</h2>
        <p className="mt-1 text-body text-text-secondary">
          <span className="font-display tabular-nums text-text-primary">{guilds.length.toLocaleString()}</span>{' '}
          {guilds.length === 1 ? 'community' : 'communities'} hosted on this server.
        </p>
      </header>

      <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-tertiary/40">
                <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Guild</th>
                <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Description</th>
                <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Created</th>
                <th scope="col" className="px-5 py-3 text-right text-section uppercase text-text-secondary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {guilds.map((g) => (
                <tr
                  key={g.id}
                  className="group/row border-b border-border-subtle/60 transition-colors last:border-b-0 hover:bg-bg-mod-subtle"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-mod-strong text-meta font-semibold text-text-secondary">
                        {initials(g.name)}
                      </span>
                      <span className="truncate text-label font-semibold text-text-primary">{g.name}</span>
                    </div>
                  </td>
                  <td className="max-w-xs truncate px-5 py-3 text-body text-text-secondary">
                    {g.description || <span className="text-text-muted">No description</span>}
                  </td>
                  <td className="px-5 py-3 font-code text-meta tabular-nums text-text-secondary">
                    {new Date(g.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity duration-[140ms] focus-within:opacity-100 group-hover/row:opacity-100">
                      <button
                        onClick={() => openEdit(g)}
                        className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors hover:bg-bg-mod-strong hover:text-text-primary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]"
                        title="Edit guild"
                        aria-label={`Edit guild ${g.name}`}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => deleteGuild(g.id, g.name)}
                        className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors hover:bg-danger-tint hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]"
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
                  <td colSpan={4} className="px-5">
                    <EmptyState
                      icon={<Server size={20} />}
                      title="No guilds have been created yet"
                      description="Once members start their own communities, every guild on this server will be listed and manageable here."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={Boolean(editingGuild)}
        onClose={closeEdit}
        size="sm"
        labelledBy="admin-edit-guild-title"
        showCloseButton
      >
        <ModalHeader>
          <ModalTitle id="admin-edit-guild-title">Edit guild</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-5 pt-2">
          <div className="space-y-2">
            <label htmlFor="admin-edit-guild-name" className="block text-label font-medium text-text-secondary">Name</label>
            <Input
              id="admin-edit-guild-name"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="admin-edit-guild-desc" className="block text-label font-medium text-text-secondary">Description</label>
            <Textarea
              id="admin-edit-guild-desc"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={closeEdit}>Cancel</Button>
          <Button onClick={saveGuild} loading={saving} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
