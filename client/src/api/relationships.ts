import { getApi } from './activeClient';
import { responseContract } from './responseContracts';
import { isRelationshipList } from './contractValidators';
import type { RelationshipUser } from './generated/RelationshipList';
import type { CreateRelationshipRequest } from './generated/CreateRelationshipRequest';

export interface Relationship {
  id: string;
  type: number; // 1 = friend, 2 = blocked, 3 = pending_incoming, 4 = pending_outgoing
  /** The other party's minimal identity; the wire projection is not a full User. */
  user: RelationshipUser;
}

export const relationshipApi = {
  list: async () => {
    const response = await responseContract(
      getApi().get('/users/@me/relationships'),
      isRelationshipList,
      'RelationshipList',
    );
    return {
      ...response,
      data: response.data.map((rel) => ({ id: rel.id, type: rel.type, user: rel.user })),
    };
  },
  addFriend: async (identifier: string) => {
    const trimmed = identifier.trim();
    const isNumericId = /^\d+$/.test(trimmed);
    const body: CreateRelationshipRequest = isNumericId
      ? { user_id: trimmed, type: 1 }
      : { username: trimmed, type: 1 };
    return getApi().post('/users/@me/relationships', body);
  },
  accept: async (userId: string) =>
    getApi().put(`/users/@me/relationships/${userId}`),
  block: async (userId: string) => {
    const body: CreateRelationshipRequest = { user_id: userId, type: 2 };
    return getApi().post('/users/@me/relationships', body);
  },
  remove: async (userId: string) =>
    getApi().delete(`/users/@me/relationships/${userId}`),
};
