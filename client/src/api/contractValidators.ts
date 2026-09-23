/**
 * The generated response validators, loaded off the startup bundle.
 *
 * `generated/validators.js` is ~87 KiB of compiled JSON Schema. It was imported
 * statically by the API modules, so it sat in the entry chunk and was parsed
 * before the first paint — the login screen included, which never validates a
 * response. It is now its own chunk: {@link responseContract} starts loading it
 * alongside the first request it validates, so it costs no extra round trip.
 *
 * Each export below has the generated validator's exact signature and calls
 * it. They are synchronous, so they can only run once the chunk is in:
 * `responseContract` guarantees that for every API response, and the gateway's
 * READY (the one synchronous caller) only ever arrives on a connection whose
 * account was first verified through `responseContract`. A call before the
 * load is a bug and throws rather than skipping the check.
 */
import type * as Generated from './generated/validators';

type Validators = typeof Generated;

let loaded: Validators | null = null;
let loading: Promise<Validators> | null = null;

/** Load the validators (once). A failed load can be retried. */
export function loadValidators(): Promise<Validators> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import('./generated/validators').then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

function validator<K extends keyof Validators>(name: K): Validators[K] {
  return ((data: unknown) => {
    if (!loaded) {
      throw new Error(`The ${String(name)} validator ran before the response validators were loaded.`);
    }
    return (loaded[name] as (value: unknown) => boolean)(data);
  }) as Validators[K];
}

export const isCurrentUser = validator('isCurrentUser');
export const isUpdatedCurrentUser = validator('isUpdatedCurrentUser');
export const isUserSettingsResponse = validator('isUserSettingsResponse');
export const isGuildDetail = validator('isGuildDetail');
export const isGuildInvite = validator('isGuildInvite');
export const isGuildInviteList = validator('isGuildInviteList');
export const isGuildSummaryList = validator('isGuildSummaryList');
export const isOwnershipTransferResponse = validator('isOwnershipTransferResponse');
export const isPublicUserProfile = validator('isPublicUserProfile');
export const isInviteAcceptResponse = validator('isInviteAcceptResponse');
export const isInvitePreview = validator('isInvitePreview');
export const isGuildEmoji = validator('isGuildEmoji');
export const isGuildEmojiList = validator('isGuildEmojiList');
export const isRelationshipList = validator('isRelationshipList');
export const isReadyGuildCore = validator('isReadyGuildCore');
