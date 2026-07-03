import { useState, useEffect } from 'react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';

export function SettingsPanel() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminApi
      .getSettings()
      .then(({ data }) => setSettings(data))
      .catch((err) => {
        toast.error(`Failed to load settings: ${extractApiError(err)}`);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data } = await adminApi.updateSettings(settings);
      setSettings(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast.error(`Failed to update settings: ${extractApiError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const update = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-text-primary">Server Settings</h2>

      <div className="card-stack-roomy max-w-xl">
        {/* Server Name */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Server Name
          </label>
          <input
            aria-label="Server Name"
            type="text"
            value={settings.server_name || ''}
            onChange={(e) => update('server_name', e.target.value)}
            className="input-field"
          />
        </div>

        {/* Server Description */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Server Description
          </label>
          <textarea
            aria-label="Server Description"
            value={settings.server_description || ''}
            onChange={(e) => update('server_description', e.target.value)}
            rows={3}
            className="input-field resize-none"
          />
        </div>

        {/* Registration Toggle */}
        <div className="card-surface flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
          <div>
            <p className="font-medium text-text-primary">Open Registration</p>
            <p className="text-sm text-text-muted">Allow new users to register accounts</p>
          </div>
          <button
            onClick={() =>
              update('registration_enabled', settings.registration_enabled === 'true' ? 'false' : 'true')
            }
            type="button"
            role="switch"
            aria-checked={settings.registration_enabled === 'true'}
            aria-label="Toggle open registration"
            className={`relative h-7 w-12 rounded-full transition-colors ${
              settings.registration_enabled === 'true'
                ? 'bg-accent-success'
                : 'bg-bg-mod-strong'
            }`}
          >
            <div
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                settings.registration_enabled === 'true' ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Max guilds per user */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Max Guilds Per User
          </label>
          <input
            aria-label="Max Guilds Per User"
            type="number"
            value={settings.max_guilds_per_user || '100'}
            onChange={(e) => update('max_guilds_per_user', e.target.value)}
            className="input-field"
          />
        </div>

        {/* Max members per guild */}
        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Max Members Per Guild
          </label>
          <input
            aria-label="Max Members Per Guild"
            type="number"
            value={settings.max_members_per_guild || '1000'}
            onChange={(e) => update('max_members_per_guild', e.target.value)}
            className="input-field"
          />
        </div>

        {/* ── Guild Storage ─────────────────────────────────── */}
        <div className="border-t border-border-subtle pt-6">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Guild Storage Limits
          </h3>
        </div>

        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Max Guild Storage Quota (MB)
          </label>
          <input
            aria-label="Max Guild Storage Quota in MB"
            type="number"
            value={settings.max_guild_storage_quota || ''}
            onChange={(e) => update('max_guild_storage_quota', e.target.value)}
            placeholder="No limit"
            className="input-field"
          />
          <p className="mt-1 text-xs text-text-muted">
            Upper limit for per-guild storage quotas (in MB). Guild owners cannot set a quota higher than this.
          </p>
        </div>

        {/* ── Federation File Cache ─────────────────────────── */}
        <div className="border-t border-border-subtle pt-6">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Federation File Cache
          </h3>
        </div>

        <div className="card-surface flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/70 px-6 py-6">
          <div>
            <p className="font-medium text-text-primary">Federation File Cache</p>
            <p className="text-sm text-text-muted">Cache files fetched from federated servers locally</p>
          </div>
          <button
            onClick={() =>
              update('federation_file_cache_enabled', settings.federation_file_cache_enabled === 'true' ? 'false' : 'true')
            }
            type="button"
            role="switch"
            aria-checked={settings.federation_file_cache_enabled === 'true'}
            aria-label="Toggle federation file cache"
            className={`relative h-7 w-12 rounded-full transition-colors ${
              settings.federation_file_cache_enabled === 'true'
                ? 'bg-accent-success'
                : 'bg-bg-mod-strong'
            }`}
          >
            <div
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                settings.federation_file_cache_enabled === 'true' ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Federation Cache Max Size (MB)
          </label>
          <input
            aria-label="Federation Cache Max Size in MB"
            type="number"
            value={settings.federation_file_cache_max_size || ''}
            onChange={(e) => update('federation_file_cache_max_size', e.target.value)}
            placeholder="No limit"
            className="input-field"
          />
        </div>

        <div>
          <label className="mb-3 block text-sm font-medium text-text-secondary">
            Federation Cache TTL (hours)
          </label>
          <input
            aria-label="Federation Cache TTL in hours"
            type="number"
            value={settings.federation_file_cache_ttl_hours || ''}
            onChange={(e) => update('federation_file_cache_ttl_hours', e.target.value)}
            placeholder="Default"
            className="input-field"
          />
          <p className="mt-1 text-xs text-text-muted">
            How long cached federated files are kept before re-fetching from the origin server.
          </p>
        </div>

        {/* Save button */}
        <div className="settings-action-row">
          <Button
            onClick={handleSave}
            disabled={saving}
            style={
              saved
                ? {
                    backgroundColor: 'var(--accent-success)',
                    borderColor: 'color-mix(in srgb, var(--accent-success) 72%, white 28%)',
                    boxShadow:
                      '0 10px 24px color-mix(in srgb, var(--accent-success) 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--accent-success) 62%, white 38%) inset',
                  }
                : undefined
            }
          >
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
