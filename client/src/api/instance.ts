import { getApi } from './activeClient';

/**
 * Non-sensitive limits advertised by the active server so the client can
 * pre-validate uploads and show the correct maximum. The server always
 * re-enforces these on every upload path — this is a UX convenience, never a
 * security boundary.
 */
export interface InstanceInfo {
  /** Server-wide maximum upload size in bytes. */
  max_upload_size: number;
  /** Size (bytes) at/above which peer-to-peer transfer is preferred. */
  p2p_threshold: number;
}

export const instanceApi = {
  getInstanceInfo: () => getApi().get<InstanceInfo>('/instance'),
};
