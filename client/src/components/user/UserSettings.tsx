import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useAccountStore } from '../../stores/accountStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useMediaDevices } from '../../hooks/useMediaDevices';
import { useMobile } from '../../hooks/useMobile';
import { APP_NAME } from '../../lib/constants';
import { hasAccount as hasLocalCryptoAccount } from '../../lib/account';
import { isAdmin } from '../../types';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { authApi, type AuthSession } from '../../api/auth';
import { cn } from '../../lib/utils';
import { confirm } from '../../stores/confirmStore';
import { ErrorBanner } from '../ui/Feedback';
import { Button } from '../ui/Button';
import {
  isEnabled as isNotificationsEnabled,
  setEnabled as setNotificationsEnabled,
  isPermissionGranted as checkNotificationPermission,
  requestPermission as requestNotificationPermission,
} from '../../lib/notifications';
import {
  getKnownActivityAppsFromStorage,
  normalizeDetectedAppId,
  readStringArray,
  readableAppName,
  saveKnownActivityAppsToStorage,
} from '../../lib/activityPresence';
import { formatIdentityFingerprint } from '../../lib/keyVerification';
import { safeExternalUrl } from '../../lib/security';
import { CustomCSS } from '../customization/CustomCSS';
import { ThemeSelector } from '../customization/ThemeSelector';

interface UserSettingsProps {
  onClose: () => void;
}

type SettingsSection =
  | 'account'
  | 'appearance'
  | 'voice'
  | 'notifications'
  | 'activity'
  | 'keybinds'
  | 'identity'
  | 'about'
  | 'server';

