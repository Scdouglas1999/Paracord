import { useState } from 'react';
import { Server, Shield, Users, Globe, ArrowRight, ArrowLeft } from 'lucide-react';

interface OnboardingWizardProps {
  onComplete: () => void;
}

const STEPS = [
  {
    title: 'Welcome to Paracord',
    subtitle: 'A self-hosted, decentralized chat platform',
    icon: Globe,
    content: (
      <div className="space-y-4 text-sm leading-relaxed text-text-secondary">
        <p>
          Unlike centralized platforms, Paracord gives you <strong className="text-text-primary">full control</strong> over
          your conversations. Your data lives on servers that you or your community operate.
        </p>
        <div className="grid gap-3">
          <div className="flex items-start gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-3">
            <Server size={18} className="mt-0.5 shrink-0 text-accent-primary" />
            <div>
              <div className="text-sm font-semibold text-text-primary">Self-Hosted</div>
              <div className="text-xs text-text-muted">Your server, your rules, your data</div>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-3">
            <Shield size={18} className="mt-0.5 shrink-0 text-accent-success" />
            <div>
              <div className="text-sm font-semibold text-text-primary">End-to-End Encrypted</div>
              <div className="text-xs text-text-muted">Optional E2EE for private direct messages</div>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-3">
            <Users size={18} className="mt-0.5 shrink-0 text-accent-warning" />
            <div>
              <div className="text-sm font-semibold text-text-primary">Multi-Server</div>
              <div className="text-xs text-text-muted">Connect to multiple communities seamlessly</div>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    title: 'Connect to a Server',
    subtitle: 'You need a server to get started',
    icon: Server,
    content: (
      <div className="space-y-4 text-sm leading-relaxed text-text-secondary">
        <p>To use Paracord, you connect to a server hosted by you or someone you trust.</p>
        <div className="space-y-3">
          <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-3">
            <div className="text-sm font-semibold text-text-primary">Join an existing server</div>
            <div className="mt-1 text-xs text-text-muted">
              Ask your admin for a server address or invite link. It looks like{' '}
              <code className="rounded bg-bg-mod-strong px-1 py-0.5 text-text-secondary">192.168.1.5:8090</code> or{' '}
              <code className="rounded bg-bg-mod-strong px-1 py-0.5 text-text-secondary">paracord://invite/...</code>
            </div>
          </div>
          <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-3">
            <div className="text-sm font-semibold text-text-primary">Host your own server</div>
            <div className="mt-1 text-xs text-text-muted">
              Download the server binary and run it on your machine, VPS, or home server. It takes a few minutes.
            </div>
          </div>
        </div>
        <p className="text-xs text-text-muted">
          You'll enter your server address on the next screen.
        </p>
      </div>
    ),
  },
];

const STORAGE_KEY = 'paracord:onboarding-complete';

export function hasCompletedOnboarding(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Icon = current.icon;

  const handleComplete = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // localStorage unavailable
    }
    onComplete();
  };

  return (
    <div className="auth-shell">
      <div className="mx-auto w-full max-w-lg">
        <div className="auth-card space-y-6 p-8 sm:p-10">
          {/* Step indicator */}
          <div className="flex items-center justify-center gap-2">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className="h-1.5 rounded-full transition-all duration-200"
                style={{
                  width: i === step ? 24 : 8,
                  backgroundColor: i === step ? 'var(--accent-primary)' : 'var(--border-subtle)',
                }}
              />
            ))}
          </div>

          {/* Header */}
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
              <Icon size={24} className="text-accent-primary" />
            </div>
            <h1 className="text-2xl font-bold text-text-primary">{current.title}</h1>
            <p className="mt-1.5 text-sm text-text-muted">{current.subtitle}</p>
          </div>

          {/* Content */}
          <div>{current.content}</div>

          {/* Navigation */}
          <div className="flex items-center gap-3 pt-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="flex h-11 items-center gap-2 rounded-xl border border-border-subtle bg-bg-mod-subtle px-5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong"
              >
                <ArrowLeft size={15} />
                Back
              </button>
            )}
            <button
              onClick={isLast ? handleComplete : () => setStep(step + 1)}
              className="btn-primary flex h-11 flex-1 items-center justify-center gap-2"
            >
              {isLast ? "Let's Go" : 'Next'}
              {!isLast && <ArrowRight size={15} />}
            </button>
          </div>

          {/* Skip option */}
          <div className="text-center">
            <button
              onClick={handleComplete}
              className="text-xs text-text-muted transition-colors hover:text-text-secondary"
            >
              Skip introduction
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
