import { useState, useEffect } from 'react';
import { Download, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
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
