/**
 * A test's own time limit, scaled like the default one: by 5 under
 * `vitest --coverage` (see vitest.config.ts), unchanged otherwise.
 */
export function slow(ms: number): number {
  return ms * Number(process.env.PARACORD_TEST_TIMEOUT_SCALE || '1');
}
