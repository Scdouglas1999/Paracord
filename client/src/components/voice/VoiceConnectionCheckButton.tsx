import { useState } from 'react';
import { Stethoscope } from 'lucide-react';
import { Button, type ButtonProps } from '../ui/Button';
import { VoiceConnectionCheck } from './VoiceConnectionCheck';
import type { DeviceSelection, DiagnosticsAdapters } from '../../lib/media/diagnostics';

// The single entry point for the guided voice check. It owns the dialog so a
// caller only has to drop the button where a user is already stuck: the
// Voice & video settings pane, or a failed join.

export interface VoiceConnectionCheckButtonProps {
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
  /** Devices the user picked, so the check tests those rather than defaults. */
  selection?: DeviceSelection;
  /** Start running as soon as the dialog opens. */
  autoStart?: boolean;
  /** Injected in tests. */
  adapters?: DiagnosticsAdapters;
  showIcon?: boolean;
}

export function VoiceConnectionCheckButton({
  label = 'Run connection check',
  variant = 'secondary',
  size,
  className,
  selection,
  autoStart = false,
  adapters,
  showIcon = true,
}: VoiceConnectionCheckButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        {showIcon && <Stethoscope size={16} aria-hidden="true" className="mr-2" />}
        {label}
      </Button>
      <VoiceConnectionCheck
        open={open}
        onClose={() => setOpen(false)}
        selection={selection}
        autoStart={autoStart}
        adapters={adapters}
      />
    </>
  );
}

export default VoiceConnectionCheckButton;
