import { useEffect, useRef } from 'react';
import { gateway, LOCAL_SERVER_ID } from '../gateway/manager';
import { isTauri } from '../lib/tauriEnv';
import {
  formatActivityLabel,
  normalizeDetectedAppId,
  readStringArray,
  readableAppName,
  recordKnownActivityApp,
} from '../lib/activityPresence';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Activity, Presence } from '../types';

const POLL_INTERVAL_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

interface ForegroundApplication {
  pid: number;
  process_name: string;
  display_name?: string | null;
  executable_path?: string | null;
  window_title?: string | null;
}

function mapStatusForPresence(status: string | undefined): Presence['status'] {
  if (status === 'idle' || status === 'dnd' || status === 'offline') return status;
  if (status === 'invisible') return 'offline';
  return 'online';
}

function isParacordProcess(app: ForegroundApplication): boolean {
  const signature = `${app.process_name} ${app.executable_path || ''}`.toLowerCase();
  return signature.includes('paracord');
}

function buildActivity(app: ForegroundApplication, startedAt: string, appId: string): Activity {
  const name = (app.display_name || '').trim() || readableAppName(app.process_name);
  const state = app.window_title?.trim() || undefined;
  return {
    name,
    type: 0,
    details: formatActivityLabel({ name, type: 0 }) || undefined,
    state,
    started_at: startedAt,
    application_id: appId,
  };
}

function publishPresence(status: Presence['status'], activities: Activity[]): void {
  const activeConnections = gateway.getAllConnections().filter((conn) => conn.connected);
  if (activeConnections.length > 0) {
    gateway.updatePresenceAll(status, activities);
    for (const conn of activeConnections) {
      const localServerUserId = useServerListStore.getState().getServer(conn.serverId)?.userId
        ?? (conn.serverId === LOCAL_SERVER_ID ? useAuthStore.getState().user?.id : null);
      if (localServerUserId) {
        usePresenceStore.getState().updatePresence({
          user_id: localServerUserId,
          status,
          activities,
        }, conn.serverId);
      }
    }
  } else {
    gateway.updatePresenceAll(status, activities);
  }
}

export function useActivityPresence(options?: { idleTimeoutMs?: number }) {
  const token = useAuthStore((state) => state.token);
  const idleTimeout = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const isIdleRef = useRef(false);
  // Per-hook-instance activity timestamp (avoids a module-level singleton
  // shared across mounts). Updated by user-input listeners below.
  const lastActivityRef = useRef(Date.now());

  // --- Idle detection (works everywhere, including non-Tauri browsers) ---
  useEffect(() => {
    if (!token) return;

    lastActivityRef.current = Date.now();
    isIdleRef.current = false;

    const resetActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const activityEvents: Array<keyof DocumentEventMap> = [
      'mousemove',
      'keydown',
      'mousedown',
      'touchstart',
    ];
    for (const event of activityEvents) {
      document.addEventListener(event, resetActivity, { passive: true });
    }

    const idleTimer = setInterval(() => {
      const settings = useAuthStore.getState().settings;
      const userStatus = settings?.status;

      // Only auto-idle users whose chosen status is 'online'.
      // DND, invisible, and already-idle-by-choice users should not be touched.
      if (userStatus !== 'online') {
        isIdleRef.current = false;
        return;
      }

      const idle = Date.now() - lastActivityRef.current > idleTimeout;

      if (idle && !isIdleRef.current) {
        isIdleRef.current = true;
        publishPresence('idle', []);
      } else if (!idle && isIdleRef.current) {
        isIdleRef.current = false;
        publishPresence('online', []);
      }
    }, IDLE_CHECK_INTERVAL_MS);

    return () => {
      for (const event of activityEvents) {
        document.removeEventListener(event, resetActivity);
      }
      clearInterval(idleTimer);
    };
  }, [token, idleTimeout]);

  // --- Tauri foreground-app activity detection ---
  useEffect(() => {
    if (!token || !isTauri()) return;

    let cancelled = false;
    let inFlight = false;
    let activeAppId: string | null = null;
    let startedAt: string | null = null;
    let lastStatus: Presence['status'] | null = null;
    let lastAppId: string | null = null;
    let lastStartedAt: string | null = null;

    const emit = (status: Presence['status'], activities: Activity[]) => {
      const appId = activities[0]?.application_id ?? null;
      const emittedStartedAt = activities[0]?.started_at ?? null;
      if (status === lastStatus && appId === lastAppId && emittedStartedAt === lastStartedAt) {
        return;
      }
      publishPresence(status, activities);
      lastStatus = status;
      lastAppId = appId;
      lastStartedAt = emittedStartedAt;
    };

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        const settings = useAuthStore.getState().settings;
        const notifications = (settings?.notifications ?? {}) as Record<string, unknown>;
        const detectionEnabled = notifications['activityDetectionEnabled'] !== false;
        let status = mapStatusForPresence(settings?.status);

        // If the idle detector has flagged the user as idle, override to 'idle'
        if (isIdleRef.current && status === 'online') {
          status = 'idle';
        }

        const nativeCaptureAllowed = detectionEnabled && status !== 'offline';
        await invoke('set_activity_sharing_enabled', { enabled: nativeCaptureAllowed });

        const detected = nativeCaptureAllowed
          ? await invoke<ForegroundApplication | null>('get_foreground_application')
          : null;
        if (cancelled) return;

        const disabledApps = new Set(
          readStringArray(notifications['activityDetectionDisabledApps']).map(normalizeDetectedAppId)
        );

        const candidate =
          detected && detected.process_name && !isParacordProcess(detected) ? detected : null;
        const appId = candidate ? normalizeDetectedAppId(candidate.process_name) : '';

        if (appId) {
          recordKnownActivityApp(appId);
        }

        const shouldHideActivity =
          !detectionEnabled || status === 'offline' || !candidate || disabledApps.has(appId);
        if (shouldHideActivity) {
          activeAppId = null;
          startedAt = null;
          emit(status, []);
          return;
        }

        if (activeAppId !== appId || !startedAt) {
          activeAppId = appId;
          startedAt = new Date().toISOString();
        }

        emit(status, [buildActivity(candidate, startedAt, appId)]);
      } catch {
        // Ignore foreground detection failures and keep last known state.
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    void tick();

    return () => {
      cancelled = true;
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('set_activity_sharing_enabled', { enabled: false }))
        .catch(() => undefined);
      window.clearInterval(timer);
    };
  }, [token]);
}


