import { useState, useEffect, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { Input, Textarea } from '../../components/ui/Input';

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={htmlFor} className="block text-label font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {hint && <p className="text-meta text-text-muted">{hint}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-label font-semibold text-text-primary">{label}</p>
        <p className="text-meta text-text-muted">{description}</p>
      </div>
      <button
        onClick={onChange}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        className={`relative h-6 w-11 shrink-0 rounded-full outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${
          checked ? 'bg-accent-primary' : 'bg-bg-mod-strong'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-[140ms] ease-[var(--ease-out)] ${
            checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

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
      <header className="mb-6">
        <h2 className="font-display text-heading text-text-primary">Server settings</h2>
        <p className="mt-1 text-body text-text-secondary">
          Configure how this deployment behaves for everyone on it.
        </p>
      </header>

      <div className="max-w-xl space-y-8">
        <section className="space-y-5">
          <Field label="Server name" htmlFor="setting-server-name">
            <Input
              id="setting-server-name"
              aria-label="Server Name"
              type="text"
              value={settings.server_name || ''}
              onChange={(e) => update('server_name', e.target.value)}
            />
          </Field>

          <Field label="Server description" htmlFor="setting-server-description">
            <Textarea
              id="setting-server-description"
              aria-label="Server Description"
              value={settings.server_description || ''}
              onChange={(e) => update('server_description', e.target.value)}
              rows={3}
              className="resize-none"
            />
          </Field>

          <div className="rounded-md border border-border-subtle bg-bg-tertiary/40 px-4 py-3">
            <Toggle
              checked={settings.registration_enabled === 'true'}
              onChange={() =>
                update('registration_enabled', settings.registration_enabled === 'true' ? 'false' : 'true')
              }
              label="Open registration"
              description="Allow anyone to create a new account on this server."
              ariaLabel="Toggle open registration"
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Max guilds per user" htmlFor="setting-max-guilds">
              <Input
                id="setting-max-guilds"
                aria-label="Max Guilds Per User"
                type="number"
                value={settings.max_guilds_per_user || '100'}
                onChange={(e) => update('max_guilds_per_user', e.target.value)}
              />
            </Field>
            <Field label="Max members per guild" htmlFor="setting-max-members">
              <Input
                id="setting-max-members"
                aria-label="Max Members Per Guild"
                type="number"
                value={settings.max_members_per_guild || '1000'}
                onChange={(e) => update('max_members_per_guild', e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-5 border-t border-border-subtle pt-7">
          <h3 className="text-section uppercase text-text-secondary">Guild storage limits</h3>
          <Field
            label="Max guild storage quota (MB)"
            htmlFor="setting-storage-quota"
            hint="Upper limit for per-guild storage quotas. Guild owners cannot set a quota higher than this."
          >
            <Input
              id="setting-storage-quota"
              aria-label="Max Guild Storage Quota in MB"
              type="number"
              value={settings.max_guild_storage_quota || ''}
              onChange={(e) => update('max_guild_storage_quota', e.target.value)}
              placeholder="No limit"
            />
          </Field>
        </section>

        <section className="space-y-5 border-t border-border-subtle pt-7">
          <h3 className="text-section uppercase text-text-secondary">Federation file cache</h3>
          <div className="rounded-md border border-border-subtle bg-bg-tertiary/40 px-4 py-3">
            <Toggle
              checked={settings.federation_file_cache_enabled === 'true'}
              onChange={() =>
                update('federation_file_cache_enabled', settings.federation_file_cache_enabled === 'true' ? 'false' : 'true')
              }
              label="Cache federated files"
              description="Store files fetched from federated servers locally to serve them faster."
              ariaLabel="Toggle federation file cache"
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Cache max size (MB)" htmlFor="setting-cache-size">
              <Input
                id="setting-cache-size"
                aria-label="Federation Cache Max Size in MB"
                type="number"
                value={settings.federation_file_cache_max_size || ''}
                onChange={(e) => update('federation_file_cache_max_size', e.target.value)}
                placeholder="No limit"
              />
            </Field>
            <Field
              label="Cache TTL (hours)"
              htmlFor="setting-cache-ttl"
              hint="How long cached files are kept before re-fetching from the origin."
            >
              <Input
                id="setting-cache-ttl"
                aria-label="Federation Cache TTL in hours"
                type="number"
                value={settings.federation_file_cache_ttl_hours || ''}
                onChange={(e) => update('federation_file_cache_ttl_hours', e.target.value)}
                placeholder="Default"
              />
            </Field>
          </div>
        </section>

        <div className="flex items-center gap-3 border-t border-border-subtle pt-6">
          <Button onClick={handleSave} loading={saving} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1.5 text-label font-medium text-accent-success">
              <Check size={16} />
              Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
