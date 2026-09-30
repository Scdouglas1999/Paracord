/**
 * The stage slot (owners: WP-G14, WP-G15). Contract: `StageProps` in
 * components/glass/shell/slots.ts. Mounted by the shell inside the stage
 * surface while `glassStore.stage.mode` is not 'none'.
 *
 * WP-G7 stub: replace this re-export with the real stage, keeping the props.
 */
export { Stage } from '../shell/stubs/StageStub';
export type { StageProps } from '../shell/slots';
