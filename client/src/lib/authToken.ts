let accessToken: string | null = null;

const REFRESH_TOKEN_KEY = 'paracord:refresh-token';

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  const trimmed = token?.trim() ?? '';
  accessToken = trimmed.length > 0 ? trimmed : null;
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setRefreshToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(REFRESH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

export function clearLegacyPersistedAuth(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('auth-storage');
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}
