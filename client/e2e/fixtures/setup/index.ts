/**
 * The first-run review harness (docs/design/setup-plan.md S13a). A spec imports from here:
 *
 *   import { installSetupScene, inviteUrl, ... } from './fixtures/setup';
 *
 * Run through `e2e/setup-review.config.ts`. The references the shots are held
 * against come from `node e2e/setup-reference.mjs`; `node e2e/setup-compare.mjs
 * <WP>` lays them side by side.
 */
export * from './harness';
export * from './hostScripts';
export * from './invites';
export * from './scene';
export * from './tauriHost';
export * from './trustWords';
