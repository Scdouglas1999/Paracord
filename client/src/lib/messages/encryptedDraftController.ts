import { createStore } from 'zustand/vanilla';
import type { EncryptedMessageDraft } from './encryptedDraftSubmission';

interface DraftPersistence {
  read(): Promise<EncryptedMessageDraft | null>;
  write(draft: EncryptedMessageDraft, expectedRevision: string | null): Promise<void>;
  clear(revision: string): Promise<void>;
}
interface DraftSnapshot {
  draft: EncryptedMessageDraft;
  status: 'loading' | 'saving' | 'saved' | 'error';
  error: string | null;
}
const empty = () => ({ revision: crypto.randomUUID(), content: '' });
const failure = (error: unknown) => `Draft not saved on this device. ${error instanceof Error ? error.message : 'Encrypted storage is unavailable.'}`;

/** In-memory text remains visible when encrypted persistence fails. */
export class EncryptedDraftController {
  readonly store = createStore<DraftSnapshot>(() => ({ draft: empty(), status: 'loading', error: null }));
  private persistedRevision: string | null = null;
  private readonly initialRevision = this.store.getState().draft.revision;
  private readonly loaded: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;
  private loadRecovered = false;
  private pausedReason: string | null = null;
  constructor(private readonly persistence: DraftPersistence) {
    this.loaded = this.load();
    void this.loaded.catch(() => {});
  }
  private async load() {
    try {
      const saved = await this.persistence.read();
      if (this.disposed || this.pausedReason) return;
      if (this.store.getState().draft.revision !== this.initialRevision) {
        if (saved?.content) throw new Error('A saved draft was found while you were typing. Reopen the conversation to review it; your unsaved text remains here.');
        return;
      }
      this.persistedRevision = saved?.revision ?? null;
      this.store.setState({ draft: saved ?? this.store.getState().draft, status: 'saved', error: null });
    } catch (error) {
      if (!this.disposed) this.store.setState({ status: 'error', error: failure(error) });
      throw error;
    }
  }
  /** UI observes load failures through the store, without unhandled rejections. */
  initialize() { void this.loaded.catch(() => {}); }
  setContent(content: string) {
    if (this.disposed) return;
    const draft = { revision: crypto.randomUUID(), content };
    this.store.setState({ draft, status: this.pausedReason ? 'error' : 'saving', error: this.pausedReason });
    if (this.pausedReason) return;
    this.save(draft);
  }
  private save(draft: EncryptedMessageDraft, retry = false) {
    const pending = this.writes.catch(() => {}).then(async () => {
      await this.loaded.catch(error => { if (!retry) throw error; });
      if (this.disposed || this.pausedReason) throw new Error(this.pausedReason ?? 'This draft session ended.');
      await this.persistence.write(draft, this.persistedRevision);
      if (this.disposed || this.pausedReason) throw new Error(this.pausedReason ?? 'This draft session ended.');
      this.loadRecovered = true;
      this.persistedRevision = draft.revision;
      if (!this.disposed && this.store.getState().draft.revision === draft.revision) this.store.setState({ status: 'saved', error: null });
    });
    this.writes = pending;
    void pending.catch(error => {
      if (!this.disposed && this.store.getState().draft.revision === draft.revision) this.store.setState({ status: 'error', error: failure(error) });
    });
    return pending;
  }
  retrySave() {
    const draft = this.store.getState().draft;
    this.store.setState({ status: 'saving', error: null });
    return this.save(draft, true);
  }
  async capture() {
    await this.loaded.catch(error => { if (!this.loadRecovered) throw error; });
    const draft = this.store.getState().draft;
    await this.writes;
    if (this.disposed || this.pausedReason) throw new Error(this.pausedReason ?? 'This draft session ended.');
    if (this.store.getState().draft.revision === draft.revision && this.store.getState().status === 'error') throw new Error(this.store.getState().error ?? 'Save this draft before sending.');
    return draft;
  }
  async clearSubmitted(submitted: EncryptedMessageDraft) {
    await this.writes.catch(() => {});
    await this.persistence.clear(submitted.revision);
    if (this.persistedRevision === submitted.revision) this.persistedRevision = null;
    if (!this.disposed && this.store.getState().draft.revision === submitted.revision) this.store.setState({ draft: empty(), status: 'saved', error: null });
  }
  dispose() { this.disposed = true; this.store.setState({ draft: empty(), status: 'loading', error: null }); }
  pauseForHistoryReview() {
    this.pausedReason = 'The server history changed. Preserve this text for recovery review before starting a fresh draft.';
    this.store.setState({ status: 'error', error: this.pausedReason });
  }
}
