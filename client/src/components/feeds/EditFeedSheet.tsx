import { useEffect, useId, useState } from 'react';
import { feedsApi, type Feed, feedErrorMessage } from '../../api/feeds';
import type { Channel } from '../../types';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Select,
  ToggleRow,
} from '../ui';
import { FieldLabel } from '../guild/SettingsPrimitives';
import { FeedSourceIcon } from './feedKinds';

export interface EditFeedSheetProps {
  guildId: string;
  feed: Feed | null;
  onClose: () => void;
  channels: Channel[];
  onSaved: (feed: Feed) => void;
}

/** Edit a feed: its name, its channel, the front page, and a Jellyfin key. */
export function EditFeedSheet({ guildId, feed, onClose, channels, onSaved }: EditFeedSheetProps) {
  const titleId = useId();
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [showOnFrontPage, setShowOnFrontPage] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!feed) return;
    setName(feed.name);
    setChannelId(feed.channel_id);
    setShowOnFrontPage(feed.show_on_front_page);
    setApiKey('');
    setError(null);
  }, [feed]);

  const save = async () => {
    if (!feed) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('A feed needs a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await feedsApi.update(guildId, feed.id, {
        name: trimmed,
        channel_id: channelId,
        show_on_front_page: showOnFrontPage,
        api_key: apiKey.trim() || undefined,
      });
      onSaved(res.data);
      onClose();
    } catch (err) {
      setError(feedErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={Boolean(feed)} onClose={onClose} labeledBy={titleId} size="md" showCloseButton>
      {feed && (
        <>
          <ModalHeader icon={<FeedSourceIcon kind={feed.kind} iconUrl={feed.icon_url} size={36} />}>
            <ModalTitle id={titleId}>Edit feed</ModalTitle>
            {feed.source && (
              <ModalDescription className="mt-1 truncate">{feed.source}</ModalDescription>
            )}
          </ModalHeader>
          <ModalBody className="flex flex-col gap-5">
            <label className="flex flex-col">
              <FieldLabel>Name</FieldLabel>
              <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="flex flex-col">
              <FieldLabel>Post in</FieldLabel>
              <Select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name ?? channel.id}
                  </option>
                ))}
              </Select>
            </label>
            {feed.kind === 'jellyfin' && (
              <label className="flex flex-col">
                <FieldLabel>API key</FieldLabel>
                <Input
                  type="password"
                  value={apiKey}
                  autoComplete="off"
                  placeholder={feed.api_key_set ? '••••' : 'From Dashboard → API keys'}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <span className="mt-1.5 text-meta text-text-muted">
                  Leave it empty to keep the saved key. A new key is checked with Jellyfin before it's saved.
                </span>
              </label>
            )}
            <ToggleRow
              className="py-0"
              label="Show on the front page"
              description="New items also appear in Latest on the server's front page."
              checked={showOnFrontPage}
              onChange={setShowOnFrontPage}
            />
            {error && <p role="alert" className="text-meta text-accent-danger">{error}</p>}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={saving}>
              Save
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}
