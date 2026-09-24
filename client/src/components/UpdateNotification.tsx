import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { ArrowDownToLine, CheckCircle2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { safeExternalUrl } from '../lib/security';
import { isTauri } from '../lib/tauriEnv';
import { Button } from './ui/Button';

const GITHUB_OWNER = (import.meta.env.VITE_GITHUB_OWNER as string | undefined)?.trim() || 'Scoduglas1999';
const GITHUB_REPO = (import.meta.env.VITE_GITHUB_REPO as string | undefined)?.trim() || 'Paracord';
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const DISMISSED_RELEASE_STORAGE_KEY = 'paracord.update.dismissed.release';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded';

interface UpdateTargetInfo {
  /** The updater's name for this OS: windows, linux, darwin. */
  os: string;
  arch: string;
  /** The bundle this build was packaged as (msi, nsis, deb, rpm, appimage, app), or '' when unknown. */
  installer_preference: string;
}

interface AvailableUpdate {
  version: string;
  releaseTag: string;
  htmlUrl: string;
  publishedAt: string | null;
  assetName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed;
}

function normalizeArch(arch: string): string {
  if (arch === 'amd64') return 'x86_64';
  return arch;
}

/**
 * The latest.json keys the updater plugin tries for this build, in its order:
 * `{os}-{arch}-{installer}`, then `{os}-{arch}`.
 *
 * Only used to name the file the toast is about. The plugin chooses the
 * download itself from the bundle the app was packaged as; this used to pass it
 * a key instead, guessed from the executable's path — which inside an AppImage
 * is the mounted binary, never `*.AppImage`, so an AppImage asked for the .deb
 * and would have written the package over itself — and an RPM install asked
 * for the .deb too.
 */
function updaterKeys(targetInfo: UpdateTargetInfo): string[] {
  const base = `${targetInfo.os}-${normalizeArch(targetInfo.arch)}`;
  return targetInfo.installer_preference
    ? [`${base}-${targetInfo.installer_preference}`, base]
    : [base];
}

function fileNameFromUrl(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return name || 'update package';
  } catch {
    const part = url.split('?')[0].split('/').pop() ?? '';
    return part || 'update package';
  }
}

