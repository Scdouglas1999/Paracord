import { describe, expect, it } from 'vitest';
import type { Attachment, Message } from '../../types';
import { collectDeviceMedia, extractUrls, mergeDeviceHistory, oldestMessageId } from './deviceMedia';

const described = (id: string, filename: string, contentType: string): Attachment => ({
  id,
  filename,
  size: 10,
  content_type: contentType,
  url: `/api/v1/attachments/${id}`,
  encryption: {
    id, filename, contentType, size: 10, sha256: 'a'.repeat(64),
    key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', nonce: 'AAAAAAAAAAAAAAAA',
  },
});

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id, channel_id: '42', content: '', attachments: [],
  author: { id: '7', username: 'mira', display_name: 'Mira', discriminator: '0' },
  created_at: '2026-09-20T10:00:00Z',
  e2ee: { version: 2, nonce: 'n', ciphertext: 'c', header: '{}' },
  ...overrides,
} as unknown as Message);

describe('the media panel for a direct message', () => {
  it('sorts decrypted files into media and files, newest first', () => {
    const messages = [
      message('100', { attachments: [described('1', 'beach.png', 'image/png'), described('2', 'notes.pdf', 'application/pdf')] }),
      message('200', { attachments: [described('3', 'clip.mp4', 'video/mp4')] }),
    ];
    const { media, files } = collectDeviceMedia(messages);
    expect(media.map((item) => [item.id, item.kind])).toEqual([['3', 'video'], ['1', 'image']]);
    expect(files.map((item) => item.attachment.encryption.filename)).toEqual(['notes.pdf']);
    expect(media[0].author).toEqual({ username: 'mira', display_name: 'Mira' });
  });

  it('leaves out a file whose key never arrived in the encrypted body', () => {
    const opaque: Attachment = {
      id: '9', filename: '0123456789abcdef0123456789abcdef.bin', size: 26, content_type: 'application/octet-stream', url: '/x',
    };
    expect(collectDeviceMedia([message('100', { attachments: [opaque] })])).toEqual({ media: [], files: [], links: [] });
  });

  it('treats an image type a browser will not preview as a file', () => {
    const { media, files } = collectDeviceMedia([message('100', { attachments: [described('1', 'logo.svg', 'image/svg+xml')] })]);
    expect(media).toEqual([]);
    expect(files).toHaveLength(1);
  });

  it('finds links the way the instance does for a server channel', () => {
    expect(extractUrls('see https://example.com/a, and (http://x.test/b). also https://example.com/a'))
      .toEqual(['https://example.com/a', 'http://x.test/b']);
    expect(extractUrls('no links, just ftp://nope')).toEqual([]);
    expect(extractUrls(Array.from({ length: 8 }, (_, i) => `https://a.test/${i}`).join(' '))).toHaveLength(5);
    const { links } = collectDeviceMedia([message('100', { content: 'plan: https://maps.example/route?x=1' })]);
    expect(links).toEqual([expect.objectContaining({ url: 'https://maps.example/route?x=1', message_id: '100' })]);
  });

  it('merges older pages without duplicates, deleted or still-sealed messages', () => {
    const merged = mergeDeviceHistory(
      [message('300'), message('200', { content: 'live copy' })],
      [message('200', { content: 'snapshot' }), message('100'), message('50')],
      { deleted: new Set(['100']), decrypting: new Set(['300']) },
    );
    expect(merged.map((row) => row.id)).toEqual(['200', '50']);
    expect(merged[0].content).toBe('live copy');
  });

  it('continues older history from the oldest message it has seen', () => {
    expect(oldestMessageId([message('900'), message('1000')], [message('120')])).toBe('120');
    expect(oldestMessageId([], [])).toBeNull();
  });
});
