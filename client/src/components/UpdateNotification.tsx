import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { safeExternalUrl } from '../lib/security';
import { isTauri } from '../lib/tauriEnv';
import { BannerStrip } from './ix/conversation/BannerStrip';

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
  const downloading = status === 'downloading';

  // A banner strip (docs/index-spec.md §6.8): the words, one text action ("Restart to update"), and a way
  // to put it away. An update that failed says so in the danger ink and keeps its action. The release notes
  // stay one click away as a link, not a second action.
  return (
    <BannerStrip
      data-testid="ix-banner-update"
      tone={errorText ? 'danger' : 'plain'}
      action={
        downloaded
          ? { label: 'Restart to update', onPress: () => void onRestartAndInstall() }
          : { label: downloading ? 'Downloading…' : 'Download update', onPress: () => void onDownload(), disabled: status === 'checking' || downloading }
      }
      onDismiss={onDismiss}
      dismissLabel={downloaded ? 'Update later' : 'Dismiss update notice'}
    >
      {errorText
        ? `The update did not finish: ${errorText}`
        : downloaded
          ? `Paracord ${updateInfo.version} is ready to install.`
          : `Paracord ${updateInfo.version} is available.`}{' '}
      <a className="ix-banner-strip__link" href={updateInfo.htmlUrl} target="_blank" rel="noreferrer">
        Release notes
      </a>
    </BannerStrip>
  );
}
