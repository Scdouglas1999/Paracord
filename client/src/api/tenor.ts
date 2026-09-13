import { getApi } from './activeClient';

export const tenorApi = {
  search: async (query: string, limit = 20) =>
    getApi().get('/tenor/search', { params: { q: query, limit } }),
  trending: async (limit = 20) =>
    getApi().get('/tenor/trending', { params: { limit } }),
};
