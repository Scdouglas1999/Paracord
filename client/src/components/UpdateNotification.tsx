import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { safeExternalUrl } from '../lib/security';
import { isTauri } from '../lib/tauriEnv';

const GITHUB_OWNER = (import.meta.env.VITE_GITHUB_OWNER as string | undefined)?.trim() || 'Scoduglas1999';
const GITHUB_REPO = (import.meta.env.VITE_GITHUB_REPO as string | undefined)?.trim() || 'Paracord';
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const DISMISSED_RELEASE_STORAGE_KEY = 'paracord.update.dismissed.release';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded';

interface UpdateTargetInfo {
  os: string;
  arch: string;
  installer_preference: string;
}

interface AvailableUpdate {
  version: string;
  releaseTag: string;
  htmlUrl: string;
  publishedAt: string | null;
  assetName: string;
  target: string | null;
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

function buildUpdaterTarget(targetInfo: UpdateTargetInfo): string | null {
  const arch = normalizeArch(targetInfo.arch);

  if (targetInfo.os === 'windows') {
    return `windows-${arch}`;
  }

  if (targetInfo.os === 'linux') {
    if (targetInfo.installer_preference === 'appimage') {
      return `linux-${arch}-appimage`;
    }
    return `linux-${arch}-deb`;
  }

  return null;
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

function readAssetUrl(rawJson: Record<string, unknown>, target: string | null): string | null {
  if (target) {
    const platforms = rawJson.platforms;
    if (isRecord(platforms)) {
      const platformEntry = platforms[target];
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

function extractUpdateInfo(update: Update, target: string | null): AvailableUpdate {
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
  const assetUrl = readAssetUrl(rawJson, target);
  const assetName = assetUrl ? fileNameFromUrl(assetUrl) : `Paracord ${version} update`;

  return {
    version,
    releaseTag,
    htmlUrl,
    publishedAt,
    assetName,
    target,
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
      const target = buildUpdaterTarget(targetInfo);
      const update = await check(target ? { target, timeout: 15_000 } : { timeout: 15_000 });

      if (!update) {
        await closeActiveUpdate();
        setStatus('idle');
        setVisible(false);
        setUpdateInfo(null);
        return;
      }

      const info = extractUpdateInfo(update, target);
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
      setErrorText(getErrorMessage(error));
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
    } catch (error) {
      setErrorText(getErrorMessage(error));
    }
  }, []);

  if (!runningInTauri || !visible || !updateInfo) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[140] w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-border-subtle bg-[color:var(--bg-floating)] p-3 shadow-xl backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">New release available</div>
          <div className="mt-1 text-xs text-text-secondary">
            Paracord {updateInfo.version}
            {updateInfo.publishedAt ? ` - ${new Date(updateInfo.publishedAt).toLocaleDateString()}` : ''}
          </div>
          <a
            className="mt-1 inline-block text-xs text-text-link hover:underline"
            href={updateInfo.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            View release notes
          </a>
        </div>
        <button
          className="icon-btn !h-7 !w-7 shrink-0 text-text-muted hover:text-text-primary"
          onClick={onDismiss}
          type="button"
          aria-label="Dismiss update notification"
        >
          x
        </button>
      </div>

      <div className="mt-3 text-xs text-text-muted">
        {status === 'downloaded' ? `Downloaded ${updateInfo.assetName}` : updateInfo.assetName}
      </div>

      {errorText && <div className="mt-2 text-xs text-accent-danger">{errorText}</div>}

      <div className="mt-3 flex flex-wrap gap-2">
        {status === 'downloaded' ? (
          <button className="btn-primary !min-h-9 !px-3 !text-sm" onClick={onRestartAndInstall} type="button">
            Restart to install
          </button>
        ) : (
          <button
            className="btn-primary !min-h-9 !px-3 !text-sm"
            onClick={onDownload}
            type="button"
            disabled={status === 'checking' || status === 'downloading'}
          >
            {status === 'downloading' ? 'Downloading...' : 'Download update'}
          </button>
        )}
        <button className="btn-ghost !min-h-9 !px-3 !text-sm" onClick={onDismiss} type="button">
          {status === 'downloaded' ? 'Later' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}
