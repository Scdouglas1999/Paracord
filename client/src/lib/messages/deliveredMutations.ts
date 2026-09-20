import type { Message } from '../../types';
import type { AccountVault, VaultLifetime, VaultTransaction } from '../crypto/accountVault';
import { assertSignalMessageId } from '../crypto/signalSessions';
import { accountScopeKey } from '../serverScope';
import { classifyDeliveryFailure, DeliveryProtocolError } from './durableDelivery';
import type { EditResolution, PreparedDeliveryEdit } from './durableEdit';
import type { DeletionResolution, PreparedMessageDeletion } from './deliveredMutationTransport';

export const DELIVERED_MUTATIONS_NAMESPACE = 'messages.delivered-mutations';
export const MUTATION_RECEIPTS_NAMESPACE = 'messages.mutation-receipts';
export const DELETED_MESSAGES_NAMESPACE = 'messages.deleted';

/** Capture from an account-owned server message and verified conversation metadata. */
export interface DeliveredMessageTarget {
  channelId: string;
  messageId: string;
  authorId: string;
  encryption:
    | { kind: 'plain' }
    | { kind: 'dm'; peer: { id: string; publicKey: string } }
    | { kind: 'group'; members: Array<{ id: string; publicKey: string }> };
}
export interface DeliveredMutation {
  id: string;
  target: DeliveredMessageTarget;
  sequence: number;
  revision: string;
  intent: { kind: 'edit'; editNonce: string; content: string } | { kind: 'delete'; deleteNonce: string };
  /** A superseded prepared PATCH remains immutable until its resolution commits. */
  prepared?: PreparedDeliveryEdit;
  deletionPrepared?: boolean;
  draft?: { content: string };
  status: 'pending' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  retryAfterAt: number;
  error: string | null;
  targetDeleted?: boolean;
}
export interface DeliveredMutationReceipt {
  id: string;
  revision: string;
  sequence: number;
  target: DeliveredMessageTarget;
  result: { kind: 'message'; message: Message } | { kind: 'deleted' };
}
interface MutationOptions {
  vault: AccountVault;
  lifetime: VaultLifetime;
  prepareEdit(tx: VaultTransaction, target: DeliveredMessageTarget, editNonce: string, content: string): Promise<PreparedDeliveryEdit>;
  prepareDelete?(tx: VaultTransaction, target: DeliveredMessageTarget): Promise<void>;
  edit(record: PreparedDeliveryEdit, signal: AbortSignal): Promise<Message>;
  resolveEdit(record: PreparedDeliveryEdit, signal: AbortSignal): Promise<EditResolution>;
  deletion: {
    resolve(record: PreparedMessageDeletion, signal: AbortSignal): Promise<DeletionResolution>;
    send(record: PreparedMessageDeletion, signal: AbortSignal): Promise<void>;
  };
  onChange?: () => void;
  beforeAttempt?(target: DeliveredMessageTarget): Promise<void>;
  onError(error: unknown): void;
  now?: () => number;
  random?: () => number;
}
const targetKey = (target: Pick<DeliveredMessageTarget, 'channelId' | 'messageId'>) => JSON.stringify([target.channelId, target.messageId]);

/**
 * Delivered-message mutations need no creation receipt and never POST a message.
 * The delivery lock is shared with DurableDelivery across tabs; accepting a new
 * edit/delete takes only the vault lock, so user intent can win during HTTP.
 * Consumers reconcile snapshots with their history journal, including tombstones;
 * an old receipt is not permission to insert a row deleted by a later gateway event.
 */
