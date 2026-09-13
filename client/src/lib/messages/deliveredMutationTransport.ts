import type { OperationContext } from '../operationContext';
import { DeliveryProtocolError } from './durableDelivery';

export interface PreparedMessageDeletion {
  channelId: string;
  messageId: string;
  deleteNonce: string;
}
export type DeletionResolution = { state: 'deleted' | 'pending' };

/**
 * DELETE with {delete_nonce} commits an actor/channel/message-bound receipt.
 * Resolution reports pending only for an extant, currently deletable target;
 * receipt replay requires visibility, but not renewed delete permission.
 * A missing target without a receipt is an unproven 404, never success here.
 */
export function createDeliveredDeletionTransport(context: OperationContext) {
  function validate(record: PreparedMessageDeletion, data: unknown): DeletionResolution & { delete_replayed?: boolean } {
    const value = data as Record<string, unknown> | null;
    if (!value || value.channel_id !== record.channelId || value.message_id !== record.messageId
      || value.actor_id !== context.scope.userId || value.delete_nonce !== record.deleteNonce
      || (value.state !== 'pending' && value.state !== 'deleted')) {
      throw new DeliveryProtocolError('The server did not acknowledge this account’s original message deletion.');
    }
    return value as DeletionResolution & { delete_replayed?: boolean };
  }
  function path(record: PreparedMessageDeletion) {
    if (!record.channelId || !record.messageId || !record.deleteNonce) throw new DeliveryProtocolError('The original deletion identity is missing.');
    return `/channels/${encodeURIComponent(record.channelId)}/messages/${encodeURIComponent(record.messageId)}`;
  }
  return {
    async resolve(record: PreparedMessageDeletion, signal: AbortSignal): Promise<DeletionResolution> {
      const response = await context.request({ method: 'POST', signal, timeout: 30_000,
        url: `${path(record)}/deletions/${encodeURIComponent(record.deleteNonce)}/resolve` });
      if (response.status !== 200) throw new DeliveryProtocolError('The server did not resolve this message deletion.');
      return { state: validate(record, response.data).state };
    },
    async send(record: PreparedMessageDeletion, signal: AbortSignal): Promise<void> {
      const response = await context.request({ method: 'DELETE', signal, timeout: 30_000, url: path(record),
        data: JSON.stringify({ delete_nonce: record.deleteNonce }), headers: { 'Content-Type': 'application/json' } });
      if (response.status !== 200) throw new DeliveryProtocolError('The server did not commit this message deletion.');
      const result = validate(record, response.data);
      if (result.state !== 'deleted' || typeof result.delete_replayed !== 'boolean') {
        throw new DeliveryProtocolError('The server did not return a committed deletion receipt.');
      }
    },
  };
}
