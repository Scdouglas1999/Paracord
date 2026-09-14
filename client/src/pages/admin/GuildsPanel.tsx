import { useState, useEffect } from 'react';
import { Pencil, Trash2, Server } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { getIdentityColor } from '../../lib/colors';
import {
  Button,
  EmptyState,
  IconButton,
  SettingsSectionHeader,
  TextField,
} from '../../components/ui';
import { Textarea } from '../../components/ui/Input';
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
        toast.error(`Failed to load servers: ${extractApiError(err)}`);
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
      toast.error(`Failed to save server: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteGuild = async (guildId: string, name: string) => {
    if (!(await confirm({
      title: 'Delete server?',
      description: `Delete "${name}"? This will delete all channels and messages. This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;
    try {
      await adminApi.deleteGuild(guildId);
      if (editingGuild?.id === guildId) closeEdit();
      fetchGuilds();
    } catch (err) {
      toast.error(`Failed to delete server: ${extractApiError(err)}`);
    }
  };

  return (
    <div>
      <SettingsSectionHeader
        title="Servers"
        description={
          <>
            <span className="pc-mono tabular-nums text-text-primary">
              {guilds.length.toLocaleString()}
            </span>{' '}
            {guilds.length === 1 ? 'community' : 'communities'} hosted on this instance.
          </>
        }
      />

      {guilds.length === 0 ? (
        <EmptyState
          icon={<Server size={20} />}
          title="No servers have been created yet"
          description="Once members start their own communities, every server on this instance will be listed and manageable here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Server</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Description</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Created</th>
                <th scope="col" className="px-3 pb-2 text-right text-section text-text-faint">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {guilds.map((g) => (
                <tr
                  key={g.id}
                  className="border-t border-border-subtle transition-colors hover:bg-bg-mod-subtle"
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-well)] text-meta font-semibold text-text-on-light"
                        style={{ backgroundColor: getIdentityColor(g.id) }}
                        aria-hidden
                      >
                        {initials(g.name)}
                      </span>
                      <span className="pc-display truncate text-name text-text-primary">
                        {g.name}
                      </span>
                    </div>
                  </td>
                  <td className="max-w-xs truncate px-3 py-2.5 text-label text-text-secondary">
                    {g.description || (
                      <span className="text-text-muted">Nobody has written one yet</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="pc-mono text-meta tabular-nums text-text-secondary">
                      {new Date(g.created_at).toLocaleDateString()}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton label={`Edit server ${g.name}`} onClick={() => openEdit(g)}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton
                        label={`Delete server ${g.name}`}
                        onClick={() => deleteGuild(g.id, g.name)}
                        className="hover:bg-danger-well hover:text-accent-danger"
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={Boolean(editingGuild)}
        onClose={closeEdit}
        size="sm"
        labelledBy="admin-edit-guild-title"
        showCloseButton
      >
        <ModalHeader>
          <ModalTitle id="admin-edit-guild-title">Edit server</ModalTitle>
        </ModalHeader>
        <ModalBody className="flex flex-col gap-5 pt-2">
          <TextField
            id="admin-edit-guild-name"
            label="Name"
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="admin-edit-guild-desc"
              className="text-label font-medium text-text-secondary"
            >
              Description
            </label>
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
