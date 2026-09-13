import { getApi } from './activeClient';
import { responseContract } from './responseContracts';
import { isPublicUserProfile } from './generated/validators';

export const userApi = {
  getProfile: async (userId: string) =>
    responseContract(
      getApi().get(`/users/${userId}/profile`),
      isPublicUserProfile,
      'PublicUserProfile',
    ),
};