export class DeliveredMutations {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly now: () => number;
  private readonly random: () => number;
  private running: Promise<{ completed: number; nextAttemptAt: number | null }> | null = null;
  private started = false;
  private waking = false;
  private wakeRequested = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: MutationOptions) {
    this.signal = AbortSignal.any([options.lifetime.signal, this.controller.signal]);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    options.lifetime.signal.addEventListener('abort', this.stop, { once: true });
  }
  private assertCurrent() { this.signal.throwIfAborted(); this.options.lifetime.assertCurrent(); }
  private assertTarget(target: DeliveredMessageTarget) {
    this.assertCurrent(); assertSignalMessageId(target.messageId);
    if (!target.channelId || target.authorId !== this.options.vault.scope.userId) {
      throw new Error('Delivered-message mutations require this account’s own message.');
    }
    const encryption = target.encryption;
    const validIdentity = (entry: { id: string; publicKey: string }) => Boolean(entry.id) && /^[0-9a-f]{64}$/i.test(entry.publicKey);
    const valid = encryption.kind === 'plain'
      || (encryption.kind === 'dm' && validIdentity(encryption.peer))
      || (encryption.kind === 'group' && encryption.members.length > 0 && encryption.members.every(validIdentity));
    if (!valid) throw new Error('The original conversation encryption metadata is invalid.');
  }

  async snapshot() {
    this.assertCurrent();
    return this.options.vault.transact(async tx => {
      const deleted = new Set((await tx.list(DELETED_MESSAGES_NAMESPACE)).map(row => row.id));
      const mutations = (await tx.list<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE)).map(row => row.value).sort((a, b) => a.sequence - b.sequence);
      const receipts = (await tx.list<DeliveredMutationReceipt>(MUTATION_RECEIPTS_NAMESPACE)).map(({ value }) =>
        deleted.has(value.id) ? { ...value, result: { kind: 'deleted' as const } } : value).sort((a, b) => a.sequence - b.sequence);
      return { mutations, receipts, deleted: [...deleted] };
    });
  }

  /** null means no pending mutation; any pending editor must provide its revision. */
  async edit(target: DeliveredMessageTarget, content: string, expectedRevision: string | null) {
    if (!content.trim()) throw new Error('Enter the replacement message before saving this edit.');
    return this.accept(target, { kind: 'edit', content, editNonce: crypto.randomUUID() }, expectedRevision);
  }
  async delete(target: DeliveredMessageTarget, expectedRevision: string | null) {
    return this.accept(target, { kind: 'delete', deleteNonce: crypto.randomUUID() }, expectedRevision);
  }
  private async accept(target: DeliveredMessageTarget, intent: DeliveredMutation['intent'], expectedRevision: string | null) {
    this.assertTarget(target);
    const captured = structuredClone(target);
    const updated = await this.options.vault.transact(async tx => {
      this.assertCurrent();
      const id = targetKey(captured);
      if (await tx.get(DELETED_MESSAGES_NAMESPACE, id)) throw new Error('This message was deleted. Copy the retained draft to send a new message.');
      const current = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, id);
      if ((current?.revision ?? null) !== expectedRevision) throw new Error('This message changed in another window. Review its latest saved mutation.');
      if (current?.intent.kind === 'delete') throw new Error('This message is already being deleted.');
      if (current && JSON.stringify(current.target) !== JSON.stringify(captured)) throw new Error('The original conversation metadata changed.');
      let sequence = current?.sequence;
      if (sequence === undefined) {
        const previous = await tx.get<number>('messages.delivery', 'sequence') ?? 0;
        sequence = previous + 1;
        if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(sequence)) throw new Error('The mutation sequence cannot advance safely.');
        tx.put('messages.delivery', 'sequence', sequence);
      }
      const record: DeliveredMutation = { ...current, id, target: captured, sequence, revision: crypto.randomUUID(), intent,
        draft: intent.kind === 'edit' ? { content: intent.content } : current?.draft,
        status: 'pending', attempts: current?.attempts ?? 0, retryAfterAt: current?.retryAfterAt ?? 0,
        nextAttemptAt: Math.max(this.now(), current?.retryAfterAt ?? 0), error: null };
      tx.put(DELIVERED_MUTATIONS_NAMESPACE, id, record);
      return record;
    });
    this.changed(); return updated;
  }
  async retry(id: string, expectedRevision: string) {
    this.assertCurrent();
    await this.options.vault.transact(async tx => {
      const current = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, id);
      if (!current || current.revision !== expectedRevision) throw new Error('Review the latest saved mutation before retrying.');
      if (current.targetDeleted) throw new Error('This message was deleted. Copy its retained draft to send a new message.');
      tx.put(DELIVERED_MUTATIONS_NAMESPACE, id, { ...current, status: 'pending', error: null, nextAttemptAt: Math.max(this.now(), current.retryAfterAt) });
    });
    this.changed();
  }

  /** Call only for an authenticated gateway/delete observation in this vault's account. */
  async observeDeleted(target: Pick<DeliveredMessageTarget, 'channelId' | 'messageId'>) {
    this.assertCurrent(); assertSignalMessageId(target.messageId);
    if (!target.channelId) throw new Error('A conversation is required.');
    await this.options.vault.transact(tx => this.markDeleted(tx, targetKey(target)));
    this.changed();
  }
  /** Recovery commits the tombstone and pending mutation effect with its cursor. */
  async observeDeletedInTransaction(tx: VaultTransaction, target: Pick<DeliveredMessageTarget, 'channelId' | 'messageId'>) {
    this.options.lifetime.assertCurrent(); assertSignalMessageId(target.messageId);
    if (!target.channelId) throw new Error('A conversation is required.');
    await this.markDeleted(tx, targetKey(target));
  }
  private async markDeleted(tx: VaultTransaction, id: string) {
    tx.put(DELETED_MESSAGES_NAMESPACE, id, { observedAt: this.now() });
    const current = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, id);
    if (!current) return;
    if (current.intent.kind === 'delete') {
      tx.put(MUTATION_RECEIPTS_NAMESPACE, current.revision, { id, revision: current.revision, sequence: current.sequence, target: current.target,
        result: { kind: 'deleted' } } satisfies DeliveredMutationReceipt);
      tx.remove(DELIVERED_MUTATIONS_NAMESPACE, id);
    } else tx.put(DELIVERED_MUTATIONS_NAMESPACE, id, { ...current, status: 'failed', targetDeleted: true,
      error: 'This message was deleted. Copy the retained draft to send a new message.', nextAttemptAt: 0 });
  }

  drain(): Promise<{ completed: number; nextAttemptAt: number | null }> {
    if (this.running) return this.running;
    const run = navigator.locks.request(`paracord:delivery:${accountScopeKey(this.options.vault.scope)}`, { mode: 'exclusive', signal: this.signal }, async () => {
      let completed = 0;
      for (;;) {
        this.assertCurrent();
        const rows = await this.options.vault.transact(async tx => (await tx.list<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE))
          .map(row => row.value).filter(row => row.status === 'pending').sort((a, b) => a.sequence - b.sequence));
        const next = rows.find(row => row.nextAttemptAt <= this.now());
        if (!next) return { completed, nextAttemptAt: rows.reduce<number | null>((earliest, row) => Math.min(earliest ?? Infinity, row.nextAttemptAt), null) };
        let attempt = next;
        try {
          await this.options.beforeAttempt?.(next.target);
          this.assertCurrent();
          attempt = await this.options.vault.transact(async tx => {
            this.assertCurrent();
            const current = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, next.id);
            if (!current || current.revision !== next.revision || current.status !== 'pending') return next;
            if (!Number.isSafeInteger(current.attempts) || current.attempts < 0 || current.attempts === Number.MAX_SAFE_INTEGER) throw new Error('Invalid mutation attempt counter.');
            const attempts = current.attempts + 1;
            const record = { ...current, attempts, nextAttemptAt: this.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)) };
            tx.put(DELIVERED_MUTATIONS_NAMESPACE, current.id, record);
            return record;
          });
          // Re-read after accepting the attempt so a concurrent deletion observation wins.
          const current = await this.options.vault.transact(tx => tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, next.id));
          if (!current || current.targetDeleted || current.revision !== attempt.revision) continue;
          attempt = current;
          if (attempt.prepared && (attempt.intent.kind === 'delete' || attempt.intent.editNonce !== attempt.prepared.editNonce)) {
            const resolved = await this.options.resolveEdit(attempt.prepared, this.signal);
            this.assertCurrent();
            await this.options.vault.transact(async tx => {
              const latest = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, attempt.id);
              if (resolved.state === 'deleted') return this.markDeleted(tx, attempt.id);
              if (latest?.prepared?.editNonce !== attempt.prepared!.editNonce || latest.targetDeleted) return;
              const { prepared: _prepared, ...retained } = latest;
              tx.put(DELIVERED_MUTATIONS_NAMESPACE, attempt.id, { ...retained, status: 'pending', error: null,
                nextAttemptAt: Math.max(this.now(), latest.retryAfterAt) });
            });
            this.options.onChange?.(); continue;
          }
          if (attempt.intent.kind === 'delete') {
            if (!attempt.deletionPrepared) {
              const prepared = await this.options.vault.transact(async tx => {
                const latest = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, attempt.id);
                if (!latest || latest.revision !== attempt.revision || latest.targetDeleted) return false;
                if (latest.target.encryption.kind !== 'plain' && !this.options.prepareDelete) throw new Error('The deleted message’s encryption dependencies must be retired before deletion.');
                await this.options.prepareDelete?.(tx, latest.target);
                this.assertCurrent();
                tx.put(DELIVERED_MUTATIONS_NAMESPACE, latest.id, { ...latest, deletionPrepared: true });
                return true;
              });
              if (!prepared) continue;
            }
            const deletion = { channelId: attempt.target.channelId, messageId: attempt.target.messageId, deleteNonce: attempt.intent.deleteNonce };
            const resolved = await this.options.deletion.resolve(deletion, this.signal);
            this.assertCurrent();
            if (resolved.state === 'pending') await this.options.deletion.send(deletion, this.signal);
            this.assertCurrent();
            await this.options.vault.transact(tx => this.markDeleted(tx, attempt.id));
            completed++;
          } else {
            if (!attempt.prepared) {
              const prepared = await this.options.vault.transact(async tx => {
                this.assertCurrent();
                const latest = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, attempt.id);
                if (!latest || latest.revision !== attempt.revision || latest.targetDeleted || latest.intent.kind !== 'edit') return null;
                const wire = await this.options.prepareEdit(tx, latest.target, latest.intent.editNonce, latest.intent.content);
                this.assertCurrent();
                if (wire.channelId !== latest.target.channelId || wire.messageId !== latest.target.messageId
                  || wire.editNonce !== latest.intent.editNonce || JSON.parse(wire.serializedRequest)?.edit_nonce !== wire.editNonce) {
                  throw new DeliveryProtocolError('The prepared edit changed its original operation identity.');
                }
                const record = { ...latest, prepared: wire };
                tx.put(DELIVERED_MUTATIONS_NAMESPACE, latest.id, record);
                return record;
              });
              if (!prepared) continue;
              attempt = prepared;
            }
            const message = await this.options.edit(attempt.prepared!, this.signal);
            this.assertCurrent();
            if (message.id !== attempt.target.messageId || message.channel_id !== attempt.target.channelId
              || message.author.id !== this.options.vault.scope.userId) throw new DeliveryProtocolError('The edited message belongs to a different target or account.');
            const finished = await this.options.vault.transact(async tx => {
              const latest = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, attempt.id);
              if (await tx.get(DELETED_MESSAGES_NAMESPACE, attempt.id)) { await this.markDeleted(tx, attempt.id); return false; }
              if (!latest || latest.revision !== attempt.revision) return false;
              tx.put(MUTATION_RECEIPTS_NAMESPACE, latest.revision, { id: latest.id, revision: latest.revision, sequence: latest.sequence, target: latest.target,
                result: { kind: 'message', message } } satisfies DeliveredMutationReceipt);
              tx.remove(DELIVERED_MUTATIONS_NAMESPACE, latest.id);
              return true;
            });
            if (finished) completed++;
          }
        } catch (error) {
          this.assertCurrent(); // Logout/lock preserves intent; it is not delivery failure.
          await this.options.vault.transact(async tx => {
            const latest = await tx.get<DeliveredMutation>(DELIVERED_MUTATIONS_NAMESPACE, attempt.id);
            if (!latest || latest.targetDeleted) return;
            const failure = classifyDeliveryFailure(error, attempt.attempts, this.now(), this.random());
            const deadline = Math.max(latest.retryAfterAt, failure.retryAfterAt);
            tx.put(DELIVERED_MUTATIONS_NAMESPACE, latest.id, latest.revision !== attempt.revision
              ? { ...latest, status: 'pending', error: null, retryAfterAt: deadline, nextAttemptAt: Math.max(this.now(), deadline) }
              : { ...latest, ...failure, retryAfterAt: deadline, nextAttemptAt: Math.max(failure.nextAttemptAt, deadline) });
          });
        }
        this.options.onChange?.();
      }
    });
    this.running = Promise.resolve(run).finally(() => { this.running = null; });
    return this.running;
  }
  private changed() { this.options.onChange?.(); this.wake(); }
  start() { this.assertCurrent(); if (this.started) return; this.started = true; window.addEventListener('online', this.wake); this.wake(); }
  wake = () => {
    if (!this.started) return;
    this.wakeRequested = true;
    if (this.waking) return;
    this.waking = true; clearTimeout(this.timer);
    void (async () => {
      do {
        this.wakeRequested = false;
        const result = await this.drain();
        if (this.started && !this.wakeRequested && result.nextAttemptAt !== null) {
          this.timer = setTimeout(this.wake, Math.min(2 ** 31 - 1, Math.max(1, result.nextAttemptAt - this.now())));
        }
      } while (this.started && this.wakeRequested);
    })().catch(error => { if (!this.signal.aborted) this.options.onError(error); }).finally(() => {
      this.waking = false; if (this.started && this.wakeRequested) this.wake();
    });
  };
  stop = () => {
    this.started = false; this.controller.abort(); clearTimeout(this.timer);
    window.removeEventListener('online', this.wake);
    this.options.lifetime.signal.removeEventListener('abort', this.stop);
  };
}
