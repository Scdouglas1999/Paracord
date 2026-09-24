import type { PreparedDeliveryEdit, EditResolution } from './durableEdit';
import axios from 'axios';
import type { Message, SendMessageRequest } from '../../types';
import type { AccountVault, VaultLifetime, VaultTransaction } from '../crypto/accountVault';
import type { OperationContext } from '../operationContext';
import { accountScopeKey } from '../serverScope';
import { listQueuedSends, OUTBOX_NAMESPACE, INTENT_NAMESPACE, isPreparedSend, commitPreparedIntent, editMessageIntent, discardMessageIntent, type DurableSend, type DurableIntent, type QueuedSend } from './durableOutbox';

export const DELIVERY_RECEIPTS_NAMESPACE = 'messages.delivery-receipts';
export type DeliveryResult = { kind: 'message'; message: Message } | { kind: 'deleted' } | { kind: 'cancelled' };
export interface DeliveryReceipt {
  nonce: string;
  channelId: string;
  acknowledgedAt: string;
  result: DeliveryResult;
}

export class DeliveryProtocolError extends Error {}

/** The HTTP body is the original committed JSON, never reconstructed or encrypted again. */
export function createDeliveryTransport(context: OperationContext) {
  return async (record: DurableSend, signal?: AbortSignal): Promise<DeliveryResult> => {
    try {
      const response = await context.request<Message>({
        method: 'POST', signal, url: `/channels/${encodeURIComponent(record.channelId)}/messages`,
        data: record.serializedRequest, headers: { 'Content-Type': 'application/json' }, timeout: 30_000,
      });
      const message = response.data;
      if ((response.status !== 200 && response.status !== 201) || !message?.id
        || message.channel_id !== record.channelId || message.author?.id !== context.scope.userId
        || message.nonce !== record.nonce) {
        throw new DeliveryProtocolError('The server did not acknowledge this message’s original delivery identity.');
      }
      return { kind: 'message', message };
    } catch (error) {
      context.assertCurrent();
      if (axios.isAxiosError(error) && error.response?.status === 410
        && error.response.data?.code === 'DELIVERY_ALREADY_DELETED') return { kind: 'deleted' };
      if (axios.isAxiosError(error) && error.response?.status === 410
        && error.response.data?.code === 'DELIVERY_CANCELLED') return { kind: 'cancelled' };
      throw error;
    }
  };
}

export type DeliveryResolution = { state: 'cancelled' }
  | { state: 'delivered' | 'deleted'; messageId: string };

/** This POST seals a missing nonce; it is deliberately not a read-only lookup. */
export function createDeliveryResolutionTransport(context: OperationContext) {
  return async (record: Pick<DurableSend, 'channelId' | 'nonce'>, signal?: AbortSignal): Promise<DeliveryResolution> => {
    const response = await context.request<{
      channel_id: string; author_id: string; nonce: string;
      state: string; message_id?: string;
    }>({ method: 'POST', signal, timeout: 30_000,
      url: `/channels/${encodeURIComponent(record.channelId)}/message-deliveries/${encodeURIComponent(record.nonce)}/resolve` });
    const result = response.data;
    if (response.status !== 200 || !result || result.channel_id !== record.channelId
      || result.author_id !== context.scope.userId || result.nonce !== record.nonce) {
      throw new DeliveryProtocolError('The server did not resolve this account’s original message delivery.');
    }
    if (result.state === 'cancelled' && result.message_id === undefined) return { state: 'cancelled' };
    if ((result.state === 'delivered' || result.state === 'deleted') && typeof result.message_id === 'string'
      && /^[1-9][0-9]{0,18}$/.test(result.message_id) && BigInt(result.message_id) <= 9223372036854775807n) {
      return { state: result.state, messageId: result.message_id };
    }
    throw new DeliveryProtocolError('The server returned an invalid message delivery resolution.');
  };
}

