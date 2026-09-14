import { useState, useEffect } from 'react';
import { Download, Loader2, Plus, BookOpen, Trash2, AlertTriangle, Archive } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import {
  Button,
  Divider,
  EmptyState,
  IconButton,
  LoadingSpinner,
  SettingsSectionHeader,
  Switch,
  Well,
} from '../../components/ui';
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
  const [preparingName, setPreparingName] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Awaited<ReturnType<typeof adminApi.prepareRestore>>['data'] | null>(null);
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

  const handlePrepareRestore = async (name: string) => {
    setPreparingName(name);
    try {
      const { data } = await adminApi.prepareRestore(name);
      setRecovery(data);
    } catch (err) {
      toast.error(`Failed to load recovery instructions: ${extractApiError(err)}`);
    } finally {
      setPreparingName(null);
    }
  };

  return (
    <div>
      <SettingsSectionHeader
        title="Backups"
        description="Create database snapshots with optional media and prepare offline recovery."
        action={
          <Button onClick={handleCreate} loading={creating} disabled={creating} className="gap-2">
            {!creating && <Plus size={16} />}
            {creating ? 'Creating…' : 'Create backup'}
          </Button>
        }
      />

      <div className="mb-5 flex items-center justify-between gap-4">
        <span id="backup-include-media" className="text-label text-text-primary">
          Include media files in the next snapshot
        </span>
        <Switch
          checked={includeMedia}
          onChange={setIncludeMedia}
          labelledBy="backup-include-media"
        />
      </div>

      <Well className="mb-6 flex items-start gap-3 px-4 py-3.5">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-accent-warning" aria-hidden />
        <p className="text-body leading-relaxed text-text-secondary">
          <span className="font-semibold text-accent-warning">
            Recovery is an offline operation.
          </span>{' '}
          Download an archive and retain the server configuration, encryption key environment, TLS
          keys and federation signing key separately. The restore command verifies a new database
          and media directory before you select its configuration. Stop every old server instance
          before activation.
        </p>
      </Well>

      {recovery && (
        <section aria-label="Recovery instructions" className="mb-8">
          <h3 className="pc-display text-heading text-text-primary">
            Recover <span className="pc-mono text-name">{recovery.filename}</span>
          </h3>
          <p className="mt-2 text-body text-text-secondary">{recovery.message}</p>
          <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-body text-text-secondary">
            {recovery.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
          <Well bare className="mt-4 overflow-x-auto p-3">
            <pre className="pc-mono text-meta text-text-secondary"><code>{recovery.command}</code></pre>
          </Well>
          <p className="mt-2 text-meta text-text-secondary">
            For PostgreSQL, also supply{' '}
            <code className="pc-mono text-text-primary">{recovery.postgres_argument}</code> after
            creating a separate empty database.
          </p>
          <Button
            className="mt-3 gap-2"
            variant="ghost"
            onClick={() => handleDownload(recovery.filename)}
            loading={downloadingName === recovery.filename}
          >
            <Download size={16} />
            Download archive
          </Button>
          <Divider className="mt-8" />
        </section>
      )}

      {loading ? (
        <Well className="px-6 py-10">
          <LoadingSpinner size="sm" label="Loading backups…" />
        </Well>
      ) : backups.length === 0 ? (
        <EmptyState
          icon={<Archive size={20} />}
          title="No backups yet"
          description="You haven't captured a snapshot of this instance. Create one now so you can roll back if something goes wrong."
          action={
            <Button
              variant="ghost"
              onClick={handleCreate}
              loading={creating}
              disabled={creating}
              className="gap-2"
            >
              {!creating && <Plus size={16} />}
              {creating ? 'Creating…' : 'Create first backup'}
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Filename</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Created</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Size</th>
                <th scope="col" className="px-3 pb-2 text-right text-section text-text-faint">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr
                  key={b.name}
                  className="border-t border-border-subtle transition-colors hover:bg-bg-mod-subtle"
                >
                  <td className="px-3 py-2.5">
                    <span className="pc-mono break-all text-meta text-text-primary">{b.name}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="pc-mono text-meta tabular-nums text-text-secondary">
                      {b.created_at ? new Date(b.created_at).toLocaleString() : 'unknown'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="pc-mono text-meta tabular-nums text-text-secondary">
                      {formatBytes(b.size_bytes)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        label={`Recovery instructions for ${b.name}`}
                        onClick={() => handlePrepareRestore(b.name)}
                        disabled={preparingName === b.name}
                      >
                        {preparingName === b.name ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <BookOpen size={16} />
                        )}
                      </IconButton>
                      <IconButton
                        label={`Download backup ${b.name}`}
                        onClick={() => handleDownload(b.name)}
                        disabled={downloadingName === b.name}
                      >
                        {downloadingName === b.name ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Download size={16} />
                        )}
                      </IconButton>
                      <IconButton
                        label={`Delete backup ${b.name}`}
                        onClick={() => handleDelete(b.name)}
                        disabled={deletingName === b.name}
                        className="hover:bg-danger-well hover:text-accent-danger"
                      >
                        {deletingName === b.name ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Trash2 size={16} />
                        )}
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
