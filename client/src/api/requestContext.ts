/** Internal request ownership; only the public history epoch travels as a header. */
export interface ApiRequestContext {
  readonly baseURL: string;
  readonly signal: AbortSignal;
  readonly historyEpoch?: string | null;
  assertCurrent(): void;
  assertResponseCurrent?(headers: unknown): void;
}

declare module 'axios' {
  interface AxiosRequestConfig<D = any> {
    data?: D;
    _paracordContext?: ApiRequestContext;
  }
}
