import '@testing-library/jest-dom/vitest';

// jsdom has no layout engine. Geometry and resize behavior are verified in
// Playwright; component tests still exercise observer setup and teardown.
globalThis.ResizeObserver = class implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock import.meta.env for tests
if (!import.meta.env.VITE_API_URL) {
  (import.meta.env as Record<string, string>).VITE_API_URL = '';
}

// Provide a minimal localStorage/sessionStorage mock (jsdom provides them,
// but some edge-case tests may clear them)
if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}
