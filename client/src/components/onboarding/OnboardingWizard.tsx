import { useState } from 'react';
import { Server, Shield, Users, Globe, ArrowRight, ArrowLeft } from 'lucide-react';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../../lib/versionedStorage';
import { Button } from '../ui/Button';

interface OnboardingWizardProps {
  onComplete: () => void;
  onTryDemo?: () => void;
}

interface FeatureRow {
  icon: typeof Server;
  color: string;
  title: string;
  body: string;
}

// A divided list of value props — not a stack of identical bordered cards
// (kill-list #5). Each row is a line icon in its own semantic color.
function FeatureList({ rows }: { rows: FeatureRow[] }) {
  return (
    <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-mod-subtle">
      {rows.map((row) => {
        const Icon = row.icon;
        return (
          <div key={row.title} className="flex items-start gap-3 px-3.5 py-3">
            <Icon size={18} className="mt-0.5 shrink-0" style={{ color: row.color }} />
            <div>
              <div className="text-label text-text-primary">{row.title}</div>
              <div className="text-meta text-text-muted">{row.body}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STEPS = [
  {
    title: 'Welcome to Paracord',
    subtitle: 'A self-hosted, decentralized place for your people',
    icon: Globe,
    content: (
      <div className="space-y-4">
        <p className="text-body text-text-secondary">
          Unlike centralized platforms, Paracord gives you{' '}
          <strong className="font-semibold text-text-primary">full control</strong> over your
          conversations. Your data lives on servers that you or your community operate.
        </p>
        <FeatureList
          rows={[
            {
              icon: Server,
              color: 'var(--accent-primary)',
              title: 'Self-hosted',
              body: 'Your server, your rules, your data',
            },
            {
              icon: Shield,
              color: 'var(--accent-success)',
              title: 'End-to-end encrypted',
              body: 'Optional E2EE for private direct messages',
            },
            {
              icon: Users,
              color: 'var(--accent-info)',
              title: 'Multi-server',
              body: 'Connect to multiple communities seamlessly',
            },
          ]}
        />
      </div>
    ),
  },
  {
    title: 'Connect to a server',
    subtitle: 'You need a server to get started',
    icon: Server,
    content: (
      <div className="space-y-4">
        <p className="text-body text-text-secondary">
          To use Paracord, you connect to a server hosted by you or someone you trust.
        </p>
        <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-mod-subtle">
          <div className="px-3.5 py-3">
            <div className="text-label text-text-primary">Join an existing server</div>
            <div className="mt-0.5 text-meta text-text-muted">
              Ask your admin for a server address or invite link. It looks like{' '}
              <code className="rounded-xs bg-bg-mod-strong px-1 py-0.5 font-code text-text-secondary">
                192.168.1.5:8090
              </code>{' '}
              or{' '}
              <code className="rounded-xs bg-bg-mod-strong px-1 py-0.5 font-code text-text-secondary">
                paracord://invite/…
              </code>
            </div>
          </div>
          <div className="px-3.5 py-3">
            <div className="text-label text-text-primary">Host your own server</div>
            <div className="mt-0.5 text-meta text-text-muted">
              Download the server binary and run it on your machine, VPS, or home server. It takes
              a few minutes.
            </div>
          </div>
        </div>
        <p className="text-meta text-text-muted">
          You'll enter your server address on the next screen.
        </p>
      </div>
    ),
  },
];

const STORAGE_KEY = 'onboarding-complete';

export function hasCompletedOnboarding(): boolean {
  try {
    return getVersionedStorageItem(STORAGE_KEY, ['onboarding-complete']) === '1';
  } catch {
    return false;
  }
}

export function OnboardingWizard({ onComplete, onTryDemo }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Icon = current.icon;

  const handleComplete = () => {
    try {
      setVersionedStorageItem(STORAGE_KEY, '1');
    } catch {
      // localStorage unavailable
    }
    onComplete();
  };

  return (
    <div className="auth-shell">
      <div className="mx-auto w-full max-w-lg">
        <div className="auth-card space-y-6">
          {/* Step indicator */}
          <div
            className="flex items-center justify-center gap-2"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={step + 1}
            aria-label={`Step ${step + 1} of ${STEPS.length}`}
          >
            {STEPS.map((_, i) => (
              <div
                key={i}
                className="h-1.5 rounded-full transition-all duration-[180ms] ease-[var(--ease-out)]"
                style={{
                  width: i === step ? 26 : 8,
                  backgroundColor: i <= step ? 'var(--accent-primary)' : 'var(--bg-mod-strong)',
                }}
              />
            ))}
          </div>

          {/* Header */}
          <div>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
              <Icon size={24} />
            </div>
            <h1 className="font-display text-display text-text-primary">{current.title}</h1>
            <p className="mt-1.5 text-body text-text-secondary">{current.subtitle}</p>
          </div>

          {/* Content */}
          <div className="space-y-4">
            <div>{current.content}</div>
            {step === 1 && onTryDemo && (
              <button
                type="button"
                onClick={onTryDemo}
                className="w-full rounded-sm border border-accent-primary/40 bg-accent-tint px-4 py-2.5 text-label text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint-strong focus-visible:shadow-[var(--focus-ring)]"
              >
                Try a public demo server
              </button>
            )}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-3 pt-1">
            {step > 0 && (
              <Button variant="secondary" size="lg" onClick={() => setStep(step - 1)}>
                <ArrowLeft size={16} className="mr-1.5" />
                Back
              </Button>
            )}
            <Button
              size="lg"
              className="flex-1"
              onClick={isLast ? handleComplete : () => setStep(step + 1)}
            >
              {isLast ? "Let's go" : 'Next'}
              {!isLast && <ArrowRight size={16} className="ml-1.5" />}
            </Button>
          </div>

          {/* Skip option */}
          <div className="text-center">
            <button
              onClick={handleComplete}
              className="rounded-sm px-2 py-1 text-meta text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]"
            >
              Skip introduction
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
