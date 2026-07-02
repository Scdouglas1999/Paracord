import { useEffect, useState, useCallback } from 'react';
import { Trash2, HardDrive } from 'lucide-react';
import { guildStorageApi, type GuildStoragePolicy, type GuildStorageInfo, type GuildFile } from '../../api/guildStorage';
import { confirm } from '../../stores/confirmStore';

interface FileStorageSectionProps {
  guildId: string;
  canManage: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function bytesToMB(bytes: number | null): string {
  if (bytes == null || bytes === 0) return '';
  return String(Math.round(bytes / (1024 * 1024)));
}

function mbToBytes(mb: string): number | null {
  const val = parseFloat(mb);
  if (isNaN(val) || val <= 0) return null;
  return Math.round(val * 1024 * 1024);
}

export function FileStorageSection({ guildId, canManage }: FileStorageSectionProps) {
  const [storageInfo, setStorageInfo] = useState<GuildStorageInfo | null>(null);
  const [files, setFiles] = useState<GuildFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Policy form state
  const [maxFileSizeMB, setMaxFileSizeMB] = useState('');
  const [storageQuotaMB, setStorageQuotaMB] = useState('');
  const [retentionDays, setRetentionDays] = useState('');
  const [allowedTypes, setAllowedTypes] = useState('');
  const [blockedTypes, setBlockedTypes] = useState('');

  // Pagination
  const [hasMoreFiles, setHasMoreFiles] = useState(false);
  const PAGE_SIZE = 50;

  const getApiErrorMessage = (err: unknown, fallback: string) => {
    const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data;
    return responseData?.message || responseData?.error || fallback;
  };

  const loadStorage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usageRes, filesRes] = await Promise.all([
        guildStorageApi.getUsage(guildId),
        guildStorageApi.listFiles(guildId, { limit: PAGE_SIZE }),
      ]);
      setStorageInfo(usageRes.data);
      setFiles(filesRes.data);
      setHasMoreFiles(filesRes.data.length >= PAGE_SIZE);

