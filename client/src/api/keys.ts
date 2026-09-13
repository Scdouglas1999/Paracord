import { getApi } from './activeClient';
import type { RestClient } from './restClient';

export interface UploadKeysRequest {
  request_id?: string;
  expected_identity_key?: string;
  signed_prekey?: {
    id: number;
    public_key: string;
    signature: string;
  };
  one_time_prekeys?: Array<{
    id: number;
    public_key: string;
  }>;
  last_resort_prekey?: {
    id: number;
    public_key: string;
  };
}

export interface UploadKeysResponse {
  request_id: string | null;
  signed_prekey_id: number | null;
  one_time_prekeys_stored: number;
  one_time_prekeys_total: number;
  last_resort_prekey_id?: number | null;
}

export interface PrekeyBundleResponse {
  identity_key: string;
  signed_prekey: {
    id: number;
    public_key: string;
    signature: string;
  };
  one_time_prekey: {
    id: number;
    public_key: string;
  } | null;
}

export interface OwnPublicKeysResponse {
  identity_key: string | null;
  signed_prekey: PrekeyBundleResponse['signed_prekey'] | null;
  one_time_prekeys: Array<{ id: number; public_key: string }>;
  last_resort_prekey: { id: number; public_key: string } | null;
}

export interface KeyCountResponse {
  one_time_prekeys_remaining: number;
  signed_prekey_uploaded: boolean;
  last_resort_prekey_uploaded: boolean;
}

export const createKeysApi = (client: () => RestClient) => ({
  uploadKeys: async (data: UploadKeysRequest) =>
    client().put<UploadKeysResponse>('/users/@me/keys', data),

  getOwnKeys: async () =>
    client().get<OwnPublicKeysResponse>('/users/@me/keys'),

  getBundle: async (userId: string) =>
    client().get<PrekeyBundleResponse>(`/users/${userId}/keys`),

  getKeyCount: async () =>
    client().get<KeyCountResponse>('/users/@me/keys/count'),
});

export const keysApi = createKeysApi(getApi);
