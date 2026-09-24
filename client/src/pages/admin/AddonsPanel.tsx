import { useEffect, useState } from 'react';
import { feedsApi, type AdminAddons, feedErrorMessage } from '../../api/feeds';
import { toast } from '../../stores/toastStore';
import {
  Button,
  ErrorBanner,
  LoadingSpinner,
  SettingsSectionHeader,
  TextField,
  ToggleRow,
} from '../../components/ui';

/**
 * Admin → Add-ons: what server add-ons may reach, and the instance's Twitch
 * app for Twitch feeds. Server owners set up their own feeds; these are the
 * switches only an instance admin holds.
 */
export function AddonsPanel() {
  const [settings, setSettings] = useState<AdminAddons | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingNetwork, setSavingNetwork] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savingTwitch, setSavingTwitch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    feedsApi.adminSettings().then(
      (res) => {
        if (cancelled) return;
        setSettings(res.data);
        setClientId(res.data.twitch_client_id ?? '');
      },
      (err: unknown) => {
        if (!cancelled) setError(feedErrorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocalNetwork = async (allowed: boolean) => {
    setSavingNetwork(true);
    try {
      const res = await feedsApi.updateAdminSettings({ local_network_allowed: allowed });
      setSettings(res.data);
      toast.success(allowed ? 'Add-ons may now reach the local network.' : 'Add-ons can no longer reach the local network.');
    } catch (err) {
      toast.error(feedErrorMessage(err));
    } finally {
      setSavingNetwork(false);
    }
  };

  const saveTwitch = async () => {
    setSavingTwitch(true);
    try {
      const body: { twitch_client_id: string; twitch_client_secret?: string } = {
        twitch_client_id: clientId.trim(),
      };
      if (clientSecret.trim()) body.twitch_client_secret = clientSecret.trim();
      const res = await feedsApi.updateAdminSettings(body);
      setSettings(res.data);
      setClientSecret('');
      toast.success('Twitch credentials saved.');
    } catch (err) {
      toast.error(feedErrorMessage(err));
    } finally {
      setSavingTwitch(false);
    }
  };

  const clearTwitch = async () => {
    setSavingTwitch(true);
    try {
      const res = await feedsApi.updateAdminSettings({ twitch_client_id: '', twitch_client_secret: '' });
      setSettings(res.data);
      setClientId('');
      setClientSecret('');
      toast.success('Twitch credentials removed.');
    } catch (err) {
      toast.error(feedErrorMessage(err));
    } finally {
      setSavingTwitch(false);
    }
  };

  if (error) return <ErrorBanner message={error} multiline />;
  if (!settings) return <LoadingSpinner label="Loading add-on settings…" className="py-10" />;

  const twitchConfigured = Boolean(settings.twitch_client_id) && settings.twitch_secret_set;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSectionHeader
        className="mb-0"
        title="Add-ons"
        description={`Switches for the add-ons server owners turn on. Each server may have up to ${settings.feeds_per_server} feeds.`}
      />

      <section className="flex max-w-2xl flex-col">
        <h3 className="pc-display text-heading text-text-primary">Network</h3>
        <ToggleRow
          label="Add-ons may reach this instance's local network"
          description="Lets feeds reach addresses on the network this instance runs on, like a Jellyfin server at home. Leave it off on a public instance: anyone who owns a server here could point a feed at machines on that network."
          checked={settings.local_network_allowed}
          onChange={(next) => void setLocalNetwork(next)}
          disabled={savingNetwork}
        />
      </section>

      <section className="flex max-w-lg flex-col gap-4">
        <div>
          <h3 className="pc-display text-heading text-text-primary">Twitch</h3>
          <p className="mt-1 text-body leading-relaxed text-text-secondary">
            Twitch feeds need an app from the Twitch developer console. Paste its client id and secret; the secret is stored encrypted and never shown again.
            {twitchConfigured ? ' Twitch feeds are available to every server.' : ' Until then, Twitch is shown as unavailable in Add a feed.'}
          </p>
        </div>
        <TextField
          label="Client id"
          value={clientId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setClientId(event.target.value)}
        />
        <TextField
          label="Client secret"
          type="password"
          value={clientSecret}
          autoComplete="off"
          placeholder={settings.twitch_secret_set ? '••••' : ''}
          hint={settings.twitch_secret_set ? 'Leave it empty to keep the saved secret.' : undefined}
          onChange={(event) => setClientSecret(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => void saveTwitch()}
            loading={savingTwitch}
            disabled={savingTwitch || !clientId.trim() || (!settings.twitch_secret_set && !clientSecret.trim())}
          >
            Save Twitch credentials
          </Button>
          {(settings.twitch_client_id || settings.twitch_secret_set) && (
            <Button variant="ghost" onClick={() => void clearTwitch()} disabled={savingTwitch}>
              Remove
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
