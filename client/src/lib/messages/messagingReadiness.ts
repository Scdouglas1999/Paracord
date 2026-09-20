import type { ActionDecision } from '../conversationActions';
import type { MessagingSnapshot } from './accountMessagingRuntime';

export const GROUP_DM_CHANNEL_TYPE = 3;

export function isGroupDm(channelType?: number | null): boolean {
  return channelType === GROUP_DM_CHANNEL_TYPE;
}

/** The members of a group conversation, as the channel object reports them. */
export interface GroupRosterMember {
  id: string;
  username?: string | null;
  public_key?: string | null;
}

/**
 * Who a group conversation is still waiting on.
 *
 * A group message is sealed under one key wrapped to every member, so a member
 * who has not published an identity key is not a member who reads it late —
 * they are a member no key can be wrapped to at all. Naming them is the only
 * refusal a sender can act on; "group conversations are not encrypted yet" was
 * a statement about the build, and this is a statement about the room.
 */
export function pendingGroupMembers(roster: readonly GroupRosterMember[] | null | undefined): string[] {
  return (roster ?? [])
    .filter(member => !member.public_key)
    .map(member => member.username || member.id);
}

export function groupEnrollmentReason(pending: readonly string[]): string {
  return `Everyone here needs encryption set up before this group can carry a message. Waiting on: ${pending.join(', ')}.`;
}

/** The roster has not arrived yet; it is a wait, not a refusal about the room. */
export const GROUP_ROSTER_UNLOADED_REASON =
  'Loading who is in this conversation before the first message can be sealed to them.';

/**
 * What a conversation's composer is allowed to do right now.
 *
 * `group` is the roster for a group conversation and is ignored elsewhere. It
 * is checked ahead of the encryption ladder below because the ladder's rungs
 * are written for a 1:1 DM ("Set up encryption before sending this direct
 * message") and point at a page that cannot enroll somebody else.
 */
export function runtimeSendDecision(
  server: ActionDecision,
  state: MessagingSnapshot,
  encrypted: boolean,
  channelId: string,
  channelType?: number,
  group?: readonly GroupRosterMember[] | null,
): ActionDecision {
  const block = (reason: string, supported = true) => ({ supported, allowed: false, reason });
  if (isGroupDm(channelType)) {
    if (!group || group.length === 0) return block(GROUP_ROSTER_UNLOADED_REASON);
    const pending = pendingGroupMembers(group);
    if (pending.length > 0) return block(groupEnrollmentReason(pending));
  }
  if (!server.allowed) return server;
  if (state.storage !== 'ready') return block(state.error ?? (state.storage === 'awaiting-handshake'
    ? 'Wait for this server’s authenticated connection before sending.' : 'Save this draft in encrypted device storage before sending.'));
  if (state.synchronization !== 'ready') return block('Wait for this account’s authenticated message recovery before sending.');
  if (state.channelErrors?.[channelId]) return block(state.channelErrors[channelId]);
  if (!encrypted) return server;
  if (state.encryptionRecovery?.kind === 'legacy-session' && state.encryptionRecovery.channelId === channelId) return block(state.encryptionError ?? 'Review this conversation’s older encryption keys before sending.');
  if (state.encryption === 'ready') return server;
  return block(state.encryptionError ?? (state.encryption === 'setup' ? 'Set up encryption for this server account before sending.'
    : state.encryption === 'locked' ? 'Unlock this server account’s encryption identity before sending.' : 'Wait for this server account’s encryption to be verified before sending.'));
}

/**
 * Attaching a file needs everything sending needs — unlocked encrypted storage,
 * a verified identity and a ready peer — because the producer writes the staged
 * ciphertext into the same account vault the message is queued in. A group
 * conversation seals attachments under the same sender key as its text, so it
 * takes the same answer rather than a separate refusal.
 */
export function runtimeAttachDecision(
  server: ActionDecision,
  state: MessagingSnapshot,
  encrypted: boolean,
  channelId: string,
  channelType?: number,
  group?: readonly GroupRosterMember[] | null,
): ActionDecision {
  return runtimeSendDecision(server, state, encrypted, channelId, channelType, group);
}
