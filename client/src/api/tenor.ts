import { getApi } from './activeClient';

export const tenorApi = {
  search: (query: string, limit = 20) =>
    getApi().get('/tenor/search', { params: { q: query, limit } }),
  trending: (limit = 20) =>
    getApi().get('/tenor/trending', { params: { limit } }),
};
