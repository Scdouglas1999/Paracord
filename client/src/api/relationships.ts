import { getApi } from './activeClient';
import type { User } from '../types';

export interface Relationship {
  id: string;
  type: number; // 1 = friend, 2 = blocked, 3 = pending_incoming, 4 = pending_outgoing
  user: User;
}

interface RawRelationship {
  id?: string;
  type?: number;
  rel_type?: number;
  user_id?: string;
  target_id?: string;
  user: User;
}

function normalizeRelationship(rel: RawRelationship): Relationship {
  const fallbackId = [rel.user_id, rel.target_id].filter(Boolean).join(':');
  return {
    id: rel.id || fallbackId || rel.user.id,
    type: rel.type ?? rel.rel_type ?? 1,
    user: rel.user,
  };
}

export const relationshipApi = {
  list: async () => {
    const response = await getApi().get<RawRelationship[]>('/users/@me/relationships');
    return {
      ...response,
      data: response.data.map(normalizeRelationship),
    };
  },
  addFriend: (identifier: string) => {
    const trimmed = identifier.trim();
    const isNumericId = /^\d+$/.test(trimmed);
    return getApi().post('/users/@me/relationships', isNumericId
      ? { user_id: trimmed, type: 1 }
      : { username: trimmed, type: 1 });
  },
  accept: (userId: string) =>
    getApi().put(`/users/@me/relationships/${userId}`),
  block: (userId: string) =>
    getApi().post('/users/@me/relationships', { user_id: userId, type: 2 }),
  remove: (userId: string) =>
    getApi().delete(`/users/@me/relationships/${userId}`),
};
