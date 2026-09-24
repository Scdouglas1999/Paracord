import type { Message } from '../../types';
import type { OperationContext } from '../operationContext';
import { DeliveryProtocolError } from './durableDelivery';

/** These bytes must be committed with any encryption state before HTTP. */
export interface PreparedDeliveryEdit {
  readonly channelId: string;
  readonly messageId: string;
  readonly editNonce: string;
  readonly serializedRequest: string;
}

type EditAcknowledgment = Message & { edit_nonce: string; edit_replayed: boolean };

/** Author-owned outbox edits use their original serialized request on every retry. */
export function createDeliveryEditTransport(context: OperationContext) {
  return async (record: PreparedDeliveryEdit, signal: AbortSignal): Promise<Message> => {
    let request: { edit_nonce?: unknown };
    try { request = JSON.parse(record.serializedRequest); } catch {
      throw new DeliveryProtocolError('The prepared edit does not contain a valid original request.');
    }
    if (!record.channelId || !record.messageId || !record.editNonce || request?.edit_nonce !== record.editNonce) {
      throw new DeliveryProtocolError('The prepared edit does not retain its original operation identity.');
    }
    const response = await context.request<EditAcknowledgment>({
      method: 'PATCH', signal, timeout: 30_000,
      url: `/channels/${encodeURIComponent(record.channelId)}/messages/${encodeURIComponent(record.messageId)}`,
      data: record.serializedRequest, headers: { 'Content-Type': 'application/json' },
    });
    const message = response.data;
    if (response.status !== 200 || !message || message.id !== record.messageId
      || message.channel_id !== record.channelId || message.author?.id !== context.scope.userId
      || message.edit_nonce !== record.editNonce || typeof message.edit_replayed !== 'boolean') {
      throw new DeliveryProtocolError('The server did not acknowledge this account’s original message edit.');
    }
    // A replay may return a newer edit. Its acknowledgment proves our original
    // operation committed, without replacing that newer content on the server.
    return message;
  };
}

export type EditResolution = { state: 'cancelled' | 'applied' | 'deleted' };

/** Seal an uncertain PATCH before a later edit can replace it. No message body is changed here. */
export function createEditResolutionTransport(context: OperationContext) {
  return async (record: Pick<PreparedDeliveryEdit, 'channelId' | 'messageId' | 'editNonce'>, signal: AbortSignal): Promise<EditResolution> => {
    const response = await context.request<{
      channel_id: string; actor_id: string; message_id: string; edit_nonce: string; state: string;
    }>({ method: 'POST', signal, timeout: 30_000,
      url: `/channels/${encodeURIComponent(record.channelId)}/messages/${encodeURIComponent(record.messageId)}/edits/${encodeURIComponent(record.editNonce)}/resolve` });
    const result = response.data;
    if (response.status !== 200 || !result || result.channel_id !== record.channelId
      || result.actor_id !== context.scope.userId || result.message_id !== record.messageId
      || result.edit_nonce !== record.editNonce
      || !['cancelled', 'applied', 'deleted'].includes(result.state)) {
      throw new DeliveryProtocolError('The server did not resolve this account’s original message edit.');
    }
    return { state: result.state as EditResolution['state'] };
  };
}
