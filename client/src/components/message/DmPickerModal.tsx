import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { extractApiError } from '../../api/client';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { activateChannel } from '../../lib/channelNavigation';
import type { ScopedChannel } from '../../lib/channelScope';
import { displayName } from '../../lib/displayName';
import { useChannelStore } from '../../stores/channelStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import type { Channel } from '../../types/index';
import { IxGlyph } from '../ix/glyphs';
import { Avatar } from '../ix/identity';
import { Segmented, segmentedIds } from '../ix/people/Segmented';
import { CreamButton } from '../ix/primitives';
import { Modal } from '../ui/Modal';

export interface DmPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired with the created/opened channel after a DM or group DM is started. */
  onCreated?: (channel: Channel) => void;
  /** Which half it opens on: a person (default), or a group ("Start a group"). */
  initialMode?: 'direct' | 'group';
}

type Mode = 'direct' | 'group';

/**
 * New message (docs/index-spec.md §6.6, §6.12): the People menu's "New message" and
 * "Start a group", the Messages label's "+", and the switcher's command. A dialog with
 * your friends; choosing one opens (or creates) the conversation with `channelStore`,
 * navigates to `/app/dms/:id`, fires `onCreated` and closes. The Group half takes several
 * and a name, and one cream "Create group conversation".
 */
export function DmPickerModal({ open, onClose, onCreated, initialMode = 'direct' }: DmPickerModalProps) {
  const navigate = useNavigate();
  const scope = useCurrentAccountScope();
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<Mode>(initialMode);
  const [groupSelected, setGroupSelected] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const groupMode = mode === 'group';

  // Each open starts fresh (on the half it was asked for) and refreshes the friend list.
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setGroupSelected([]);
    setGroupName('');
    setQuery('');
    setError(null);
    setSubmitting(false);
    void fetchRelationships();
    searchRef.current?.focus();
  }, [open, initialMode, fetchRelationships]);

  const friends = relationships.filter((r) => r.type === 1);
  const filteredFriends = friends.filter((relationship) => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return true;
    return (
      displayName(relationship.user).toLocaleLowerCase().includes(normalized) ||
      relationship.user.username.toLocaleLowerCase().includes(normalized)
    );
  });

  const commitChannel = (channel: ScopedChannel) => {
    activateChannel(channel);
    onCreated?.(channel);
    onClose();
    navigate(`/app/dms/${channel.id}`);
  };

  const startDm = async (userId: string) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (!scope) throw new Error('Sign in to this instance before messaging.');
      const data = await useChannelStore.getState().createDm(userId, scope);
      commitChannel(data);
    } catch (err) {
      setError(extractApiError(err) || 'Failed to start this direct message.');
    } finally {
      setSubmitting(false);
    }
  };

  const createGroup = async () => {
    if (submitting || groupSelected.length === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      if (!scope) throw new Error('Sign in to this instance before messaging.');
      const data = await useChannelStore.getState().createGroupDm(groupSelected, groupName || undefined, scope);
      commitChannel(data);
    } catch (err) {
      setError(extractApiError(err) || 'Failed to create this group conversation.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleGroupMember = (userId: string) => {
    setGroupSelected((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  const ids = segmentedIds('ix-newmsg', mode);

  return (
    <Modal open={open} onClose={onClose} labeledBy={titleId} panelClassName="ix-dialog-panel ix-newmsg" manageFocus>
      <div className="ix-newmsg__head">
        <h2 id={titleId} className="ix-dialog__title">
          New message
        </h2>
        <p className="ix-dialog__body">
          {groupMode ? 'Choose the friends this conversation is for.' : 'Choose a friend to start or reopen a conversation.'}
        </p>
        <Segmented
          label="Message type"
          idBase="ix-newmsg"
          items={[
            { value: 'direct', label: 'Direct' },
            { value: 'group', label: 'Group' },
          ]}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setError(null);
          }}
        />
        <label className="ix-newmsg__search">
          <IxGlyph name="search" size={15} />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search friends"
            placeholder="Search friends"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {groupMode && (
          <input
            type="text"
            className="ix-field ix-newmsg__name"
            placeholder="Group name (optional)"
            aria-label="Group name"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
          />
        )}
      </div>

      <div className="ix-newmsg__list" role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
        {friends.length === 0 ? (
          <p className="ix-newmsg__empty">
            <strong>No friends to message yet</strong>
            Add a friend first: you can only message people you&rsquo;re friends with.
          </p>
        ) : filteredFriends.length === 0 ? (
          <p className="ix-newmsg__empty">
            <strong>No friends found</strong>
            No friends match &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          filteredFriends.map((rel) => {
            const selected = groupSelected.includes(rel.user.id);
            const name = displayName(rel.user);
            return (
              <button
                key={rel.id}
                type="button"
                aria-pressed={groupMode ? selected : undefined}
                className="ix-newmsg__person"
                data-selected={groupMode && selected ? '' : undefined}
                onClick={() => {
                  if (groupMode) toggleGroupMember(rel.user.id);
                  else void startDm(rel.user.id);
                }}
              >
                {groupMode && (
                  <span className="ix-newmsg__check" data-on={selected ? '' : undefined} aria-hidden="true">
                    {selected && <IxGlyph name="check" size={12} />}
                  </span>
                )}
                <Avatar userId={rel.user.id} name={name} avatar={rel.user.avatar_hash ?? null} size={32} ring="var(--ix-card)" />
                <span className="ix-newmsg__who">
                  <span className="ix-newmsg__name-text">{name}</span>
                  <span className="ix-newmsg__user">@{rel.user.username}</span>
                </span>
                {!groupMode && <span className="ix-newmsg__go">Message</span>}
              </button>
            );
          })
        )}
      </div>

      {error && (
        <p role="alert" className="ix-dialog__error ix-newmsg__error">
          {error}
        </p>
      )}

      {groupMode && (
        <div className="ix-newmsg__foot">
          <div className="ix-newmsg__count">
            <span>{groupSelected.length === 0 ? 'Select at least one friend' : `${groupSelected.length} friend${groupSelected.length === 1 ? '' : 's'} selected`}</span>
            <span>{groupSelected.length + 1} total</span>
          </div>
          <CreamButton disabled={groupSelected.length === 0 || submitting} onClick={() => void createGroup()}>
            {submitting ? 'Creating…' : 'Create group conversation'}
          </CreamButton>
        </div>
      )}
    </Modal>
  );
}
