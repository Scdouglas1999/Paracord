import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../../types';
import { encryptAttachmentBytes } from '../../lib/messages/attachments/attachmentCrypto';
import { EncryptedAttachment } from './EncryptedAttachment';

const download = vi.fn();
vi.mock('../../api/files', () => ({ fileApi: { download: (...args: unknown[]) => download(...args) } }));

/** Object URLs are not implemented in jsdom; record them so leaks are visible. */
let issued: Blob[] = [];
let revoked: string[] = [];

beforeEach(() => {
  issued = [];
  revoked = [];
  download.mockReset();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:decrypted-${issued.length}`;
      issued.push(blob);
      return url;
    });
    static revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function encryptedAttachment(text: string, filename: string, contentType: string): Promise<Attachment> {
  const sealed = await encryptAttachmentBytes(new TextEncoder().encode(text));
  download.mockImplementation(async () => ({
    data: { arrayBuffer: async () => sealed.ciphertext.buffer.slice(0) },
  }));
  return {
    id: '1234567890123456789',
    filename: '0123456789abcdef0123456789abcdef.bin',
    size: sealed.ciphertext.byteLength,
    content_type: 'application/octet-stream',
    url: '/api/v1/attachments/1234567890123456789',
    encryption: {
      id: '1234567890123456789', key: sealed.material.key, nonce: sealed.material.nonce,
      filename, contentType, size: sealed.size, sha256: sealed.sha256,
    },
  };
}

describe('an attachment in an end-to-end encrypted conversation', () => {
  it('shows the real filename and type from the encrypted body, not the stored blob', async () => {
    const attachment = await encryptedAttachment('private notes', 'notes.txt', 'text/plain');
    render(<EncryptedAttachment attachment={attachment} />);

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(screen.queryByText(/0123456789abcdef/)).not.toBeInTheDocument();
    expect(screen.getByText('End-to-end encrypted')).toBeInTheDocument();
  });

  it('decrypts an image preview on sight', async () => {
    const attachment = await encryptedAttachment('not really a png, but the type drives the preview', 'holiday.png', 'image/png');
    render(<EncryptedAttachment attachment={attachment} />);

    const image = await screen.findByAltText('holiday.png');
    expect(image).toHaveAttribute('src', 'blob:decrypted-0');
    expect(download).toHaveBeenCalledWith('1234567890123456789', undefined);
  });

  it('waits for an explicit action before pulling down a non-image file', async () => {
    const attachment = await encryptedAttachment('a long document', 'contract.pdf', 'application/pdf');
    render(<EncryptedAttachment attachment={attachment} />);

    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Decrypt and open' }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    // Let the decryption settle inside this test so its object URL cannot land
    // in the next one.
    await waitFor(() => expect(issued).toHaveLength(1));
    expect(await issued[0].text()).toBe('a long document');
  });

  it('downloads the decrypted plaintext, never the stored ciphertext', async () => {
    const attachment = await encryptedAttachment('the exact plaintext body', 'notes.txt', 'text/plain');
    render(<EncryptedAttachment attachment={attachment} />);

    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    await waitFor(() => expect(issued).toHaveLength(1));
    expect(await issued[0].text()).toBe('the exact plaintext body');
    expect(issued[0].type).toBe('text/plain');
  });

  it('says so when an attachment fails its integrity check instead of showing it', async () => {
    const attachment = await encryptedAttachment('tampered body', 'holiday.png', 'image/png');
    download.mockImplementation(async () => ({
      data: { arrayBuffer: async () => new Uint8Array(64).buffer },
    }));
    render(<EncryptedAttachment attachment={attachment} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/authentication check/);
    expect(screen.queryByAltText('holiday.png')).not.toBeInTheDocument();
  });

  it('labels an attachment the encrypted body never described', () => {
    render(<EncryptedAttachment attachment={{
      id: '5', filename: 'plain.png', size: 10, content_type: 'image/png', url: '/api/v1/attachments/5',
    }} />);

    expect(screen.getByText(/No key for this file arrived/)).toBeInTheDocument();
    expect(screen.queryByText('End-to-end encrypted')).not.toBeInTheDocument();
  });

  it('releases the decrypted copy when the view goes away', async () => {
    const attachment = await encryptedAttachment('temporary preview', 'holiday.png', 'image/png');
    const { unmount } = render(<EncryptedAttachment attachment={attachment} />);
    await screen.findByAltText('holiday.png');
    unmount();
    await waitFor(() => expect(revoked).toContain('blob:decrypted-0'));
  });
});