const NAV_ITEMS: { id: SettingsSection; label: string; adminOnly?: boolean }[] = [
  { id: 'account', label: 'My Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'voice', label: 'Voice & Video' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'activity', label: 'Activity Privacy' },
  { id: 'keybinds', label: 'Keybinds' },
  { id: 'identity', label: 'Identity' },
  { id: 'server', label: 'Server', adminOnly: true },
  { id: 'about', label: 'About' },
];

export function UserSettings({ onClose }: UserSettingsProps) {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<SettingsSection>('account');
  const [mobileShowNav, setMobileShowNav] = useState(true);
  const user = useAuthStore(s => s.user);
  const settings = useAuthStore(s => s.settings);
  const logout = useAuthStore(s => s.logout);
  const fetchUser = useAuthStore(s => s.fetchUser);
  const fetchSettings = useAuthStore(s => s.fetchSettings);
  const updateSettings = useAuthStore(s => s.updateSettings);
  const updateUser = useAuthStore(s => s.updateUser);
  const accountPublicKey = useAccountStore((s) => s.publicKey);
  const accountUnlocked = useAccountStore((s) => s.isUnlocked);
  const setThemeUI = useUIStore((s) => s.setTheme);
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const setLowBandwidthModeUI = useUIStore((s) => s.setLowBandwidthMode);
  const customCss = useUIStore((s) => s.customCss);
  const setCustomCss = useUIStore((s) => s.setCustomCss);
  const [theme, setTheme] = useState<'dark' | 'light' | 'amoled' | 'high-contrast'>('dark');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [linkedAccountsInput, setLinkedAccountsInput] = useState('');
  const [locale, setLocale] = useState('en-US');
  const [messageCompact, setMessageCompact] = useState(false);
  const [notifications, setNotifications] = useState<Record<string, unknown>>({});
  const [knownActivityApps, setKnownActivityApps] = useState<string[]>([]);
  const [keybinds, setKeybinds] = useState<Record<string, unknown>>({});
  const [capturingKeybind, setCapturingKeybind] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'success' | 'error' | null>(null);
  const cryptoAuthEnabled = settings?.crypto_auth_enabled === true;
  const {
    audioInputDevices,
    audioOutputDevices,
    selectedAudioInput,
    selectedAudioOutput,
    selectAudioInput,
    selectAudioOutput,
    enumerate,
  } = useMediaDevices();
  const applyAudioInputDevice = useVoiceStore((s) => s.applyAudioInputDevice);
  const applyAudioOutputDevice = useVoiceStore((s) => s.applyAudioOutputDevice);
  const userIsAdmin = user ? isAdmin(user.flags ?? 0) : false;
  const [restartConfirm, setRestartConfirm] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const localCryptoAccountReady = Boolean(accountPublicKey) || hasLocalCryptoAccount();
  const isMobile = useMobile();
  const [notifEnabled, setNotifEnabled] = useState(() => isNotificationsEnabled());
  const [notifPermission, setNotifPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);
  const [emailCurrentPassword, setEmailCurrentPassword] = useState('');
  const [passwordCurrentPassword, setPasswordCurrentPassword] = useState('');
  const [accountNewPassword, setAccountNewPassword] = useState('');
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('');
  const [accountNewEmail, setAccountNewEmail] = useState('');
  const [accountActionLoading, setAccountActionLoading] = useState(false);
  const [accountDataExporting, setAccountDataExporting] = useState(false);

  // MFA state
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaBackupCodesRemaining, setMfaBackupCodesRemaining] = useState(0);
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; otpauth_url: string; qr_code: string } | null>(null);
  const [mfaVerifyCode, setMfaVerifyCode] = useState('');
  const [mfaDisableCode, setMfaDisableCode] = useState('');
  const [mfaBackupCodes, setMfaBackupCodes] = useState<string[]>([]);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaView, setMfaView] = useState<'idle' | 'setup' | 'disable'>('idle');
  const [mfaStatus, setMfaStatus] = useState<string | null>(null);

  // Identity portability state
  const [exportIncludeMessages, setExportIncludeMessages] = useState(false);
  const [exportIncludeRelationships, setExportIncludeRelationships] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<Record<string, unknown> | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);

  const clearStatus = useCallback(() => {
    setStatusText(null);
    setStatusKind(null);
  }, []);

  const setSuccessStatus = useCallback((message: string) => {
    setStatusText(message);
    setStatusKind('success');
  }, []);

  const setErrorStatus = useCallback((message: string) => {
    setStatusText(message);
    setStatusKind('error');
  }, []);

  useEffect(() => {
    void checkNotificationPermission().then((granted) => {
      setNotifPermission(granted ? 'granted' : 'denied');
    });
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, []);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name || '');
      setBio(user.bio || '');
      setPronouns(user.pronouns || '');
      const linked = Array.isArray(user.linked_accounts)
        ? user.linked_accounts
            .filter(
              (entry): entry is { label: string; url: string } =>
                Boolean(
                  entry &&
                    typeof entry.label === 'string' &&
                    entry.label.trim().length > 0 &&
                    typeof entry.url === 'string' &&
                    entry.url.trim().length > 0
                )
            )
            .map((entry) => `${entry.label}|${entry.url}`)
            .join('\n')
        : '';
      setLinkedAccountsInput(linked);
      setAccountNewEmail(user.email || '');
    }
  }, [user?.id, user?.display_name, user?.bio, user?.pronouns, user?.linked_accounts, user?.email]);

  useEffect(() => {
    if (settings) {
      const notif = settings.notifications as Record<string, unknown> | undefined;
      const knownFromSettings = readStringArray(notif?.['activityDetectionKnownApps']).map(
        normalizeDetectedAppId
      );
      const knownFromStorage = getKnownActivityAppsFromStorage().map(normalizeDetectedAppId);
      const known = Array.from(new Set([...knownFromSettings, ...knownFromStorage])).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
      );
      const disabledApps = readStringArray(notif?.['activityDetectionDisabledApps']).map(
        normalizeDetectedAppId
      );

      setTheme(settings.theme);
      setLocale(settings.locale || 'en-US');
      setMessageCompact(settings.message_display_compact || false);
      setKnownActivityApps(known);
      setNotifications({
        ...(settings.notifications as Record<string, unknown>),
        activityDetectionEnabled: notif?.['activityDetectionEnabled'] !== false,
        activityDetectionKnownApps: known,
        activityDetectionDisabledApps: Array.from(new Set(disabledApps)).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' })
        ),
      });
      if (typeof notif?.['profilePronouns'] === 'string') {
        setPronouns((notif['profilePronouns'] as string).trim());
      }
      if (Array.isArray(notif?.['profileLinkedAccounts'])) {
        const linked = (notif['profileLinkedAccounts'] as Array<unknown>)
          .filter(
            (entry): entry is { label: string; url: string } =>
              Boolean(
                entry &&
                  typeof entry === 'object' &&
                  entry !== null &&
                  typeof (entry as Record<string, unknown>).label === 'string' &&
                  typeof (entry as Record<string, unknown>).url === 'string'
              )
          )
          .map((entry) => `${entry.label}|${entry.url}`)
          .join('\n');
        setLinkedAccountsInput(linked);
      }
      setLowBandwidthModeUI(notif?.['lowBandwidthMode'] === true);
      setKeybinds((settings.keybinds as Record<string, unknown>) || {});
      if (typeof notif?.['audioInputDeviceId'] === 'string') {
        selectAudioInput(notif['audioInputDeviceId'] as string);
      }
      if (typeof notif?.['audioOutputDeviceId'] === 'string') {
        selectAudioOutput(notif['audioOutputDeviceId'] as string);
      }
    }
  }, [settings, setLowBandwidthModeUI]);

  useEffect(() => {
    if (activeSection !== 'voice') return;
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return enumerate();
      })
      .catch(() => {
        /* ignore permission denial */
      });
  }, [activeSection, enumerate]);

  const selectMobileSection = useCallback((section: SettingsSection) => {
    setActiveSection(section);
    setMobileShowNav(false);
    history.pushState({ settingsSection: section }, '');
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const handlePopState = (e: PopStateEvent) => {
      if (mobileShowNav) {
        // Already showing nav list — let browser handle (close settings via parent)
        onClose();
      } else {
        // Navigate back to nav list
        e.preventDefault?.();
        setMobileShowNav(true);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isMobile, mobileShowNav, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (capturingKeybind) {
      e.preventDefault();
      e.stopPropagation();
      setCapturingKeybind(null);
      return;
    }
    onClose();
  };

  const handleThemeChange = (newTheme: 'dark' | 'light' | 'amoled' | 'high-contrast') => {
    setTheme(newTheme);
    setThemeUI(newTheme);
  };

  const mergedNotifications = useMemo<Record<string, unknown>>(
    () => ({
      desktop: true,
      messageSound: true,
      lowBandwidthMode,
      ...notifications,
    }),
    [notifications, lowBandwidthMode]
  );

  const mergedKeybinds = useMemo<Record<string, unknown>>(
    () => ({
      toggleMute: 'Ctrl+Shift+M',
      toggleDeafen: 'Ctrl+Shift+D',
      pushToTalk: 'Not set',
      ...keybinds,
    }),
    [keybinds]
  );

  const activityDetectionEnabled = mergedNotifications['activityDetectionEnabled'] !== false;
  const ownIdentityFingerprint = useMemo(() => {
    const key = (user?.public_key || accountPublicKey || '').trim();
    if (!key) return null;
    return formatIdentityFingerprint(key);
  }, [accountPublicKey, user?.public_key]);
  const disabledActivityApps = useMemo(
    () =>
      new Set(
        readStringArray(mergedNotifications['activityDetectionDisabledApps']).map(
          normalizeDetectedAppId
        )
      ),
    [mergedNotifications]
  );
  const visibleKnownActivityApps = useMemo(() => {
    const knownFromNotifications = readStringArray(
      mergedNotifications['activityDetectionKnownApps']
    ).map(normalizeDetectedAppId);
    return Array.from(new Set([...knownActivityApps, ...knownFromNotifications])).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }, [knownActivityApps, mergedNotifications]);

  useEffect(() => {
    if (activeSection !== 'activity') return;
    const syncDetectedApps = () => {
      const latest = getKnownActivityAppsFromStorage().map(normalizeDetectedAppId);
      const merged = Array.from(new Set([...latest, ...visibleKnownActivityApps])).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
      );
      setKnownActivityApps((prev) => {
        if (prev.length === merged.length && prev.every((value, index) => value === merged[index])) {
          return prev;
        }
        return merged;
      });
    };

    syncDetectedApps();
    const timer = window.setInterval(syncDetectedApps, 2000);
    return () => window.clearInterval(timer);
  }, [activeSection, visibleKnownActivityApps]);

  const saveProfile = async () => {
    const linkedAccounts = linkedAccountsInput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const splitAt = line.indexOf('|');
        if (splitAt <= 0 || splitAt === line.length - 1) return null;
        const label = line.slice(0, splitAt).trim();
        const url = line.slice(splitAt + 1).trim();
        if (!label || !url) return null;
        const safeUrl = safeExternalUrl(url);
        if (!safeUrl) return null;
        return { label, url: safeUrl };
      });
    if (linkedAccounts.some((entry) => entry === null)) {
      setErrorStatus('Linked accounts must use the format "Label|https://url".');
      return;
    }
    const parsedLinkedAccounts = linkedAccounts.filter(
      (entry): entry is { label: string; url: string } => entry !== null
    );
    if (parsedLinkedAccounts.length > 8) {
      setErrorStatus('You can add up to 8 linked accounts.');
      return;
    }

    setSaving(true);
    clearStatus();
    try {
      await updateUser({
        display_name: displayName || undefined,
        bio: bio || undefined,
      });
      await updateSettings({
        notifications: {
          ...mergedNotifications,
          profilePronouns: pronouns.trim() || null,
          profileLinkedAccounts: parsedLinkedAccounts,
        },
      });
      await fetchUser();
      setSuccessStatus('Profile updated.');
    } catch (err) {
      setErrorStatus(`Failed to update profile: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const { data } = await authApi.listSessions();
      setSessions(data);
    } catch (err) {
      setErrorStatus(`Failed to load sessions: ${extractApiError(err)}`);
    } finally {
      setSessionsLoading(false);
    }
  }, [setErrorStatus]);

  useEffect(() => {
    if (activeSection !== 'account') return;
    void loadSessions();
    void authApi.mfaStatus().then(({ data }) => {
      setMfaEnabled(data.mfa_enabled ?? false);
      setMfaBackupCodesRemaining(data.backup_codes_remaining ?? 0);
    }).catch((err) => {
      setMfaStatus(`Failed to load MFA status: ${extractApiError(err)}`);
    });
  }, [activeSection, loadSessions]);

  const revokeSession = async (sessionId: string) => {
    if (sessionBusyId) return;
    if (!(await confirm({ title: 'Sign out this session?', description: 'This will end the session immediately.', confirmLabel: 'Sign out', variant: 'danger' }))) return;
    setSessionBusyId(sessionId);
    try {
      await authApi.revokeSession(sessionId);
      setSessions((prev) => prev.filter((session) => session.id !== sessionId));
      if (!sessions.find((session) => session.id === sessionId)?.current) {
        setSuccessStatus('Session revoked.');
      }
    } catch (err) {
      setErrorStatus(`Failed to revoke session: ${extractApiError(err)}`);
    } finally {
      setSessionBusyId(null);
    }
  };

  const submitPasswordChange = async () => {
    const current = passwordCurrentPassword.trim();
    const nextPassword = accountNewPassword.trim();
    const confirmPw = accountConfirmPassword.trim();
    if (!current || !nextPassword) {
      setErrorStatus('Current password and new password are required.');
      return;
    }
    if (nextPassword !== confirmPw) {
      setErrorStatus('New password confirmation does not match.');
      return;
    }
    setAccountActionLoading(true);
    try {
      await authApi.changePassword(current, nextPassword);
      setPasswordCurrentPassword('');
      setAccountNewPassword('');
      setAccountConfirmPassword('');
      setSuccessStatus('Password updated. Other sessions were signed out.');
      await loadSessions();
    } catch (err) {
      setErrorStatus(`Failed to change password: ${extractApiError(err)}`);
    } finally {
      setAccountActionLoading(false);
    }
  };

  const submitEmailChange = async () => {
    const current = emailCurrentPassword.trim();
    const nextEmail = accountNewEmail.trim();
    if (!current || !nextEmail) {
      setErrorStatus('Current password and new email are required.');
      return;
    }
    setAccountActionLoading(true);
    try {
      await authApi.changeEmail(current, nextEmail);
      setEmailCurrentPassword('');
      setSuccessStatus('Email updated. Other sessions were signed out.');
      await fetchUser();
      await loadSessions();
    } catch (err) {
      setErrorStatus(`Failed to change email: ${extractApiError(err)}`);
    } finally {
      setAccountActionLoading(false);
    }
  };

  const startMfaSetup = async () => {
    setMfaLoading(true);
    setMfaStatus(null);
    try {
      const { data } = await authApi.mfaSetup();
      setMfaSetupData(data);
      setMfaView('setup');
      setMfaVerifyCode('');
    } catch (err) {
      setMfaStatus(`Failed to start MFA setup: ${extractApiError(err)}`);
    } finally {
      setMfaLoading(false);
    }
  };

  const verifyMfaSetup = async () => {
    if (!mfaVerifyCode.trim()) return;
    setMfaLoading(true);
    setMfaStatus(null);
    try {
      const { data } = await authApi.mfaVerify(mfaVerifyCode.trim());
      setMfaEnabled(true);
      setMfaBackupCodes(data.backup_codes ?? []);
      setMfaBackupCodesRemaining(data.backup_codes?.length ?? 0);
      setMfaView('idle');
      setMfaSetupData(null);
      setMfaVerifyCode('');
      setMfaStatus('Two-factor authentication enabled.');
    } catch (err) {
      setMfaStatus(`Failed to verify MFA setup: ${extractApiError(err)}`);
    } finally {
      setMfaLoading(false);
    }
  };

  const disableMfa = async () => {
    if (!mfaDisableCode.trim()) return;
    setMfaLoading(true);
    setMfaStatus(null);
    try {
      await authApi.mfaDisable(mfaDisableCode.trim());
      setMfaEnabled(false);
      setMfaBackupCodesRemaining(0);
      setMfaBackupCodes([]);
      setMfaView('idle');
      setMfaDisableCode('');
      setMfaStatus('Two-factor authentication disabled.');
    } catch (err) {
      setMfaStatus(`Failed to disable MFA: ${extractApiError(err)}`);
    } finally {
      setMfaLoading(false);
    }
  };

  const downloadAccountData = async () => {
    if (accountDataExporting) return;
    setAccountDataExporting(true);
    try {
      const { data } = await authApi.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `paracord-account-data-${user?.username ?? 'export'}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSuccessStatus('Account data export downloaded.');
    } catch (err) {
      setErrorStatus(`Account export failed: ${extractApiError(err)}`);
    } finally {
      setAccountDataExporting(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    clearStatus();
    try {
      await updateSettings({
        theme,
        locale,
        message_display_compact: messageCompact,
        crypto_auth_enabled: cryptoAuthEnabled,
        notifications: {
          ...mergedNotifications,
          audioInputDeviceId: selectedAudioInput,
          audioOutputDeviceId: selectedAudioOutput,
        },
        keybinds: mergedKeybinds,
      });
      setThemeUI(theme);
      setSuccessStatus('Settings saved.');
    } catch (err) {
      setErrorStatus(`Failed to save settings: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const setActivityDetectionEnabled = (enabled: boolean) => {
    setNotifications((prev) => ({
      ...prev,
      activityDetectionEnabled: enabled,
      activityDetectionKnownApps: visibleKnownActivityApps,
    }));
  };

  const toggleActivityApp = (appId: string) => {
    const normalized = normalizeDetectedAppId(appId);
    setNotifications((prev) => {
      const disabled = new Set(
        readStringArray(prev['activityDetectionDisabledApps']).map(normalizeDetectedAppId)
      );
      if (disabled.has(normalized)) {
        disabled.delete(normalized);
      } else {
        disabled.add(normalized);
      }
      return {
        ...prev,
        activityDetectionKnownApps: visibleKnownActivityApps,
        activityDetectionDisabledApps: Array.from(disabled).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' })
        ),
      };
    });
  };

  const saveActivitySettings = async () => {
    saveKnownActivityAppsToStorage(visibleKnownActivityApps);
    await saveSettings();
  };

  const handleCryptoSecurityToggle = async (enabled: boolean) => {
    if (!localCryptoAccountReady) return;
    setSaving(true);
    try {
      await updateSettings({
        theme,
        locale,
        message_display_compact: messageCompact,
        crypto_auth_enabled: enabled,
        notifications: {
          ...mergedNotifications,
          audioInputDeviceId: selectedAudioInput,
          audioOutputDeviceId: selectedAudioOutput,
        },
        keybinds: mergedKeybinds,
      });
      setSuccessStatus(
        enabled ? 'Device crypto security enabled.' : 'Device crypto security disabled.',
      );
    } catch (err) {
      setErrorStatus(`Failed to update device crypto security: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  // Identity portability handlers
  const handleExportIdentity = useCallback(async () => {
    setExporting(true);
    setIdentityStatus(null);
    try {
      const params = new URLSearchParams();
      if (exportIncludeMessages) params.set('include_messages', 'true');
      const res = await getApi().post<Record<string, unknown>>(
        `/users/@me/export?${params.toString()}`
      );
      const bundle = res.data;
      // If not including relationships, strip them from the download
      if (!exportIncludeRelationships && bundle.relationships) {
        bundle.relationships = [];
      }
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `paracord-identity-${user?.username ?? 'export'}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setIdentityStatus('Identity exported successfully.');
    } catch (err) {
      setIdentityStatus(`Export failed: ${extractApiError(err)}`);
    } finally {
      setExporting(false);
    }
  }, [exportIncludeMessages, exportIncludeRelationships, user?.username]);

  const handleImportFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportPreview(null);
    setIdentityStatus(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as Record<string, unknown>;
        setImportPreview(parsed);
      } catch {
        setIdentityStatus('Failed to parse identity file. Ensure it is valid JSON.');
      }
    };
    reader.readAsText(file);
  }, []);

  const handleImportIdentity = useCallback(async () => {
    if (!importPreview) return;
    setImporting(true);
    setIdentityStatus(null);
    try {
      const res = await getApi().post<Record<string, unknown>>(
        '/users/@me/import',
        importPreview,
      );
      const result = res.data;
      const warnings = (result.warnings as string[]) || [];
      const parts: string[] = [];
      if (result.profile_updated) parts.push('Profile updated');
      if (result.settings_imported) parts.push('Settings imported');
      if (typeof result.messages_imported === 'number' && result.messages_imported > 0)
        parts.push(`${result.messages_imported} messages imported`);
      if (typeof result.prekeys_imported === 'number' && result.prekeys_imported > 0)
        parts.push(`${result.prekeys_imported} encryption keys imported`);
      if (typeof result.attachments_noted === 'number' && result.attachments_noted > 0)
        parts.push(`${result.attachments_noted} attachment records noted`);
      if (typeof result.relationships_found === 'number' && result.relationships_found > 0)
        parts.push(`${result.relationships_found} relationships noted`);
      if (typeof result.guilds_noted === 'number' && result.guilds_noted > 0)
        parts.push(`${result.guilds_noted} guild memberships noted`);
      let msg = parts.length > 0 ? `Import complete: ${parts.join(', ')}.` : 'Import complete.';
      if (warnings.length > 0) {
        msg += ` Warnings: ${warnings.join('; ')}`;
      }
      setIdentityStatus(msg);
      setImportPreview(null);
      setImportFile(null);
    } catch (err) {
      setIdentityStatus(`Import failed: ${extractApiError(err)}`);
    } finally {
      setImporting(false);
    }
  }, [importPreview]);

  return (
    <div
      className={cn(
        'relative h-full min-h-0 overflow-hidden rounded-[1.5rem] border border-border-subtle/70 bg-bg-primary/90 backdrop-blur-sm',
        isMobile ? 'flex flex-col' : 'flex'
      )}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="pointer-events-none absolute -left-20 top-0 h-72 w-72 rounded-full blur-[120px]" style={{ backgroundColor: 'var(--ambient-glow-primary)' }} />
      <div className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full blur-[140px]" style={{ backgroundColor: 'var(--ambient-glow-success)' }} />

      {!isMobile && (
        <div className="absolute right-6 top-6 z-50 flex flex-col items-center gap-1">
          <button
            onClick={onClose}
            className="command-icon-btn rounded-full border border-border-strong bg-bg-secondary/75 hover:bg-bg-mod-subtle"
            aria-label="Close user settings"
            title="Close user settings"
          >
            <X size={18} />
          </button>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Esc</span>
        </div>
      )}

      {isMobile ? (
        mobileShowNav ? (
          <div className="relative z-10 flex flex-1 flex-col overflow-y-auto bg-bg-secondary/70 pt-[calc(var(--safe-top)+0.75rem)]">
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">User Settings</div>
              <button
                onClick={onClose}
                className="command-icon-btn h-9 w-9 rounded-full border border-border-strong bg-bg-secondary/75"
                aria-label="Close user settings"
                title="Close user settings"
              >
                <X size={17} />
              </button>
            </div>
            <div className="flex flex-col px-2 pb-[calc(var(--safe-bottom)+1rem)]">
              {NAV_ITEMS.filter(item => !item.adminOnly || userIsAdmin).map(item => (
                <button
                  key={item.id}
                  onClick={() => selectMobileSection(item.id)}
                  className="flex w-full items-center justify-between rounded-xl px-4 py-3.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-mod-subtle active:bg-bg-mod-strong"
                >
                  {item.label}
                  <ArrowLeft size={14} className="rotate-180 text-text-muted" />
                </button>
              ))}
              <div className="mx-2 my-2 h-px bg-border-subtle" />
              <button
                onClick={() => { onClose(); navigate('/app/developers'); }}
                className="flex w-full items-center justify-between rounded-xl px-4 py-3.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-mod-subtle active:bg-bg-mod-strong"
              >
                Developer Portal
                <ArrowLeft size={14} className="rotate-180 text-text-muted" />
              </button>
              <div className="mx-2 my-2 h-px bg-border-subtle" />
              <button
                onClick={() => { void logout(); onClose(); }}
                className="flex w-full items-center rounded-xl px-4 py-3.5 text-sm font-medium text-accent-danger transition-colors hover:bg-accent-danger/10"
              >
                Log Out
              </button>
            </div>
          </div>
        ) : (
          <div className="relative z-10 flex items-center gap-2 border-b border-border-subtle/70 bg-bg-secondary/70 px-3 pb-2.5 pt-[calc(var(--safe-top)+0.75rem)]">
            <button
              onClick={() => setMobileShowNav(true)}
              className="command-icon-btn h-9 w-9 rounded-full border border-border-strong bg-bg-secondary/75"
              aria-label="Back to settings menu"
            >
              <ArrowLeft size={17} />
            </button>
            <div className="flex-1 text-sm font-semibold text-text-primary">
              {NAV_ITEMS.find(i => i.id === activeSection)?.label ?? activeSection}
            </div>
            <button
              onClick={onClose}
              className="command-icon-btn h-9 w-9 rounded-full border border-border-strong bg-bg-secondary/75"
              aria-label="Close user settings"
              title="Close user settings"
            >
              <X size={17} />
            </button>
          </div>
        )
      ) : (
        <div className="relative z-10 w-72 shrink-0 overflow-y-auto border-r border-border-subtle/70 bg-bg-secondary/65 px-4 py-10">
          <div className="ml-auto w-full max-w-[236px]">
            <button
              onClick={onClose}
              className="group mb-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
            >
              <ArrowLeft size={14} className="transition-transform group-hover:-translate-x-0.5" />
              Back
            </button>
            <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              User Settings
            </div>
            {NAV_ITEMS.filter(item => !item.adminOnly || userIsAdmin).map(item => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`settings-nav-item ${activeSection === item.id ? 'active' : ''}`}
              >
                {item.label}
              </button>
            ))}
            <div className="mx-2 my-2 h-px bg-border-subtle" />
            <button
              onClick={() => { onClose(); navigate('/app/developers'); }}
              className="settings-nav-item"
            >
              Developer Portal
            </button>
            <div className="mx-2 my-2 h-px bg-border-subtle" />
            <button
              onClick={() => { void logout(); onClose(); }}
              className="settings-nav-item"
              style={{ color: 'var(--accent-danger)', borderColor: 'transparent' }}
            >
              Log Out
            </button>
          </div>
        </div>
      )}

      {/* Content area */}
      {(!isMobile || !mobileShowNav) && <div className={cn('relative z-10 flex-1 overflow-y-auto', isMobile ? 'px-3 pb-[calc(var(--safe-bottom)+1rem)] pt-3' : 'px-6 py-8')}>
        <div className="w-full">
          {!isMobile && (
            <nav className="mb-4 flex items-center gap-1.5 text-xs text-text-muted" aria-label="Breadcrumb">
              <span className="font-medium">Settings</span>
              <span aria-hidden>/</span>
              <span className="font-semibold text-text-secondary">
                {NAV_ITEMS.find(i => i.id === activeSection)?.label ?? activeSection}
              </span>
            </nav>
          )}
          {statusText && statusKind === 'error' && (
            <div className="mb-10">
              <ErrorBanner message={statusText} />
            </div>
          )}
          {statusText && statusKind === 'success' && (
            <div
              className="card-surface mb-10 inline-flex max-w-full items-center rounded-xl border border-accent-success/35 bg-accent-success/10 px-4 py-3 text-sm font-medium text-accent-success"
              role="status"
              aria-live="polite"
            >
              {statusText}
            </div>
          )}

          {activeSection === 'account' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)] !p-0 overflow-hidden">
              <div className="p-8 pb-0">
                <h2 className="settings-section-title mb-8">My Account</h2>
              </div>
              <div>
                <div
                  className="h-28"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-primary-hover) 100%)' }}
                />
                <div className="px-8 pb-8">
                  <div className="-mt-9 mb-12 flex items-end">
                    <div
                      className="flex h-20 w-20 items-center justify-center rounded-full border-4 text-2xl font-bold text-white"
                      style={{ backgroundColor: 'var(--accent-primary)', borderColor: 'var(--bg-secondary)' }}
                    >
                      {user?.username?.charAt(0).toUpperCase() || 'U'}
                    </div>
                    <span className="ml-3 text-xl font-bold text-text-primary">
                      {user?.username || 'User'}
                    </span>
                  </div>
                  <div className="card-stack-roomy">
                    <div
                      className="card-surface card-stack-relaxed rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-8"
                    >
                      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Username</div>
                        <div className="text-sm font-medium text-text-primary">{user?.username || 'Unknown'}</div>
                      </div>
                      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Display Name</div>
                        <input className="input-field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                      </div>
                      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Bio</div>
                        <textarea className="input-field resize-none" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
                      </div>
                      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Pronouns</div>
                        <input
                          className="input-field"
                          value={pronouns}
                          onChange={(e) => setPronouns(e.target.value)}
                          placeholder="e.g. they/them"
                        />
                      </div>
                      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Linked Accounts</div>
                        <div className="mb-3 text-xs text-text-muted">
                          One per line in the format <code>Label|https://url</code>.
                        </div>
                        <textarea
                          className="input-field resize-none"
                          rows={4}
                          value={linkedAccountsInput}
                          onChange={(e) => setLinkedAccountsInput(e.target.value)}
                          placeholder={'GitHub|https://github.com/username\nWebsite|https://example.com'}
                        />
                      </div>
                      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Email</div>
                        <div className="text-sm font-medium text-text-primary">
                          {user?.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : '***@***'}
                        </div>
                      </div>
                      <div className="settings-action-row">
                        <Button onClick={() => void saveProfile()} disabled={saving}>
                          {saving ? 'Saving...' : 'Save Profile'}
                        </Button>
                      </div>
                    </div>

                    <div className="card-surface rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-8">
                      <div className="card-stack-relaxed">
                        <div className="text-base font-semibold text-text-primary">Account Security</div>
                        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                            Change Email
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="block">
                              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">New Email</span>
                              <input
                                className="input-field mt-2"
                                type="email"
                                value={accountNewEmail}
                                onChange={(e) => setAccountNewEmail(e.target.value)}
                                autoComplete="email"
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Current Password</span>
                              <input
                                className="input-field mt-2"
                                type="password"
                                value={emailCurrentPassword}
                                onChange={(e) => setEmailCurrentPassword(e.target.value)}
                                autoComplete="current-password"
                              />
                            </label>
                          </div>
                          <div className="settings-action-row">
                            <Button
                              onClick={() => void submitEmailChange()}
                              disabled={accountActionLoading || !emailCurrentPassword.trim() || !accountNewEmail.trim()}
                            >
                              {accountActionLoading ? 'Updating...' : 'Update Email'}
                            </Button>
                          </div>
                        </div>

                        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                            Change Password
                          </div>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <label className="block">
                              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Current</span>
                              <input
                                className="input-field mt-2"
                                type="password"
                                value={passwordCurrentPassword}
                                onChange={(e) => setPasswordCurrentPassword(e.target.value)}
                                autoComplete="current-password"
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">New</span>
                              <input
                                className="input-field mt-2"
                                type="password"
                                value={accountNewPassword}
                                onChange={(e) => setAccountNewPassword(e.target.value)}
                                autoComplete="new-password"
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Confirm</span>
                              <input
                                className="input-field mt-2"
                                type="password"
                                value={accountConfirmPassword}
                                onChange={(e) => setAccountConfirmPassword(e.target.value)}
                                autoComplete="new-password"
                              />
                            </label>
                          </div>
                          <div className="settings-action-row">
                            <Button
                              onClick={() => void submitPasswordChange()}
                              disabled={
                                accountActionLoading ||
                                !passwordCurrentPassword.trim() ||
                                !accountNewPassword.trim() ||
                                !accountConfirmPassword.trim()
                              }
                            >
                              {accountActionLoading ? 'Updating...' : 'Update Password'}
                            </Button>
                          </div>
                        </div>

                        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                                Data Export
                              </div>
                              <div className="mt-1 text-sm text-text-muted">
                                Download a JSON export of your account data.
                              </div>
                            </div>
                            <Button
                              onClick={() => void downloadAccountData()}
                              disabled={accountDataExporting}
                            >
                              {accountDataExporting ? 'Exporting...' : 'Download Data'}
                            </Button>
                          </div>
                        </div>

                        {/* Two-Factor Authentication */}
                        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                                Two-Factor Authentication (2FA)
                              </div>
                              <div className="mt-1 text-sm text-text-muted">
                                {mfaEnabled
                                  ? `Enabled. ${mfaBackupCodesRemaining} backup code${mfaBackupCodesRemaining !== 1 ? 's' : ''} remaining.`
                                  : 'Add an extra layer of security to your account.'}
                              </div>
                            </div>
                            {mfaView === 'idle' && (
                              mfaEnabled ? (
                                <button
                                  className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-1.5 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15 disabled:opacity-60"
                                  onClick={() => { setMfaView('disable'); setMfaStatus(null); }}
                                  disabled={mfaLoading}
                                >
                                  Disable 2FA
                                </button>
                              ) : (
                                <Button
                                  size="sm"
                                  onClick={() => void startMfaSetup()}
                                  disabled={mfaLoading}
                                >
                                  {mfaLoading ? 'Loading...' : 'Enable 2FA'}
                                </Button>
                              )
                            )}
                          </div>

                          {mfaStatus && (
                            <div
                              className={`mb-4 rounded-lg px-4 py-3 text-sm font-medium ${mfaStatus.includes('enabled') || mfaStatus.includes('disabled') ? 'border border-accent-success/35 bg-accent-success/10 text-accent-success' : 'border border-accent-danger/35 bg-accent-danger/10 text-accent-danger'}`}
                              role={mfaStatus.includes('enabled') || mfaStatus.includes('disabled') ? 'status' : 'alert'}
                              aria-live={mfaStatus.includes('enabled') || mfaStatus.includes('disabled') ? 'polite' : 'assertive'}
                            >
                              {mfaStatus}
                            </div>
                          )}

                          {mfaBackupCodes.length > 0 && (
                            <div className="mb-4">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-warning">
                                Save These Backup Codes
                              </div>
                              <div className="rounded-lg border border-border-subtle bg-bg-tertiary/70 p-3 font-mono text-xs text-text-primary">
                                {mfaBackupCodes.map((code) => (
                                  <div key={code}>{code}</div>
                                ))}
                              </div>
                              <div className="mt-2 text-xs text-text-muted">
                                Each code can only be used once. Store them somewhere safe.
                              </div>
                              <button
                                className="mt-2 text-xs font-semibold text-text-link hover:underline"
                                onClick={() => setMfaBackupCodes([])}
                              >
                                I have saved my codes
                              </button>
                            </div>
                          )}

                          {mfaView === 'setup' && mfaSetupData && (
                            <div className="space-y-4">
                              <div className="text-sm text-text-muted">
                                1. Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.), or manually enter the secret.
                              </div>
                              <div className="flex justify-center">
                                <img src={mfaSetupData.qr_code} alt="TOTP QR Code" className="h-40 w-40 rounded-lg" />
                              </div>
                              <div className="rounded-lg border border-border-subtle bg-bg-tertiary/70 p-3 font-mono text-xs text-text-primary break-all">
                                {mfaSetupData.secret}
                              </div>
                              <div className="text-sm text-text-muted">
                                2. Enter the 6-digit code from your authenticator app:
                              </div>
                              <input
                                className="input-field"
                                type="text"
                                aria-label="Authenticator code"
                                inputMode="numeric"
                                maxLength={6}
                                placeholder="000000"
                                value={mfaVerifyCode}
                                onChange={(e) => setMfaVerifyCode(e.target.value.replace(/\D/g, ''))}
                              />
                              <div className="flex gap-3">
                                <Button
                                  onClick={() => void verifyMfaSetup()}
                                  disabled={mfaLoading || mfaVerifyCode.length < 6}
                                >
                                  {mfaLoading ? 'Verifying...' : 'Confirm & Enable'}
                                </Button>
                                <button
                                  className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                                  onClick={() => { setMfaView('idle'); setMfaSetupData(null); setMfaVerifyCode(''); setMfaStatus(null); }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}

                          {mfaView === 'disable' && (
                            <div className="space-y-4">
                              <div className="text-sm text-text-muted">
                                Enter your current TOTP code or a backup code to disable 2FA:
                              </div>
                              <input
                                className="input-field"
                                type="text"
                                aria-label="Current TOTP or backup code"
                                placeholder="6-digit code or backup code"
                                value={mfaDisableCode}
                                onChange={(e) => setMfaDisableCode(e.target.value)}
                              />
                              <div className="flex gap-3">
                                <button
                                  className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-4 py-2 text-sm font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15 disabled:opacity-60"
                                  onClick={() => void disableMfa()}
                                  disabled={mfaLoading || !mfaDisableCode.trim()}
                                >
                                  {mfaLoading ? 'Disabling...' : 'Disable 2FA'}
                                </button>
                                <button
                                  className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                                  onClick={() => { setMfaView('idle'); setMfaDisableCode(''); setMfaStatus(null); }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                            <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                              Active Sessions
                            </div>
                            <button
                              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                              onClick={() => void loadSessions()}
                              disabled={sessionsLoading}
                            >
                              {sessionsLoading ? 'Refreshing...' : 'Refresh'}
                            </button>
                          </div>
                          <div className="space-y-2.5">
                            {sessions.map((session) => (
                              <div
                                key={session.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-tertiary/70 px-3 py-2.5"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium text-text-primary">
                                      {session.user_agent || session.device_id || 'Unknown device'}
                                    </span>
                                    {session.current && (
                                      <span className="rounded-full border border-accent-success/35 bg-accent-success/12 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent-success">
                                        Current
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 text-xs text-text-muted">
                                    {session.ip_address || 'No IP'} - Last seen {new Date(session.last_seen_at).toLocaleString()}
                                  </div>
                                </div>
                                <button
                                  className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-2.5 py-1.5 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15 disabled:opacity-60"
                                  onClick={() => void revokeSession(session.id)}
                                  disabled={sessionBusyId === session.id}
                                >
                                  {sessionBusyId === session.id ? 'Revoking...' : 'Revoke'}
                                </button>
                              </div>
                            ))}
                            {!sessionsLoading && sessions.length === 0 && (
                              <div className="rounded-lg border border-border-subtle bg-bg-tertiary/70 px-3 py-2.5 text-sm text-text-muted">
                                No active sessions found.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="card-surface rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-4 sm:p-5">
                      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        <div className="card-surface min-h-[5.25rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/80 px-6 py-5">
                          <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Theme</div>
                          <div className="mt-1 text-base font-semibold text-text-primary">{theme.toUpperCase()}</div>
                        </div>
                        <div className="card-surface min-h-[5.25rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/80 px-6 py-5">
                          <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Locale</div>
                          <div className="mt-1 text-base font-semibold text-text-primary">{locale}</div>
                        </div>
                        <div className="card-surface min-h-[5.25rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/80 px-6 py-5">
                          <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Message Density</div>
                          <div className="mt-1 text-base font-semibold text-text-primary">
                            {messageCompact ? 'Compact' : 'Comfortable'}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="card-surface rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-8">
                      <div className="card-stack-relaxed">
                        <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                              Device Crypto Security (Optional)
                            </div>
                            <div className="mt-1 text-sm text-text-muted">
                              When enabled, this account can use local key unlock and challenge-response sign-in.
                            </div>
                          </div>
                          <ToggleSwitch
                            on={cryptoAuthEnabled}
                            onToggle={() => handleCryptoSecurityToggle(!cryptoAuthEnabled)}
                            disabled={!localCryptoAccountReady || saving}
                          />
                        </div>

                        {!localCryptoAccountReady && (
                          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                            <div className="text-sm text-text-muted">
                              You have not set up a local crypto identity for this account yet.
                            </div>
                            <div className="settings-action-row">
                              <Button
                                onClick={() => {
                                  onClose();
                                  navigate('/setup?migrate=1');
                                }}
                              >
                                Set Up Local Identity
                              </Button>
                            </div>
                          </div>
                        )}

                        {localCryptoAccountReady && (
                          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6 text-sm">
                            {cryptoAuthEnabled ? (
                              <span className="text-text-primary">
                                Security mode is enabled. {accountUnlocked ? 'Identity is currently unlocked.' : 'Identity is currently locked.'}
                              </span>
                            ) : (
                              <span className="text-text-muted">
                                Security mode is disabled. This account signs in with username/password only.
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">Appearance</h2>
              <div className="mb-8">
                <ThemeSelector
                  currentTheme={theme}
                  onThemeChange={(t) => handleThemeChange(t)}
                />
              </div>
              <div className="card-stack-relaxed">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Locale</span>
                  <input className="input-field mt-3" value={locale} onChange={(e) => setLocale(e.target.value)} />
                </label>
                <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Compact Message Display</div>
                  </div>
                  <ToggleSwitch on={messageCompact} onToggle={() => setMessageCompact(!messageCompact)} />
                </div>
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                  <CustomCSS
                    initialCSS={customCss}
                    onSave={(css) => setCustomCss(css)}
                  />
                </div>
              </div>
              <div className="settings-action-row">
                <Button onClick={() => void saveSettings()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Appearance'}
                </Button>
              </div>
            </div>
          )}

          {activeSection === 'voice' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">Voice & Video</h2>
              <div className="card-stack">
                <label className="card-surface block rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Input Device</span>
                  <select
                    className="select-field mt-3"
                    value={selectedAudioInput || ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      selectAudioInput(value);
                      void applyAudioInputDevice(value || null);
                    }}
                  >
                    <option value="">Default</option>
                    {audioInputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="card-surface block rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Output Device</span>
                  <select
                    className="select-field mt-3"
                    value={selectedAudioOutput || ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      selectAudioOutput(value);
                      void applyAudioOutputDevice(value || null);
                    }}
                  >
                    <option value="">Default</option>
                    {audioOutputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Speaker ${device.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/55 px-6 py-5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Input Mode</span>
                  <div className="mt-3 flex gap-2">
                    {(['voice_activity', 'push_to_talk'] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setNotifications((prev) => ({ ...prev, voiceInputMode: mode }))}
                        className={cn(
                          'flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                          (mergedNotifications['voiceInputMode'] ?? 'voice_activity') === mode
                            ? 'border-accent-primary bg-accent-primary/10 text-accent-primary'
                            : 'border-border-subtle bg-bg-primary text-text-secondary hover:border-border-strong hover:text-text-primary'
                        )}
                      >
                        {mode === 'voice_activity' ? 'Voice Activity' : 'Push to Talk'}
                      </button>
                    ))}
                  </div>
                  {(mergedNotifications['voiceInputMode'] ?? 'voice_activity') === 'push_to_talk' && (
                    <p className="mt-2 text-xs text-text-muted">
                      Set your Push to Talk key in the Keybinds section. You will be muted by default — hold the key to speak.
                    </p>
                  )}
                </div>
                <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Noise Suppression</div>
                    <div className="text-xs text-text-muted">Reduces background noise</div>
                  </div>
                  <ToggleSwitch
                    on={Boolean(mergedNotifications['noiseSuppression'] ?? true)}
                    onToggle={() => setNotifications((prev) => ({ ...prev, noiseSuppression: !Boolean(prev['noiseSuppression'] ?? true) }))}
                  />
                </div>
                <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Echo Cancellation</div>
                    <div className="text-xs text-text-muted">Reduces echo from speakers</div>
                  </div>
                  <ToggleSwitch
                    on={Boolean(mergedNotifications['echoCancellation'] ?? true)}
                    onToggle={() => setNotifications((prev) => ({ ...prev, echoCancellation: !Boolean(prev['echoCancellation'] ?? true) }))}
                  />
                </div>
                <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Automatic Gain Control</div>
                    <div className="text-xs text-text-muted">Normalizes mic volume (can add noise on some setups)</div>
                  </div>
                  <ToggleSwitch
                    on={Boolean(mergedNotifications['autoGainControl'] ?? false)}
                    onToggle={() => setNotifications((prev) => ({ ...prev, autoGainControl: !Boolean(prev['autoGainControl'] ?? false) }))}
                  />
                </div>
              </div>
              <div className="settings-action-row">
                <Button onClick={() => {
                  void saveSettings().then(() => {
                    // Re-acquire the microphone with updated noise suppression /
                    // echo cancellation / auto gain constraints so changes take effect
                    // immediately without requiring a mute/unmute cycle.
                    void useVoiceStore.getState().reapplyAudioConstraints();
                  });
                }} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Voice Settings'}
                </Button>
              </div>
            </div>
          )}

          {activeSection === 'notifications' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">Notifications</h2>
              <div className="card-stack">
                <div className="card-surface flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Desktop Notifications</div>
                    <div className="text-xs text-text-muted">Show desktop notifications for new messages</div>
                    {notifPermission === 'denied' && notifEnabled && (
                      <div className="mt-1 text-xs text-accent-warning">
                        Notification permission denied by the system. Click the toggle to request permission again.
                      </div>
                    )}
                    {notifPermission === 'granted' && notifEnabled && (
                      <div className="mt-1 text-xs text-accent-success">Permission granted</div>
                    )}
                  </div>
                  <ToggleSwitch
                    on={notifEnabled}
                    onToggle={() => {
                      const next = !notifEnabled;
                      if (next) {
                        void requestNotificationPermission().then((granted) => {
                          setNotifPermission(granted ? 'granted' : 'denied');
                          setNotifEnabled(granted);
                          setNotificationsEnabled(granted);
                          setNotifications((prev) => ({ ...prev, desktop: granted }));
                        });
                      } else {
                        setNotifEnabled(false);
                        setNotificationsEnabled(false);
                        setNotifications((prev) => ({ ...prev, desktop: false }));
                      }
                    }}
                  />
                </div>
                <div className="card-surface flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Message Sound</div>
                    <div className="text-xs text-text-muted">Play a sound for incoming messages</div>
                  </div>
                  <ToggleSwitch
                    on={Boolean(mergedNotifications.messageSound)}
                    onToggle={() => setNotifications((prev) => ({ ...prev, messageSound: !Boolean(prev.messageSound) }))}
                  />
                </div>
                <div className="card-surface flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Low Bandwidth Mode</div>
                    <div className="text-xs text-text-muted">
                      Hide heavy image previews and reduce automatic media loading.
                    </div>
                  </div>
                  <ToggleSwitch
                    on={Boolean(mergedNotifications.lowBandwidthMode)}
                    onToggle={() => {
                      const next = !Boolean(mergedNotifications.lowBandwidthMode);
                      setLowBandwidthModeUI(next);
                      setNotifications((prev) => ({ ...prev, lowBandwidthMode: next }));
                    }}
                  />
                </div>
              </div>
              <div className="settings-action-row">
                <Button onClick={() => void saveSettings()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Notifications'}
                </Button>
              </div>
            </div>
          )}

          {activeSection === 'activity' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">Activity Privacy</h2>
              <div className="card-stack">
                <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Display current activity</div>
                    <div className="text-xs text-text-muted">
                      Show the game/app you are currently using in presence.
                    </div>
                  </div>
                  <ToggleSwitch
                    on={Boolean(activityDetectionEnabled)}
                    onToggle={() => setActivityDetectionEnabled(!Boolean(activityDetectionEnabled))}
                  />
                </div>

                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    Detected Apps
                  </div>
                  <div className="mb-3 text-xs text-text-muted">
                    Disable any detected app to prevent Paracord from reporting it.
                  </div>
                  {visibleKnownActivityApps.length === 0 ? (
                    <div className="rounded-lg border border-border-subtle bg-bg-tertiary/70 px-3 py-2.5 text-sm text-text-muted">
                      No apps detected yet. Launch a game/app while Paracord is open.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {visibleKnownActivityApps.map((appId) => {
                        const enabled = !disabledActivityApps.has(appId);
                        return (
                          <div
                            key={appId}
                            className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-tertiary/70 px-3 py-2.5"
                          >
                            <div>
                              <div className="text-sm font-medium text-text-primary">{readableAppName(appId)}</div>
                              <div className="text-xs text-text-muted">{appId}</div>
                            </div>
                            <ToggleSwitch on={enabled} onToggle={() => toggleActivityApp(appId)} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="settings-action-row">
                <Button onClick={() => void saveActivitySettings()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Activity Privacy'}
                </Button>
              </div>
            </div>
          )}

          {activeSection === 'keybinds' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">Keybinds</h2>
              <div className="card-stack">
                {[
                  { key: 'toggleMute' as const, action: 'Toggle Mute' },
                  { key: 'toggleDeafen' as const, action: 'Toggle Deafen' },
                  { key: 'pushToTalk' as const, action: 'Push to Talk' },
                ].map(kb => (
                  <div
                    key={kb.key}
                    className="card-surface flex flex-col items-stretch gap-2 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm font-medium text-text-primary">{kb.action}</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border-subtle bg-bg-tertiary px-3 py-2 text-sm font-mono text-text-muted outline-none focus:border-accent-primary sm:w-48"
                      value={capturingKeybind === kb.key ? 'Press keys...' : String(mergedKeybinds[kb.key] ?? '')}
                      onFocus={() => setCapturingKeybind(kb.key)}
                      onBlur={() => setCapturingKeybind(null)}
                      onKeyDown={(e) => {
                        e.preventDefault();
                        const keys: string[] = [];
                        if (e.ctrlKey) keys.push('Ctrl');
                        if (e.shiftKey) keys.push('Shift');
                        if (e.altKey) keys.push('Alt');
                        if (e.metaKey) keys.push('Meta');
                        const base = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                        if (!['Control', 'Shift', 'Alt', 'Meta'].includes(base)) {
                          keys.push(base);
                        }
                        if (keys.length > 0) {
                          setKeybinds((prev) => ({ ...prev, [kb.key]: keys.join('+') }));
                          setCapturingKeybind(null);
                        }
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="settings-action-row">
                <Button onClick={() => void saveSettings()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Keybinds'}
                </Button>
              </div>
            </div>
          )}

          {activeSection === 'identity' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">Identity Portability</h2>

              {identityStatus && (
                <div
                  className="card-surface mb-8 inline-flex max-w-full items-center rounded-xl border border-border-subtle bg-bg-mod-subtle px-4 py-3 text-sm font-medium"
                  style={{ color: identityStatus.includes('failed') || identityStatus.includes('Failed') ? 'var(--accent-danger)' : 'var(--accent-success)' }}
                >
                  {identityStatus}
                </div>
              )}

              <div className="card-stack-roomy">
                <div className="card-surface rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-8">
                  <div className="mb-6">
                    <div className="text-base font-semibold text-text-primary">Current Identity Key</div>
                    <div className="mt-1 text-sm text-text-muted">
                      Share and verify this fingerprint with trusted contacts.
                    </div>
                  </div>
                  {ownIdentityFingerprint ? (
                    <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Fingerprint</div>
                      <div className="break-all font-mono text-xs text-text-primary">{ownIdentityFingerprint}</div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3 text-sm text-text-muted">
                      No public identity key attached to this account yet.
                    </div>
                  )}
                </div>

                {/* Export Section */}
                <div className="card-surface rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-8">
                  <div className="mb-6">
                    <div className="text-base font-semibold text-text-primary">Export Identity</div>
                    <div className="mt-1 text-sm text-text-muted">
                      Export your identity as a signed bundle that can be imported to another Paracord server.
                    </div>
                  </div>
                  <div className="card-stack">
                    <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                      <div>
                        <div className="text-sm font-medium text-text-primary">Include Messages</div>
                        <div className="text-xs text-text-muted">Export your message history (can be large)</div>
                      </div>
                      <ToggleSwitch on={exportIncludeMessages} onToggle={() => setExportIncludeMessages(!exportIncludeMessages)} />
                    </div>
                    <div className="card-surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                      <div>
                        <div className="text-sm font-medium text-text-primary">Include Relationships</div>
                        <div className="text-xs text-text-muted">Export your friend and block list</div>
                      </div>
                      <ToggleSwitch on={exportIncludeRelationships} onToggle={() => setExportIncludeRelationships(!exportIncludeRelationships)} />
                    </div>
                  </div>
                  <div className="settings-action-row">
                    <Button
                      onClick={() => void handleExportIdentity()}
                      disabled={exporting}
                    >
                      {exporting ? 'Exporting...' : 'Export Identity'}
                    </Button>
                  </div>
                </div>

                {/* Import Section */}
                <div className="card-surface rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-8">
                  <div className="mb-6">
                    <div className="text-base font-semibold text-text-primary">Import Identity</div>
                    <div className="mt-1 text-sm text-text-muted">
                      Import an identity bundle from another Paracord server. This will merge the imported data with your current account.
                    </div>
                  </div>
                  <div className="card-stack">
                    <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Select Bundle File</div>
                      <input
                        type="file"
                        accept=".json"
                        onChange={handleImportFileSelect}
                        className="block w-full text-sm text-text-muted file:mr-3 file:rounded-lg file:border file:border-border-subtle file:bg-bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-text-primary hover:file:bg-bg-mod-subtle"
                      />
                      {importFile && (
                        <div className="mt-2 text-xs text-text-muted">
                          Selected: {importFile.name}
                        </div>
                      )}
                    </div>

                    {importPreview && (
                      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-5">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Import Preview</div>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-text-muted">Origin Server</span>
                            <span className="font-medium text-text-primary">{String(importPreview.origin_server ?? 'Unknown')}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-text-muted">Username</span>
                            <span className="font-medium text-text-primary">
                              {(importPreview.user as Record<string, unknown>)?.username
                                ? String((importPreview.user as Record<string, unknown>).username)
                                : 'Unknown'}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-text-muted">Messages</span>
                            <span className="font-medium text-text-primary">
                              {Array.isArray(importPreview.messages) ? importPreview.messages.length : 0}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-text-muted">Attachments</span>
                            <span className="font-medium text-text-primary">
                              {Array.isArray(importPreview.attachments) ? importPreview.attachments.length : 0}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-text-muted">Prekeys</span>
                            <span className="font-medium text-text-primary">
                              {Array.isArray((importPreview.prekeys as Record<string, unknown> | undefined)?.one_time_prekeys)
                                ? ((importPreview.prekeys as Record<string, unknown>).one_time_prekeys as unknown[]).length
                                : 0}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-text-muted">Relationships</span>
                            <span className="font-medium text-text-primary">
                              {Array.isArray(importPreview.relationships) ? importPreview.relationships.length : 0}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-text-muted">Guild Memberships</span>
                            <span className="font-medium text-text-primary">
                              {Array.isArray(importPreview.guilds) ? importPreview.guilds.length : 0}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-text-muted">Exported At</span>
                            <span className="font-medium text-text-primary">
                              {importPreview.exported_at ? new Date(String(importPreview.exported_at)).toLocaleString() : 'Unknown'}
                            </span>
                          </div>
                        </div>
                        <div className="mt-4 rounded-lg border border-accent-warning/30 bg-accent-warning/10 px-4 py-3 text-xs text-accent-warning">
                          This will merge the imported identity with your current account. Profile fields will be overwritten.
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="settings-action-row">
                    <Button
                      onClick={() => void handleImportIdentity()}
                      disabled={importing || !importPreview}
                    >
                      {importing ? 'Importing...' : 'Import Identity'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'server' && userIsAdmin && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">Server</h2>
              <div className="card-stack">
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Update & Restart</div>
                  <div className="mt-2 text-sm text-text-muted">
                    Pull the latest code from git, rebuild the client and server, then restart. All connected users will be temporarily disconnected.
                  </div>
                  <div className="mt-4">
                    {!restartConfirm ? (
                      <Button
                        style={{ backgroundColor: 'var(--accent-warning, #f59e0b)' }}
                        onClick={() => setRestartConfirm(true)}
                        disabled={restarting}
                      >
                        Update & Restart Server
                      </Button>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm font-medium text-text-primary">Are you sure?</span>
                        <Button
                          style={{ backgroundColor: 'var(--accent-danger)' }}
                          disabled={restarting}
                          onClick={async () => {
                            setRestarting(true);
                            try {
                              await adminApi.restartUpdate();
                            } catch {
                              setRestarting(false);
                              setRestartConfirm(false);
                              setErrorStatus('Failed to trigger restart.');
                            }
                          }}
                        >
                          {restarting ? 'Restarting...' : 'Yes, restart now'}
                        </Button>
                        <Button
                          style={{ backgroundColor: 'var(--bg-tertiary)' }}
                          onClick={() => setRestartConfirm(false)}
                          disabled={restarting}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'about' && (
            <div className="settings-surface-card w-full min-h-[calc(100dvh-13.5rem)]">
              <h2 className="settings-section-title mb-8">About</h2>
              <div className="card-stack">
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
                  <div className="text-sm font-semibold text-text-primary">{APP_NAME}</div>
                  <div className="mt-1 text-xs text-text-muted">Version 0.4.0</div>
                </div>
                <div className="text-sm leading-6 text-text-muted">
                  A decentralized, self-hostable Discord alternative built with Rust, Tauri, and React.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}

function ToggleSwitch({ on, onToggle, disabled = false }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className="relative h-6 w-11 rounded-full border transition-colors"
      style={{
        backgroundColor: disabled
          ? 'var(--interactive-muted)'
          : on
            ? 'var(--accent-success)'
            : 'var(--interactive-muted)',
        borderColor: on ? 'color-mix(in srgb, var(--accent-success) 75%, white 25%)' : 'var(--border-subtle)',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div
        className="absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-all"
        style={{ left: on ? '18px' : '2px' }}
      />
    </button>
  );
}

