import { getApi as getActiveApi, getServerApi } from './activeClient';
import { LOCAL_SERVER_ID } from '../lib/serverScope';
import type { LoginResponse } from '../types';
import type { RegistrationMode } from './auth';

// Setup belongs to the server this client is *signed in to*, never to whichever
// remote server happens to be selected — claiming an instance creates an
// account, so it follows the same home-session rule as login and registration.
const getHomeApi = () => getServerApi(LOCAL_SERVER_ID);

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
  /** True while this server still needs its first owner. */
  setup_required?: boolean;
  /** Operator-chosen name for this server, once it has been claimed. */
  instance_name?: string | null;
}

/**
 * What a signed-out browser needs in order to choose between the login page and
 * the setup page. Served unauthenticated — an unclaimed server has nobody who
 * could authenticate.
 */
export interface SetupStatus {
  setup_required: boolean;
  instance_name?: string;
  /**
   * While setup is pending: whether the server asks the home router to let
   * people outside the network in. Absent on servers before 3.2.
   */
  router_forwarding?: boolean;
  /** While setup is pending: who can create an account right now. */
  registration_mode?: RegistrationMode;
}

/**
 * The password rules this server actually enforces, so the setup page can show
 * all of them before submit instead of advertising only a length.
 */
export interface PasswordRequirements {
  min_length: number;
  max_length: number;
  requires_uppercase: boolean;
  requires_lowercase: boolean;
  requires_digit: boolean;
  requires_symbol: boolean;
  length_unit: string;
}

export interface ClaimInstanceRequest {
  token: string;
  username: string;
  email?: string;
  password: string;
  instance_name: string;
  initial_space_name: string;
  display_name?: string;
  /** Who can create an account from now on. */
  registration_mode?: RegistrationMode;
}

/** Registration's session payload, plus what the claim additionally created. */
export interface ClaimInstanceResponse extends LoginResponse {
  instance_name: string;
  space: { id: string; name: string };
}

export const instanceApi = {
  getInstanceInfo: async () => getActiveApi().get<InstanceInfo>('/instance'),
  getSetupStatus: async () => getHomeApi().get<SetupStatus>('/setup/status'),
  getPasswordRequirements: async () =>
    getHomeApi().get<PasswordRequirements>('/setup/password-requirements'),
  claimInstance: async (data: ClaimInstanceRequest) =>
    getHomeApi().post<ClaimInstanceResponse>('/setup/claim', data),
};