      const policy = usageRes.data.policy;
      setMaxFileSizeMB(bytesToMB(policy?.max_file_size ?? null));
      setStorageQuotaMB(bytesToMB(policy?.storage_quota ?? null));
      setRetentionDays(policy?.retention_days != null ? String(policy.retention_days) : '');
      setAllowedTypes(policy?.allowed_types?.join(', ') ?? '');
      setBlockedTypes(policy?.blocked_types?.join(', ') ?? '');
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to load storage info'));
    } finally {
      setLoading(false);
    }
  }, [guildId]);

  useEffect(() => {
    void loadStorage();
  }, [loadStorage]);

  const loadMoreFiles = async () => {
    if (!files.length) return;
    const lastId = files[files.length - 1].id;
    try {
      const { data } = await guildStorageApi.listFiles(guildId, { before: lastId, limit: PAGE_SIZE });
      setFiles((prev) => [...prev, ...data]);
      setHasMoreFiles(data.length >= PAGE_SIZE);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to load more files'));
    }
  };

  const savePolicy = async () => {
    if (!canManage) return;
    setSaving(true);
    setError(null);
    try {
      const policy: Partial<GuildStoragePolicy> = {
        max_file_size: mbToBytes(maxFileSizeMB),
        storage_quota: mbToBytes(storageQuotaMB),
        retention_days: retentionDays.trim() ? parseInt(retentionDays, 10) || null : null,
        allowed_types: allowedTypes.trim()
          ? allowedTypes.split(',').map((t) => t.trim()).filter(Boolean)
          : null,
        blocked_types: blockedTypes.trim()
          ? blockedTypes.split(',').map((t) => t.trim()).filter(Boolean)
          : null,
      };
      await guildStorageApi.updatePolicy(guildId, policy);
      await loadStorage();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to save storage policy'));
    } finally {
      setSaving(false);
    }
  };

  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  };

  const deleteSelectedFiles = async () => {
    if (!selectedFileIds.length) return;
    if (!(await confirm({
      title: `Delete ${selectedFileIds.length} file${selectedFileIds.length === 1 ? '' : 's'}?`,
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;

    setError(null);
    try {
      await guildStorageApi.deleteFiles(guildId, selectedFileIds);
      setFiles((prev) => prev.filter((f) => !selectedFileIds.includes(f.id)));
      setSelectedFileIds([]);
      // Refresh usage
      const { data } = await guildStorageApi.getUsage(guildId);
      setStorageInfo(data);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to delete files'));
    }
  };

  // Usage bar calculations
  const usage = storageInfo?.usage ?? 0;
  const quota = storageInfo?.quota;
  const usagePercent = quota && quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
  const usageBarColor =
    usagePercent >= 90 ? 'var(--accent-danger)' :
    usagePercent >= 75 ? 'var(--accent-warning, #f0b232)' :
    'var(--accent-success)';

  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack-relaxed">
      <h2 className="settings-section-title !mb-0">File Storage</h2>

      {error && (
        <div className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-2.5 text-sm font-medium text-accent-danger">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-text-muted">Loading storage info...</div>
      ) : (
        <>
          {/* Storage usage bar */}
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Storage Usage
            </div>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-xl font-semibold text-text-primary">{formatBytes(usage)}</span>
              {quota != null && (
                <span className="text-sm text-text-muted">/ {formatBytes(quota)} ({usagePercent.toFixed(1)}%)</span>
              )}
              {quota == null && (
                <span className="text-sm text-text-muted">(no quota set)</span>
              )}
            </div>
            {quota != null && quota > 0 && (
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-bg-mod-strong">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${usagePercent}%`, backgroundColor: usageBarColor }}
                />
              </div>
            )}
          </div>

          {/* Policy form */}
          {canManage && (
            <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4 sm:p-5">
              <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Storage Policy
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Max File Size (MB)</span>
                  <input
                    type="number"
                    min="0"
                    value={maxFileSizeMB}
                    onChange={(e) => setMaxFileSizeMB(e.target.value)}
                    className="input-field mt-2"
                    placeholder="No limit"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Storage Quota (MB)</span>
                  <input
                    type="number"
                    min="0"
                    value={storageQuotaMB}
                    onChange={(e) => setStorageQuotaMB(e.target.value)}
                    className="input-field mt-2"
                    placeholder="No limit"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Retention Days</span>
                  <input
                    type="number"
                    min="0"
                    value={retentionDays}
                    onChange={(e) => setRetentionDays(e.target.value)}
                    className="input-field mt-2"
                    placeholder="Forever"
                  />
                </label>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Allowed MIME Types</span>
                  <input
                    type="text"
                    value={allowedTypes}
                    onChange={(e) => setAllowedTypes(e.target.value)}
                    className="input-field mt-2"
                    placeholder="e.g. image/png, image/jpeg"
                  />
                  <p className="mt-1 text-xs text-text-muted">Comma-separated. Leave empty for all types.</p>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Blocked MIME Types</span>
                  <input
                    type="text"
                    value={blockedTypes}
                    onChange={(e) => setBlockedTypes(e.target.value)}
                    className="input-field mt-2"
                    placeholder="e.g. application/exe"
                  />
                  <p className="mt-1 text-xs text-text-muted">Comma-separated. Blocked types override allowed.</p>
                </label>
              </div>
              <div className="settings-action-row mt-4">
                <button
                  className="btn-primary"
                  onClick={() => void savePolicy()}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : 'Save Policy'}
                </button>
              </div>
            </div>
          )}

          {!canManage && (
            <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3 text-sm text-text-secondary">
              Only server admins can modify file storage policies.
            </div>
          )}

          {/* File browser */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Guild Files
              </div>
              {canManage && selectedFileIds.length > 0 && (
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg border border-accent-danger/30 bg-accent-danger/10 px-3 py-1.5 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
                  onClick={() => void deleteSelectedFiles()}
                >
                  <Trash2 size={13} />
                  Delete {selectedFileIds.length} selected
                </button>
              )}
            </div>

            {files.length === 0 ? (
              <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-8 text-center">
                <HardDrive size={36} className="mx-auto mb-2 text-text-muted" />
                <p className="text-sm text-text-muted">No files uploaded yet.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border-subtle">
                <div className="hidden items-center bg-bg-secondary px-4 py-2.5 text-xs font-semibold uppercase text-text-muted sm:flex">
                  {canManage && <span className="w-8" />}
                  <span className="flex-1">Filename</span>
                  <span className="w-24 text-right">Size</span>
                  <span className="w-36 text-right">Uploaded</span>
                </div>
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="flex flex-col items-start gap-1.5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-2"
                    style={{ borderTop: '1px solid var(--border-subtle)' }}
                  >
                    {canManage && (
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-subtle accent-accent-primary"
                        checked={selectedFileIds.includes(file.id)}
                        onChange={() => toggleFileSelection(file.id)}
                      />
                    )}
                    <span className="flex-1 truncate font-medium text-text-primary">{file.filename}</span>
                    {file.content_type && (
                      <span className="hidden text-xs text-text-muted sm:inline">{file.content_type}</span>
                    )}
                    <span className="w-24 text-right text-xs text-text-muted sm:text-sm">
                      {formatBytes(file.size)}
                    </span>
                    <span className="w-36 text-right text-xs text-text-muted sm:text-sm">
                      {new Date(file.created_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {hasMoreFiles && (
              <div className="mt-3 text-center">
                <button
                  className="rounded-lg border border-border-subtle bg-bg-mod-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                  onClick={() => void loadMoreFiles()}
                >
                  Load More
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
