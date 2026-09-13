import type { Message } from '../../types';

/** Keep sub-millisecond server precision; Date.parse alone merges distinct edits. */
function timestamp(value: string | undefined): bigint | null {
  if (!value) return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isSafeInteger(seconds)) return null;
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

/** A delayed receipt cannot prove equal-timestamp conflicting edits are newer. */
export function canProjectMutationReceipt(current: Message, receipt: Message): boolean {
  if (current.id !== receipt.id || current.channel_id !== receipt.channel_id || current.author.id !== receipt.author.id) return false;
  const received = timestamp(receipt.edited_timestamp);
  const known = timestamp(current.edited_timestamp);
  if (current.edited_timestamp && known === null) return false;
  if (receipt.edited_timestamp && received === null) return false;
  if (received !== null && (known === null || received > known)) return true;
  if (known !== received) return false;
  return (Boolean(current.e2ee) || current.content === receipt.content) && JSON.stringify(current.e2ee ?? null) === JSON.stringify(receipt.e2ee ?? null);
}
