type Navigate = (path: string) => void;

let navigate: Navigate | null = null;

/** AppShell registers the router. Jump actions call this instead of rewriting the address bar. */
export function registerAppNavigate(next: Navigate | null): void {
  navigate = next;
}

export function appNavigate(path: string): void {
  if (!navigate) {
    throw new Error('This page is not ready to open a conversation yet.');
  }
  navigate(path);
}
