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
