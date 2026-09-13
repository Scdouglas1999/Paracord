import { useEffect, useState, useCallback } from 'react';
import { Trash2, HardDrive } from 'lucide-react';
import { guildStorageApi, type GuildStoragePolicy, type GuildStorageInfo, type GuildFile } from '../../api/guildStorage';
import { confirm } from '../../stores/confirmStore';
import { Button, Divider, EmptyState, ErrorBanner, Input, Well } from '../ui';
import { Skeleton } from '../ui/Skeleton';
import { SectionHeader, FieldLabel, GroupLabel, GateNotice } from './SettingsPrimitives';

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
  const overQuota = usagePercent >= 90;
  // §9: colour is never the only cue — the numbers and the sentence below carry
  // the same reading the meter does.
  const meterTone = overQuota
    ? 'bg-accent-danger'
    : usagePercent >= 75
      ? 'bg-accent-warning'
      : 'bg-accent-primary';

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="File storage"
        description="Track how much storage this building is using and set the rules for what members can upload."
      />

      {error && <ErrorBanner message={error} multiline />}

      {loading ? (
        <div className="flex flex-col gap-4">
          <Skeleton height={96} borderRadius="var(--radius-well)" />
          <Skeleton height={44} borderRadius="var(--radius-control)" />
          <Skeleton height={44} borderRadius="var(--radius-control)" />
        </div>
      ) : (
        <>
          {/* Storage usage — a recessed readout, never a second plate. */}
          <Well as="section" bare className="px-5 py-4">
            <div className="flex items-baseline justify-between gap-3">
              <GroupLabel>Storage used</GroupLabel>
              <span className="pc-mono text-meta text-text-muted">
                {quota != null ? `${usagePercent.toFixed(1)}%` : 'no quota set'}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="pc-mono text-title text-text-primary">{formatBytes(usage)}</span>
              {quota != null && (
                <span className="pc-mono text-meta text-text-muted">/ {formatBytes(quota)}</span>
              )}
            </div>
            {quota != null && quota > 0 && (
              <div
                className="mt-3 h-2.5 w-full overflow-hidden rounded-[var(--radius-full)] bg-bg-mod-strong"
                role="progressbar"
                aria-valuenow={Math.round(usagePercent)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`${formatBytes(usage)} of ${formatBytes(quota)} used`}
              >
                <div
                  className={`h-full rounded-[var(--radius-full)] transition-[width] duration-[var(--duration-normal)] ${meterTone}`}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>
            )}
            {overQuota && (
              <p className="mt-2.5 text-meta leading-relaxed text-accent-danger">
                This building is nearly out of storage. Delete files or raise the quota to keep uploads flowing.
              </p>
            )}
          </Well>

          <Divider />

          {/* Policy */}
          {canManage ? (
            <section>
              <GroupLabel>Upload policy</GroupLabel>
              <div className="mt-4 grid gap-5 sm:grid-cols-3">
                <label className="block">
                  <FieldLabel>Max file size (MB)</FieldLabel>
                  <Input
                    type="number"
                    min="0"
                    value={maxFileSizeMB}
                    onChange={(e) => setMaxFileSizeMB(e.target.value)}
                    className="pc-mono"
                    placeholder="No limit"
                  />
                </label>
                <label className="block">
                  <FieldLabel>Storage quota (MB)</FieldLabel>
                  <Input
                    type="number"
                    min="0"
                    value={storageQuotaMB}
                    onChange={(e) => setStorageQuotaMB(e.target.value)}
                    className="pc-mono"
                    placeholder="No limit"
                  />
                </label>
                <label className="block">
                  <FieldLabel>Retention (days)</FieldLabel>
                  <Input
                    type="number"
                    min="0"
                    value={retentionDays}
                    onChange={(e) => setRetentionDays(e.target.value)}
                    className="pc-mono"
                    placeholder="Forever"
                  />
                </label>
              </div>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <label className="block">
                    <FieldLabel>Allowed MIME types</FieldLabel>
                    <Input
                      type="text"
                      value={allowedTypes}
                      onChange={(e) => setAllowedTypes(e.target.value)}
                      placeholder="image/png, image/jpeg"
                    />
                  </label>
                  <p className="mt-2 text-meta leading-relaxed text-text-muted">
                    Comma-separated. Empty allows every type.
                  </p>
                </div>
                <div>
                  <label className="block">
                    <FieldLabel>Blocked MIME types</FieldLabel>
                    <Input
                      type="text"
                      value={blockedTypes}
                      onChange={(e) => setBlockedTypes(e.target.value)}
                      placeholder="application/x-msdownload"
                    />
                  </label>
                  <p className="mt-2 text-meta leading-relaxed text-text-muted">
                    Blocked types always win over allowed.
                  </p>
                </div>
              </div>
              <div className="mt-5">
                <Button variant="primary" onClick={() => void savePolicy()} loading={saving} disabled={saving}>
                  Save policy
                </Button>
              </div>
            </section>
          ) : (
            <section>
              <GateNotice>Only members with server-management permission can change the upload policy.</GateNotice>
            </section>
          )}

          <Divider />

          {/* File browser */}
          <section>
            <div className="flex items-center justify-between gap-3">
              <GroupLabel>Uploaded files</GroupLabel>
              {canManage && selectedFileIds.length > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void deleteSelectedFiles()}
                >
                  <Trash2 size={14} />
                  Delete {selectedFileIds.length} selected
                </Button>
              )}
            </div>

            {files.length === 0 ? (
              <EmptyState
                className="!py-8"
                icon={<HardDrive size={20} />}
                title="No files stored yet"
                description="Attachments members share in channels collect here, where you can audit them or delete the ones eating your quota."
              />
            ) : (
              <div className="mt-4">
                <div className="hidden items-center gap-3 px-1 pb-2 text-section text-text-faint sm:flex">
                  {canManage && <span className="w-4" />}
                  <span className="flex-1">Filename</span>
                  <span className="w-24 text-right">Size</span>
                  <span className="w-32 text-right">Uploaded</span>
                </div>
                <Divider className="hidden sm:block" />
                <ul className="divide-y divide-border-subtle">
                  {files.map((file) => (
                    <li
                      key={file.id}
                      className="flex flex-col items-start gap-1.5 px-1 py-2.5 text-label sm:flex-row sm:items-center sm:gap-3"
                    >
                      {canManage && (
                        <input
                          type="checkbox"
                          className="pc-checkbox"
                          checked={selectedFileIds.includes(file.id)}
                          onChange={() => toggleFileSelection(file.id)}
                          aria-label={`Select ${file.filename}`}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-text-primary">{file.filename}</span>
                      {file.content_type && (
                        <span className="hidden pc-mono text-meta text-text-muted sm:inline">{file.content_type}</span>
                      )}
                      <span className="pc-mono text-meta text-text-muted sm:w-24 sm:text-right">
                        {formatBytes(file.size)}
                      </span>
                      <span className="pc-mono text-meta text-text-muted sm:w-32 sm:text-right">
                        {new Date(file.created_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
                {hasMoreFiles && (
                  <div className="mt-4">
                    <Button variant="ghost" size="sm" onClick={() => void loadMoreFiles()}>
                      Load more
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
