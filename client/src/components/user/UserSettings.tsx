import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  ArrowLeft,
  ChevronRight,
  User,
  Palette,
  Mic,
  Bell,
  Eye,
  Keyboard,
  Fingerprint,
  Server,
  Info,
  Code2,
  LogOut,
  CheckCircle2,
  ShieldAlert,
  Download,
  RefreshCw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
import { toast } from '../../stores/toastStore';
import { ErrorBanner } from '../ui/Feedback';
import { Button } from '../ui/Button';
import { Input, Textarea, Select } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import {
  isEnabled as isNotificationsEnabled,
  setEnabled as setNotificationsEnabled,
  isPermissionGranted as checkNotificationPermission,
  requestPermission as requestNotificationPermission,
} from '../../lib/features/notifications';
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

type NavItem = { id: SettingsSection; label: string; icon: LucideIcon; adminOnly?: boolean };

// Sectioned nav (design-spec §7 nav item + section groups). Icons keep the rail
// legible and consistent; grouping gives rhythm instead of one flat list.
const NAV_GROUPS: { label?: string; items: NavItem[] }[] = [
  { items: [{ id: 'account', label: 'My Account', icon: User }] },
  {
    label: 'Preferences',
    items: [
      { id: 'appearance', label: 'Appearance', icon: Palette },
      { id: 'voice', label: 'Voice & Video', icon: Mic },
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'activity', label: 'Activity Privacy', icon: Eye },
      { id: 'keybinds', label: 'Keybinds', icon: Keyboard },
    ],
  },
  {
    label: 'Advanced',
    items: [
      { id: 'identity', label: 'Identity', icon: Fingerprint },
      { id: 'server', label: 'Server', icon: Server, adminOnly: true },
      { id: 'about', label: 'About', icon: Info },
    ],
  },
];