/** Resolve first, then use the ordinary author-authorized delete endpoint. */
export function createDeliveryDiscardTransport(context: OperationContext) {
  const resolve = createDeliveryResolutionTransport(context);
  return async (record: DurableSend, signal: AbortSignal): Promise<DeliveryResult> => {
    const outcome = await resolve(record, signal);
    if (outcome.state === 'cancelled') return { kind: 'cancelled' };
    if (outcome.state === 'deleted') return { kind: 'deleted' };
    try {
      const response = await context.request({ method: 'DELETE', signal, timeout: 30_000,
        url: `/channels/${encodeURIComponent(record.channelId)}/messages/${encodeURIComponent(outcome.messageId)}` });
      if (response.status !== 204) throw new DeliveryProtocolError('The server did not confirm deletion of this message.');
      return { kind: 'deleted' };
    } catch (error) {
      context.assertCurrent();
      if (!axios.isAxiosError(error) || error.response?.status !== 404) throw error;
      const repeated = await resolve(record, signal);
      if (repeated.state !== 'deleted' || repeated.messageId !== outcome.messageId) throw error;
      return { kind: 'deleted' };
    }
  };
}

function retryAfterAt(error: unknown, now: number): number | null {
  if (!axios.isAxiosError(error)) return null;
  const raw = error.response?.headers['retry-after'];
  if (typeof raw === 'string' || typeof raw === 'number') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
    const date = Date.parse(String(raw));
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  return null;
}

function retryDelay(attempts: number, random: number) {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(Math.max(0, attempts - 1), 6));
  return Math.min(60_000, base * (0.8 + 0.4 * Math.min(1, Math.max(0, random))));
}

export function classifyDeliveryFailure(error: unknown, attempts: number, now: number, random: number) {
  const http = axios.isAxiosError(error);
  const status = http ? error.response?.status : undefined;
  const retryable = http && (!error.response || status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500));
  const retryAt = retryAfterAt(error, now);
  const data = http ? error.response?.data : undefined;
  const serverMessage = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : null;
  // A refused send is the same sentence whatever caused it: a block, a lost
  // permission, a conversation that closed. The server says only "forbidden" on
  // purpose — a blocked sender must not be told they were blocked — but that
  // word is not an explanation, and until now it was the only thing the author
  // got. Say the one thing that is true and gives nothing away.
  const refusedMessage = status === 403 && (!serverMessage || /^forbidden$/i.test(serverMessage.trim()))
    ? 'This message can’t be delivered.'
    : null;
  return {
    status: retryable ? 'pending' as const : 'failed' as const,
    nextAttemptAt: retryable ? Math.max(now + retryDelay(attempts, random), retryAt ?? 0) : 0,
    retryAfterAt: retryAt ?? 0,
    // A 4xx the server did not ask us to come back for is a *decision about
    // this message*: an AutoMod block, a permission that is gone, a body it
    // will not accept. Replaying the same bytes gets the same answer forever,
    // so the queue must not offer to. 408/425/429 are the server asking for
    // patience, and everything else — a dropped connection, a 5xx, a client
    // error with no response at all — is a delivery that never happened. 401 is
    // the one 4xx left out: it says the session is gone, not that this message
    // is unacceptable, and it comes back the moment the account signs in again.
    refused: http && status !== undefined && status >= 400 && status < 500 && status !== 401 && !retryable,
    error: refusedMessage ?? serverMessage ?? (error instanceof Error ? error.message : 'Message delivery failed.'),
  };
}

interface DeliveryOptions {
  vault: AccountVault;
  lifetime: VaultLifetime;
  send: (record: DurableSend, signal: AbortSignal) => Promise<DeliveryResult>;
  beforeAttempt?: () => Promise<void>;
  prepareIntent?: (transaction: VaultTransaction, intent: DurableIntent) => Promise<SendMessageRequest>;
  /**
   * Encrypted attachment seam: work a queued draft needs finished *before* its
   * preparing transaction opens. Uploading attachment ciphertext can take
   * minutes, and holding the account vault lock across it would stall every
   * draft save in every tab. A failure here is classified exactly like a failed
   * preparation, so the draft stays editable and retries with backoff.
   */
  beforeIntentPrepare?: (intent: DurableIntent) => Promise<void>;
  discard?: (record: DurableSend, signal: AbortSignal) => Promise<DeliveryResult>;
  reconcileRemoved?: (transaction: VaultTransaction, record: DurableSend) => Promise<void>;
  acknowledgeSend?: (transaction: VaultTransaction, record: DurableSend, message: Message) => Promise<void>;
  edit?: {
    resolveSend: (record: DurableSend, signal: AbortSignal) => Promise<DeliveryResolution>;
    resolveEdit: (record: PreparedDeliveryEdit, signal: AbortSignal) => Promise<EditResolution>;
    prepare: (transaction: VaultTransaction, record: DurableSend, messageId: string, editNonce: string, content: string) => Promise<PreparedDeliveryEdit>;
    restore: (transaction: VaultTransaction, record: DurableSend, content: string) => Promise<DurableIntent>;
    send: (record: PreparedDeliveryEdit, signal: AbortSignal) => Promise<Message>;
  };
  onReceipt?: (receipt: DeliveryReceipt) => void;
  onChange?: () => void;
  onError: (error: unknown) => void;
  now?: () => number;
  random?: () => number;
}

