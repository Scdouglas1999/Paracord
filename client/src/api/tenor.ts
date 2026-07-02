import { apiClient } from './client';

export const tenorApi = {
  search: (query: string, limit = 20) =>
    apiClient.get('/tenor/search', { params: { q: query, limit } }),
  trending: (limit = 20) =>
    apiClient.get('/tenor/trending', { params: { limit } }),
};
