import { useState, useEffect, useId } from 'react';
import { Check } from 'lucide-react';
import { adminApi, type RouterAccess } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import {
  Button,
  ChoiceCards,
  Divider,
  ErrorBanner,
  SettingsSectionHeader,
  TextField,
  ToggleRow,
} from '../../components/ui';
import { Textarea } from '../../components/ui/Input';
import { REGISTRATION_CHOICES, ROUTER_SETTING_LABEL, reachLabel } from '../../lib/instanceAccess';

export function SettingsPanel() {
  const registrationLabelId = useId();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [router, setRouter] = useState<RouterAccess | null>(null);
  const [routerDraft, setRouterDraft] = useState<boolean | null>(null);
  const [routerError, setRouterError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminApi
      .getSettings()
      .then(({ data }) => setSettings(data))
      .catch((err) => {
        toast.error(`Failed to load settings: ${extractApiError(err)}`);
      });
    adminApi
      .getRouterAccess()
      .then(({ data }) => {
        setRouter(data);
        setRouterDraft(data.saved);
      })
      .catch((err) => {
        setRouterError(`Couldn't read the network setting: ${extractApiError(err)}`);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setRouterError(null);
    try {
      const { data } = await adminApi.updateSettings(settings);
      setSettings(data);
      if (router && routerDraft !== null && routerDraft !== router.saved) {
        try {
          const { data: next } = await adminApi.updateRouterAccess(routerDraft);
          setRouter(next);
          setRouterDraft(next.saved);
        } catch (err) {
          // Said next to the switch it belongs to, and kept there: this one
          // usually needs the owner to do something by hand.
          setRouterError(extractApiError(err));
          throw err;
        }
      }
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
        title="Instance settings"
        description="Configure how this deployment behaves for everyone on it."
      />

      <div className="flex max-w-xl flex-col gap-8">
        <section className="flex flex-col gap-5">
          <TextField
            id="setting-server-name"
            label="Instance name"
            type="text"
            value={settings.server_name || ''}
            onChange={(e) => update('server_name', e.target.value)}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="setting-server-description"
              className="text-label font-medium text-text-secondary"
            >
              Instance description
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
            label="New accounts"
            description="Let new people create accounts here. Turn this off to stop all sign-ups; people who already have an account can still sign in."
            checked={settings.registration_enabled === 'true'}
            onChange={(next) => update('registration_enabled', next ? 'true' : 'false')}
          />

          <div className="flex flex-col gap-2">
            <span
              id={registrationLabelId}
              className="text-label font-medium text-text-secondary"
            >
              Who can create an account
            </span>
            <ChoiceCards
              labeledBy={registrationLabelId}
              options={REGISTRATION_CHOICES}
              value={settings.registration_mode === 'open' ? 'open' : 'invite_only'}
              onChange={(next) => update('registration_mode', next)}
              disabled={settings.registration_enabled !== 'true' || !settings.registration_mode}
              layout="row"
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id="setting-max-guilds"
              label="Max servers per user"
              type="number"
              value={settings.max_guilds_per_user || '100'}
              onChange={(e) => update('max_guilds_per_user', e.target.value)}
            />
            <TextField
              id="setting-max-members"
              label="Max members per server"
              type="number"
              value={settings.max_members_per_guild || '1000'}
              onChange={(e) => update('max_members_per_guild', e.target.value)}
            />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <Divider />
          <h3 className="pc-display text-heading text-text-primary">Network</h3>
          {router && (
            <p className="text-label text-text-secondary">
              Right now:{' '}
              <span className="font-semibold text-text-primary">
                {router.loopback_bind ? 'Only reachable from this computer' : reachLabel(router.running)}
              </span>
            </p>
          )}
          <ToggleRow
            className="py-0"
            label={ROUTER_SETTING_LABEL}
            description="Paracord asks your router to open a port for this server (UPnP). Off means only people on your home network can connect. If you set up port forwarding by hand, or reach the server through a domain, leave this off."
            checked={routerDraft ?? false}
            onChange={(next) => {
              setRouterDraft(next);
              setRouterError(null);
              setSaved(false);
            }}
            disabled={!router || Boolean(router.locked_by)}
          />
          {router?.locked_by && (
            <p className="text-meta leading-relaxed text-text-faint">
              This is set by <code className="pc-mono">{router.locked_by}</code> where the server is
              started, so it can’t be changed here.
            </p>
          )}
          {router?.loopback_bind && (
            <p className="text-meta leading-relaxed text-text-faint">
              This server only listens on this computer, so nobody else can reach it either way.
            </p>
          )}
          {router && routerDraft !== null && routerDraft !== router.running && (
            <p className="text-meta leading-relaxed text-text-secondary" role="status">
              {routerDraft === router.saved
                ? 'Saved. Restart the server for this to take effect.'
                : 'Takes effect after you save and restart the server.'}
            </p>
          )}
          {routerError && <ErrorBanner message={routerError} multiline />}
        </section>

        <section className="flex flex-col gap-5">
          <Divider />
          <h3 className="pc-display text-heading text-text-primary">Server storage limits</h3>
          <TextField
            id="setting-storage-quota"
            label="Max server storage quota (MB)"
            hint="Upper limit for per-server storage quotas. Server owners cannot set a quota higher than this."
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
            description="Store files fetched from federated instances locally to serve them faster."
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
