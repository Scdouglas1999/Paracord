import { useEffect, useMemo, useState } from 'react';
import { X, Monitor, Sun, Moon } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useMediaDevices } from '../../hooks/useMediaDevices';
import { APP_NAME } from '../../lib/constants';
import { isAdmin } from '../../types';
import { adminApi } from '../../api/admin';

interface UserSettingsProps {
  onClose: () => void;
}

type SettingsSection = 'account' | 'appearance' | 'voice' | 'notifications' | 'keybinds' | 'about' | 'server';

const NAV_ITEMS: { id: SettingsSection; label: string; adminOnly?: boolean }[] = [
  { id: 'account', label: 'My Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'voice', label: 'Voice & Video' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'keybinds', label: 'Keybinds' },
  { id: 'server', label: 'Server', adminOnly: true },
  { id: 'about', label: 'About' },
];

export function UserSettings({ onClose }: UserSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('account');
  const user = useAuthStore(s => s.user);
  const settings = useAuthStore(s => s.settings);
  const logout = useAuthStore(s => s.logout);
  const fetchSettings = useAuthStore(s => s.fetchSettings);
  const updateSettings = useAuthStore(s => s.updateSettings);
  const updateUser = useAuthStore(s => s.updateUser);
  const setThemeUI = useUIStore((s) => s.setTheme);
  const [theme, setTheme] = useState<'dark' | 'light' | 'amoled'>('dark');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [locale, setLocale] = useState('en-US');
  const [messageCompact, setMessageCompact] = useState(false);
  const [notifications, setNotifications] = useState<Record<string, unknown>>({});
  const [keybinds, setKeybinds] = useState<Record<string, unknown>>({});
  const [capturingKeybind, setCapturingKeybind] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
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

  useEffect(() => {
    void fetchSettings();
  }, []);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name || '');
      setBio(user.bio || '');
    }
  }, [user?.id, user?.display_name, user?.bio]);

  useEffect(() => {
    if (settings) {
      const notif = settings.notifications as Record<string, unknown> | undefined;
      setTheme(settings.theme);
      setLocale(settings.locale || 'en-US');
      setMessageCompact(settings.message_display_compact || false);
      setNotifications((settings.notifications as Record<string, unknown>) || {});
      setKeybinds((settings.keybinds as Record<string, unknown>) || {});
      if (typeof notif?.['audioInputDeviceId'] === 'string') {
        selectAudioInput(notif['audioInputDeviceId'] as string);
      }
      if (typeof notif?.['audioOutputDeviceId'] === 'string') {
        selectAudioOutput(notif['audioOutputDeviceId'] as string);
      }
    }
  }, [settings]);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const handleThemeChange = (newTheme: 'dark' | 'light' | 'amoled') => {
    setTheme(newTheme);
    setThemeUI(newTheme);
  };

  const mergedNotifications = useMemo<Record<string, unknown>>(
    () => ({
      desktop: true,
      messageSound: true,
      ...notifications,
    }),
    [notifications]
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

  const saveProfile = async () => {
    setSaving(true);
    setStatusText(null);
    try {
      await updateUser({
        display_name: displayName || undefined,
        bio: bio || undefined,
      });
      setStatusText('Profile updated.');
    } catch {
      setStatusText('Failed to update profile.');
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    setStatusText(null);
    try {
      await updateSettings({
        theme,
        locale,
        message_display_compact: messageCompact,
        notifications: {
          ...mergedNotifications,
          audioInputDeviceId: selectedAudioInput,
          audioOutputDeviceId: selectedAudioOutput,
        },
        keybinds: mergedKeybinds,
      });
      setThemeUI(theme);
      setStatusText('Settings saved.');
    } catch {
      setStatusText('Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex bg-bg-tertiary/95 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="pointer-events-none absolute -left-20 top-0 h-72 w-72 rounded-full bg-accent-primary/20 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-accent-success/10 blur-[140px]" />
      {/* Left navigation */}
      <div
        className="relative z-10 w-72 shrink-0 overflow-y-auto border-r border-border-subtle/70 bg-bg-secondary/65 px-4 py-10"
      >
        <div className="ml-auto w-full max-w-[236px]">
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
            onClick={() => { logout(); onClose(); }}
            className="settings-nav-item"
            style={{ color: 'var(--accent-danger)', borderColor: 'transparent' }}
          >
            Log Out
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="relative z-10 flex-1 overflow-y-auto px-6 py-10">
        <div className="w-full">
        {/* Close button */}
        <div className="fixed right-6 top-5 z-20 flex flex-col items-center gap-1">
          <button onClick={onClose} className="command-icon-btn rounded-full border border-border-strong bg-bg-secondary/75">
            <X size={18} />
          </button>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Esc</span>
        </div>
        {statusText && (
          <div className="mb-5 rounded-xl border border-border-subtle bg-bg-mod-subtle px-4 py-3 text-sm font-medium" style={{ color: statusText.includes('Failed') ? 'var(--accent-danger)' : 'var(--accent-success)' }}>
            {statusText}
          </div>
        )}

        {activeSection === 'account' && (
          <div className="settings-surface-card w-full min-h-[calc(100vh-13.5rem)] !p-0 overflow-hidden">
            <div className="p-5 pb-0">
              <h2 className="settings-section-title mb-4">My Account</h2>
            </div>
            <div>
              <div
                className="h-28"
                style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-primary-hover) 100%)' }}
              />
              <div className="px-6 pb-6">
                <div className="-mt-9 mb-5 flex items-end">
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
                <div
                  className="space-y-6 rounded-2xl border border-border-subtle bg-bg-tertiary/80 p-6"
                >
                  <div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Username</div>
                      <div className="text-sm font-medium text-text-primary">{user?.username || 'Unknown'}</div>
                    </div>
                  </div>
                  <div>
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Display Name</div>
                      <input className="input-field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Bio</div>
                      <textarea className="input-field resize-none" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Email</div>
                      <div className="text-sm font-medium text-text-primary">
                        {user?.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : '***@***'}
                      </div>
                    </div>
                  </div>
                  <button className="btn-primary" onClick={() => void saveProfile()} disabled={saving}>
                    {saving ? 'Saving...' : 'Save Profile'}
                  </button>
                </div>
                <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="min-h-[5.25rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-3.5 py-3.5">
                    <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Theme</div>
                    <div className="mt-1 text-base font-semibold text-text-primary">{theme.toUpperCase()}</div>
                  </div>
                  <div className="min-h-[5.25rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-3.5 py-3.5">
                    <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Locale</div>
                    <div className="mt-1 text-base font-semibold text-text-primary">{locale}</div>
                  </div>
                  <div className="min-h-[5.25rem] rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-3.5 py-3.5">
                    <div className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Message Density</div>
                    <div className="mt-1 text-base font-semibold text-text-primary">
                      {messageCompact ? 'Compact' : 'Comfortable'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeSection === 'appearance' && (
          <div className="settings-surface-card w-full min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">Appearance</h2>
            <div className="mb-6">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Theme</div>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { id: 'dark' as const, label: 'Dark', icon: <Moon size={20} /> },
                  { id: 'light' as const, label: 'Light', icon: <Sun size={20} /> },
                  { id: 'amoled' as const, label: 'AMOLED', icon: <Monitor size={20} /> },
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => handleThemeChange(t.id)}
                    className="flex flex-col items-center gap-2.5 rounded-xl border px-6 py-5 transition-colors"
                    style={{
                      backgroundColor: theme === t.id ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                      color: theme === t.id ? '#fff' : 'var(--text-secondary)',
                      borderColor: theme === t.id ? 'var(--accent-primary)' : 'var(--border-subtle)',
                    }}
                  >
                    {t.icon}
                    <span className="text-sm font-medium">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-5">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Locale</span>
                <input className="input-field mt-2" value={locale} onChange={(e) => setLocale(e.target.value)} />
              </label>
              <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">Compact Message Display</div>
                </div>
                <ToggleSwitch on={messageCompact} onToggle={() => setMessageCompact(!messageCompact)} />
              </div>
            </div>
            <button className="btn-primary mt-5" onClick={() => void saveSettings()} disabled={saving}>
              {saving ? 'Saving...' : 'Save Appearance'}
            </button>
          </div>
        )}

        {activeSection === 'voice' && (
          <div className="settings-surface-card w-full min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">Voice & Video</h2>
            <div className="space-y-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Input Device</span>
                <select
                  className="select-field mt-2"
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
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Output Device</span>
                <select
                  className="select-field mt-2"
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
              <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">Noise Suppression</div>
                  <div className="text-xs text-text-muted">Reduces background noise</div>
                </div>
                <ToggleSwitch
                  on={Boolean(mergedNotifications['noiseSuppression'] ?? true)}
                  onToggle={() => setNotifications((prev) => ({ ...prev, noiseSuppression: !Boolean(prev['noiseSuppression'] ?? true) }))}
                />
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">Echo Cancellation</div>
                  <div className="text-xs text-text-muted">Reduces echo from speakers</div>
                </div>
                <ToggleSwitch
                  on={Boolean(mergedNotifications['echoCancellation'] ?? true)}
                  onToggle={() => setNotifications((prev) => ({ ...prev, echoCancellation: !Boolean(prev['echoCancellation'] ?? true) }))}
                />
              </div>
            </div>
            <button className="btn-primary mt-5" onClick={() => {
              void saveSettings().then(() => {
                // Re-acquire the microphone with updated noise suppression /
                // echo cancellation constraints so changes take effect
                // immediately without requiring a mute/unmute cycle.
                void useVoiceStore.getState().reapplyAudioConstraints();
              });
            }} disabled={saving}>
              {saving ? 'Saving...' : 'Save Voice Settings'}
            </button>
          </div>
        )}

        {activeSection === 'notifications' && (
          <div className="settings-surface-card w-full min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">Notifications</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">Desktop Notifications</div>
                  <div className="text-xs text-text-muted">Show desktop notifications for new messages</div>
                </div>
                <ToggleSwitch
                  on={Boolean(mergedNotifications.desktop)}
                  onToggle={() => setNotifications((prev) => ({ ...prev, desktop: !Boolean(prev.desktop) }))}
                />
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5">
                <div>
                  <div className="text-sm font-medium text-text-primary">Message Sound</div>
                  <div className="text-xs text-text-muted">Play a sound for incoming messages</div>
                </div>
                <ToggleSwitch
                  on={Boolean(mergedNotifications.messageSound)}
                  onToggle={() => setNotifications((prev) => ({ ...prev, messageSound: !Boolean(prev.messageSound) }))}
                />
              </div>
            </div>
            <button className="btn-primary mt-5" onClick={() => void saveSettings()} disabled={saving}>
              {saving ? 'Saving...' : 'Save Notifications'}
            </button>
          </div>
        )}

        {activeSection === 'keybinds' && (
          <div className="settings-surface-card w-full min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">Keybinds</h2>
            <div className="space-y-3">
              {[
                { key: 'toggleMute' as const, action: 'Toggle Mute' },
                { key: 'toggleDeafen' as const, action: 'Toggle Deafen' },
                { key: 'pushToTalk' as const, action: 'Push to Talk' },
              ].map(kb => (
                <div
                  key={kb.key}
                  className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3.5"
                >
                  <span className="text-sm font-medium text-text-primary">{kb.action}</span>
                  <input
                    className="h-10 w-48 rounded-lg border border-border-subtle bg-bg-tertiary px-3 py-2 text-sm font-mono text-text-muted outline-none focus:border-accent-primary"
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
            <button className="btn-primary mt-5" onClick={() => void saveSettings()} disabled={saving}>
              {saving ? 'Saving...' : 'Save Keybinds'}
            </button>
          </div>
        )}

        {activeSection === 'server' && userIsAdmin && (
          <div className="settings-surface-card w-full min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">Server</h2>
            <div className="space-y-4">
              <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Update & Restart</div>
                <div className="mt-2 text-sm text-text-muted">
                  Pull the latest code from git, rebuild the client and server, then restart. All connected users will be temporarily disconnected.
                </div>
                <div className="mt-4">
                  {!restartConfirm ? (
                    <button
                      className="btn-primary"
                      style={{ backgroundColor: 'var(--accent-warning, #f59e0b)' }}
                      onClick={() => setRestartConfirm(true)}
                      disabled={restarting}
                    >
                      Update & Restart Server
                    </button>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-text-primary">Are you sure?</span>
                      <button
                        className="btn-primary"
                        style={{ backgroundColor: 'var(--accent-danger)' }}
                        disabled={restarting}
                        onClick={async () => {
                          setRestarting(true);
                          try {
                            await adminApi.restartUpdate();
                          } catch {
                            setRestarting(false);
                            setRestartConfirm(false);
                            setStatusText('Failed to trigger restart.');
                          }
                        }}
                      >
                        {restarting ? 'Restarting...' : 'Yes, restart now'}
                      </button>
                      <button
                        className="btn-primary"
                        style={{ backgroundColor: 'var(--bg-tertiary)' }}
                        onClick={() => setRestartConfirm(false)}
                        disabled={restarting}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeSection === 'about' && (
          <div className="settings-surface-card w-full min-h-[calc(100vh-13.5rem)]">
            <h2 className="settings-section-title mb-6">About</h2>
            <div className="space-y-3">
              <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-3">
                <div className="text-sm font-semibold text-text-primary">{APP_NAME}</div>
                <div className="mt-1 text-xs text-text-muted">Version 0.1.0</div>
              </div>
              <div className="text-sm leading-6 text-text-muted">
                A decentralized, self-hostable Discord alternative built with Rust, Tauri, and React.
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function ToggleSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="relative h-6 w-11 rounded-full border transition-colors"
      style={{
        backgroundColor: on ? 'var(--accent-success)' : 'var(--interactive-muted)',
        borderColor: on ? 'color-mix(in srgb, var(--accent-success) 75%, white 25%)' : 'var(--border-subtle)',
      }}
    >
      <div
        className="absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-all"
        style={{ left: on ? '18px' : '2px' }}
      />
    </button>
  );
}
