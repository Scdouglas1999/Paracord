export interface DisplayIdentity {
  username?: string | null;
  display_name?: string | null;
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Visible identity: server nickname, then profile display name, then handle. */
export function displayName(user: DisplayIdentity | null | undefined, nick?: string | null): string {
  return nonBlank(nick) ?? nonBlank(user?.display_name) ?? nonBlank(user?.username) ?? 'Unknown User';
}

/** Stable account handle used for search, mentions, and security-sensitive labels. */
export function userHandle(user: DisplayIdentity | null | undefined): string {
  return nonBlank(user?.username) ?? 'unknown';
}
