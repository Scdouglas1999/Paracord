import type { AxiosResponse } from 'axios';

import { loadValidators } from './contractValidators';

/** An incompatible response must not overwrite an already valid projection. */
export class ApiContractError extends Error {
  readonly code = 'INVALID_SERVER_RESPONSE';
  constructor(readonly contract: string) {
    // The diagnostic contains no response payload, credentials, or user content.
    super(`The server returned an invalid ${contract} response. Update the server and try again.`);
    this.name = 'ApiContractError';
  }
}

/** Validate at the API boundary, preserving the transport response and errors. */
export async function responseContract<T>(
  request: Promise<AxiosResponse<unknown>>,
  validate: (data: unknown) => data is T,
  contract: string,
): Promise<AxiosResponse<T>> {
  // The validators load alongside the request, not in front of it.
  const [response] = await Promise.all([request, loadValidators()]);
  const data = response.data;
  if (!validate(data)) throw new ApiContractError(contract);
  return { ...response, data };
}
