import { describe, expect, it, vi } from 'vitest';
import { EncryptedDraftController } from './encryptedDraftController';
import type { EncryptedMessageDraft } from './encryptedDraftSubmission';

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(initial: EncryptedMessageDraft | null = null) {
  let saved = initial;
  const persistence = { read: vi.fn(async () => saved),
    write: vi.fn(async (draft: EncryptedMessageDraft, expected: string | null) => {
      if ((saved?.revision ?? null) !== expected) throw new Error('Draft changed in another window'); saved = draft;
    }), clear: vi.fn(async (revision: string) => { if (saved?.revision === revision) saved = null; }) };
  const controller = new EncryptedDraftController(persistence);
  return { controller, persistence, current: () => saved, replace: (draft: EncryptedMessageDraft) => { saved = draft; } };
}
describe('encrypted composer draft controller', () => {
  it('waits for encryption commit before accepting a captured draft', async () => {
    const f = fixture(); await f.controller.capture();
    const pending = gate<void>(); f.persistence.write.mockImplementationOnce(async () => pending.promise);
    f.controller.setContent('Not accepted before commit');
    let accepted = false; const captured = f.controller.capture().then(value => { accepted = true; return value; });
    await Promise.resolve(); expect(accepted).toBe(false);
    expect(f.controller.store.getState().status).toBe('saving'); pending.resolve();
    expect((await captured).content).toBe('Not accepted before commit');
  });
  it('retains visible text and rejects acceptance when storage fails, then supports explicit retry', async () => {
    const f = fixture(); await f.controller.capture();
    f.persistence.write.mockRejectedValueOnce(new Error('Quota exceeded'));
    f.controller.setContent('Keep these unsaved words');
    await expect(f.controller.capture()).rejects.toThrow('Quota exceeded');
    expect(f.controller.store.getState().draft.content).toBe('Keep these unsaved words');
    expect(f.current()).toBeNull(); await f.controller.retrySave();
    expect((await f.controller.capture()).content).toBe('Keep these unsaved words');
  });
  it('preserves text typed while a submitted revision is awaiting delivery', async () => {
    const f = fixture(); await f.controller.capture();
    f.controller.setContent('Submitted'); const submitted = await f.controller.capture();
    f.controller.setContent('Newer'); await f.controller.capture();
    await f.controller.clearSubmitted(submitted);
    expect(f.controller.store.getState().draft.content).toBe('Newer'); expect(f.current()?.content).toBe('Newer');
  });
  it('cannot overwrite another tab’s newer revision', async () => {
    const f = fixture({ revision: 'original', content: 'Original' }); await f.controller.capture();
    f.replace({ revision: 'another-tab', content: 'Preserve another tab' });
    f.controller.setContent('Visible unsaved edit');
    await expect(f.controller.capture()).rejects.toThrow('another window');
    expect(f.current()?.content).toBe('Preserve another tab');
    expect(f.controller.store.getState().draft.content).toBe('Visible unsaved edit');
  });
  it('does not let a late initial read erase newly typed text or overwrite saved text', async () => {
    const saved = gate<EncryptedMessageDraft | null>();
    const write = vi.fn(async (_draft: EncryptedMessageDraft, _revision: string | null) => {});
    const controller = new EncryptedDraftController({ read: () => saved.promise, write, clear: async () => {} });
    controller.setContent('Typed before read finished'); saved.resolve({ revision: 'older', content: 'Saved earlier' });
    await expect(controller.capture()).rejects.toThrow('saved draft was found');
    expect(controller.store.getState().draft.content).toBe('Typed before read finished'); expect(write).not.toHaveBeenCalled();
  });
  it('recovers from temporary initial storage failure without discarding unsaved text', async () => {
    const write = vi.fn(async () => {});
    const controller = new EncryptedDraftController({ read: async () => { throw new Error('Storage unavailable'); }, write, clear: async () => {} });
    await expect(controller.capture()).rejects.toThrow('Storage unavailable');
    controller.setContent('Retained'); await controller.retrySave();
    expect((await controller.capture()).content).toBe('Retained');
  });
});