const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

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
  const [deletingAccount, setDeletingAccount] = useState(false);

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

  const handleDeleteAccount = useCallback(async () => {
    const ok = await confirm({
      title: 'Delete your account?',
      description:
        'This permanently erases your profile, messages, and memberships on this server. It cannot be undone.',
      confirmLabel: 'Delete account',
      cancelLabel: 'Keep account',
      variant: 'danger',
    });
    if (!ok) return;
    setDeletingAccount(true);
    clearStatus();
    try {
      // Backend requires an explicit confirmation header (users::delete_me).
      await getApi().delete('/users/@me', { headers: { 'x-confirm-delete': 'DELETE' } });
      toast.success('Your account has been deleted.');
      await logout();
      onClose();
    } catch (err) {
      setErrorStatus(`Failed to delete account: ${extractApiError(err)}`);
      setDeletingAccount(false);
    }
  }, [clearStatus, logout, onClose, setErrorStatus]);

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

  const activeLabel = NAV_ITEMS.find((i) => i.id === activeSection)?.label ?? activeSection;
  const maskedEmail = user?.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : '***@***';
  const voiceInputMode = (mergedNotifications['voiceInputMode'] ?? 'voice_activity') as
    | 'voice_activity'
    | 'push_to_talk';

  return (
    <div
      className={cn(
        'relative h-full min-h-0 overflow-hidden rounded-lg border border-border-subtle bg-bg-primary',
        isMobile ? 'flex flex-col' : 'flex'
      )}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {!isMobile && (
        <div className="absolute right-6 top-6 z-50 flex flex-col items-center gap-1">
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-sm border border-border-subtle bg-bg-secondary text-interactive-normal shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
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
          <div className="relative z-10 flex flex-1 flex-col overflow-y-auto bg-bg-secondary pt-[calc(var(--safe-top)+0.75rem)]">
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="text-section uppercase text-text-muted">User settings</div>
              <button
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-sm border border-border-subtle bg-bg-secondary text-interactive-normal"
                aria-label="Close user settings"
                title="Close user settings"
              >
                <X size={17} />
              </button>
            </div>
            <div className="flex flex-col gap-4 px-2 pb-[calc(var(--safe-bottom)+1rem)]">
              {NAV_GROUPS.map((group, gi) => {
                const items = group.items.filter((item) => !item.adminOnly || userIsAdmin);
                if (items.length === 0) return null;
                return (
                  <div key={group.label ?? `group-${gi}`}>
                    {group.label && (
                      <div className="px-3 pb-1.5 text-section uppercase text-text-muted">{group.label}</div>
                    )}
                    {items.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          onClick={() => selectMobileSection(item.id)}
                          className="flex w-full items-center gap-3 rounded-sm px-3 py-3 text-label text-text-primary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle active:bg-bg-mod-strong"
                        >
                          <Icon size={18} className="shrink-0 text-text-muted" />
                          <span className="flex-1 text-left">{item.label}</span>
                          <ChevronRight size={16} className="text-text-muted" />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              <div className="mx-3 h-px bg-border-subtle" />
              <button
                onClick={() => { onClose(); navigate('/app/developers'); }}
                className="flex w-full items-center gap-3 rounded-sm px-3 py-3 text-label text-text-primary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle active:bg-bg-mod-strong"
              >
                <Code2 size={18} className="shrink-0 text-text-muted" />
                <span className="flex-1 text-left">Developer Portal</span>
                <ChevronRight size={16} className="text-text-muted" />
              </button>
              <button
                onClick={() => { void logout(); onClose(); }}
                className="flex w-full items-center gap-3 rounded-sm px-3 py-3 text-label text-accent-danger transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-tint"
              >
                <LogOut size={18} className="shrink-0" />
                <span className="flex-1 text-left">Log Out</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="relative z-10 flex items-center gap-2 border-b border-border-subtle bg-bg-secondary px-3 pb-2.5 pt-[calc(var(--safe-top)+0.75rem)]">
            <button
              onClick={() => setMobileShowNav(true)}
              className="flex h-9 w-9 items-center justify-center rounded-sm border border-border-subtle bg-bg-secondary text-interactive-normal"
              aria-label="Back to settings menu"
            >
              <ArrowLeft size={17} />
            </button>
            <div className="flex-1 text-subhead text-text-primary">{activeLabel}</div>
            <button
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-sm border border-border-subtle bg-bg-secondary text-interactive-normal"
              aria-label="Close user settings"
              title="Close user settings"
            >
              <X size={17} />
            </button>
          </div>
        )
      ) : (
        <nav
          aria-label="User settings"
          className="relative z-10 flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-bg-secondary px-3 py-6"
        >
          <button
            onClick={onClose}
            className="group mb-4 flex items-center gap-2 self-start rounded-sm px-2.5 py-1.5 text-label text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            <ArrowLeft size={15} className="transition-transform group-hover:-translate-x-0.5" />
            Back
          </button>
          <div className="flex flex-col gap-5">
            {NAV_GROUPS.map((group, gi) => {
              const items = group.items.filter((item) => !item.adminOnly || userIsAdmin);
              if (items.length === 0) return null;
              return (
                <div key={group.label ?? `group-${gi}`}>
                  {group.label && (
                    <div className="mb-1.5 px-2.5 text-section uppercase text-text-muted">{group.label}</div>
                  )}
                  <div className="flex flex-col gap-0.5">
                    {items.map((item) => (
                      <NavButton
                        key={item.id}
                        item={item}
                        active={activeSection === item.id}
                        onClick={() => setActiveSection(item.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="my-5 h-px bg-border-subtle" />
          <button
            onClick={() => { onClose(); navigate('/app/developers'); }}
            className="flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-label text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            <Code2 size={17} className="shrink-0 text-text-muted" />
            Developer Portal
          </button>
          <button
            onClick={() => { void logout(); onClose(); }}
            className="mt-0.5 flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-label text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-tint focus-visible:shadow-[var(--focus-ring)]"
          >
            <LogOut size={17} className="shrink-0" />
            Log Out
          </button>
        </nav>
      )}

      {/* Content area */}
      {(!isMobile || !mobileShowNav) && (
        <div className={cn('relative z-10 flex-1 overflow-y-auto', isMobile ? 'px-4 pb-[calc(var(--safe-bottom)+1.5rem)] pt-4' : 'px-10 py-10')}>
          <div className="mx-auto w-full max-w-3xl">
            {!isMobile && (
              <nav className="mb-6 flex items-center gap-1.5 text-meta text-text-muted" aria-label="Breadcrumb">
                <span>Settings</span>
                <ChevronRight size={13} aria-hidden className="text-text-muted" />
                <span className="font-medium text-text-secondary">{activeLabel}</span>
              </nav>
            )}

            {statusText && statusKind === 'error' && (
              <div className="mb-6">
                <ErrorBanner message={statusText} />
              </div>
            )}
            {statusText && statusKind === 'success' && (
              <div
                className="mb-6 flex items-center gap-2.5 rounded-md border border-border-subtle bg-bg-accent px-4 py-3 shadow-sm"
                role="status"
                aria-live="polite"
              >
                <CheckCircle2 size={18} className="shrink-0 text-accent-success" />
                <span className="text-label text-text-primary">{statusText}</span>
              </div>
            )}

            {activeSection === 'account' && (
              <div>
                <header className="mb-8 flex items-center gap-4">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent-tint font-display text-2xl font-bold text-accent-primary ring-1 ring-inset ring-border-strong">
                    {user?.username?.charAt(0).toUpperCase() || 'U'}
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate text-heading text-text-primary">{user?.username || 'My Account'}</h2>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      Manage your profile, security, and how you sign in.
                    </p>
                  </div>
                </header>

                {/* Public profile */}
                <section>
                  <h3 className="text-section uppercase text-text-muted">Public profile</h3>
                  <div className="mt-2 divide-y divide-border-subtle">
                    <div className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div className="min-w-0">
                        <div className="text-label text-text-primary">Username</div>
                        <p className="mt-0.5 text-meta text-text-secondary">Your unique handle across the server.</p>
                      </div>
                      <span className="font-code text-sm text-text-secondary">{user?.username || 'unknown'}</span>
                    </div>

                    <div className="py-4">
                      <label htmlFor="acct-display" className="text-label text-text-primary">Display name</label>
                      <p className="mt-0.5 text-meta text-text-secondary">Shown to other members instead of your username.</p>
                      <Input
                        id="acct-display"
                        className="mt-2.5 max-w-md"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Add a friendly name"
                      />
                    </div>

                    <div className="py-4">
                      <label htmlFor="acct-pronouns" className="text-label text-text-primary">Pronouns</label>
                      <p className="mt-0.5 text-meta text-text-secondary">A short note that appears on your profile.</p>
                      <Input
                        id="acct-pronouns"
                        className="mt-2.5 max-w-xs"
                        value={pronouns}
                        onChange={(e) => setPronouns(e.target.value)}
                        placeholder="e.g. they/them"
                      />
                    </div>

                    <div className="py-4">
                      <label htmlFor="acct-bio" className="text-label text-text-primary">About me</label>
                      <p className="mt-0.5 text-meta text-text-secondary">A sentence or two the rest of the community will see.</p>
                      <Textarea
                        id="acct-bio"
                        className="mt-2.5 max-w-xl resize-none"
                        rows={3}
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        placeholder="Tell people what you're into."
                      />
                    </div>

                    <div className="py-4">
                      <label htmlFor="acct-links" className="text-label text-text-primary">Linked accounts</label>
                      <p className="mt-0.5 text-meta text-text-secondary">
                        One per line as <code className="font-code text-text-secondary">Label|https://url</code>. Up to eight.
                      </p>
                      <Textarea
                        id="acct-links"
                        className="mt-2.5 max-w-xl resize-none font-code text-sm"
                        rows={4}
                        value={linkedAccountsInput}
                        onChange={(e) => setLinkedAccountsInput(e.target.value)}
                        placeholder={'GitHub|https://github.com/username\nWebsite|https://example.com'}
                      />
                    </div>
                  </div>
                  <div className="mt-5">
                    <Button loading={saving} onClick={() => void saveProfile()}>Save Profile</Button>
                  </div>
                </section>

                {/* Security & sign-in */}
                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Security &amp; sign-in</h3>

                  <div className="mt-5">
                    <div className="text-label text-text-primary">Email address</div>
                    <p className="mt-0.5 text-meta text-text-secondary">
                      Current: <span className="font-code text-text-secondary">{maskedEmail}</span>. Changing it signs out your other sessions.
                    </p>
                    <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="text-meta text-text-secondary">New email</span>
                        <Input
                          className="mt-1.5"
                          type="email"
                          value={accountNewEmail}
                          onChange={(e) => setAccountNewEmail(e.target.value)}
                          autoComplete="email"
                        />
                      </label>
                      <label className="block">
                        <span className="text-meta text-text-secondary">Current password</span>
                        <Input
                          className="mt-1.5"
                          type="password"
                          value={emailCurrentPassword}
                          onChange={(e) => setEmailCurrentPassword(e.target.value)}
                          autoComplete="current-password"
                        />
                      </label>
                    </div>
                    <div className="mt-3">
                      <Button
                        variant="secondary"
                        loading={accountActionLoading}
                        onClick={() => void submitEmailChange()}
                        disabled={!emailCurrentPassword.trim() || !accountNewEmail.trim()}
                      >
                        Update Email
                      </Button>
                    </div>
                  </div>

                  <div className="mt-7">
                    <div className="text-label text-text-primary">Password</div>
                    <p className="mt-0.5 text-meta text-text-secondary">
                      Pick something you don't use elsewhere. Other sessions are signed out on change.
                    </p>
                    <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-3">
                      <label className="block">
                        <span className="text-meta text-text-secondary">Current</span>
                        <Input
                          className="mt-1.5"
                          type="password"
                          value={passwordCurrentPassword}
                          onChange={(e) => setPasswordCurrentPassword(e.target.value)}
                          autoComplete="current-password"
                        />
                      </label>
                      <label className="block">
                        <span className="text-meta text-text-secondary">New</span>
                        <Input
                          className="mt-1.5"
                          type="password"
                          value={accountNewPassword}
                          onChange={(e) => setAccountNewPassword(e.target.value)}
                          autoComplete="new-password"
                        />
                      </label>
                      <label className="block">
                        <span className="text-meta text-text-secondary">Confirm</span>
                        <Input
                          className="mt-1.5"
                          type="password"
                          value={accountConfirmPassword}
                          onChange={(e) => setAccountConfirmPassword(e.target.value)}
                          autoComplete="new-password"
                        />
                      </label>
                    </div>
                    <div className="mt-3">
                      <Button
                        variant="secondary"
                        loading={accountActionLoading}
                        onClick={() => void submitPasswordChange()}
                        disabled={
                          !passwordCurrentPassword.trim() ||
                          !accountNewPassword.trim() ||
                          !accountConfirmPassword.trim()
                        }
                      >
                        Update Password
                      </Button>
                    </div>
                  </div>

                  {/* Two-factor authentication */}
                  <div className="mt-7">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-label text-text-primary">Two-factor authentication</div>
                        <p className="mt-0.5 text-meta text-text-secondary">
                          {mfaEnabled
                            ? `Enabled. ${mfaBackupCodesRemaining} backup code${mfaBackupCodesRemaining !== 1 ? 's' : ''} remaining.`
                            : 'Require a rotating code from your authenticator app when you sign in.'}
                        </p>
                      </div>
                      {mfaView === 'idle' && (
                        mfaEnabled ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => { setMfaView('disable'); setMfaStatus(null); }}
                            disabled={mfaLoading}
                          >
                            Disable 2FA
                          </Button>
                        ) : (
                          <Button size="sm" loading={mfaLoading} onClick={() => void startMfaSetup()}>
                            Enable 2FA
                          </Button>
                        )
                      )}
                    </div>

                    {mfaStatus && (
                      <div
                        className={cn(
                          'mt-3 rounded-md border px-4 py-3 text-sm font-medium',
                          mfaStatus.includes('enabled') || mfaStatus.includes('disabled')
                            ? 'border-accent-success/30 bg-success-tint text-accent-success'
                            : 'border-accent-danger/30 bg-danger-tint text-accent-danger'
                        )}
                        role={mfaStatus.includes('enabled') || mfaStatus.includes('disabled') ? 'status' : 'alert'}
                        aria-live={mfaStatus.includes('enabled') || mfaStatus.includes('disabled') ? 'polite' : 'assertive'}
                      >
                        {mfaStatus}
                      </div>
                    )}

                    {mfaBackupCodes.length > 0 && (
                      <div className="mt-4 max-w-md">
                        <div className="text-section uppercase text-accent-warning">Save these backup codes</div>
                        <div className="mt-2 rounded-md border border-border-subtle bg-bg-tertiary p-3 font-code text-sm leading-relaxed text-text-primary">
                          {mfaBackupCodes.map((code) => (
                            <div key={code}>{code}</div>
                          ))}
                        </div>
                        <p className="mt-2 text-meta text-text-secondary">
                          Each code works once. Store them somewhere only you can reach.
                        </p>
                        <Button variant="ghost" size="sm" className="-ml-2 mt-1" onClick={() => setMfaBackupCodes([])}>
                          I've saved my codes
                        </Button>
                      </div>
                    )}

                    {mfaView === 'setup' && mfaSetupData && (
                      <div className="mt-4 max-w-md space-y-4">
                        <p className="text-sm text-text-secondary">
                          1. Scan this QR code with your authenticator app (Google Authenticator, Authy, and friends), or enter the secret by hand.
                        </p>
                        <div className="flex justify-center rounded-md border border-border-subtle bg-bg-tertiary p-4">
                          <img src={mfaSetupData.qr_code} alt="TOTP QR code" className="h-40 w-40 rounded-sm" />
                        </div>
                        <div className="rounded-md border border-border-subtle bg-bg-tertiary p-3 font-code text-sm break-all text-text-primary">
                          {mfaSetupData.secret}
                        </div>
                        <p className="text-sm text-text-secondary">2. Enter the 6-digit code the app shows.</p>
                        <Input
                          type="text"
                          aria-label="Authenticator code"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="000000"
                          className="max-w-[12rem] font-code tracking-[0.35em]"
                          value={mfaVerifyCode}
                          onChange={(e) => setMfaVerifyCode(e.target.value.replace(/\D/g, ''))}
                        />
                        <div className="flex gap-3">
                          <Button loading={mfaLoading} disabled={mfaVerifyCode.length < 6} onClick={() => void verifyMfaSetup()}>
                            Confirm &amp; Enable
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => { setMfaView('idle'); setMfaSetupData(null); setMfaVerifyCode(''); setMfaStatus(null); }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}

                    {mfaView === 'disable' && (
                      <div className="mt-4 max-w-md space-y-4">
                        <p className="text-sm text-text-secondary">
                          Enter a current authenticator code or one of your backup codes to turn two-factor off.
                        </p>
                        <Input
                          type="text"
                          aria-label="Current TOTP or backup code"
                          placeholder="6-digit code or backup code"
                          className="font-code"
                          value={mfaDisableCode}
                          onChange={(e) => setMfaDisableCode(e.target.value)}
                        />
                        <div className="flex gap-3">
                          <Button
                            variant="destructive"
                            loading={mfaLoading}
                            disabled={!mfaDisableCode.trim()}
                            onClick={() => void disableMfa()}
                          >
                            Disable 2FA
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => { setMfaView('idle'); setMfaDisableCode(''); setMfaStatus(null); }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Active sessions */}
                  <div className="mt-7">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-label text-text-primary">Active sessions</div>
                        <p className="mt-0.5 text-meta text-text-secondary">Devices currently signed in to your account.</p>
                      </div>
                      <Button variant="ghost" size="sm" disabled={sessionsLoading} onClick={() => void loadSessions()}>
                        <RefreshCw size={15} className={cn('mr-1.5', sessionsLoading && 'animate-spin')} />
                        Refresh
                      </Button>
                    </div>
                    <div className="mt-3 space-y-2">
                      {sessionsLoading && sessions.length === 0 && (
                        <>
                          <Skeleton height={58} borderRadius="var(--radius-md)" />
                          <Skeleton height={58} borderRadius="var(--radius-md)" />
                        </>
                      )}
                      {sessions.map((session) => (
                        <div
                          key={session.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-tertiary px-4 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-label text-text-primary">
                                {session.user_agent || session.device_id || 'Unknown device'}
                              </span>
                              {session.current && (
                                <span className="rounded-xs bg-success-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-success">
                                  Current
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-meta text-text-muted">
                              {session.ip_address || 'No IP'} &middot; Last seen {new Date(session.last_seen_at).toLocaleString()}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-accent-danger hover:bg-danger-tint hover:text-accent-danger"
                            disabled={sessionBusyId === session.id}
                            onClick={() => void revokeSession(session.id)}
                          >
                            {sessionBusyId === session.id ? 'Revoking…' : 'Revoke'}
                          </Button>
                        </div>
                      ))}
                      {!sessionsLoading && sessions.length === 0 && (
                        <p className="rounded-md border border-border-subtle bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
                          No other devices are signed in right now.
                        </p>
                      )}
                    </div>
                  </div>
                </section>

                {/* Your data */}
                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Your data</h3>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-label text-text-primary">Download your data</div>
                      <p className="mt-0.5 text-meta text-text-secondary">A JSON export of your account, profile, and settings.</p>
                    </div>
                    <Button variant="secondary" loading={accountDataExporting} onClick={() => void downloadAccountData()}>
                      {!accountDataExporting && <Download size={16} className="mr-1.5" />}
                      Download data
                    </Button>
                  </div>
                </section>

                {/* Device security */}
                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Device security</h3>
                  <div className="mt-2 divide-y divide-border-subtle">
                    <ToggleRow
                      title="Device crypto security"
                      description="Use local key unlock and challenge-response sign-in on this device."
                      on={cryptoAuthEnabled}
                      onToggle={() => handleCryptoSecurityToggle(!cryptoAuthEnabled)}
                      disabled={!localCryptoAccountReady || saving}
                    />
                  </div>
                  {!localCryptoAccountReady ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-tertiary px-4 py-3">
                      <p className="min-w-0 text-meta text-text-secondary">
                        You haven't set up a local crypto identity for this account yet.
                      </p>
                      <Button variant="secondary" size="sm" onClick={() => { onClose(); navigate('/setup?migrate=1'); }}>
                        Set up local identity
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-3 text-meta text-text-secondary">
                      {cryptoAuthEnabled
                        ? `Enabled. ${accountUnlocked ? 'Your identity is currently unlocked.' : 'Your identity is currently locked.'}`
                        : 'Disabled. This account signs in with username and password only.'}
                    </p>
                  )}
                </section>

                {/* Danger zone */}
                <section className="mt-10">
                  <div className="rounded-md border border-accent-danger/30 bg-danger-tint p-5">
                    <div className="flex items-start gap-3">
                      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-accent-danger" />
                      <div className="min-w-0">
                        <h3 className="text-subhead text-text-primary">Delete account</h3>
                        <p className="mt-1 max-w-xl text-sm leading-relaxed text-text-secondary">
                          Permanently erase your profile, messages, and memberships on this server. Friends lose the
                          connection and your username is freed. This can't be undone.
                        </p>
                        <div className="mt-4">
                          <Button variant="destructive" loading={deletingAccount} onClick={() => void handleDeleteAccount()}>
                            Delete my account
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {activeSection === 'appearance' && (
              <div>
                <SettingsHeader
                  title="Appearance"
                  description="Tune the look and density of Paracord to match how you read."
                />
                <section>
                  <h3 className="text-section uppercase text-text-muted">Theme</h3>
                  <div className="mt-3">
                    <ThemeSelector currentTheme={theme} onThemeChange={(t) => handleThemeChange(t)} />
                  </div>
                </section>

                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Display</h3>
                  <div className="mt-2 divide-y divide-border-subtle">
                    <div className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div className="min-w-0">
                        <div className="text-label text-text-primary">Message density</div>
                        <p className="mt-0.5 text-meta text-text-secondary">
                          Comfortable gives each message room to breathe; compact fits more on screen.
                        </p>
                      </div>
                      <Segmented
                        value={messageCompact ? 'compact' : 'comfortable'}
                        onChange={(v) => setMessageCompact(v === 'compact')}
                        options={[
                          { value: 'comfortable', label: 'Comfortable' },
                          { value: 'compact', label: 'Compact' },
                        ]}
                      />
                    </div>
                    <div className="py-4">
                      <label htmlFor="appearance-locale" className="text-label text-text-primary">Language &amp; region</label>
                      <p className="mt-0.5 text-meta text-text-secondary">
                        BCP-47 locale used for dates, numbers, and translations.
                      </p>
                      <Input
                        id="appearance-locale"
                        className="mt-2.5 max-w-[12rem]"
                        value={locale}
                        onChange={(e) => setLocale(e.target.value)}
                        placeholder="en-US"
                      />
                    </div>
                  </div>
                </section>

                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Custom CSS</h3>
                  <p className="mt-2 max-w-xl text-sm text-text-secondary">
                    For power users — inject your own styles. Applies instantly on save.
                  </p>
                  <div className="mt-3 rounded-md border border-border-subtle bg-bg-tertiary p-4">
                    <CustomCSS initialCSS={customCss} onSave={(css) => setCustomCss(css)} />
                  </div>
                </section>

                <div className="mt-8">
                  <Button loading={saving} onClick={() => void saveSettings()}>Save Appearance</Button>
                </div>
              </div>
            )}

            {activeSection === 'voice' && (
              <div>
                <SettingsHeader
                  title="Voice & Video"
                  description="Choose your devices and how your mic behaves in calls."
                />
                <section>
                  <h3 className="text-section uppercase text-text-muted">Devices</h3>
                  <div className="mt-2 divide-y divide-border-subtle">
                    <div className="py-4">
                      <label htmlFor="voice-input" className="text-label text-text-primary">Input device</label>
                      <p className="mt-0.5 text-meta text-text-secondary">The microphone others hear you through.</p>
                      <Select
                        id="voice-input"
                        className="mt-2.5 max-w-md"
                        value={selectedAudioInput || ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          const previous = selectedAudioInput || '';
                          selectAudioInput(value);
                          void applyAudioInputDevice(value || null).then((ok) => {
                            if (!ok) {
                              selectAudioInput(previous);
                              toast.error('Could not switch microphone. It may be in use or unavailable.');
                            }
                          });
                        }}
                      >
                        <option value="">Default</option>
                        {audioInputDevices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="py-4">
                      <label htmlFor="voice-output" className="text-label text-text-primary">Output device</label>
                      <p className="mt-0.5 text-meta text-text-secondary">Where call audio plays back.</p>
                      <Select
                        id="voice-output"
                        className="mt-2.5 max-w-md"
                        value={selectedAudioOutput || ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          const previous = selectedAudioOutput || '';
                          selectAudioOutput(value);
                          void applyAudioOutputDevice(value || null).then((ok) => {
                            if (!ok) {
                              selectAudioOutput(previous);
                              toast.error('Could not switch speaker. It may be unavailable.');
                            }
                          });
                        }}
                      >
                        <option value="">Default</option>
                        {audioOutputDevices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Speaker ${device.deviceId.slice(0, 6)}`}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                </section>

                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Input mode</h3>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-label text-text-primary">How your mic activates</div>
                      <p className="mt-0.5 text-meta text-text-secondary">
                        {voiceInputMode === 'push_to_talk'
                          ? 'Set your Push to Talk key under Keybinds. You start muted — hold the key to speak.'
                          : 'Your mic opens automatically when you speak.'}
                      </p>
                    </div>
                    <Segmented
                      value={voiceInputMode}
                      onChange={(mode) => setNotifications((prev) => ({ ...prev, voiceInputMode: mode }))}
                      options={[
                        { value: 'voice_activity', label: 'Voice Activity' },
                        { value: 'push_to_talk', label: 'Push to Talk' },
                      ]}
                    />
                  </div>
                </section>

                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Processing</h3>
                  <div className="mt-2 divide-y divide-border-subtle">
                    <ToggleRow
                      title="Noise suppression"
                      description="Filters out steady background noise like fans and keyboards."
                      on={Boolean(mergedNotifications['noiseSuppression'] ?? true)}
                      onToggle={() => setNotifications((prev) => ({ ...prev, noiseSuppression: !Boolean(prev['noiseSuppression'] ?? true) }))}
                    />
                    <ToggleRow
                      title="Echo cancellation"
                      description="Stops your speakers from bleeding back into your mic."
                      on={Boolean(mergedNotifications['echoCancellation'] ?? true)}
                      onToggle={() => setNotifications((prev) => ({ ...prev, echoCancellation: !Boolean(prev['echoCancellation'] ?? true) }))}
                    />
                    <ToggleRow
                      title="Automatic gain control"
                      description="Levels your mic volume. Can add hiss on some setups."
                      on={Boolean(mergedNotifications['autoGainControl'] ?? false)}
                      onToggle={() => setNotifications((prev) => ({ ...prev, autoGainControl: !Boolean(prev['autoGainControl'] ?? false) }))}
                    />
                  </div>
                </section>

                <div className="mt-8">
                  <Button
                    loading={saving}
                    onClick={() => {
                      void saveSettings().then(() => {
                        // Re-acquire the microphone with updated noise suppression /
                        // echo cancellation / auto gain constraints so changes take effect
                        // immediately without requiring a mute/unmute cycle.
                        void useVoiceStore.getState().reapplyAudioConstraints();
                      });
                    }}
                  >
                    Save Voice Settings
                  </Button>
                </div>
              </div>
            )}

            {activeSection === 'notifications' && (
              <div>
                <SettingsHeader
                  title="Notifications"
                  description="Decide when Paracord should reach out and how loud it gets."
                />
                <section>
                  <div className="divide-y divide-border-subtle">
                    <ToggleRow
                      title="Desktop notifications"
                      description="Surface new messages as system notifications."
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
                    >
                      {notifPermission === 'denied' && notifEnabled && (
                        <p className="mt-1.5 text-meta text-accent-warning">
                          Your system blocked notification permission. Toggle again to ask once more.
                        </p>
                      )}
                      {notifPermission === 'granted' && notifEnabled && (
                        <p className="mt-1.5 text-meta text-accent-success">Permission granted.</p>
                      )}
                    </ToggleRow>
                    <ToggleRow
                      title="Message sound"
                      description="Play a soft chime when a new message arrives."
                      on={Boolean(mergedNotifications.messageSound)}
                      onToggle={() => setNotifications((prev) => ({ ...prev, messageSound: !Boolean(prev.messageSound) }))}
                    />
                    <ToggleRow
                      title="Low bandwidth mode"
                      description="Hide heavy image previews and cut back on automatic media loading."
                      on={Boolean(mergedNotifications.lowBandwidthMode)}
                      onToggle={() => {
                        const next = !Boolean(mergedNotifications.lowBandwidthMode);
                        setLowBandwidthModeUI(next);
                        setNotifications((prev) => ({ ...prev, lowBandwidthMode: next }));
                      }}
                    />
                  </div>
                </section>

                <div className="mt-8">
                  <Button loading={saving} onClick={() => void saveSettings()}>Save Notifications</Button>
                </div>
              </div>
            )}

            {activeSection === 'activity' && (
              <div>
                <SettingsHeader
                  title="Activity Privacy"
                  description="Control what Paracord shares about the apps and games you use."
                />
                <section>
                  <div className="divide-y divide-border-subtle">
                    <ToggleRow
                      title="Display current activity"
                      description="Show the game or app you're using in your presence."
                      on={Boolean(activityDetectionEnabled)}
                      onToggle={() => setActivityDetectionEnabled(!Boolean(activityDetectionEnabled))}
                    />
                  </div>
                </section>

                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Detected apps</h3>
                  <p className="mt-2 max-w-xl text-sm text-text-secondary">
                    Turn off any app you'd rather keep private. Paracord stops reporting it right away.
                  </p>
                  {visibleKnownActivityApps.length === 0 ? (
                    <div className="mt-4 flex items-start gap-3 rounded-md border border-border-subtle bg-bg-tertiary px-4 py-4">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-text-muted">
                        <Eye size={18} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-label text-text-primary">Nothing detected yet</div>
                        <p className="mt-0.5 text-meta text-text-secondary">
                          Launch a game or app while Paracord is open and it'll appear here to manage.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 divide-y divide-border-subtle">
                      {visibleKnownActivityApps.map((appId) => {
                        const enabled = !disabledActivityApps.has(appId);
                        return (
                          <div key={appId} className="flex items-center justify-between gap-4 py-3">
                            <div className="min-w-0">
                              <div className="truncate text-label text-text-primary">{readableAppName(appId)}</div>
                              <div className="truncate font-code text-meta text-text-muted">{appId}</div>
                            </div>
                            <ToggleSwitch on={enabled} onToggle={() => toggleActivityApp(appId)} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <div className="mt-8">
                  <Button loading={saving} onClick={() => void saveActivitySettings()}>Save Activity Privacy</Button>
                </div>
              </div>
            )}

            {activeSection === 'keybinds' && (
              <div>
                <SettingsHeader
                  title="Keybinds"
                  description="Global shortcuts for voice controls. Focus a field and press the combination."
                />
                <section>
                  <div className="divide-y divide-border-subtle">
                    {[
                      { key: 'toggleMute' as const, action: 'Toggle mute' },
                      { key: 'toggleDeafen' as const, action: 'Toggle deafen' },
                      { key: 'pushToTalk' as const, action: 'Push to talk' },
                    ].map((kb) => (
                      <div key={kb.key} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <span className="text-label text-text-primary">{kb.action}</span>
                        <input
                          className="h-10 w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 font-code text-sm text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)] sm:w-52"
                          value={capturingKeybind === kb.key ? 'Press keys…' : String(mergedKeybinds[kb.key] ?? '')}
                          readOnly
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
                </section>

                <div className="mt-8">
                  <Button loading={saving} onClick={() => void saveSettings()}>Save Keybinds</Button>
                </div>
              </div>
            )}

            {activeSection === 'identity' && (
              <div>
                <SettingsHeader
                  title="Identity Portability"
                  description="Verify your key, or move your identity between Paracord servers."
                />

                {identityStatus && (
                  <div
                    className={cn(
                      'mb-6 rounded-md border px-4 py-3 text-sm font-medium',
                      identityStatus.toLowerCase().includes('failed')
                        ? 'border-accent-danger/30 bg-danger-tint text-accent-danger'
                        : 'border-accent-success/30 bg-success-tint text-accent-success'
                    )}
                    role={identityStatus.toLowerCase().includes('failed') ? 'alert' : 'status'}
                  >
                    {identityStatus}
                  </div>
                )}

                <section>
                  <h3 className="text-section uppercase text-text-muted">Current identity key</h3>
                  <p className="mt-2 max-w-xl text-sm text-text-secondary">
                    Share this fingerprint with trusted contacts so they can confirm it's really you.
                  </p>
                  {ownIdentityFingerprint ? (
                    <div className="mt-3 rounded-md border border-border-subtle bg-bg-tertiary px-4 py-3">
                      <div className="text-section uppercase text-text-muted">Fingerprint</div>
                      <div className="mt-1.5 break-all font-code text-sm text-text-primary">{ownIdentityFingerprint}</div>
                    </div>
                  ) : (
                    <p className="mt-3 rounded-md border border-border-subtle bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
                      No public identity key is attached to this account yet.
                    </p>
                  )}
                </section>

                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Export identity</h3>
                  <p className="mt-2 max-w-xl text-sm text-text-secondary">
                    Download a signed bundle you can import into another Paracord server.
                  </p>
                  <div className="mt-2 divide-y divide-border-subtle">
                    <ToggleRow
                      title="Include messages"
                      description="Bundle your message history. This can get large."
                      on={exportIncludeMessages}
                      onToggle={() => setExportIncludeMessages(!exportIncludeMessages)}
                    />
                    <ToggleRow
                      title="Include relationships"
                      description="Bundle your friends and block list."
                      on={exportIncludeRelationships}
                      onToggle={() => setExportIncludeRelationships(!exportIncludeRelationships)}
                    />
                  </div>
                  <div className="mt-5">
                    <Button loading={exporting} onClick={() => void handleExportIdentity()}>
                      {!exporting && <Download size={16} className="mr-1.5" />}
                      Export Identity
                    </Button>
                  </div>
                </section>

                <section className="mt-9 border-t border-border-subtle pt-8">
                  <h3 className="text-section uppercase text-text-muted">Import identity</h3>
                  <p className="mt-2 max-w-xl text-sm text-text-secondary">
                    Bring in a bundle from another server. Imported data is merged with this account.
                  </p>
                  <div className="mt-4">
                    <label htmlFor="identity-file" className="text-label text-text-primary">Bundle file</label>
                    <input
                      id="identity-file"
                      type="file"
                      accept=".json"
                      onChange={handleImportFileSelect}
                      className="mt-2.5 block w-full max-w-md text-sm text-text-muted file:mr-3 file:rounded-sm file:border file:border-border-subtle file:bg-bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-text-primary hover:file:bg-bg-mod-subtle"
                    />
                    {importFile && (
                      <p className="mt-2 text-meta text-text-secondary">Selected: {importFile.name}</p>
                    )}
                  </div>

                  {importPreview && (
                    <div className="mt-5 rounded-md border border-border-subtle bg-bg-tertiary px-4 py-4">
                      <div className="text-section uppercase text-text-muted">Import preview</div>
                      <dl className="mt-3 space-y-2 text-sm">
                        {([
                          ['Origin server', String(importPreview.origin_server ?? 'Unknown')],
                          ['Username', (importPreview.user as Record<string, unknown>)?.username ? String((importPreview.user as Record<string, unknown>).username) : 'Unknown'],
                          ['Messages', String(Array.isArray(importPreview.messages) ? importPreview.messages.length : 0)],
                          ['Attachments', String(Array.isArray(importPreview.attachments) ? importPreview.attachments.length : 0)],
                          ['Prekeys', String(Array.isArray((importPreview.prekeys as Record<string, unknown> | undefined)?.one_time_prekeys) ? ((importPreview.prekeys as Record<string, unknown>).one_time_prekeys as unknown[]).length : 0)],
                          ['Relationships', String(Array.isArray(importPreview.relationships) ? importPreview.relationships.length : 0)],
                          ['Guild memberships', String(Array.isArray(importPreview.guilds) ? importPreview.guilds.length : 0)],
                          ['Exported at', importPreview.exported_at ? new Date(String(importPreview.exported_at)).toLocaleString() : 'Unknown'],
                        ] as [string, string][]).map(([label, value]) => (
                          <div key={label} className="flex justify-between gap-4">
                            <dt className="text-text-muted">{label}</dt>
                            <dd className="text-right font-medium text-text-primary">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <div className="mt-4 flex items-start gap-2.5 rounded-md border border-accent-warning/30 bg-warning-tint px-3.5 py-3 text-meta text-accent-warning">
                        <ShieldAlert size={15} className="mt-0.5 shrink-0" />
                        <span>This merges the imported identity into your account. Profile fields will be overwritten.</span>
                      </div>
                    </div>
                  )}
                  <div className="mt-5">
                    <Button variant="secondary" loading={importing} disabled={!importPreview} onClick={() => void handleImportIdentity()}>
                      Import Identity
                    </Button>
                  </div>
                </section>
              </div>
            )}

            {activeSection === 'server' && userIsAdmin && (
              <div>
                <SettingsHeader
                  title="Server"
                  description="Administrative controls for this Paracord instance."
                />
                <section>
                  <div className="rounded-md border border-accent-warning/30 bg-warning-tint p-5">
                    <div className="flex items-start gap-3">
                      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-accent-warning" />
                      <div className="min-w-0">
                        <h3 className="text-subhead text-text-primary">Update &amp; restart</h3>
                        <p className="mt-1 max-w-xl text-sm leading-relaxed text-text-secondary">
                          Pull the latest code, rebuild the client and server, then restart. Everyone connected is
                          briefly disconnected.
                        </p>
                        <div className="mt-4">
                          {!restartConfirm ? (
                            <Button variant="secondary" disabled={restarting} onClick={() => setRestartConfirm(true)}>
                              Update &amp; restart server
                            </Button>
                          ) : (
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="text-label text-text-primary">Are you sure?</span>
                              <Button
                                variant="destructive"
                                loading={restarting}
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
                                Yes, restart now
                              </Button>
                              <Button variant="ghost" disabled={restarting} onClick={() => setRestartConfirm(false)}>
                                Cancel
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {activeSection === 'about' && (
              <div>
                <SettingsHeader title="About" description="What you're running and who built it." />
                <section>
                  <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle pb-4">
                    <div className="font-display text-title text-text-primary">{APP_NAME}</div>
                    <div className="font-code text-meta text-text-muted">Version 0.4.0</div>
                  </div>
                  <p className="mt-5 max-w-xl text-body text-text-secondary">
                    A decentralized, self-hostable Discord alternative built with Rust, Tauri, and React — with its own
                    end-to-end-encrypted media engine.
                  </p>
                </section>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-label outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
        active
          ? 'bg-accent-tint text-text-primary'
          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
      )}
    >
      {active && (
        <span aria-hidden className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-secondary" />
      )}
      <Icon
        size={17}
        className={cn('shrink-0', active ? 'text-accent-primary' : 'text-text-muted group-hover:text-text-secondary')}
      />
      <span className="truncate">{item.label}</span>
    </button>
  );
}

function SettingsHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-8">
      <h2 className="text-heading text-text-primary">{title}</h2>
      {description && (
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-text-secondary">{description}</p>
      )}
    </header>
  );
}

function ToggleRow({
  title,
  description,
  on,
  onToggle,
  disabled = false,
  children,
}: {
  title: string;
  description?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="min-w-0">
        <div className="text-label text-text-primary">{title}</div>
        {description && <p className="mt-0.5 text-meta leading-relaxed text-text-secondary">{description}</p>}
        {children}
      </div>
      <ToggleSwitch on={on} onToggle={onToggle} disabled={disabled} />
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex shrink-0 rounded-sm border border-border-subtle bg-bg-tertiary p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-[6px] px-3 py-1.5 text-label outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
              selected
                ? 'bg-accent-primary text-text-on-accent shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// Toggle track ramps --bg-mod-strong (off) → --accent-primary (on) per design-spec
// §7; the knob is the only pill, focus renders the layered ring.
function ToggleSwitch({ on, onToggle, disabled = false }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'bg-accent-primary' : 'bg-bg-mod-strong'
      )}
    >
      <span
        className={cn(
          'inline-block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-[140ms] ease-[var(--ease-out)]',
          on ? 'translate-x-[23px]' : 'translate-x-[3px]'
        )}
      />
    </button>
  );
}
