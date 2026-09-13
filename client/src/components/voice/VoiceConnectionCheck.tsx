import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Download, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useAuthStore } from '../../stores/authStore';
import {
  STEP_ORDER,
  STEP_TITLES,
  createBrowserAdapters,
  downloadDiagnostics,
  runVoiceConnectionCheck,
} from '../../lib/media/diagnostics';
import type {
  DeviceSelection,
  DiagnosticReport,
  DiagnosticStatus,
  DiagnosticStepResult,
  DiagnosticsAdapters,
} from '../../lib/media/diagnostics';

// Guided voice connection check.
//
// Chat runs over TCP and voice runs over QUIC on UDP, so a server can be
// perfectly healthy for messages and completely unreachable for calls. This
// panel walks the causes one at a time and says, in plain language, which one
// actually broke — and what to do about it.
//
// It never joins, leaves or alters a call. Closing it returns the user to chat
// exactly as they left it.

const STATUS_ICON: Record<DiagnosticStatus, typeof CheckCircle2> = {
  pending: CircleDashed,
  running: Loader2,
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  skipped: MinusCircle,
};

const STATUS_TONE: Record<DiagnosticStatus, string> = {
  pending: 'text-text-muted',
  running: 'text-text-secondary',
  pass: 'text-accent-primary',
  warn: 'text-accent-warning',
  fail: 'text-accent-danger',
  skipped: 'text-text-muted',
};

const STATUS_LABEL: Record<DiagnosticStatus, string> = {
  pending: 'Not run yet',
  running: 'Checking',
  pass: 'Working',
  warn: 'Needs attention',
  fail: 'Problem found',
  skipped: 'Skipped',
};

const OVERALL_COPY: Record<DiagnosticReport['overall'], { title: string; body: string }> = {
  pass: {
    title: 'Everything needed for a call is working',
    body: 'Your devices, this browser and the route to the server all passed.',
  },
  warn: {
    title: 'Calls should work, with limits',
    body: 'Nothing is broken, but something below will reduce what you can do in a call.',
  },
  fail: {
    title: 'Something is stopping calls',
    body: 'The step marked below is the reason. Chat is unaffected — you can close this and keep talking.',
  },
};

function emptySteps(): DiagnosticStepResult[] {
  return STEP_ORDER.map((id) => ({
    id,
    title: STEP_TITLES[id],
    status: 'pending' as DiagnosticStatus,
    code: null,
    summary: '',
    remedy: '',
    detail: {},
    durationMs: 0,
  }));
}

export interface VoiceConnectionCheckProps {
  open: boolean;
  onClose: () => void;
  /** Devices the user picked in Voice & Video, so the check tests those. */
  selection?: DeviceSelection;
  /** Injected in tests; production uses the real browser adapters. */
  adapters?: DiagnosticsAdapters;
  /** Start as soon as the panel opens (used from a join failure). */
  autoStart?: boolean;
}

export function VoiceConnectionCheck({
  open,
  onClose,
  selection,
  adapters,
  autoStart = false,
}: VoiceConnectionCheckProps) {
  // The panel body is a separate component that only exists while the dialog is
  // open. Unmounting it is what discards a finished report and stops an
  // in-flight measurement, so closing the dialog cannot leave a microphone or
  // an audio context running behind the user's back.
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      labelledBy="voice-connection-check-title"
      describedBy="voice-connection-check-intro"
      showCloseButton
      // Settings is a windowed overlay at z-[150]; the check is opened from
      // inside it, so the default z-[60] would render it *behind* that backdrop
      // and swallow every click. Toasts stay above at z-[9999].
      zIndexClassName="z-[160]"
    >
      {open && (
        <ConnectionCheckPanel
          onClose={onClose}
          selection={selection}
          adapters={adapters}
          autoStart={autoStart}
        />
      )}
    </Modal>
  );
}

