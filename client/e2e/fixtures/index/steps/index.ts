/**
 * The built-in steps, by name, for `harness.step('arrive')`. The story, in
 * order: `arrive` (s1), `join` (s2), `crowd` + `busy` (s5). A package's own
 * step lives in its own file here and is passed to `harness.step` as an object.
 */
import { arrive } from './arrive';
import { busy } from './busy';
import { crowd } from './crowd';
import { join } from './join';
import { message } from './message';
import { typing } from './typing';
import type { Step } from '../step';

export const BUILT_IN_STEPS: Record<string, Step<any>> = { arrive, join, crowd, busy, message, typing };

export type BuiltInStepName = 'arrive' | 'join' | 'crowd' | 'busy' | 'message' | 'typing';

export { arrive, busy, crowd, join, message, typing };
