import { useEffect, useMemo, useState } from 'react';
import { extractApiError } from '../../api/client';
import { dailyWordApi, type DailyWordSettings, type DailyWordSettingsUpdate } from '../../api/dailyWord';
import { useDailyWordSettings } from '../../hooks/useDailyWord';
import { useChannelActions, useCurrentChannelStore, useGuildChannels } from '../../hooks/useChannels';
import { confirm } from '../../stores/confirmStore';
import { useDailyWordStore } from '../../stores/dailyWordStore';
import { toast } from '../../stores/toastStore';
import { ChannelType } from '../../types';
import { Button, Chip, ErrorBanner, LoadingSpinner, Select, ToggleRow, Well } from '../ui';
import { FieldLabel } from '../guild/SettingsPrimitives';
import { DailyWordMark } from './DailyWordMark';

export const DAILY_WORD_DESCRIPTION =
  'A five-letter word to guess in six tries, the same word for everyone, new every day. Adds a Daily word page to the sidebar.';

/** Settings for the Daily word add-on: on or off, where results are shared, and the front page. */
export function DailyWordSection({ guildId }: { guildId: string }) {
  const { settings, status, error: loadError } = useDailyWordSettings(guildId);
  const [saving, setSaving] = useState<keyof DailyWordSettingsUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channels = useGuildChannels(guildId);
  const loaded = useCurrentChannelStore((view) => view.guildChannelsLoaded[guildId] === true);
  const { fetchChannels } = useChannelActions();

  const [channelsError, setChannelsError] = useState<string | null>(null);
  useEffect(() => {
    if (loaded || !guildId) return;
    Promise.resolve()
      .then(() => fetchChannels(guildId))
      .catch((err: unknown) => setChannelsError(`This server's channels couldn't be loaded: ${extractApiError(err)}`));
  }, [loaded, guildId, fetchChannels]);

  const textChannels = useMemo(
    () => channels
      .filter((channel) => (channel.type ?? channel.channel_type) === ChannelType.Text)
      .sort((a, b) => a.position - b.position),
    [channels],
  );

  const save = async (body: DailyWordSettingsUpdate, field: keyof DailyWordSettingsUpdate, done?: string) => {
    setError(null);
    setSaving(field);
    try {
      const res = await dailyWordApi.updateSettings(guildId, body);
      useDailyWordStore.getState().adoptSettings(res.data);
      if (done) toast.success(done);
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSaving(null);
    }
  };

  const onRemove = async () => {
    const ok = await confirm({
      title: 'Remove Daily word from this server?',
      description: 'The Daily word page leaves the sidebar. Everyone keeps their results and streaks, so you can add it again later.',
      confirmLabel: 'Remove from server',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    if (!ok) return;
    await save({ enabled: false }, 'enabled', 'Daily word removed from this server.');
  };

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner label="Loading Daily word settings…" />
      </div>
    );
  }
  if (status === 'error' || !settings) {
    return <ErrorBanner message={loadError || "Daily word settings couldn't be loaded."} multiline />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {error && <ErrorBanner message={error} multiline />}
      {channelsError && settings.enabled && <ErrorBanner message={channelsError} multiline />}
      <Well bare className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="pc-sports-addon-mark" aria-hidden>
            <DailyWordMark />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-name font-semibold text-text-primary">Daily word</h3>
              {settings.enabled && <Chip size="sm" tone="accent">Added</Chip>}
            </div>
            <p className="mt-0.5 text-body leading-relaxed text-text-secondary">{DAILY_WORD_DESCRIPTION}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {settings.enabled ? (
            <Button size="sm" variant="ghost" onClick={() => void onRemove()} disabled={saving !== null}>
              Remove from server
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void save({ enabled: true }, 'enabled', 'Daily word added to this server.')}
              disabled={saving !== null}
              loading={saving === 'enabled'}
            >
              Add to server
            </Button>
          )}
        </div>
      </Well>

      {settings.enabled && <DailyWordOptions settings={settings} textChannels={textChannels} saving={saving} save={save} />}
    </div>
  );
}

function DailyWordOptions({
  settings,
  textChannels,
  saving,
  save,
}: {
  settings: DailyWordSettings;
  textChannels: { id: string; name?: string | null }[];
  saving: keyof DailyWordSettingsUpdate | null;
  save: (body: DailyWordSettingsUpdate, field: keyof DailyWordSettingsUpdate, done?: string) => Promise<void>;
}) {
  const current = settings.share_channel_id ?? '';
  const missing = current !== '' && !textChannels.some((channel) => channel.id === current);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label className="flex max-w-sm flex-col">
        <FieldLabel>Share results in</FieldLabel>
        <span className="mb-2 text-meta text-text-muted">
          Where the Share button posts. With no channel set, each person picks one when they share.
        </span>
        <Select
          aria-label="Share results in"
          value={current}
          disabled={saving !== null}
          onChange={(event) =>
            void save({ share_channel_id: event.target.value || null }, 'share_channel_id', 'Saved.')}
        >
          <option value="">No set channel</option>
          {missing && <option value={current}>A channel that is gone</option>}
          {textChannels.map((channel) => (
            <option key={channel.id} value={channel.id}>#{channel.name}</option>
          ))}
        </Select>
      </label>
      <ToggleRow
        label="Show on the front page"
        description="A Daily word card on the server's front page: who solved today's word, and a way in."
        checked={settings.show_on_front_page}
        disabled={saving !== null}
        onChange={(next) => void save({ show_on_front_page: next }, 'show_on_front_page')}
      />
    </div>
  );
}
