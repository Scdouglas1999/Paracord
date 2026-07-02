import type { MessageE2eePayload } from '../types';
import { decryptDmMessage } from './dmE2ee';
import { secureDelete, secureGet, secureSet } from './secureStorage';

const MAX_IN_FLIGHT_DECRYPTS = 5;

type PendingDecrypt = {
  resolve: (plaintext: string) => void;
  reject: (reason?: unknown) => void;
};

type QueuedDecrypt = {
  id: number;
  channelId: string;
  payload: MessageE2eePayload;
  privateKey: Uint8Array;
  peerPublicKey: string;
};

type WorkerDecryptResponse = {
  type: 'pc-dm-decrypt-result';
  id: number;
  ok: boolean;
  plaintext?: string;
  error?: string;
};

type WorkerSecureStorageRequest = {
  type: 'pc-secure-storage-request';
  id: number;
  op: 'get' | 'set' | 'delete';
  key: string;
  value?: string;
};

let worker: Worker | null = null;
let nextDecryptId = 0;
let inFlightDecrypts = 0;
const pendingDecrypts = new Map<number, PendingDecrypt>();
const decryptQueue: QueuedDecrypt[] = [];

function supportsModuleWorkers(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function isDecryptResponseMessage(value: unknown): value is WorkerDecryptResponse {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<WorkerDecryptResponse>;
  return payload.type === 'pc-dm-decrypt-result' && typeof payload.id === 'number';
}

function isSecureStorageRequestMessage(value: unknown): value is WorkerSecureStorageRequest {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<WorkerSecureStorageRequest>;
  return (
    payload.type === 'pc-secure-storage-request'
    && typeof payload.id === 'number'
    && (payload.op === 'get' || payload.op === 'set' || payload.op === 'delete')
    && typeof payload.key === 'string'
  );
}

async function handleSecureStorageBridgeMessage(message: WorkerSecureStorageRequest): Promise<void> {
  if (!worker) return;
  try {
    if (message.op === 'get') {
      const value = await secureGet(message.key);
      worker.postMessage({
        type: 'pc-secure-storage-response',
        id: message.id,
        ok: true,
        value,
      });
      return;
    }

    if (message.op === 'set') {
      await secureSet(message.key, message.value ?? '');
      worker.postMessage({
        type: 'pc-secure-storage-response',
        id: message.id,
        ok: true,
        value: null,
      });
      return;
    }

    await secureDelete(message.key);
    worker.postMessage({
      type: 'pc-secure-storage-response',
      id: message.id,
      ok: true,
      value: null,
    });
  } catch (err) {
    worker.postMessage({
      type: 'pc-secure-storage-response',
      id: message.id,
      ok: false,
      error: err instanceof Error ? err.message : 'secure storage bridge failed',
    });
  }
}

function pumpDecryptQueue(): void {
  const activeWorker = worker;
  if (!activeWorker) {
    return;
  }

  while (inFlightDecrypts < MAX_IN_FLIGHT_DECRYPTS && decryptQueue.length > 0) {
    const job = decryptQueue.shift();
    if (!job) break;
    inFlightDecrypts += 1;
    const privateKeyCopy = job.privateKey.slice();
    const privateKeyBuffer = privateKeyCopy.buffer;
    activeWorker.postMessage(
      {
        type: 'pc-dm-decrypt',
        id: job.id,
        channelId: job.channelId,
        payload: job.payload,
        privateKey: privateKeyBuffer,
        peerPublicKey: job.peerPublicKey,
      },
      [privateKeyBuffer],
    );
  }
}

function ensureWorker(): Worker | null {
  if (worker) {
    return worker;
  }
  if (!supportsModuleWorkers()) {
    return null;
  }

  worker = new Worker(new URL('../workers/dmDecrypt.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('message', (event: MessageEvent) => {
    if (isSecureStorageRequestMessage(event.data)) {
      void handleSecureStorageBridgeMessage(event.data);
      return;
    }
    if (!isDecryptResponseMessage(event.data)) {
      return;
    }
    const result = event.data;
    const pending = pendingDecrypts.get(result.id);
    if (!pending) {
      return;
    }
    pendingDecrypts.delete(result.id);
    inFlightDecrypts = Math.max(0, inFlightDecrypts - 1);
    if (result.ok) {
      pending.resolve(result.plaintext ?? '');
    } else {
      pending.reject(new Error(result.error || 'DM decrypt failed'));
    }
    pumpDecryptQueue();
  });
  worker.addEventListener('error', (event) => {
    const error = event.error ?? new Error(event.message || 'DM decrypt worker failed');
    const currentPending = Array.from(pendingDecrypts.values());
    pendingDecrypts.clear();
    decryptQueue.length = 0;
    inFlightDecrypts = 0;
    worker = null;
    for (const pending of currentPending) {
      pending.reject(error);
    }
  });

  return worker;
}

export async function decryptDmMessageOffthread(
  channelId: string,
  payload: MessageE2eePayload,
  privateKey: Uint8Array,
  peerPublicKey: string,
): Promise<string> {
  const activeWorker = ensureWorker();
  if (!activeWorker) {
    return decryptDmMessage(channelId, payload, privateKey, peerPublicKey);
  }

  const id = ++nextDecryptId;
  return new Promise<string>((resolve, reject) => {
    pendingDecrypts.set(id, { resolve, reject });
    decryptQueue.push({
      id,
      channelId,
      payload,
      privateKey,
      peerPublicKey,
    });
    pumpDecryptQueue();
  });
}