/** Revision shown by the queue UI; stale editors must not replace a newer intention. */
export function queuedMutationRevision(record: DurableSend): string {
  if (record.mutation?.kind === 'discard') return 'discard';
  return record.mutation?.next?.editNonce ?? record.mutation?.editNonce ?? record.nonce;
}

/**
 * One network attempt at a time per account, including across browser tabs.
 * Failed or delayed items block only later sends in their own conversation.
 * Attempts and retry times commit before HTTP; a crash never loses the body or
 * retries immediately without the recorded delay. Acknowledgment and outbox
 * removal are one encrypted transaction, with a durable receipt for UI recovery.
 */
export class DurableDelivery {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lockName: string;
  private running: Promise<{ sent: number; nextAttemptAt: number | null }> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private waking = false;
  private wakeRequested = false;
  constructor(private readonly options: DeliveryOptions) {
    this.signal = AbortSignal.any([options.lifetime.signal, this.controller.signal]);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.lockName = `paracord:delivery:${accountScopeKey(options.vault.scope)}`;
    options.lifetime.signal.addEventListener('abort', this.stop, { once: true });
  }

  private assertCurrent() {
    this.signal.throwIfAborted();
    this.options.lifetime.assertCurrent();
  }

  /** A null result means the queue changed atomically and its lane must be reloaded. */
  private async prepareEditAttempt(attempt: DurableSend): Promise<DurableSend | null> {
    const mutation = attempt.mutation;
    if (mutation?.kind !== 'edit') return attempt;
    const editor = this.options.edit;
    if (!editor) throw new Error('No durable edit transport is available.');
    if (mutation.prepared) {
      if (!mutation.next) return attempt;
      // Seal the previous edit even after a timeout or a permanent failure.
      // Its delayed request must never overwrite the replacement operation.
      const resolved = await editor.resolveEdit(mutation.prepared, this.signal);
      this.assertCurrent();
      if (resolved.state === 'deleted') throw new DeliveryProtocolError('This message was deleted. Copy the retained draft to send a new message.');
      await this.options.vault.transact(async tx => {
        const current = await tx.get<DurableSend>(OUTBOX_NAMESPACE, attempt.id);
        if (current?.mutation?.kind !== 'edit' || current.mutation.editNonce !== mutation.editNonce) return;
        if (!current.mutation.next) throw new Error('The replacement edit intent is missing.');
        tx.put(OUTBOX_NAMESPACE, current.id, { ...current, mutation: { kind: 'edit', ...current.mutation.next },
          status: 'pending', error: null, refused: false, attempts: 0, nextAttemptAt: Math.max(this.now(), current.retryAfterAt ?? 0) });
      });
      return null;
    }
    const resolved = await editor.resolveSend(attempt, this.signal);
    this.assertCurrent();
    if (resolved.state === 'deleted') throw new DeliveryProtocolError('This message was deleted. Copy the retained draft to send a new message.');
    return this.options.vault.transact(async tx => {
      this.assertCurrent();
      const current = await tx.get<DurableSend>(OUTBOX_NAMESPACE, attempt.id);
      if (current?.mutation?.kind !== 'edit' || current.mutation.editNonce !== mutation.editNonce) return null;
      if (resolved.state === 'cancelled') {
        const restored = await editor.restore(tx, current, current.mutation.content);
        if (restored.nonce === current.nonce || restored.channelId !== current.channelId || restored.sequence !== current.sequence) {
          throw new DeliveryProtocolError('The replacement draft must keep its conversation and order with a new delivery identity.');
        }
        if (JSON.parse(current.serializedRequest).e2ee) {
          if (!this.options.reconcileRemoved) throw new Error('The canceled encryption generation must be resolved before replacement.');
          await this.options.reconcileRemoved(tx, current);
        }
        tx.remove(OUTBOX_NAMESPACE, current.id);
        tx.put(INTENT_NAMESPACE, restored.id, restored);
        return null;
      }
      const prepared = await editor.prepare(tx, current, resolved.messageId, current.mutation.editNonce, current.mutation.content);
      if (prepared.channelId !== current.channelId || prepared.messageId !== resolved.messageId
        || prepared.editNonce !== current.mutation.editNonce || JSON.parse(prepared.serializedRequest)?.edit_nonce !== prepared.editNonce) {
        throw new DeliveryProtocolError('The prepared edit changed its original operation identity.');
      }
      const updated = { ...current, mutation: { ...current.mutation, prepared } };
      tx.put(OUTBOX_NAMESPACE, current.id, updated);
      return updated;
    });
  }