function releaseUrl(tag: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag}`;
}

function readAssetUrl(rawJson: Record<string, unknown>, keys: string[]): string | null {
  const platforms = rawJson.platforms;
  if (isRecord(platforms)) {
    for (const key of keys) {
      const platformEntry = platforms[key];
      if (isRecord(platformEntry) && typeof platformEntry.url === 'string') {
        return platformEntry.url;
      }
    }
  }

  if (typeof rawJson.url === 'string') {
    return rawJson.url;
  }

  return null;
}

function extractUpdateInfo(update: Update, keys: string[]): AvailableUpdate {
  const rawJson = isRecord(update.rawJson) ? update.rawJson : {};
  const version = normalizeVersion(update.version);
  const releaseTag =
    typeof rawJson.tag_name === 'string' && rawJson.tag_name.length > 0
      ? rawJson.tag_name
      : `v${version}`;
  const rawHtmlUrl =
    typeof rawJson.html_url === 'string' && rawJson.html_url.length > 0
      ? rawJson.html_url
      : releaseUrl(releaseTag);
  const htmlUrl = safeExternalUrl(rawHtmlUrl) ?? releaseUrl(releaseTag);
  const publishedAt =
    typeof rawJson.pub_date === 'string'
      ? rawJson.pub_date
      : typeof rawJson.published_at === 'string'
        ? rawJson.published_at
        : update.date ?? null;
  const assetUrl = readAssetUrl(rawJson, keys);
  const assetName = assetUrl ? fileNameFromUrl(assetUrl) : `Paracord ${version} update`;

  return {
    version,
    releaseTag,
    htmlUrl,
    publishedAt,
    assetName,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unexpected error.';
  }
}

export function UpdateNotification() {
  const runningInTauri = useMemo(() => isTauri(), []);
  const activeUpdateRef = useRef<Update | null>(null);
  const statusRef = useRef<UpdateStatus>('idle');
  const visibleRef = useRef(false);

  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const closeActiveUpdate = useCallback(async () => {
    const active = activeUpdateRef.current;
    activeUpdateRef.current = null;
    if (!active) return;
    try {
      await active.close();
    } catch {
      // no-op
    }
  }, []);

  const setActiveUpdate = useCallback(async (next: Update) => {
    const prev = activeUpdateRef.current;
    activeUpdateRef.current = next;
    if (!prev || prev === next) return;
    try {
      await prev.close();
    } catch {
      // no-op
    }
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (!runningInTauri) return;
    if (statusRef.current === 'downloading') return;
    if (statusRef.current === 'downloaded') {
      if (!visibleRef.current) setVisible(true);
      return;
    }

    setStatus('checking');
    setErrorText(null);

    try {
      const targetInfo = await invoke<UpdateTargetInfo>('get_update_target');
      const update = await check({ timeout: 15_000 });

      if (!update) {
        await closeActiveUpdate();
        setStatus('idle');
        setVisible(false);
        setUpdateInfo(null);
        return;
      }

      const info = extractUpdateInfo(update, updaterKeys(targetInfo));
      const dismissedRelease = window.localStorage.getItem(DISMISSED_RELEASE_STORAGE_KEY);
      if (dismissedRelease === info.releaseTag) {
        await closeActiveUpdate();
        setStatus('idle');
        setVisible(false);
        setUpdateInfo(null);
        return;
      }

      await setActiveUpdate(update);
      setUpdateInfo(info);
      setStatus('available');
      setVisible(true);
    } catch (error) {
      setStatus('idle');
      const message = getErrorMessage(error);
      setErrorText(message);
      // Update checks run automatically on launch and on an interval. On an
      // offline machine or a self-hosted/dev build with no update feed they
      // fail routinely, so log for diagnostics instead of nagging the user
      // with a toast on every failed background check.
      if (import.meta.env.DEV) {
        console.warn('Update check failed:', message);
      }
    }
  }, [closeActiveUpdate, runningInTauri, setActiveUpdate]);

  useEffect(() => {
    if (!runningInTauri) return;

    void checkForUpdates();
    const interval = window.setInterval(() => {
      void checkForUpdates();
    }, CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [checkForUpdates, runningInTauri]);

  useEffect(() => {
    return () => {
      void closeActiveUpdate();
    };
  }, [closeActiveUpdate]);

  const onDismiss = useCallback(() => {
    if (status === 'downloaded') {
      setVisible(false);
      return;
    }

    if (updateInfo) {
      window.localStorage.setItem(DISMISSED_RELEASE_STORAGE_KEY, updateInfo.releaseTag);
    }

    setVisible(false);
    setStatus('idle');
    setUpdateInfo(null);
    void closeActiveUpdate();
  }, [closeActiveUpdate, status, updateInfo]);

  const onDownload = useCallback(async () => {
    const update = activeUpdateRef.current;
    if (!update || status === 'downloading') return;

    setStatus('downloading');
    setErrorText(null);

    try {
      await update.download();
      setStatus('downloaded');
      setVisible(true);
    } catch (error) {
      setStatus('available');
      setErrorText(getErrorMessage(error));
    }
  }, [status]);

  const onRestartAndInstall = useCallback(async () => {
    const update = activeUpdateRef.current;
    if (!update) return;

    setErrorText(null);
    try {
      await update.install();
      // Windows never gets here: its installer takes over and closes the app.
      // On Linux and macOS the new version is in place and this one is still
      // running, so start it.
      await invoke('restart_after_update');
    } catch (error) {
      setErrorText(getErrorMessage(error));
    }
  }, []);

  if (!runningInTauri || !visible || !updateInfo) return null;

  const downloaded = status === 'downloaded';
  const StatusIcon = downloaded ? CheckCircle2 : ArrowDownToLine;
  const statusColor = downloaded ? 'var(--accent-success)' : 'var(--accent-info)';

  // Toast recipe (lantern-stage-spec §8): bg-accent surface, hairline border, radius-md,
  // shadow-[var(--shadow-plate)], a leading semantic state icon, --text-label title and --text-meta body.
  return (
    <div
      role="status"
      aria-live="polite"
      className="pc-enter fixed bottom-4 right-4 z-[140] w-[min(24rem,calc(100vw-1.5rem))] rounded-well border border-border-subtle bg-bg-raised p-4 shadow-[var(--shadow-plate)]"
    >
      <div className="flex items-start gap-3">
        <StatusIcon size={18} style={{ color: statusColor, flexShrink: 0, marginTop: '1px' }} />
        <div className="min-w-0 flex-1">
          <div className="text-label text-text-primary">
            {downloaded ? 'Update ready to install' : 'New release available'}
          </div>
          <div className="mt-0.5 text-meta text-text-secondary">
            Paracord {updateInfo.version}
            {updateInfo.publishedAt
              ? ` · ${new Date(updateInfo.publishedAt).toLocaleDateString()}`
              : ''}
          </div>
          <a
            className="mt-1 inline-block rounded-chip text-meta font-medium text-text-link outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:underline focus-visible:shadow-[var(--focus-ring)]"
            href={updateInfo.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            View release notes
          </a>
        </div>
        <button
          className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-chip text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          onClick={onDismiss}
          type="button"
          aria-label="Dismiss update notification"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 truncate font-code text-meta text-text-muted" title={updateInfo.assetName}>
        {downloaded ? `Downloaded ${updateInfo.assetName}` : updateInfo.assetName}
      </div>

      {errorText && (
        <div className="mt-2 rounded-chip bg-danger-tint px-2.5 py-1.5 text-meta text-accent-danger">
          {errorText}
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {downloaded ? (
          <Button size="sm" onClick={onRestartAndInstall}>
            Restart to install
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onDownload}
            loading={status === 'downloading'}
            disabled={status === 'checking' || status === 'downloading'}
          >
            {status === 'downloading' ? 'Downloading…' : 'Download update'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {downloaded ? 'Later' : 'Dismiss'}
        </Button>
      </div>
    </div>
  );
}
