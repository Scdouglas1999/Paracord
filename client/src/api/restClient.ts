import type { AxiosRequestConfig, AxiosResponse } from 'axios';

export type ApiRequest = <T>(config: AxiosRequestConfig) => Promise<AxiosResponse<T>>;

/** The domain API needs HTTP verbs, not mutable Axios defaults or interceptors. */
export function createRestClient(request: ApiRequest) {
  return {
    get: <T>(url: string, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'GET', url }),
    delete: <T>(url: string, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'DELETE', url }),
    post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'POST', url, data }),
    put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'PUT', url, data }),
    patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>({ ...config, method: 'PATCH', url, data }),
  };
}

export type RestClient = ReturnType<typeof createRestClient>;

/**
 * A getter for a client that may not exist yet, whose requests then fail as
 * rejected promises instead of throwing.
 *
 * A server that is still connecting has no client, and `getApi()` says so by
 * throwing. A domain function that is not itself `async` (`list: () =>
 * getApi().get(...)`) would throw that straight into whoever called it, and
 * called from an effect that is the error boundary (the whole page, seen in the
 * owner's log as "This server is not connected"). Handed this getter, the same
 * function returns a promise that rejects, which every caller already handles.
 */
export function rejectWhenUnavailable(resolve: () => RestClient): () => RestClient {
  return () => {
    try {
      return resolve();
    } catch (error) {
      const fail = () => Promise.reject(error);
      return { get: fail, delete: fail, post: fail, put: fail, patch: fail } as RestClient;
    }
  };
}