  drain(): Promise<{ sent: number; nextAttemptAt: number | null }> {
    if (this.running) return this.running;
    const run = navigator.locks.request(this.lockName, { mode: 'exclusive', signal: this.signal }, async () => {
      this.assertCurrent();
      const lanes = new Map<string, { records: QueuedSend[]; index: number }>();
      for (const record of await listQueuedSends(this.options.vault)) {
        const lane = lanes.get(record.channelId) ?? { records: [], index: 0 };
        lane.records.push(record); lanes.set(record.channelId, lane);
      }
      const refreshLane = async (channelId: string) => {
        const records = (await listQueuedSends(this.options.vault)).filter(record => record.channelId === channelId);
        if (records.length) lanes.set(channelId, { records, index: 0 });
        else lanes.delete(channelId);
      };
      let sent = 0;
      for (;;) {
        this.assertCurrent();
        const now = this.now();
        let candidate: QueuedSend | undefined;
        let nextAttemptAt: number | null = null;
        for (const { records, index } of lanes.values()) {
          const head = records[index];
          if (head.status !== 'pending') continue;
          if (head.nextAttemptAt <= now && (!candidate || head.sequence < candidate.sequence)) candidate = head;
          nextAttemptAt = Math.min(nextAttemptAt ?? Infinity, head.nextAttemptAt);
        }
        if (!candidate) return { sent, nextAttemptAt };
        const next = candidate;
        const lane = lanes.get(next.channelId)!;
        let attempt: DurableSend | null;
        let preparing: DurableIntent | undefined;
        try {
          await this.options.beforeAttempt?.();
          if (!isPreparedSend(next) && this.options.beforeIntentPrepare) {
            preparing = next;
            await this.options.beforeIntentPrepare(next);
            this.assertCurrent();
            preparing = undefined;
          }
          attempt = await this.options.vault.transact(async tx => {
            this.assertCurrent();
            let current: DurableSend | null = await tx.get<DurableSend>(OUTBOX_NAMESPACE, next.id);
            if (!current) {
              const intent = await tx.get<DurableIntent>(INTENT_NAMESPACE, next.id);
              if (!intent) return null; // An edit/discard can win before preparation.
              preparing = intent;
              if (!this.options.prepareIntent) throw new Error('No encryptor is available for this queued draft.');
              const request = await this.options.prepareIntent(tx, intent);
              this.assertCurrent();
              current = commitPreparedIntent(tx, intent, request);
            } else if (isPreparedSend(next) && current.serializedRequest !== next.serializedRequest) {
              throw new Error('The queued message changed before delivery.');
            }
            if (!Number.isSafeInteger(current.attempts) || current.attempts < 0 || current.attempts === Number.MAX_SAFE_INTEGER) throw new Error('Invalid delivery attempt counter.');
            const attempted = { ...current, attempts: current.attempts + 1, nextAttemptAt: now + retryDelay(current.attempts + 1, this.random()) };
            tx.put(OUTBOX_NAMESPACE, next.id, attempted);
            return attempted;
          });
        } catch (error) {
          this.assertCurrent();
          if (!preparing) throw error;
          const preparedFrom = preparing;
          const current = await this.options.vault.transact(async tx => {
            const draft = await tx.get<DurableIntent>(INTENT_NAMESPACE, next.id);
            if (!draft || draft.revision !== preparedFrom.revision) return draft;
            if (!Number.isSafeInteger(draft.attempts) || draft.attempts < 0 || draft.attempts === Number.MAX_SAFE_INTEGER) throw error;
            const failed = { ...draft, attempts: draft.attempts + 1,
              ...classifyDeliveryFailure(error, draft.attempts + 1, this.now(), this.random()) };
            tx.put(INTENT_NAMESPACE, draft.id, failed);
            return failed;
          });
          if (current) lane.records[lane.index] = current;
          else {
            lane.index++;
            if (lane.index === lane.records.length) lanes.delete(next.channelId);
          }
          this.options.onChange?.();
          continue;
        }
        if (!attempt) {
          lane.index++;
          if (lane.index === lane.records.length) lanes.delete(next.channelId);
          continue;
        }
        let result: DeliveryResult;
        try {
          this.assertCurrent();
          if (attempt.mutation?.kind === 'edit') {
            const prepared = await this.prepareEditAttempt(attempt);
            if (!prepared) { await refreshLane(attempt.channelId); this.options.onChange?.(); continue; }
            attempt = prepared;
            if (attempt.mutation?.kind !== 'edit' || !attempt.mutation.prepared) throw new Error('The committed edit request is missing.');
            result = { kind: 'message', message: await this.options.edit!.send(attempt.mutation.prepared, this.signal) };
          } else if (attempt.mutation?.kind === 'discard') {
            if (!this.options.discard) throw new Error('No delivery resolution transport is available.');
            result = await this.options.discard(attempt, this.signal);
            if (result.kind === 'message') throw new DeliveryProtocolError('The server has not completed the requested discard.');
          } else result = await this.options.send(attempt, this.signal);
          if (result.kind !== 'message' && JSON.parse(attempt.serializedRequest).e2ee && !this.options.reconcileRemoved) {
            throw new DeliveryProtocolError('Resolve this message’s encryption generation before removing it from the outbox.');
          }
          this.assertCurrent();
        } catch (error) {
          this.assertCurrent(); // Logout/lock is cancellation, never a failed send or receipt.
          const failedAttempt = attempt;
          if (!failedAttempt) throw error;
          const failed = await this.options.vault.transact(async tx => {
            this.assertCurrent();
            const current = await tx.get<DurableSend>(OUTBOX_NAMESPACE, failedAttempt.id);
            if (!current) throw new Error('The attempted message is missing from the outbox.');
            const failure = classifyDeliveryFailure(error, failedAttempt.attempts, this.now(), this.random());
            const updated = current.mutation && queuedMutationRevision(current) !== queuedMutationRevision(failedAttempt)
              ? { ...current, status: 'pending' as const, error: null, refused: false,
                retryAfterAt: Math.max(current.retryAfterAt ?? 0, failure.retryAfterAt),
                nextAttemptAt: Math.max(this.now(), current.retryAfterAt ?? 0, failure.retryAfterAt) }
              : { ...current, ...failure };
            tx.put(OUTBOX_NAMESPACE, failedAttempt.id, updated);
            return updated;
          });
          lane.records[lane.index] = failed;
          this.options.onChange?.();
          continue;
        }
        const receipt: DeliveryReceipt = { nonce: attempt.nonce, channelId: attempt.channelId, acknowledgedAt: new Date(this.now()).toISOString(), result };
        const requestedDiscard = await this.options.vault.transact(async tx => {
          this.assertCurrent();
          const current = await tx.get<DurableSend>(OUTBOX_NAMESPACE, attempt.id);
          if (!current) throw new Error('The attempted message is missing from the outbox.');
          // A changed edit or discard can commit while HTTP is in flight.
          // Its durable intent wins and blocks followers until resolution.
          if (current.mutation && queuedMutationRevision(current) !== queuedMutationRevision(attempt)) return current;
          if (result.kind !== 'message' && JSON.parse(attempt.serializedRequest).e2ee) {
            await this.options.reconcileRemoved!(tx, attempt);
          }
          if (result.kind === 'message' && !attempt.mutation) await this.options.acknowledgeSend?.(tx, attempt, result.message);
          tx.put(DELIVERY_RECEIPTS_NAMESPACE, attempt.id, receipt);
          tx.remove(OUTBOX_NAMESPACE, attempt.id);
          return null;
        });
        if (requestedDiscard) {
          lane.records[lane.index] = requestedDiscard;
          this.options.onChange?.();
          continue;
        }
        lane.index++;
        if (result.kind !== 'message' || attempt.mutation?.kind === 'edit') {
          const remaining = (await listQueuedSends(this.options.vault)).filter(record => record.channelId === attempt.channelId);
          if (remaining.length) lanes.set(attempt.channelId, { records: remaining, index: 0 });
          else lanes.delete(attempt.channelId);
        } else if (lane.index === lane.records.length) lanes.delete(attempt.channelId);
        if (result.kind === 'message') sent++;
        this.assertCurrent();
        this.options.onReceipt?.(receipt);
        this.options.onChange?.();
      }
    });
    this.running = Promise.resolve(run).finally(() => { this.running = null; });
    return this.running;
  }

