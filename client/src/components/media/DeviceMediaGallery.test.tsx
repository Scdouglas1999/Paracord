import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { Attachment, Message } from '../../types';

const harness = vi.hoisted(() => ({
  readHistoryPage: vi.fn(),
  decryptAttachmentBlob: vi.fn(),
  decryptAttachmentThumbnail: vi.fn(),
  galleryApi: { channelAttachments: vi.fn(), guildAttachments: vi.fn(), channelLinks: vi.fn() },
}));

vi.mock('../../lib/messages/attachments/attachmentDecryption', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/messages/attachments/attachmentDecryption')>()),
  decryptAttachmentBlob: harness.decryptAttachmentBlob,
  decryptAttachmentThumbnail: harness.decryptAttachmentThumbnail,
}));
vi.mock('../../api/gallery', () => ({ galleryApi: harness.galleryApi }));

const store = create<{
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  deletedMessageIds: Set<string>;
  decryptingIds: Set<string>;
  readHistoryPage: typeof harness.readHistoryPage;
}>(() => ({
  messages: {}, hasMore: {}, deletedMessageIds: new Set(), decryptingIds: new Set(),
  readHistoryPage: harness.readHistoryPage,
}));
vi.mock('../../hooks/useMessageStore', () => ({ useCurrentMessageStoreApi: () => store }));

import { DeviceMediaGallery } from './DeviceMediaGallery';

const photo = (id: string, withThumbnail: boolean): Attachment => ({
  id, filename: `${id}.bin`, size: 26, content_type: 'application/octet-stream', url: `/api/v1/attachments/${id}`,
  encryption: {
    id, filename: `photo-${id}.png`, contentType: 'image/png', size: 10, sha256: 'a'.repeat(64),
    key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', nonce: 'AAAAAAAAAAAAAAAA',
    ...(withThumbnail ? { thumbnail: {
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', nonce: 'AAAAAAAAAAAAAAAA', data: 'AAAA',
      contentType: 'image/jpeg', size: 3, sha256: 'b'.repeat(64), width: 10, height: 10,
    } } : {}),
  },
});

const message = (id: string, attachments: Attachment[], created_at = '2026-09-20T10:00:00Z'): Message => ({
  id, channel_id: '42', content: '', attachments, created_at,
  author: { id: '7', username: 'jonas', display_name: 'Jonas', discriminator: '0' },
  e2ee: { version: 2, nonce: 'n', ciphertext: 'c', header: '{}' },
} as unknown as Message);

class SeenAtOnce {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  disconnect() {}
  unobserve() {}
}

let urls = 0;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  urls = 0;
  created.length = 0;
  revoked.length = 0;
  vi.stubGlobal('IntersectionObserver', SeenAtOnce);
  URL.createObjectURL = vi.fn(() => { const url = `blob:test/${++urls}`; created.push(url); return url; });
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  harness.decryptAttachmentThumbnail.mockResolvedValue(new Blob(['t'], { type: 'image/jpeg' }));
  harness.decryptAttachmentBlob.mockResolvedValue(new Blob(['f'], { type: 'image/png' }));
  store.setState({
    messages: { '42': [message('200', [photo('1', true)]), message('300', [photo('2', false)])] },
    hasMore: { '42': true },
    deletedMessageIds: new Set(),
    decryptingIds: new Set(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DeviceMediaGallery', () => {
  it('shows decrypted images from this device and asks the instance for no listing', async () => {
    render(<DeviceMediaGallery channelId="42" />);
    expect(await screen.findByRole('button', { name: /photo-1\.png, from Jonas/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /photo-2\.png, from Jonas/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'September 2026' })).toBeInTheDocument();
    expect(screen.getByText('Showing what’s on this device.')).toBeInTheDocument();
    // The inline preview is used when the sender attached one; otherwise the
    // image itself is decrypted, as in the conversation.
    await waitFor(() => expect(harness.decryptAttachmentThumbnail).toHaveBeenCalledTimes(1));
    expect(harness.decryptAttachmentBlob).toHaveBeenCalledTimes(1);
    expect(harness.galleryApi.channelAttachments).not.toHaveBeenCalled();
    expect(harness.galleryApi.channelLinks).not.toHaveBeenCalled();
  });

  it('revokes every decrypted preview when the panel closes', async () => {
    const { unmount } = render(<DeviceMediaGallery channelId="42" />);
    await waitFor(() => expect(created).toHaveLength(2));
    unmount();
    expect([...revoked].sort()).toEqual([...created].sort());
  });

  it('pages older history through the decrypt path and keeps what it found', async () => {
    harness.readHistoryPage.mockResolvedValue({
      messages: [message('150', [photo('3', true)], '2026-08-02T10:00:00Z')],
      hasMore: false,
    });
    render(<DeviceMediaGallery channelId="42" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load older' })); });
    expect(harness.readHistoryPage).toHaveBeenCalledWith('42', '200');
    expect(await screen.findByRole('region', { name: 'August 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /photo-3\.png/ })).toBeInTheDocument();
    // Nothing older remains, so the action goes away.
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
  });

  it('says so when older history cannot be loaded', async () => {
    harness.readHistoryPage.mockRejectedValue(new Error('Network down'));
    render(<DeviceMediaGallery channelId="42" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load older' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load older messages');
  });

  it('lists links and files from decrypted messages', async () => {
    store.setState({
      messages: { '42': [
        { ...message('400', [{ ...photo('5', false), encryption: { ...photo('5', false).encryption!, filename: 'plan.pdf', contentType: 'application/pdf' } }]) },
        { ...message('500', []), content: 'route: https://maps.example/r' },
      ] },
    });
    render(<DeviceMediaGallery channelId="42" />);
    expect(screen.getByText('No images or videos in recent messages.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByText('plan.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }));
    expect(screen.getByRole('link', { name: 'maps.example/r' })).toHaveAttribute('href', 'https://maps.example/r');
  });
});
