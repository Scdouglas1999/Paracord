/**
 * DEV ONLY: light the room from the looping fixture scene instead of a real
 * stream, for review shots with no media server (docs/design/glass-plan.md
 * §5.1, "Mocked states"). The review harness opts in by setting
 * `window.__PARACORD_ROOM_FIXTURE__ = 'stream'` before the app loads
 * (`e2e/fixtures/glass/install.ts`). It is never a fallback: without that
 * explicit switch the room uses the real stream, and in a production build
 * `import.meta.env.DEV` is false, so both the switch and the fixture module
 * fold away.
 */
import type { FrameSource } from './frameSource';

export const ROOM_FIXTURE_GLOBAL = '__PARACORD_ROOM_FIXTURE__';

/** Whether the harness asked for the fixture stream (always false in production). */
export function roomFixtureRequested(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  return (window as unknown as Record<string, unknown>)[ROOM_FIXTURE_GLOBAL] === 'stream';
}

/** The fixture stream source loader; null in production builds. */
export const loadFixtureStreamSource: (() => Promise<FrameSource>) | null = import.meta.env.DEV
  ? async () => {
      const { createFixtureFrameSource } = await import('./fixtureFrameSource');
      return createFixtureFrameSource({ scene: 'stream', width: 320, height: 180 });
    }
  : null;