  /** Explicit retry keeps the original bytes, nonce and rate-limit deadline. */
  async retry(id: string) {
    await navigator.locks.request(this.lockName, { mode: 'exclusive', signal: this.signal }, async () => {
      this.assertCurrent();
      await this.options.vault.transact(async tx => {
        const prepared = await tx.get<DurableSend>(OUTBOX_NAMESPACE, id);
        const current = prepared ?? await tx.get<DurableIntent>(INTENT_NAMESPACE, id);
        if (!current) throw new Error('This message is no longer in the outbox.');
        tx.put(prepared ? OUTBOX_NAMESPACE : INTENT_NAMESPACE, id, { ...current, status: 'pending', error: null, refused: false, nextAttemptAt: Math.max(this.now(), current.retryAfterAt ?? 0) });
      });
    });
    this.options.onChange?.();
    this.wake();
  }

  /** Persist edits immediately, including while the original request is in flight. */
  async editPrepared(id: string, revision: string, content: string) {
    await this.options.vault.transact(async tx => {
      this.assertCurrent();
      const current = await tx.get<DurableSend>(OUTBOX_NAMESPACE, id);
      if (!current) throw new Error('This message is no longer queued. Edit its delivered message in the conversation.');
      if (current.mutation?.kind === 'discard') throw new Error('This message is already being discarded.');
      if (queuedMutationRevision(current) !== revision) throw new Error('This queued message changed in another window. Review its latest draft before editing it.');
      const edit = { editNonce: crypto.randomUUID(), content };
      const mutation = current.mutation?.prepared
        ? { ...current.mutation, next: edit }
        : { kind: 'edit' as const, ...edit };
      tx.put(OUTBOX_NAMESPACE, id, { ...current, draft: { content }, mutation, status: 'pending', error: null, refused: false,
        nextAttemptAt: Math.max(this.now(), current.retryAfterAt ?? 0) });
    });
    this.options.onChange?.(); this.wake();
  }

