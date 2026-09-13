import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import {
  Button,
  Divider,
  SettingsSectionHeader,
  TextField,
  ToggleRow,
} from '../../components/ui';
import { Textarea } from '../../components/ui/Input';

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
      <SettingsSectionHeader
        title="Server settings"
        description="Configure how this deployment behaves for everyone on it."
      />

      <div className="flex max-w-xl flex-col gap-8">
        <section className="flex flex-col gap-5">
          <TextField
            id="setting-server-name"
            label="Server name"
            type="text"
            value={settings.server_name || ''}
            onChange={(e) => update('server_name', e.target.value)}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="setting-server-description"
              className="text-label font-medium text-text-secondary"
            >
              Server description
            </label>
            <Textarea
              id="setting-server-description"
              value={settings.server_description || ''}
              onChange={(e) => update('server_description', e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>

          <ToggleRow
            label="Open registration"
            description="Allow anyone to create a new account on this server."
            checked={settings.registration_enabled === 'true'}
            onChange={(next) => update('registration_enabled', next ? 'true' : 'false')}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id="setting-max-guilds"
              label="Max guilds per user"
              type="number"
              value={settings.max_guilds_per_user || '100'}
              onChange={(e) => update('max_guilds_per_user', e.target.value)}
            />
            <TextField
              id="setting-max-members"
              label="Max members per guild"
              type="number"
              value={settings.max_members_per_guild || '1000'}
              onChange={(e) => update('max_members_per_guild', e.target.value)}
            />
          </div>
        </section>

        <section className="flex flex-col gap-5">
          <Divider />
          <h3 className="pc-display text-heading text-text-primary">Guild storage limits</h3>
          <TextField
            id="setting-storage-quota"
            label="Max guild storage quota (MB)"
            hint="Upper limit for per-guild storage quotas. Guild owners cannot set a quota higher than this."
            type="number"
            value={settings.max_guild_storage_quota || ''}
            onChange={(e) => update('max_guild_storage_quota', e.target.value)}
            placeholder="No limit"
          />
        </section>

        <section className="flex flex-col gap-5">
          <Divider />
          <h3 className="pc-display text-heading text-text-primary">Federation file cache</h3>

          <ToggleRow
            label="Cache federated files"
            description="Store files fetched from federated servers locally to serve them faster."
            checked={settings.federation_file_cache_enabled === 'true'}
            onChange={(next) =>
              update('federation_file_cache_enabled', next ? 'true' : 'false')
            }
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id="setting-cache-size"
              label="Cache max size (MB)"
              type="number"
              value={settings.federation_file_cache_max_size || ''}
              onChange={(e) => update('federation_file_cache_max_size', e.target.value)}
              placeholder="No limit"
            />
            <TextField
              id="setting-cache-ttl"
              label="Cache TTL (hours)"
              hint="How long cached files are kept before re-fetching from the origin."
              type="number"
              value={settings.federation_file_cache_ttl_hours || ''}
              onChange={(e) => update('federation_file_cache_ttl_hours', e.target.value)}
              placeholder="Default"
            />
          </div>
        </section>

        <div className="flex flex-col gap-5">
          <Divider />
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} loading={saving} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            {saved && (
              <span className="inline-flex items-center gap-1.5 text-label font-medium text-accent-success">
                <Check size={16} aria-hidden />
                Saved
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