function ConnectionCheckPanel({
  onClose,
  selection,
  adapters,
  autoStart,
}: Omit<VoiceConnectionCheckProps, 'open'> & { autoStart: boolean }) {
  const user = useAuthStore((state) => state.user);
  const [steps, setSteps] = useState<DiagnosticStepResult[]>(emptySteps);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [running, setRunning] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [includeCamera, setIncludeCamera] = useState(false);
  const [question, setQuestion] = useState<string | null>(null);
  const answerRef = useRef<((heard: boolean) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  const ask = useCallback(
    (prompt: string) =>
      new Promise<boolean>((resolve) => {
        answerRef.current = (heard: boolean) => {
          answerRef.current = null;
          setQuestion(null);
          resolve(heard);
        };
        setQuestion(prompt);
      }),
    [],
  );

  const resolvedAdapters = useMemo<DiagnosticsAdapters>(() => {
    const base = adapters ?? createBrowserAdapters();
    return { ...base, ask: base.ask ?? ask };
  }, [adapters, ask]);

  const run = useCallback(async () => {
    if (running) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setReport(null);
    setMicLevel(0);
    setSteps(emptySteps());
    try {
      const result = await runVoiceConnectionCheck({
        adapters: resolvedAdapters,
        selection,
        includeCamera,
        accountDisplayName: user?.display_name ?? user?.username ?? null,
        serverOrigin: typeof window === 'undefined' ? null : window.location.origin,
        signal: controller.signal,
        onProgress: (next) => {
          if (runIdRef.current === runId) setSteps(next);
        },
        onLevel: (level) => {
          if (runIdRef.current === runId) setMicLevel(level);
        },
      });
      if (runIdRef.current === runId) setReport(result);
    } finally {
      if (runIdRef.current === runId) {
        setRunning(false);
        setMicLevel(0);
        setQuestion(null);
        answerRef.current = null;
      }
    }
  }, [includeCamera, resolvedAdapters, running, selection, user]);

  // Unmounting is the only close path, so one cleanup covers every case: stop
  // the run and drop the microphone rather than letting it outlive the dialog.
  useEffect(
    () => () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      answerRef.current = null;
    },
    [],
  );

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void run();
  }, [autoStart, run]);

  const micRunning = running && steps.some((step) => step.id === 'microphone' && step.status === 'running');

  return (
    <>
      <ModalHeader>
        <ModalTitle id="voice-connection-check-title">Voice connection check</ModalTitle>
        <p id="voice-connection-check-intro" className="mt-2 text-body text-text-secondary">
          Chat and calls travel different ways, so calls can fail while messages keep working. This
          check tests each part separately. It never joins a call, and closing it leaves anything you
          are already in untouched.
        </p>
      </ModalHeader>

      <ModalBody className="max-h-[60vh] overflow-y-auto">
        {report && (
          <div
            className={
              report.overall === 'fail'
                ? 'rounded-[var(--radius-well)] bg-danger-well px-3.5 py-3 shadow-[var(--shadow-well)]'
                : report.overall === 'warn'
                  ? 'rounded-[var(--radius-well)] bg-warning-tint px-3.5 py-3 shadow-[var(--shadow-well)]'
                  : 'pc-well px-3.5 py-3'
            }
            role="status"
          >
            <p className="text-label text-text-primary">{OVERALL_COPY[report.overall].title}</p>
            <p className="mt-1 text-meta leading-relaxed text-text-secondary">{OVERALL_COPY[report.overall].body}</p>
          </div>
        )}

        {question && (
          <div className="pc-well mt-3 px-3.5 py-3">
            <p className="text-label text-text-primary">{question}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => answerRef.current?.(true)}>
                Yes, I heard it
              </Button>
              <Button size="sm" variant="secondary" onClick={() => answerRef.current?.(false)}>
                No, nothing played
              </Button>
            </div>
          </div>
        )}

        <ol className="mt-3 space-y-1" aria-live="polite">
          {steps.map((step) => {
            const Icon = STATUS_ICON[step.status];
            return (
              <li
                key={step.id}
                className="flex gap-3 rounded-[var(--radius-control)] px-2.5 py-2.5 odd:bg-bg-mod-subtle"
                data-testid={`voice-check-step-${step.id}`}
                data-status={step.status}
              >
                <Icon
                  size={18}
                  aria-hidden="true"
                  className={`mt-0.5 shrink-0 ${STATUS_TONE[step.status]} ${
                    step.status === 'running' ? 'animate-spin' : ''
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-label text-text-primary">{step.title}</span>
                    <span className={`text-meta ${STATUS_TONE[step.status]}`}>
                      {STATUS_LABEL[step.status]}
                    </span>
                    {step.durationMs > 0 && (
                      <span className="text-meta text-text-muted">{step.durationMs} ms</span>
                    )}
                  </div>
                  {step.summary && (
                    <p className="mt-1 text-meta leading-relaxed text-text-secondary">{step.summary}</p>
                  )}
                  {step.remedy && (
                    <p className="mt-1.5 text-meta leading-relaxed text-text-primary">{step.remedy}</p>
                  )}
                  {step.code && (
                    <p className="pc-mono mt-1 text-meta text-text-faint">{step.code}</p>
                  )}
                  {step.id === 'microphone' && micRunning && (
                    <div className="mt-2">
                      <div
                        role="meter"
                        aria-label="Microphone input level"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(micLevel * 100)}
                        className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-mod-strong"
                      >
                        <div
                          className="h-full rounded-full bg-accent-primary transition-[width] duration-75"
                          style={{ width: `${Math.min(100, Math.round(micLevel * 100))}%` }}
                        />
                      </div>
                      <p className="mt-1 text-meta text-text-secondary">Speak now — say a few words.</p>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <label className="mt-3 flex items-center gap-2 text-meta text-text-secondary">
          <input
            type="checkbox"
            checked={includeCamera}
            disabled={running}
            onChange={(event) => setIncludeCamera(event.target.checked)}
          />
          Also check my camera
        </label>
      </ModalBody>

      <ModalFooter className="flex-wrap justify-between">
        <Button
          variant="secondary"
          disabled={!report}
          onClick={() => report && downloadDiagnostics(report)}
        >
          <Download size={16} aria-hidden="true" className="mr-2" />
          Export diagnostics
        </Button>
        <div className="flex gap-3">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button loading={running} onClick={() => void run()}>
            {report ? 'Run again' : 'Run check'}
          </Button>
        </div>
      </ModalFooter>
    </>
  );
}

export default VoiceConnectionCheck;
