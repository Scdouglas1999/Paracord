import { useMemo } from 'react';

import { stageTargetOf, useGlassStore, type OpenStageMode } from '../../../stores/glassStore';
import { Stage } from '../../glass/stage';
import { PhoneStageChrome } from '../../glass/shell/PhoneStageChrome';
import { useIxShell } from '../shell/IxShellContext';
import type { CallSlotProps } from '../shell/slots';

/**
 * STUB (IX-4). Owner: IX-13, which replaces this file with the Index call view
 * (index-spec §7): the surface grows out of the card, header, people grid,
 * stream focus, chat column, controls.
 *
 * Until then the Glass stage keeps calls and streams working, drawn on the Index
 * call surface (inset 10, radius 24) instead of its Glass pane. It appears and
 * goes without motion.
 */
export function CallSlot(_props: CallSlotProps) {
  const { layout } = useIxShell();
  const stage = useGlassStore((state) => state.stage);
  const target = useMemo(() => stageTargetOf(stage), [stage]);
  if (!target || stage.mode === 'none') return null;
  const mode = stage.mode as OpenStageMode;
  return (
    <section aria-label="Call" data-native-underlay-clear="" className="ix-inset-surface ix-call-stub">
      <Stage target={target} mode={mode} />
      {layout === 'phone' && <PhoneStageChrome target={target} mode={mode} />}
    </section>
  );
}
