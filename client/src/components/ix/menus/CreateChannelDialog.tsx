import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import { activateChannel } from '../../../lib/channelNavigation';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { ChannelType } from '../../../types';
import { Modal } from '../../ui/Modal';
import { CreamButton } from '../primitives';
import { closeCreateChannel, type CreateChannelRequest } from './hostStore';

/**
 * Create channel / Create room (docs/index-spec.md §6.2, §4.5): a name, an
 * optional category, and one cream "Create". The server menu opens it for the two
 * rows it names; a category's "+" in the sidebar opens it with the category
 * preselected (`openCreateChannel({ ..., parentId })`). Only Manage Channels
 * reaches it; the server is still the authority.
 *
 * A text channel opens once it exists; a room does not navigate (joining never
 * navigates, §8.1: the sidebar shows it under Rooms).
 */

export function CreateChannelDialog({ request }: { request: CreateChannelRequest }) {
  const navigate = useNavigate();
  const room = request.kind === 'room';
  const noun = room ? 'room' : 'channel';
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState(request.parentId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channels = useChannelStore((state) => state.channelsByGuild[entityScopeKey(request.scope, request.guildId)]);
  const categories = useMemo(
    () => (channels ?? []).filter((channel) => (channel.type ?? channel.channel_type) === ChannelType.Category),
    [channels],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await useChannelStore.getState().createChannel(
        request.guildId,
        {
          name: trimmed,
          channel_type: room ? ChannelType.Voice : ChannelType.Text,
          parent_id: parentId || null,
        },
        request.scope,
      );
      closeCreateChannel();
      if (!room) {
        activateChannel(created);
        navigate(`/app/guilds/${request.guildId}/channels/${created.id}`);
      }
    } catch (err) {
      setError(`Could not create the ${noun}: ${extractApiError(err)}`);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={closeCreateChannel}
      labeledBy={titleId}
      panelClassName="ix-dialog-panel"
      manageFocus
    >
      <form className="ix-dialog" onSubmit={(event) => void submit(event)}>
        <h2 id={titleId} className="ix-dialog__title">
          {room ? 'Create room' : 'Create channel'}
        </h2>
        <p className="ix-dialog__body">
          {room
            ? 'A room is where people talk. It shows under Rooms in the sidebar.'
            : 'Channels are where the conversation is kept.'}
        </p>
        <label className="ix-dialog__field">
          <span className="ix-dialog__label">Name</span>
          <input
            ref={inputRef}
            className="ix-field"
            value={name}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            placeholder={room ? 'Late night' : 'plans'}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {categories.length > 0 && (
          <label className="ix-dialog__field">
            <span className="ix-dialog__label">Category</span>
            <select
              className="ix-field ix-field--select"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">None</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <p role="alert" className="ix-dialog__error">
            {error}
          </p>
        )}
        <div className="ix-dialog__actions">
          <button type="button" className="ix-dialog__cancel" onClick={closeCreateChannel}>
            Cancel
          </button>
          <CreamButton type="submit" disabled={!name.trim() || busy}>
            {busy ? 'Creating…' : 'Create'}
          </CreamButton>
        </div>
      </form>
    </Modal>
  );
}
