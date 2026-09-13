import type { Message } from '../../types';

export type HistoryMode = 'latest' | 'before' | 'around';
type MessagePatch = Partial<Message> & Pick<Message, 'id'>;
type Mutation = { kind: 'write'; created: boolean; value: MessagePatch } | { kind: 'delete' };
export const MAX_HISTORY_MUTATIONS = 10_000;

/**
 * One history request owns its journal. It lives only until the bounded HTTP
 * request completes or is cancelled; repeated edits coalesce by message ID.
 * Never retain a global, unbounded list of gateway events.
 */
export class HistoryRequest {
  readonly controller = new AbortController();
  private readonly changes = new Map<string, Mutation>();
  failure: string | null = null;

  constructor(readonly mode: HistoryMode, private readonly limit = MAX_HISTORY_MUTATIONS) {
    this.controller.signal.addEventListener('abort', () => this.changes.clear(), { once: true });
  }

  private accept(id: string): boolean {
    if (this.controller.signal.aborted) return false;
    if (this.changes.has(id) || this.changes.size < this.limit) return true;
    this.failure = 'Too many messages changed while history was loading. Retry to load a current page.';
    this.changes.clear();
    this.controller.abort();
    return false;
  }

  isDeleted(id: string): boolean {
    return this.changes.get(id)?.kind === 'delete';
  }

  record(message: MessagePatch, created = false): void {
    if (!this.accept(message.id)) return;
    const previous = this.changes.get(message.id);
    // Message IDs cannot be reused. Replay after a delete must not resurrect it.
    if (previous?.kind === 'delete') return;
    this.changes.set(message.id, {
      kind: 'write',
      created: created || previous?.created === true,
      value: { ...(previous?.value ?? {}), ...message },
    });
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.accept(id)) return;
      this.changes.set(id, { kind: 'delete' });
    }
  }

  reconcile(history: Message[], current: Message[]): Message[] {
    const messages = new Map(history.map((message) => [message.id, message]));
    if (this.mode === 'before') {
      // The live window remains authoritative when paging backwards.
      for (const message of current) messages.set(message.id, message);
    }
    for (const [id, mutation] of this.changes) {
      if (mutation.kind === 'delete') {
        messages.delete(id);
        continue;
      }
      const base = messages.get(id);
      if (base) {
        messages.set(id, { ...base, ...mutation.value });
      } else if (mutation.created && this.mode !== 'around') {
        messages.set(id, mutation.value as Message);
      }
    }
    // Snowflakes exceed Number's integer precision. Compare decimal strings.
    return [...messages.values()].sort((a, b) =>
      a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
}
