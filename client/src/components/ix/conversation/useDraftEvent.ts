import { useCallback, useState } from 'react';

import { getApi } from '../../../api/activeClient';
import { extractApiError } from '../../../api/client';
import { useCurrentMessageStoreApi } from '../../../hooks/useMessageStore';
import { newDraft, draftPayload, type DraftPlan } from './draftEvent';

export interface DraftEvent {
  plan: DraftPlan | null;
  /** The event or its message is being sent. */
  posting: boolean;
  /** Why the last attempt failed, in words; the draft stays so Post it can try again. */
  error: string | null;
  /** The event form is open (Edit). */
  editing: boolean;
  /** Plan a night: the draft appears, growing out of the card at `from`. */
  start: (from: DOMRect | null) => void;
  /** Post it: create the scheduled event, then post it in the channel. */
  post: () => Promise<void>;
  /** Edit: open the event form first. */
  openEdit: () => void;
  closeEdit: () => void;
  /** The form created the event: post it in the channel (the same last step as Post it). */
  postCreated: (event: { id: string }) => Promise<void>;
}

/**
 * The state of "Plan a night" (docs/index-spec.md §4.13): a draft, "Post it", and
 * "Edit". The event is created on the server only when the person says so, and the
 * message that shows it in the channel is the channel's ordinary send
 * (`<event:ID>`, which the timeline draws as the event card and the sidebar reads
 * as "Game night · Fri 9 PM"). If the event is made and the message fails, the
 * event id is kept: Post it again sends only the message, never a second event.
 */
export function useDraftEvent(input: {
  guildId: string;
  channelId: string;
  channels: readonly { id: string; name?: string | null; type?: number; channel_type?: number; position: number; parent_id?: string | null }[];
  now?: () => Date;
}): DraftEvent {
  const { guildId, channelId, channels, now } = input;
  const messageStore = useCurrentMessageStoreApi();
  const [plan, setPlan] = useState<DraftPlan | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const start = useCallback(
    (from: DOMRect | null) => {
      setError(null);
      setPlan(newDraft(now ? now() : new Date(), channels, from));
    },
    [channels, now],
  );

  const send = useCallback(
    async (eventId: string) => {
      await messageStore.getState().sendMessage(channelId, `<event:${eventId}>`);
    },
    [messageStore, channelId],
  );

  const post = useCallback(async () => {
    if (!plan || posting) return;
    setPosting(true);
    setError(null);
    try {
      let eventId = plan.eventId;
      if (!eventId) {
        const { data } = await getApi().post<{ id: string }>(`/guilds/${guildId}/events`, draftPayload(plan));
        eventId = String(data.id);
        const made = eventId;
        setPlan((current) => (current ? { ...current, eventId: made } : current));
      }
      await send(eventId);
    } catch (failure) {
      setError(extractApiError(failure));
    } finally {
      setPosting(false);
    }
  }, [plan, posting, guildId, send]);

  const postCreated = useCallback(
    async (event: { id: string }) => {
      const eventId = String(event.id);
      setPlan((current) => (current ? { ...current, eventId } : current));
      setPosting(true);
      setError(null);
      try {
        await send(eventId);
      } catch (failure) {
        setError(extractApiError(failure));
      } finally {
        setPosting(false);
      }
    },
    [send],
  );

  return {
    plan,
    posting,
    error,
    editing,
    start,
    post,
    openEdit: () => setEditing(true),
    closeEdit: () => setEditing(false),
    postCreated,
  };
}
