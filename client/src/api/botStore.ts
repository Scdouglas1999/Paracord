import { apiClient } from './client';

export interface StoreBot {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  icon_hash: string | null;
  install_count: number;
  bot_user_id: string;
  permissions: string;
  verified_developer?: boolean;
  review_count?: number;
  average_rating?: number;
}

export interface StoreBotSearchResult {
  bots: StoreBot[];
  total: number;
}

export interface StoreBotFeaturedResult {
  bots: StoreBot[];
}

export interface StoreBotCategoriesResult {
  categories: string[];
}

export interface BotReview {
  id: string;
  bot_app_id: string;
  user_id: string;
  rating: number;
  title?: string | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotReviewListResult {
  reviews: BotReview[];
  summary: {
    review_count: number;
    average_rating: number;
  };
}

export interface BotMetricsResult {
  application_id: string;
  install_count: number;
  active_guild_count: number;
  review_count: number;
  average_rating: number;
  metrics_30d: Array<{
    event_type: string;
    count: number;
  }>;
}

export const botStoreApi = {
  search: (params?: { q?: string; category?: string; limit?: number; offset?: number }) =>
    apiClient.get<StoreBotSearchResult>('/bots/store', { params }),
  featured: () =>
    apiClient.get<StoreBotFeaturedResult>('/bots/store/featured'),
  categories: () =>
    apiClient.get<StoreBotCategoriesResult>('/bots/store/categories'),
  listReviews: (botAppId: string, params?: { limit?: number; offset?: number }) =>
    apiClient.get<BotReviewListResult>(`/bots/store/${botAppId}/reviews`, { params }),
  upsertMyReview: (
    botAppId: string,
    payload: { rating: number; title?: string; body?: string },
  ) => apiClient.put<BotReviewListResult>(`/bots/store/${botAppId}/reviews/@me`, payload),
  getDeveloperMetrics: (botAppId: string) =>
    apiClient.get<BotMetricsResult>(`/bots/applications/${botAppId}/metrics`),
};
