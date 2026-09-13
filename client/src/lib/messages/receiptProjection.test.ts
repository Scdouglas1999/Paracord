import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { canProjectMutationReceipt } from './receiptProjection';

const message = (content: string, edited_timestamp?: string) => ({ id: '100', channel_id: 'channel', author: { id: 'author' }, content, edited_timestamp } as Message);
describe('durable receipt projection ordering', () => {
  it('does not replace a newer gateway edit with an older delayed HTTP receipt', () => {
    expect(canProjectMutationReceipt(message('Latest', '2026-09-12T12:00:00.002Z'), message('Old', '2026-09-12T12:00:00.001Z'))).toBe(false);
  });
  it('preserves server precision finer than JavaScript milliseconds', () => {
    expect(canProjectMutationReceipt(message('First', '2026-09-12T12:00:00.000001Z'), message('Second', '2026-09-12T12:00:00.000002Z'))).toBe(true);
  });
  it('retains the current row for conflicting tied or missing edit timestamps', () => {
    expect(canProjectMutationReceipt(message('Current', '2026-09-12T12:00:00Z'), message('Conflict', '2026-09-12T12:00:00.000Z'))).toBe(false);
    expect(canProjectMutationReceipt(message('Current'), message('Unknown'))).toBe(false);
  });
  it('accepts the first proved edit and rejects malformed timestamps or another owner', () => {
    expect(canProjectMutationReceipt(message('Original'), message('Edited', '2026-09-12T12:00:00Z'))).toBe(true);
    expect(canProjectMutationReceipt(message('Current'), message('Unknown', 'invalid'))).toBe(false);
    expect(canProjectMutationReceipt(message('Current'), { ...message('Current'), channel_id: 'other' })).toBe(false);
  });
});
