import { useState, useEffect } from 'react';
import { Download, Loader2, Plus, RotateCcw, Trash2, AlertTriangle, Archive } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { EmptyState, LoadingSpinner } from '../../components/ui/Feedback';
import { confirm } from '../../stores/confirmStore';

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

export function BackupsPanel() {
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
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-heading text-text-primary">Backups</h2>
          <p className="mt-1 text-body text-text-secondary">
            Create point-in-time snapshots and restore this server from one.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-body text-text-secondary">
            <input
              type="checkbox"
              checked={includeMedia}
              onChange={(e) => setIncludeMedia(e.target.checked)}
              className="h-4 w-4 rounded-xs border-border-subtle accent-accent-primary"
            />
            Include media files
          </label>
          <Button onClick={handleCreate} loading={creating} disabled={creating} className="gap-2">
            {!creating && <Plus size={16} />}
            {creating ? 'Creating…' : 'Create backup'}
          </Button>
        </div>
      </header>

      <div className="mb-6 flex items-start gap-3 rounded-md border border-accent-warning/30 bg-warning-tint px-4 py-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-accent-warning" />
        <p className="text-body text-text-secondary">
          <span className="font-semibold text-text-primary">Restoring overwrites everything.</span>{' '}
          A restore replaces current data on disk with the snapshot's contents. Download a fresh backup first, then restart the server once the restore completes.
        </p>
      </div>

      {loading ? (
        <div className="rounded-md border border-border-subtle bg-bg-secondary px-6 py-10 shadow-sm">
          <LoadingSpinner size="sm" label="Loading backups…" />
        </div>
      ) : backups.length === 0 ? (
        <div className="rounded-md border border-border-subtle bg-bg-secondary px-4 shadow-sm">
          <EmptyState
            icon={<Archive size={20} />}
            title="No backups yet"
            description="You haven't captured a snapshot of this server. Create one now so you can roll back if something goes wrong."
            action={
              <Button onClick={handleCreate} loading={creating} disabled={creating} className="gap-2">
                {!creating && <Plus size={16} />}
                {creating ? 'Creating…' : 'Create first backup'}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-tertiary/40">
                  <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Filename</th>
                  <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Created</th>
                  <th scope="col" className="px-5 py-3 text-section uppercase text-text-secondary">Size</th>
                  <th scope="col" className="px-5 py-3 text-right text-section uppercase text-text-secondary">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr
                    key={b.name}
                    className="group/row border-b border-border-subtle/60 transition-colors last:border-b-0 hover:bg-bg-mod-subtle"
                  >
                    <td className="px-5 py-3">
                      <span className="font-code text-meta text-text-primary">{b.name}</span>
                    </td>
                    <td className="px-5 py-3 font-code text-meta tabular-nums text-text-secondary">
                      {b.created_at ? new Date(b.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-3 font-code text-meta tabular-nums text-text-secondary">
                      {formatBytes(b.size_bytes)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity duration-[140ms] focus-within:opacity-100 group-hover/row:opacity-100">
                        <button
                          onClick={() => handleRestore(b.name)}
                          disabled={restoringName === b.name}
                          className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors hover:bg-warning-tint hover:text-accent-warning focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                          title="Restore backup"
                          aria-label={`Restore backup ${b.name}`}
                        >
                          {restoringName === b.name ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                        </button>
                        <button
                          onClick={() => handleDownload(b.name)}
                          disabled={downloadingName === b.name}
                          className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors hover:bg-bg-mod-strong hover:text-text-primary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                          title="Download backup"
                          aria-label={`Download backup ${b.name}`}
                        >
                          {downloadingName === b.name ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                        </button>
                        <button
                          onClick={() => handleDelete(b.name)}
                          disabled={deletingName === b.name}
                          className="flex h-8 w-8 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors hover:bg-danger-tint hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                          title="Delete backup"
                          aria-label={`Delete backup ${b.name}`}
                        >
                          {deletingName === b.name ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
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