  /** Persist the discard before any network request; reload must never resume the original POST. */
  async discardPrepared(id: string) {
    await this.options.vault.transact(async tx => {
      this.assertCurrent();
      const current = await tx.get<DurableSend>(OUTBOX_NAMESPACE, id);
      if (!current) throw new Error('This message is no longer queued. If it was delivered, delete it from the conversation.');
      tx.put(OUTBOX_NAMESPACE, id, { ...current, mutation: { kind: 'discard' }, status: 'pending',
        error: null, refused: false, nextAttemptAt: Math.max(this.now(), current.retryAfterAt ?? 0) });
    });
    this.options.onChange?.(); this.wake();
  }

  async editDraft(id: string, revision: string, content: string) {
    this.assertCurrent();
    const updated = await editMessageIntent(this.options.vault, id, revision, content);
    this.options.onChange?.(); this.wake();
    return updated;
  }

  async discardDraft(id: string, revision: string) {
    this.assertCurrent();
    await discardMessageIntent(this.options.vault, id, revision);
    this.options.onChange?.(); this.wake();
  }

  start() {
    this.assertCurrent();
    if (this.started) return;
    this.started = true;
    window.addEventListener('online', this.wake);
    this.wake();
  }

  /** Call after a newly prepared message commits. Existing in-flight work coalesces. */
  wake = () => {
    if (!this.started) return;
    this.wakeRequested = true;
    if (this.waking) return;
    this.waking = true;
    clearTimeout(this.timer);
    void (async () => {
      do {
        this.wakeRequested = false;
        const { nextAttemptAt } = await this.drain();
        if (this.started && !this.wakeRequested && nextAttemptAt !== null) {
          this.timer = setTimeout(this.wake, Math.min(2 ** 31 - 1, Math.max(1, nextAttemptAt - this.now())));
        }
      } while (this.started && this.wakeRequested);
    })().catch(error => {
      if (!this.signal.aborted) this.options.onError(error);
    }).finally(() => {
      this.waking = false;
      if (this.started && this.wakeRequested) this.wake();
    });
  };

  stop = () => {
    this.started = false;
    this.controller.abort();
    this.options.lifetime.signal.removeEventListener('abort', this.stop);
    clearTimeout(this.timer);
    window.removeEventListener('online', this.wake);
  };
}
