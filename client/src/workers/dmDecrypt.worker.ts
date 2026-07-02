/// <reference lib="webworker" />

import type { MessageE2eePayload } from '../types';
import { decryptDmMessage } from '../lib/dmE2ee';

type DecryptRequestMessage = {
  type: 'pc-dm-decrypt';
  id: number;
  channelId: string;
  payload: MessageE2eePayload;
  privateKey: ArrayBuffer;
  peerPublicKey: string;
};

type DecryptResponseMessage =
  | {
      type: 'pc-dm-decrypt-result';
      id: number;
      ok: true;
      plaintext: string;
    }
  | {
      type: 'pc-dm-decrypt-result';
      id: number;
      ok: false;
      error: string;
    };

function isDecryptRequestMessage(value: unknown): value is DecryptRequestMessage {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<DecryptRequestMessage>;
  return (
    data.type === 'pc-dm-decrypt'
    && typeof data.id === 'number'
    && typeof data.channelId === 'string'
    && typeof data.peerPublicKey === 'string'
    && data.privateKey instanceof ArrayBuffer
    && typeof data.payload === 'object'
    && data.payload !== null
  );
}

self.addEventListener('message', (event: MessageEvent) => {
  if (!isDecryptRequestMessage(event.data)) {
    return;
  }
  const message = event.data;
  void (async () => {
    try {
      const privateKey = new Uint8Array(message.privateKey);
      const plaintext = await decryptDmMessage(
        message.channelId,
        message.payload,
        privateKey,
        message.peerPublicKey,
      );
      const response: DecryptResponseMessage = {
        type: 'pc-dm-decrypt-result',
        id: message.id,
        ok: true,
        plaintext,
      };
      self.postMessage(response);
    } catch (err) {
      const response: DecryptResponseMessage = {
        type: 'pc-dm-decrypt-result',
        id: message.id,
        ok: false,
        error: err instanceof Error ? err.message : 'DM decrypt failed',
      };
      self.postMessage(response);
    }
  })();
});

