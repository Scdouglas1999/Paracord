/**
 * What a direct message is called (docs/lantern-stage-spec.md §7.6).
 *
 * One rule, in one place, because three surfaces were each building this string
 * for themselves: the DM index, the unified conversation merge, and the room
 * model behind a DM's header. All three joined every recipient — and the
 * recipient list includes **you**, so mara's own group conversation was called
 * "mara, renquist". Nobody addresses a conversation to themselves.
 *
 * Pure. No React, no stores: the caller knows which account is looking.
 */

import { displayName } from './displayName';
import type { Channel } from '../types';

interface Named {
  id: string;
  username?: string | null;
  display_name?: string | null;
}

/**
 * The people in a DM other than the viewer, in the order the channel gave them.
 *
 * A one-to-one DM may carry `recipient` instead of `recipients`; both are
 * filtered the same way, so a conversation with yourself (which the server does
 * allow) comes back empty rather than reading as a conversation with a stranger.
 */
export function dmCompanions(
  channel: Pick<Channel, 'recipient' | 'recipients'> | undefined,
  selfUserId: string | null | undefined,
): Named[] {
  const list: Named[] = channel?.recipients?.length
    ? [...channel.recipients]
    : channel?.recipient
      ? [channel.recipient]
      : [];
  return selfUserId ? list.filter((person) => person.id !== selfUserId) : list;
}

/**
 * A DM's title: the operator-set name if it has one, otherwise everybody in it
 * except you.
 *
 * `empty` is what a conversation with nobody else in it is called — a group
 * whose other members have all left, or a note to self.
 */
export function dmTitleFor(
  channel: (Pick<Channel, 'name' | 'recipient' | 'recipients'>) | undefined,
  selfUserId: string | null | undefined,
  empty = 'Just you',
): string {
  if (channel?.name) return channel.name;
  const names = dmCompanions(channel, selfUserId).map((person) => displayName(person));
  return names.length > 0 ? names.join(', ') : empty;
}
