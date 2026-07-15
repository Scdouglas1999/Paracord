import { getApi } from './activeClient';

export interface UploadKeysRequest {
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

export interface KeyCountResponse {
  one_time_prekeys_remaining: number;
  signed_prekey_uploaded: boolean;
  last_resort_prekey_uploaded: boolean;
}

export const keysApi = {
  uploadKeys: (data: UploadKeysRequest) =>
    getApi().put<UploadKeysResponse>('/users/@me/keys', data),

  getBundle: (userId: string) =>
    getApi().get<PrekeyBundleResponse>(`/users/${userId}/keys`),

  getKeyCount: () =>
    getApi().get<KeyCountResponse>('/users/@me/keys/count'),
};
