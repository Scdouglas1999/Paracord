import { getApi } from './activeClient';

export interface GalleryAuthor {
  id: string;
  username: string;
  display_name: string | null;
  avatar_hash: string | null;
}

export interface GalleryAttachment {
  id: string;
  message_id: string;
  channel_id: string;
  filename: string;
  content_type: string | null;
  size: number;
  url: string;
  width: number | null;
  height: number | null;
  kind: 'image' | 'video' | 'file';
  created_at: string;
  author: GalleryAuthor;
}

export interface GalleryLink {
  url: string;
  title: string | null;
  site: string | null;
  image: string | null;
  message_id: string;
  channel_id: string;
  created_at: string;
  author: GalleryAuthor;
}

export interface GalleryPage<T> {
  items: T[];
  next_before: string | null;
}

export interface GalleryQuery {
  kind?: string;
  before?: string | null;
  limit?: number;
  channel_id?: string | null;
}

function queryString(query: GalleryQuery): string {
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.before) params.set('before', query.before);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.channel_id) params.set('channel_id', query.channel_id);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const galleryApi = {
  channelAttachments: (channelId: string, query: GalleryQuery = {}) =>
    getApi().get<GalleryPage<GalleryAttachment>>(
      `/channels/${channelId}/attachments${queryString(query)}`,
    ),
  guildAttachments: (guildId: string, query: GalleryQuery = {}) =>
    getApi().get<GalleryPage<GalleryAttachment>>(
      `/guilds/${guildId}/attachments${queryString(query)}`,
    ),
  channelLinks: (channelId: string, query: Pick<GalleryQuery, 'before' | 'limit'> = {}) =>
    getApi().get<GalleryPage<GalleryLink>>(`/channels/${channelId}/links${queryString(query)}`),
};
