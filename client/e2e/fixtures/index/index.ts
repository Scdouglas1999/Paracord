/**
 * The Index review harness. A spec imports from here:
 *
 *   import { installIndexScene, shoot, reachState, ... } from './fixtures/index';
 *
 * See `harness.ts` (the scene), `steps/` (what happens in it), `drivers.ts`
 * (how a spec drives the UI by the plan's test ids) and docs/design/
 * index-checkpoints/IX-0.md.
 */
export * from './call';
export * from './drivers';
export * from './gateway';
export * from './harness';
export * from './scene';
export * from './step';
export * from './steps';
export * from './world';
